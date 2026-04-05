import { RateLimitError } from "./errors.js";
import type { RateLimitOverrides, RateLimitPolicy } from "./types.js";

interface RateLimitState {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision extends RateLimitPolicy {
  remaining: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private readonly entries = new Map<string, RateLimitState>();

  public constructor(private readonly defaults: RateLimitPolicy) {}

  public check(clientId: string, toolName: string, overrides?: RateLimitOverrides): RateLimitDecision {
    const now = Date.now();
    const policy = {
      maxRequests: overrides?.maxRequests ?? this.defaults.maxRequests,
      windowMs: overrides?.windowMs ?? this.defaults.windowMs
    };
    const key = `${clientId}:${toolName}`;
    const current = this.entries.get(key);

    if (current === undefined || current.resetAt <= now) {
      const resetAt = now + policy.windowMs;

      this.entries.set(key, {
        count: 1,
        resetAt
      });

      this.compact(now);

      return {
        ...policy,
        remaining: Math.max(policy.maxRequests - 1, 0),
        resetAt
      };
    }

    if (current.count >= policy.maxRequests) {
      throw new RateLimitError(`Rate limit exceeded for ${toolName}`, {
        clientId,
        resetAt: current.resetAt,
        toolName,
        windowMs: policy.windowMs
      });
    }

    current.count += 1;
    this.entries.set(key, current);

    return {
      ...policy,
      remaining: Math.max(policy.maxRequests - current.count, 0),
      resetAt: current.resetAt
    };
  }

  private compact(now: number): void {
    for (const [key, value] of this.entries.entries()) {
      if (value.resetAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export function loadRateLimitPolicy(env: NodeJS.ProcessEnv = process.env): RateLimitPolicy {
  return {
    maxRequests: parsePositiveInt(env.MCP_RATE_LIMIT_MAX_REQUESTS, 60),
    windowMs: parsePositiveInt(env.MCP_RATE_LIMIT_WINDOW_MS, 60_000)
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
