import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { AuthError } from "./errors.js";

export interface AuthConfig {
  apiKey?: string;
  bearerToken?: string;
  enabled: boolean;
}

export interface AuthResult {
  clientId: string;
  method: "anonymous" | "api-key" | "bearer";
  principal: string;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const apiKey = normalizeSecret(env.MCP_API_KEY);
  const bearerToken = normalizeSecret(env.MCP_BEARER_TOKEN);
  const config: AuthConfig = {
    enabled: Boolean(apiKey || bearerToken)
  };

  if (apiKey !== undefined) {
    config.apiKey = apiKey;
  }

  if (bearerToken !== undefined) {
    config.bearerToken = bearerToken;
  }

  return config;
}

export function authenticateHttpRequest(
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined,
  config: AuthConfig
): AuthResult {
  if (!config.enabled) {
    const anonymousIp = getRequestIp(headers, remoteAddress);
    return {
      clientId: `anonymous:${anonymousIp}`,
      method: "anonymous",
      principal: "anonymous"
    };
  }

  const apiKeyHeader = getHeader(headers, "x-api-key");
  if (config.apiKey !== undefined && apiKeyHeader === config.apiKey) {
    return {
      clientId: `api-key:${fingerprint(config.apiKey)}`,
      method: "api-key",
      principal: "api-key"
    };
  }

  const authorizationHeader = getHeader(headers, "authorization");
  if (config.bearerToken !== undefined && authorizationHeader === `Bearer ${config.bearerToken}`) {
    return {
      clientId: `bearer:${fingerprint(config.bearerToken)}`,
      method: "bearer",
      principal: "bearer"
    };
  }

  throw new AuthError("Missing or invalid credentials", {
    acceptedHeaders: "authorization,x-api-key",
    remoteAddress: getRequestIp(headers, remoteAddress)
  });
}

export function getRequestIp(headers: IncomingHttpHeaders, remoteAddress: string | undefined): string {
  const forwarded = getHeader(headers, "x-forwarded-for");
  if (forwarded !== undefined) {
    const [ip] = forwarded.split(",");
    if (ip !== undefined && ip.trim().length > 0) {
      return ip.trim();
    }
  }

  return remoteAddress ?? "unknown";
}

export function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  const normalized = Array.isArray(value) ? value[0] : value;

  if (typeof normalized !== "string") {
    return undefined;
  }

  const trimmed = normalized.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

function normalizeSecret(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
