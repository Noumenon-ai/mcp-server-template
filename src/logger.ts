import pino, { type Logger } from "pino";

export interface RequestLogBindings {
  clientId: string;
  requestId: string;
  sessionId?: string;
  toolName?: string;
  transport: string;
}

export function createLogger(serverName: string): Logger {
  return pino({
    base: {
      server: serverName
    },
    formatters: {
      level(label) {
        return {
          level: label
        };
      }
    },
    level: process.env.LOG_LEVEL ?? "info",
    messageKey: "message",
    redact: {
      paths: [
        "authorization",
        "headers.authorization",
        "headers.x-api-key",
        "req.headers.authorization",
        "req.headers.x-api-key"
      ],
      remove: true
    },
    serializers: {
      err: pino.stdSerializers.err
    },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}

export function createRequestLogger(logger: Logger, bindings: RequestLogBindings): Logger {
  return logger.child(bindings);
}
