import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnvFile } from "dotenv";

export function loadPackageEnv(importMetaUrl: string): void {
  const entryPath = fileURLToPath(importMetaUrl);
  const packageDir = resolve(dirname(entryPath), "..");
  const envPath = resolve(packageDir, ".env");
  const envLocalPath = resolve(packageDir, ".env.local");

  if (existsSync(envPath)) {
    loadEnvFile({
      path: envPath
    });
  }

  if (existsSync(envLocalPath)) {
    loadEnvFile({
      override: true,
      path: envLocalPath
    });
  }
}
