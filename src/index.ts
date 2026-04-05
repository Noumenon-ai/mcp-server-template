import { pathToFileURL } from "node:url";

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadPackageEnv } from "./env.js";
import { startServer } from "./server.js";
import type { ServerDefinition } from "./types.js";

export * from "./auth.js";
export * from "./env.js";
export * from "./errors.js";
export * from "./logger.js";
export * from "./rate-limit.js";
export * from "./server.js";
export * from "./types.js";

export const templateServerDefinition: ServerDefinition = {
  metadata: {
    defaultPort: 8787,
    description: "Reusable MCP template with auth, rate limiting, logging, resources, and HTTP or stdio transports.",
    name: "mcp-template",
    title: "MCP Template Server",
    version: "1.0.0"
  },
  resources: [
    {
      description: "Overview of the starter template's built-in features.",
      mimeType: "text/markdown",
      name: "starter-overview",
      read: async (uri) => ({
        contents: [
          {
            mimeType: "text/markdown",
            text: [
              "# MCP Template Overview",
              "",
              "This template ships with:",
              "- Streamable HTTP and stdio transports",
              "- API key and bearer-token auth for HTTP requests",
              "- Fixed-window in-memory rate limiting",
              "- Structured JSON logging via pino",
              "- Automatic package-local .env loading",
              "- Base health_check and echo_json tools"
            ].join("\n"),
            uri: uri.href
          }
        ]
      }),
      template: new ResourceTemplate("kit://overview", { list: undefined }),
      title: "Starter Overview"
    }
  ],
  tools: []
};

async function main(): Promise<void> {
  loadPackageEnv(import.meta.url);
  await startServer(templateServerDefinition);
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
