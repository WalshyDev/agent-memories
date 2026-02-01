import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

// Auth middleware
app.use('*', async (c, next) => {
  // Skip auth for health check
  if (c.req.path === '/health') {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  const apiKey = c.env.API_KEY;

  if (!apiKey) {
    return c.json({ error: 'Server not configured with API key' }, 500);
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  if (token !== apiKey) {
    return c.json({ error: 'Invalid API key' }, 401);
  }

  await next();
});

// Health check (no auth required)
app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// MCP endpoint (POST for JSON-RPC requests)
app.post('/mcp', async (c) => {
  const request = await c.req.json<JsonRpcRequest>();
  const response = await handleMcpRequest(c.env, request);
  return c.json(response);
});

// SSE endpoint for MCP (required for bidirectional communication)
app.get('/sse', async (c) => {
  // Return SSE stream - for now just keep connection alive
  // Real messages are sent in response to /mcp POSTs
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Send initial connection message
  writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`));

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// Save memory (REST API)
app.post('/memories', async (c) => {
  const body = await c.req.json<CreateMemoryRequest>();

  if (!body.content || typeof body.content !== 'string') {
    return c.json({ error: 'content is required and must be a string' }, 400);
  }

  const memory = await saveMemory(c.env, body.content, body.tags, body.source);

  return c.json({ success: true, memory });
});

// Search memories (REST API)
app.get('/memories/search', async (c) => {
  const query = c.req.query('q');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : 5;

  if (!query) {
    return c.json({ error: 'Query parameter q is required' }, 400);
  }

  const memories = await searchMemories(c.env, query, limit);
  return c.json({ memories });
});

// Manually trigger resync
app.post('/memories/resync', async (c) => {
  const result = await triggerResync(c.env);

  if (!result.success) {
    return c.json({ error: result.error }, 500);
  }

  return c.json({ success: true, jobId: result.jobId });
});

// Delete memory
app.delete('/memories/:id', async (c) => {
  const id = c.req.param('id');

  // Delete from R2
  await c.env.MEMORIES_BUCKET.delete(`memories/${id}.json`);

  // Trigger resync to update AI Search index
  const resync = await triggerResync(c.env);

  return c.json({
    success: true,
    resync: resync.success ? { jobId: resync.jobId } : { error: resync.error }
  });
});

// List all memories (paginated)
app.get('/memories', async (c) => {
  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : 20;

  const listed = await c.env.MEMORIES_BUCKET.list({
    prefix: 'memories/',
    limit,
    ...(cursor && { cursor }),
  });

  const memories: Memory[] = [];

  for (const object of listed.objects) {
    const obj = await c.env.MEMORIES_BUCKET.get(object.key);
    if (obj) {
      const memory = await obj.json<Memory>();
      memories.push(memory);
    }
  }

  return c.json({
    memories,
    cursor: listed.truncated ? listed.cursor : null,
  });
});

// MCP tool definitions
const MCP_TOOLS = [
  {
    name: 'save_memory',
    description: `Save a memory for future reference. Use this when the user explicitly asks to remember something, or when they express strong preferences with words like "ALWAYS", "NEVER", "Remember that...", or "I prefer...". Examples:
- "Remember that I prefer TypeScript over JavaScript"
- "Always use tabs for indentation in my projects"
- "Never use semicolons in my code"`,
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The memory content to save',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags to categorize the memory (e.g., ["coding-style", "preferences"])',
        },
        source: {
          type: 'string',
          enum: ['user', 'auto'],
          description: 'Whether this memory was explicitly requested by the user or auto-detected',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_memories',
    description: `Search for relevant memories. Use this at the start of sessions or before making decisions about coding style, architecture, or user preferences. This helps maintain consistency with the user's established preferences.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find relevant memories',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
        },
      },
      required: ['query'],
    },
  },
];

