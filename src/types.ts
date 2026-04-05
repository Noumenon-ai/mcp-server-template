import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonArray = JsonValue[];
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type TransportMode = "http" | "stdio";

export interface RateLimitPolicy {
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitOverrides {
  maxRequests?: number;
  windowMs?: number;
}

export interface ServerMetadata {
  defaultPort: number;
  description: string;
  name: string;
  title?: string;
  version: string;
}

export interface RequestContext {
  clientId: string;
  logger: Logger;
  requestId: string;
  server: McpServer;
  sessionId?: string;
  transport: TransportMode;
}

export interface ResourceDefinition {
  description: string;
  mimeType?: string;
  name: string;
  read: (uri: URL, params: Record<string, string>) => Promise<ReadResourceResult>;
  template: ResourceTemplate | string;
  title: string;
}

export interface ToolDefinition {
  description: string;
  execute: (input: Record<string, unknown>, context: RequestContext) => Promise<CallToolResult>;
  inputSchema: z.ZodRawShape;
  name: string;
  rateLimit?: RateLimitOverrides;
  title: string;
}

export interface ToolConfig<InputSchema extends z.ZodRawShape> {
  description: string;
  execute: (input: z.output<z.ZodObject<InputSchema>>, context: RequestContext) => Promise<CallToolResult>;
  inputSchema: InputSchema;
  name: string;
  rateLimit?: RateLimitOverrides;
  title: string;
}

export interface ServerDefinition {
  metadata: ServerMetadata;
  resources?: ResourceDefinition[];
  tools: ToolDefinition[];
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(
  () =>
    z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(jsonValueSchema),
      z.record(z.string(), jsonValueSchema)
    ])
) as z.ZodType<JsonValue>;

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export function createJsonText(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

export function createTextResult(text: string, structuredContent?: JsonObject): CallToolResult {
  const result: CallToolResult = {
    content: [
      {
        text,
        type: "text"
      }
    ]
  };

  if (structuredContent !== undefined) {
    result.structuredContent = structuredContent;
  }

  return result;
}

export function createJsonResult(structuredContent: JsonObject): CallToolResult {
  return createTextResult(createJsonText(structuredContent), structuredContent);
}

export function defineTool<InputSchema extends z.ZodRawShape>(definition: ToolConfig<InputSchema>): ToolDefinition {
  const normalized: ToolDefinition = {
    description: definition.description,
    execute: definition.execute as ToolDefinition["execute"],
    inputSchema: definition.inputSchema,
    name: definition.name,
    title: definition.title
  };

  if (definition.rateLimit !== undefined) {
    normalized.rateLimit = definition.rateLimit;
  }

  return normalized;
}

export function normalizeJsonValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }

  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }

  if (typeof value === "object") {
    const normalized: JsonObject = {};

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) {
        continue;
      }

      normalized[key] = normalizeJsonValue(entry);
    }

    return normalized;
  }

  return String(value);
}

export function normalizeJsonObject(value: unknown): JsonObject {
  const normalized = normalizeJsonValue(value);

  if (typeof normalized === "object" && normalized !== null && !Array.isArray(normalized)) {
    return normalized;
  }

  return {
    value: normalized
  };
}
