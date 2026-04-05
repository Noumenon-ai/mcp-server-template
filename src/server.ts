import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { LoggingMessageNotification, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { authenticateHttpRequest, getHeader, loadAuthConfig } from "./auth.js";
import { AppError, ConfigurationError, ValidationError, normalizeError, serializeError, toToolErrorResult } from "./errors.js";
import { createLogger, createRequestLogger, type RequestLogBindings } from "./logger.js";
import { InMemoryRateLimiter, loadRateLimitPolicy } from "./rate-limit.js";
import {
  createJsonResult,
  defineTool,
  jsonValueSchema,
  type JsonObject,
  type ResourceDefinition,
  type ServerDefinition,
  type ToolDefinition,
  type TransportMode
} from "./types.js";

export interface StartServerOptions {
  corsOrigins?: string[];
  healthPath?: string;
  host?: string;
  mcpPath?: string;
  port?: number;
  transport?: TransportMode;
}

interface HttpSession {
  clientId: string;
  connectedAt: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface JsonRpcRequestLike {
  id?: unknown;
}

interface SharedRuntime {
  logger: ReturnType<typeof createLogger>;
  rateLimiter: InMemoryRateLimiter;
  sessionClients: Map<string, string>;
}

interface CorsConfig {
  origins: Set<string>;
}

const MAX_HTTP_BODY_BYTES = 1_000_000;

export async function startServer(definition: ServerDefinition, options: StartServerOptions = {}): Promise<void> {
  assertUniqueToolNames(definition.tools);

  const shared: SharedRuntime = {
    logger: createLogger(definition.metadata.name),
    rateLimiter: new InMemoryRateLimiter(loadRateLimitPolicy()),
    sessionClients: new Map<string, string>()
  };

  const transport = options.transport ?? (process.env.MCP_TRANSPORT === "http" ? "http" : "stdio");
  if (transport === "stdio") {
    const server = createConnectedServer(definition, shared);
    const stdioTransport = new StdioServerTransport();

    await server.connect(stdioTransport);
    shared.logger.info({ transport: "stdio" }, "mcp_server_ready");

    registerProcessShutdown(shared.logger, async () => {
      await closeServer(server, shared.logger);
    });

    return;
  }

  await startHttpServer(definition, shared, options);
}

function createConnectedServer(definition: ServerDefinition, shared: SharedRuntime): McpServer {
  const server = new McpServer(
    {
      name: definition.metadata.name,
      version: definition.metadata.version
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  for (const tool of [...createBaseTools(definition), ...definition.tools]) {
    registerTool(server, tool, shared);
  }

  for (const resource of definition.resources ?? []) {
    registerResource(server, resource, shared.logger);
  }

  return server;
}

function createBaseTools(definition: ServerDefinition): ToolDefinition[] {
  return [
    defineTool({
      description: "Return server runtime metadata and current process state.",
      execute: async (_input, context) => {
        const payload: JsonObject = {
          clientId: context.clientId,
          requestId: context.requestId,
          server: definition.metadata.name,
          sessionId: context.sessionId ?? null,
          startedAt: new Date(Date.now() - Math.round(process.uptime() * 1_000)).toISOString(),
          transport: context.transport,
          uptimeSeconds: Math.round(process.uptime()),
          version: definition.metadata.version
        };

        return createJsonResult(payload);
      },
      inputSchema: {},
      name: "health_check",
      rateLimit: {
        maxRequests: 240,
        windowMs: 60_000
      },
      title: "Health Check"
    }),
    defineTool({
      description: "Echo structured input back to the caller. Useful for smoke tests and scaffolding.",
      execute: async ({ message, metadata }) => {
        const payload: JsonObject = {
          message,
          metadata: metadata ?? {}
        };

        return createJsonResult(payload);
      },
      inputSchema: {
        message: z.string().min(1).max(4_000),
        metadata: z.record(z.string(), jsonValueSchema).optional()
      },
      name: "echo_json",
      title: "Echo JSON"
    })
  ];
}

function registerTool(server: McpServer, tool: ToolDefinition, shared: SharedRuntime): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      title: tool.title
    },
    async (input, extra) => {
      const requestId = randomUUID();
      const sessionId = extra.sessionId;
      const transport: TransportMode = sessionId === undefined ? "stdio" : "http";
      const clientId = sessionId === undefined ? "stdio" : shared.sessionClients.get(sessionId) ?? `session:${sessionId}`;
      const bindings: RequestLogBindings = {
        clientId,
        requestId,
        toolName: tool.name,
        transport
      };

      if (sessionId !== undefined) {
        bindings.sessionId = sessionId;
      }

      const requestLogger = createRequestLogger(shared.logger, bindings);

      try {
        const parsedInput = parseToolInput(tool, input);
        const rateLimit = shared.rateLimiter.check(clientId, tool.name, tool.rateLimit);

        requestLogger.info({ remaining: rateLimit.remaining, resetAt: rateLimit.resetAt }, "tool_started");
        await emitLog(server, sessionId, "info", `Running tool ${tool.name}`);

        const context = {
          clientId,
          logger: requestLogger,
          requestId,
          server,
          transport
        };

        const result = await tool.execute(
          parsedInput,
          sessionId === undefined
            ? context
            : {
                ...context,
                sessionId
              }
        );

        requestLogger.info("tool_completed");
        return result;
      } catch (error) {
        const normalized = normalizeError(error);

        requestLogger.error({ error: serializeError(normalized) }, "tool_failed");
        await emitLog(
          server,
          sessionId,
          normalized.statusCode >= 500 ? "error" : "warning",
          normalized.expose ? normalized.message : "Internal server error"
        );

        return toToolErrorResult(normalized);
      }
    }
  );
}

function registerResource(server: McpServer, resource: ResourceDefinition, logger: SharedRuntime["logger"]): void {
  const config = {
    description: resource.description,
    mimeType: resource.mimeType,
    title: resource.title
  };

  const callback = async (uri: URL, params: Record<string, string>): Promise<ReadResourceResult> => {
    try {
      return await resource.read(uri, params);
    } catch (error) {
      const normalized = normalizeError(error);
      logger.error({ error: serializeError(normalized), resource: resource.name }, "resource_failed");
      throw normalized;
    }
  };

  if (typeof resource.template === "string") {
    server.registerResource(resource.name, resource.template, config, async (uri) => callback(uri, {}));
    return;
  }

  server.registerResource(resource.name, resource.template, config, async (uri, params) => callback(uri, params as Record<string, string>));
}

async function startHttpServer(
  definition: ServerDefinition,
  shared: SharedRuntime,
  options: StartServerOptions
): Promise<void> {
  const authConfig = loadAuthConfig();
  const corsConfig = loadCorsConfig(options.corsOrigins);
  const host = options.host ?? process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = parsePositiveInt(process.env.MCP_HTTP_PORT ?? process.env.PORT, options.port ?? definition.metadata.defaultPort);
  const mcpPath = options.mcpPath ?? process.env.MCP_PATH ?? "/mcp";
  const healthPath = options.healthPath ?? process.env.MCP_HEALTH_PATH ?? "/health";
  const enableJsonResponse = process.env.MCP_ENABLE_JSON_RESPONSE !== "false";
  const sessions = new Map<string, HttpSession>();

  const httpServer = createServer(async (request, response) => {
    let body: unknown;

    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
      const origin = getHeader(request.headers, "origin");

      if (request.method === "OPTIONS") {
        if (requestUrl.pathname !== mcpPath) {
          writeJson(response, 404, {
            error: "Not found"
          });
          return;
        }

        handlePreflight(response, origin, corsConfig);
        return;
      }

      applyCorsHeaders(response, origin, corsConfig);

      if (request.method === "GET" && requestUrl.pathname === healthPath) {
        writeJson(response, 200, {
          authEnabled: authConfig.enabled,
          corsOrigins: [...corsConfig.origins],
          server: definition.metadata.name,
          sessions: sessions.size,
          status: "ok",
          transport: "http",
          version: definition.metadata.version
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/") {
        writeJson(response, 200, {
          description: definition.metadata.description,
          healthPath,
          mcpPath,
          server: definition.metadata.name,
          title: definition.metadata.title ?? definition.metadata.name,
          version: definition.metadata.version
        });
        return;
      }

      if (requestUrl.pathname !== mcpPath) {
        writeJson(response, 404, {
          error: "Not found"
        });
        return;
      }

      if (request.method !== "DELETE" && request.method !== "GET" && request.method !== "POST") {
        writeJson(response, 405, {
          error: "Method not allowed"
        });
        return;
      }

      const auth = authenticateHttpRequest(request.headers, request.socket.remoteAddress, authConfig);
      if (request.method === "POST") {
        body = await readJsonBody(request);
      }

      const sessionId = getHeader(request.headers, "mcp-session-id");

      if (sessionId === undefined) {
        if (request.method !== "POST" || !isInitializeBody(body)) {
          throw new ValidationError("Initialize the server before using the HTTP transport", {
            expectedMethod: "POST",
            path: mcpPath
          });
        }

        const session = await createHttpSession(definition, shared, sessions, auth.clientId, enableJsonResponse);
        await session.transport.handleRequest(request, response, body);
        return;
      }

      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw new ValidationError(`Unknown MCP session: ${sessionId}`);
      }

      shared.sessionClients.set(sessionId, auth.clientId);
      session.clientId = auth.clientId;

      if (request.method === "POST") {
        await session.transport.handleRequest(request, response, body);
        return;
      }

      await session.transport.handleRequest(request, response);
    } catch (error) {
      const normalized = normalizeError(error);

      shared.logger.error({ error: serializeError(normalized) }, "http_request_failed");
      writeJsonRpcError(response, normalized, extractJsonRpcId(body));
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  shared.logger.info(
    {
      authEnabled: authConfig.enabled,
      corsOrigins: [...corsConfig.origins],
      healthPath,
      host,
      mcpPath,
      port,
      transport: "http"
    },
    "mcp_server_ready"
  );

  registerProcessShutdown(shared.logger, async () => {
    for (const session of sessions.values()) {
      await closeTransport(session.transport, shared.logger);
      await closeServer(session.server, shared.logger);
    }

    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });
}

async function createHttpSession(
  definition: ServerDefinition,
  shared: SharedRuntime,
  sessions: Map<string, HttpSession>,
  clientId: string,
  enableJsonResponse: boolean
): Promise<HttpSession> {
  const server = createConnectedServer(definition, shared);
  let session!: HttpSession;

  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse,
    onsessioninitialized: (sessionId) => {
      shared.sessionClients.set(sessionId, clientId);
      sessions.set(sessionId, session);
    },
    sessionIdGenerator: () => randomUUID()
  });

  session = {
    clientId,
    connectedAt: new Date().toISOString(),
    server,
    transport
  };

  transport.onclose = () => {
    void (async () => {
      const sessionId = transport.sessionId;

      if (sessionId !== undefined) {
        sessions.delete(sessionId);
        shared.sessionClients.delete(sessionId);
      }

      await closeServer(server, shared.logger);
    })();
  };

  await server.connect(transport as unknown as import("@modelcontextprotocol/sdk/shared/transport.js").Transport);
  return session;
}

async function emitLog(
  server: McpServer,
  sessionId: string | undefined,
  level: LoggingMessageNotification["params"]["level"],
  data: string
): Promise<void> {
  if (sessionId === undefined) {
    return;
  }

  try {
    await server.sendLoggingMessage({ data, level }, sessionId);
  } catch {
    // Ignore transport-specific log delivery failures.
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.byteLength;

    if (totalBytes > MAX_HTTP_BODY_BYTES) {
      throw new ValidationError("Request body is too large", {
        maxBytes: MAX_HTTP_BODY_BYTES
      });
    }

    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (rawBody.length === 0) {
    throw new ValidationError("Request body is required");
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
}

function writeJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  if (response.writableEnded) {
    return;
  }

  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function writeJsonRpcError(response: ServerResponse, error: AppError, id: unknown): void {
  if (response.writableEnded) {
    return;
  }

  response.statusCode = error.statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify({
      error: {
        code: mapErrorCode(error.code),
        data: error.details ?? null,
        message: error.expose ? error.message : "Internal server error"
      },
      id: id ?? null,
      jsonrpc: "2.0"
    })
  );
}

function extractJsonRpcId(body: unknown): unknown {
  if (isJsonRpcRequest(body)) {
    return body.id ?? null;
  }

  return null;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequestLike {
  return typeof value === "object" && value !== null;
}

function isInitializeBody(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { method?: unknown }).method === "initialize";
}

function mapErrorCode(code: string): number {
  switch (code) {
    case "AUTHENTICATION_ERROR":
      return -32001;
    case "RATE_LIMIT_ERROR":
      return -32029;
    case "VALIDATION_ERROR":
      return -32602;
    default:
      return -32000;
  }
}

function parseToolInput(tool: ToolDefinition, input: unknown): Record<string, unknown> {
  const schema = z.object(tool.inputSchema).strict();
  const parsed = schema.safeParse(input ?? {});

  if (!parsed.success) {
    throw parsed.error;
  }

  return parsed.data;
}

function loadCorsConfig(origins: string[] | undefined): CorsConfig {
  const configuredOrigins =
    origins ??
    (process.env.MCP_CORS_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

  if (configuredOrigins.includes("*")) {
    throw new ConfigurationError("Wildcard CORS origins are not allowed", {
      envVar: "MCP_CORS_ORIGINS"
    });
  }

  return {
    origins: new Set(configuredOrigins)
  };
}

function applyCorsHeaders(response: ServerResponse, origin: string | undefined, config: CorsConfig): void {
  if (origin === undefined || !config.origins.has(origin)) {
    return;
  }

  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-headers", "authorization, content-type, mcp-session-id, x-api-key");
  response.setHeader("access-control-allow-methods", "DELETE, GET, OPTIONS, POST");
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
}

function handlePreflight(response: ServerResponse, origin: string | undefined, config: CorsConfig): void {
  if (origin === undefined || !config.origins.has(origin)) {
    writeJson(response, 403, {
      error: "Origin is not allowed"
    });
    return;
  }

  applyCorsHeaders(response, origin, config);
  response.statusCode = 204;
  response.end();
}

function parsePositiveInt(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function assertUniqueToolNames(tools: ToolDefinition[]): void {
  const seen = new Set<string>(["health_check", "echo_json"]);

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new ConfigurationError(`Duplicate tool name: ${tool.name}`);
    }

    seen.add(tool.name);
  }
}

async function closeServer(server: McpServer, logger: SharedRuntime["logger"]): Promise<void> {
  try {
    await server.close();
  } catch (error) {
    logger.error({ error: serializeError(error) }, "server_close_failed");
  }
}

async function closeTransport(transport: StreamableHTTPServerTransport, logger: SharedRuntime["logger"]): Promise<void> {
  try {
    await transport.close();
  } catch (error) {
    logger.error({ error: serializeError(error) }, "transport_close_failed");
  }
}

function registerProcessShutdown(logger: SharedRuntime["logger"], shutdown: () => Promise<void>): void {
  let shuttingDown = false;

  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    void (async () => {
      try {
        logger.info({ signal }, "shutdown_started");
        await shutdown();
        process.exit(0);
      } catch (error) {
        logger.error({ error: serializeError(error), signal }, "shutdown_failed");
        process.exit(1);
      }
    })();
  };

  process.once("SIGINT", () => handle("SIGINT"));
  process.once("SIGTERM", () => handle("SIGTERM"));
}
