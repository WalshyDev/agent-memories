# Agent memories

Persistent, semantic memory for Claude Code/Opencode/other AI agent sessions using Cloudflare R2 + AI Search.

Save preferences, coding styles, and important context that persists across sessions. When you tell Claude "always use tabs" or "remember that I prefer TypeScript", it stays remembered.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  MCP Server (stdio)                                   │  │
│  │  ├── save_memory                                      │  │
│  │  └── search_memories                                  │  │
│  └───────────────────────┬───────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Cloudflare Worker                           │
│  ┌──────────┐  ┌────────────────────────────────────────┐   │
│  │    R2    │◄─┤           AI Search                    │   │
│  │ (storage)│  │ (auto-indexes, handles embeddings)     │   │
│  └──────────┘  └────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Setup

### Prerequisites

- Node.js 20+
- Cloudflare account with R2 and AI Search enabled
- Wrangler CLI (`npx wrangler`)

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Cloudflare Resources

```bash
# Create R2 bucket
wrangler r2 bucket create claude-memories

# Create AI Search instance via Cloudflare Dashboard:
# 1. Go to AI > AI Search
# 2. Create new instance named "claude-memories"
# 3. Connect it to the "claude-memories" R2 bucket
```

### 3. Configure Secrets

```bash
# API key for authenticating requests (generate a secure random string - e.g. `openssl rand -hex 32`)
wrangler secret put API_KEY

# Cloudflare API token (needs AI Search and R2 permissions)
wrangler secret put CF_API_TOKEN

# Your Cloudflare account ID
wrangler secret put CF_ACCOUNT_ID

# AI Search instance name from step 2
wrangler secret put AI_SEARCH_INSTANCE
```

### 4. Deploy Worker

```bash
npm run deploy
```

Note your worker URL (e.g., `https://agent-memories.<subdomain>.workers.dev`)

### 5. Configure Your AI Coding Assistant

#### Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "claude-memory": {
      "type": "http",
      "url": "https://agent-memories.<subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

#### OpenCode

Add to `~/.opencode/config.json`:

```json
{
  "mcpServers": {
    "claude-memory": {
      "type": "http",
      "url": "https://agent-memories.<subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

## Usage

Once configured, your AI agent will have access to two tools:

### save_memory

Saves information for future reference. Triggered when you say things like:
- "Remember that I prefer TypeScript over JavaScript"
- "Always use tabs for indentation"
- "Never use semicolons in my code"

### search_memories

Retrieves relevant memories. Your AI agent can use this to recall your preferences before making coding decisions.

### Examples

```
> Remember that I always want error handling with try/catch, never .catch()

> What are my coding preferences?

> Remember: this project uses pnpm, not npm
```

## API Reference

### POST /memories

Save a new memory.

```bash
curl -X POST https://agent-memories.<subdomain>.workers.dev/memories \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"content": "Always use TypeScript", "tags": ["preferences"]}'
```

### GET /memories/search

Semantic search for memories.

```bash
curl "https://agent-memories.<subdomain>.workers.dev/memories/search?q=typescript&limit=5" \
  -H "Authorization: Bearer your-api-key"
```

### GET /memories

List all memories (paginated).

```bash
curl "https://agent-memories.<subdomain>.workers.dev/memories?limit=20" \
  -H "Authorization: Bearer your-api-key"
```

### DELETE /memories/:id

Delete a memory.

```bash
curl -X DELETE "https://agent-memories.<subdomain>.workers.dev/memories/abc-123" \
  -H "Authorization: Bearer your-api-key"
```

### POST /memories/resync

Manually trigger AI Search reindex.

```bash
curl -X POST "https://agent-memories.<subdomain>.workers.dev/memories/resync" \
  -H "Authorization: Bearer your-api-key"
```

## Development

```bash
# Run locally
npm run dev

# Build
npm run build
```

## License

MIT
