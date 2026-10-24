import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "./paths";

export const MAX_RECENT_MODELS = 8;

export function getRecentModelsPath(): string {
  return join(getAgentDir(), "recent-models.json");
}

export function parseRecentModelKeys(raw: unknown): string[] {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === "string" && k.includes(":") && k.trim().length > 2);
}

export function pushRecentModelKey(existing: string[], newKey: string, max = MAX_RECENT_MODELS): string[] {
  if (!newKey || !newKey.includes(":")) return existing;
  const filtered = existing.filter((k) => k !== newKey);
  return [newKey, ...filtered].slice(0, max);
}

export function readRecentModels(): string[] {
  const p = getRecentModelsPath();
  if (!existsSync(p)) {
    return [];
  }
  try {
    const raw = readFileSync(p, "utf8");
    return parseRecentModelKeys(raw);
  } catch {
    return [];
  }
}

export function writeRecentModels(keys: string[]): void {
  const p = getRecentModelsPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(keys, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to write recent models:", e);
  }
}

export function recordRecentModel(provider: string, modelId: string): string[] {
  if (!provider || !modelId) return readRecentModels();
  const key = `${provider}:${modelId}`;
  const existing = readRecentModels();
  const next = pushRecentModelKey(existing, key);
  writeRecentModels(next);
  return next;
}
