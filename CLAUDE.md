# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Persistent semantic memory system for Claude Code sessions using Cloudflare R2 + AI Search. The Worker serves both a REST API and MCP protocol directly.

## Commands

```bash
# Install dependencies (from root)
npm install

# Development
npm run dev                 # Run worker locally with wrangler dev

# Deploy
npm run deploy              # Deploy worker to Cloudflare
```

## Architecture

```
Claude Code ──► Cloudflare Worker (MCP + REST) ──► R2 (storage)
                         │                              │
                         └──► AI Search ◄───────────────┘
                              (auto-indexes R2)
```

**Data Flow:**
1. Claude Code connects to Worker via MCP (JSON-RPC over HTTP)
2. Worker handles `save_memory` and `search_memories` tool calls
3. Memories stored as JSON in R2 at `memories/{uuid}.json`
4. Worker triggers AI Search resync via Cloudflare API
5. Search uses `env.AI.autorag(instance).search()` for semantic queries

**Memory Schema:**
```typescript
interface Memory {
  id: string;           // UUID
  content: string;      // The memory text
  tags: string[];       // Categories
  source: 'user' | 'auto';
  createdAt: string;    // ISO timestamp
}
```

## Worker Endpoints

### MCP Protocol
- `POST /mcp` - MCP JSON-RPC endpoint (initialize, tools/list, tools/call)
- `GET /sse` - SSE endpoint for MCP connection

### REST API
- `POST /memories` - Save memory, triggers AI Search resync
- `GET /memories/search?q=...&limit=5` - Semantic search via AI Search
- `GET /memories` - List all (paginated with cursor)
- `DELETE /memories/:id` - Delete and resync
- `POST /memories/resync` - Manual resync trigger
- `GET /health` - Health check (no auth)

## Required Secrets (wrangler secret put)

- `API_KEY` - Bearer token for auth
- `CF_API_TOKEN` - Cloudflare API token for AI Search resync
- `CF_ACCOUNT_ID` - Cloudflare account ID
- `AI_SEARCH_INSTANCE` - AI Search instance name

## Claude Code MCP Configuration

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "agent-memories": {
      "type": "http",
      "url": "https://your-worker.your-subdomain.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```
