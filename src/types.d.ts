interface Env {
  MEMORIES_BUCKET: R2Bucket;
  AI: Ai;
  API_KEY: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  AI_SEARCH_INSTANCE: string;
}

interface Memory {
  id: string;
  content: string;
  tags: string[];
  source: 'user' | 'auto';
  createdAt: string;
}

interface CreateMemoryRequest {
  content: string;
  tags?: string[];
  source?: 'user' | 'auto';
}

interface AiSearchResult {
  object: string;
  search_query: string;
  data: Array<{
    file_id: string;
    filename: string;
    score: number;
    attributes: Record<string, string | number | boolean | null>;
    content: Array<{ type: string; text: string }>;
  }>;
}

// MCP JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
