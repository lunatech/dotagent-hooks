import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OutputPolicyConfig {
  maxChars: number;
  maxRepeats: number;
  minBlockChars: number;
  minRepeatedChars: number;
}

export const DEFAULT_OUTPUT_POLICY: OutputPolicyConfig = {
  maxChars: 96_000,
  maxRepeats: 24,
  minBlockChars: 32,
  minRepeatedChars: 1_536,
};

function configPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "output-policy");
}

export function parseOutputPolicyConfig(contents: string): OutputPolicyConfig {
  const config = { ...DEFAULT_OUTPUT_POLICY };
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim() as keyof OutputPolicyConfig;
    const rawValue = line.slice(separator + 1).trim();
    if (!(key in config) || !/^\d+$/.test(rawValue)) continue;
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value)) continue;
    config[key] = value;
  }
  config.maxChars = Math.max(0, config.maxChars);
  config.maxRepeats = Math.max(2, config.maxRepeats);
  config.minBlockChars = Math.max(8, config.minBlockChars);
  config.minRepeatedChars = Math.max(64, config.minRepeatedChars);
  return config;
}

export function readOutputPolicyConfig(): OutputPolicyConfig {
  const path = configPath();
  return existsSync(path) ? parseOutputPolicyConfig(readFileSync(path, "utf8")) : { ...DEFAULT_OUTPUT_POLICY };
}
