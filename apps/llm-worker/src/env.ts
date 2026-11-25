import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function applyEnvFile(file: string): void {
  if (!existsSync(file)) {
    return;
  }
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (key.length > 0 && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnvFile(): void {
  const files = [...new Set([resolve(process.cwd(), ".env"), resolve(process.cwd(), "apps/llm-worker/.env")])];
  for (const file of files) {
    applyEnvFile(file);
  }
}