// Helper to save memory (shared between REST and MCP)
async function saveMemory(
  env: Env,
  content: string,
  tags: string[] = [],
  source: 'user' | 'auto' = 'user'
): Promise<Memory> {
  const memory: Memory = {
    id: crypto.randomUUID(),
    content,
    tags,
    source,
    createdAt: new Date().toISOString(),
  };

  await env.MEMORIES_BUCKET.put(
    `memories/${memory.id}.json`,
    JSON.stringify(memory, null, 2),
    {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        tags: memory.tags.join(','),
        source: memory.source,
        createdAt: memory.createdAt,
      },
    }
  );

  await triggerResync(env);
  return memory;
}

// Helper to search memories (shared between REST and MCP)
async function searchMemories(
  env: Env,
  query: string,
  limit: number = 5
): Promise<(Memory & { score: number })[]> {
  const autorag = env.AI.autorag(env.AI_SEARCH_INSTANCE);
  const results = await autorag.search({
    query,
    max_num_results: Math.min(limit, 50),
    rewrite_query: true,
    ranking_options: { score_threshold: 0.1 },
  }) as AiSearchResult;

  const memories: (Memory & { score: number })[] = [];

  for (const item of results.data) {
    const textContent = item.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    try {
      const memory = JSON.parse(textContent) as Memory;
      memories.push({ ...memory, score: item.score });
    } catch {
      memories.push({
        id: item.file_id,
        content: textContent,
        tags: [],
        source: 'auto',
        createdAt: new Date().toISOString(),
        score: item.score,
      });
    }
  }

  return memories;
}

// MCP response helpers
function mcpResult(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function mcpToolResult(id: string | number, text: string, isError = false): JsonRpcResponse {
  return mcpResult(id, {
    content: [{ type: 'text', text }],
    ...(isError && { isError: true }),
  });
}

function mcpError(id: string | number, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// MCP JSON-RPC handler
async function handleMcpRequest(env: Env, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      return mcpResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-memories', version: '1.0.0' },
      });

    case 'tools/list':
      return mcpResult(id, { tools: MCP_TOOLS });

    case 'tools/call': {
      const toolName = params?.name as string;
      const toolArgs = params?.arguments as Record<string, unknown> | undefined;

      if (toolName === 'save_memory') {
        const content = toolArgs?.content as string;
        if (!content) {
          return mcpToolResult(id, 'Error: content is required', true);
        }

        const memory = await saveMemory(
          env,
          content,
          (toolArgs?.tags as string[]) || [],
          (toolArgs?.source as 'user' | 'auto') || 'user'
        );

        return mcpToolResult(id, `Memory saved successfully with ID: ${memory.id}`);
      }

      if (toolName === 'search_memories') {
        const query = toolArgs?.query as string;
        if (!query) {
          return mcpToolResult(id, 'Error: query is required', true);
        }

        const memories = await searchMemories(env, query, (toolArgs?.limit as number) || 5);

        if (memories.length === 0) {
          return mcpToolResult(id, 'No memories found matching the query.');
        }

        const formatted = memories
          .map((m, i) => {
            const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
            return `${i + 1}. ${m.content}${tags} (relevance: ${(m.score * 100).toFixed(1)}%)`;
          })
          .join('\n');

        return mcpToolResult(id, `Found ${memories.length} relevant memories:\n\n${formatted}`);
      }

      return mcpToolResult(id, `Unknown tool: ${toolName}`, true);
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return mcpResult(id, {});

    default:
      return mcpError(id, -32601, `Method not found: ${method}`);
  }
}

// Trigger AI Search resync
async function triggerResync(env: Env): Promise<{ success: boolean; jobId?: string; error?: string }> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai-search/instances/${env.AI_SEARCH_INSTANCE}/jobs`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const result = await response.json() as { success: boolean; result?: { id: string }; errors?: Array<{ message: string }> };

  if (!result.success) {
    return { success: false, error: result.errors?.[0]?.message || 'Unknown error' };
  }

  return { success: true, jobId: result.result?.id };
}

export default app;
