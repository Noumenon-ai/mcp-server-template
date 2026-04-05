import { ZodError } from "zod";

import type { JsonObject } from "./types.js";

interface AppErrorOptions {
  code: string;
  details?: JsonObject;
  expose?: boolean;
  statusCode: number;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly details?: JsonObject;
  public readonly expose: boolean;
  public readonly statusCode: number;

  public constructor(message: string, options: AppErrorOptions) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.expose = options.expose ?? true;
    this.statusCode = options.statusCode;

    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export class AuthError extends AppError {
  public constructor(message = "Unauthorized", details?: JsonObject) {
    const options: AppErrorOptions = {
      code: "AUTHENTICATION_ERROR",
      statusCode: 401
    };

    if (details !== undefined) {
      options.details = details;
    }

    super(message, options);
  }
}

export class ConfigurationError extends AppError {
  public constructor(message: string, details?: JsonObject) {
    const options: AppErrorOptions = {
      code: "CONFIGURATION_ERROR",
      statusCode: 500
    };

    if (details !== undefined) {
      options.details = details;
    }

    super(message, options);
  }
}

export class ExternalApiError extends AppError {
  public constructor(message: string, details?: JsonObject, statusCode = 502) {
    const options: AppErrorOptions = {
      code: "EXTERNAL_API_ERROR",
      statusCode
    };

    if (details !== undefined) {
      options.details = details;
    }

    super(message, options);
  }
}

export class NotFoundError extends AppError {
  public constructor(message: string, details?: JsonObject) {
    const options: AppErrorOptions = {
      code: "NOT_FOUND_ERROR",
      statusCode: 404
    };

    if (details !== undefined) {
      options.details = details;
    }

    super(message, options);
  }
}

export class RateLimitError extends AppError {
  public constructor(message: string, details?: JsonObject) {
    const options: AppErrorOptions = {
      code: "RATE_LIMIT_ERROR",
      statusCode: 429
    };

    if (details !== undefined) {
      options.details = details;
    }

    super(message, options);
  }
}

export class SandboxError extends AppError {
  public constructor(message: string, details?: JsonObject) {
    const options: AppErrorOptions = {
      code: "SANDBOX_ERROR",
      statusCode: 403
    };

    if (details !== undefined) {
      options.details = details;
    }

    super(message, options);
  }
}

export class ValidationError extends AppError {
  public constructor(message: string, details?: JsonObject) {
    const options: AppErrorOptions = {
      code: "VALIDATION_ERROR",
      statusCode: 400
    };

    if (details !== undefined) {
      options.details = details;
    }

    super(message, options);
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof ZodError) {
    return new ValidationError("Validation failed", {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.join(".")
      }))
    });
  }

  if (error instanceof Error) {
    return new AppError(error.message, {
      code: "INTERNAL_ERROR",
      details: {
        name: error.name
      },
      expose: false,
      statusCode: 500
    });
  }

  return new AppError("Unknown error", {
    code: "INTERNAL_ERROR",
    expose: false,
    statusCode: 500
  });
}

export function serializeError(error: unknown): JsonObject {
  const normalized = normalizeError(error);

  return {
    code: normalized.code,
    details: normalized.details ?? null,
    message: normalized.message,
    name: normalized.name,
    statusCode: normalized.statusCode
  };
}

export function toToolErrorResult(error: unknown) {
  const normalized = normalizeError(error);
  const message = normalized.expose ? normalized.message : "Internal server error";

  return {
    content: [
      {
        text: `${normalized.code}: ${message}`,
        type: "text" as const
      }
    ],
    isError: true,
    structuredContent: {
      code: normalized.code,
      error: serializeError(normalized)
    }
  };
}
