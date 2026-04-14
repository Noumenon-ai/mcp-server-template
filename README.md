# MCP Server Template

**Production-Ready Base for Building MCP Servers**

Stop writing boilerplate. Start with a battle-tested foundation that handles auth, rate limiting, logging, and error handling out of the box.

---

## What You Get

- **Dual Transport** -- Streamable HTTP and stdio, switch with one env var
- **Authentication** -- API key (`x-api-key`) and Bearer token auth built in
- **Rate Limiting** -- Per-client, per-tool fixed-window rate limiter
- **Structured Logging** -- Pino JSON logging with automatic credential redaction
- **Typed Errors** -- `AuthError`, `ValidationError`, `RateLimitError`, `NotFoundError`, and more
- **Environment Loading** -- Automatic `.env` and `.env.local` loading via dotenv
- **TypeScript** -- Strict mode, full type safety, zero `any`
- **Base Tools** -- `health_check` and `echo_json` included for immediate smoke testing
- **CORS** -- Configurable per-origin CORS with preflight handling
- **Graceful Shutdown** -- Clean SIGINT/SIGTERM handling with transport cleanup

## Quick Start

```bash
# Clone this template
git clone https://github.com/YOUR_USERNAME/mcp-server-template.git my-mcp-server
cd my-mcp-server

# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env

# Build
npm run build

# Run (stdio mode, default)
npm start

# Run (HTTP mode)
MCP_TRANSPORT=http npm start

# Development mode with hot reload
npm run dev
```

## Register Your First Tool

Open `src/index.ts` and add tools to the `tools` array:

```typescript
import { z } from "zod";
import { defineTool, createJsonResult } from "./types.js";
import type { ServerDefinition } from "./types.js";

export const myServerDefinition: ServerDefinition = {
  metadata: {
    defaultPort: 8787,
    description: "My custom MCP server",
    name: "my-mcp-server",
    title: "My MCP Server",
    version: "1.0.0",
  },
  tools: [
    defineTool({
      name: "get_weather",
      title: "Get Weather",
      description: "Fetch current weather for a city.",
      inputSchema: {
        city: z.string().min(1).describe("City name"),
        units: z.enum(["celsius", "fahrenheit"]).optional(),
      },
      execute: async ({ city, units }, context) => {
        context.logger.info({ city }, "fetching_weather");

        // Your real implementation here
        const weather = { city, temp: 22, units: units ?? "celsius" };

        return createJsonResult(weather);
      },
    }),
  ],
};
```

Every tool you register automatically gets:
- Input validation via Zod schemas
- Per-client rate limiting
- Structured request logging with request IDs
- Error normalization and safe client responses
- Session tracking for HTTP transport

## Add a Resource

```typescript
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

export const myServerDefinition: ServerDefinition = {
  metadata: { /* ... */ },
  tools: [ /* ... */ ],
  resources: [
    {
      name: "config",
      title: "Server Configuration",
      description: "Current server configuration values.",
      mimeType: "application/json",
      template: new ResourceTemplate("myserver://config", { list: undefined }),
      read: async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ version: "1.0.0" }, null, 2),
          },
        ],
      }),
    },
  ],
};
```

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio` or `http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP server bind address |
| `MCP_HTTP_PORT` | `8787` | HTTP server port |
| `MCP_API_KEY` | _(empty)_ | API key for `x-api-key` header auth |
| `MCP_BEARER_TOKEN` | _(empty)_ | Bearer token for `Authorization` header auth |
| `MCP_RATE_LIMIT_MAX_REQUESTS` | `60` | Max requests per window per client per tool |
| `MCP_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds |
| `MCP_CORS_ORIGINS` | _(empty)_ | Comma-separated allowed CORS origins |
| `LOG_LEVEL` | `info` | Pino log level: `debug`, `info`, `warn`, `error` |

Set `MCP_API_KEY` or `MCP_BEARER_TOKEN` to enable authentication. Leave both empty for open access (stdio mode does not use auth).

## Project Structure

```
src/
  index.ts         # Entry point and server definition
  server.ts        # Server class, tool registration, HTTP/stdio transport
  auth.ts          # API key + Bearer token authentication
  rate-limit.ts    # Fixed-window in-memory rate limiter
  logger.ts        # Pino structured logging with credential redaction
  errors.ts        # Typed error classes (Auth, Validation, RateLimit, etc.)
  env.ts           # Automatic .env file loading
  types.ts         # Shared types, helpers, Zod schemas
```

---

## Want Pre-Built Production Servers?

This template is the foundation. But if you want to skip the build phase and ship faster, the **MCP Starter Kit** includes **5 production-ready servers** built on this exact template:

| Server | What It Does |
|---|---|
| **Supabase CRUD** | Full database operations with RLS, filtering, pagination |
| **Stripe Billing** | Customers, subscriptions, invoices, payment links, webhooks |
| **Email (Resend)** | Send transactional and marketing emails, manage contacts |
| **File Manager** | Upload, download, list, delete files with S3-compatible storage |
| **Web Scraper** | Extract structured data from any URL with Markdown conversion |

Each server ships with complete tool definitions, error handling, and tests. Clone, configure your API keys, deploy.

**[Get the full MCP Starter Kit](https://noumenon6.gumroad.com/l/mcp)**

---

## License

MIT -- see [LICENSE](./LICENSE).
---
Built by [Noumenon](https://github.com/Noumenon-ai)