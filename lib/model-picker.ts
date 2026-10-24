/**
 * Pure model-picker logic shared by the desktop dropdown and the mobile sheet.
 * Extracted from ChatInput so the filter/group contract is unit-testable
 * without rendering React.
 */

export interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

export interface ModelProviderGroup {
  provider: string;
  options: ModelOption[];
}

/**
 * Case-insensitive substring filter across display name, model id and
 * provider. Empty/whitespace queries return the input unchanged (same array
 * reference) so callers can skip re-render work.
 */
export function filterModelOptions(options: ModelOption[], query: string, locale: string): ModelOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  if (!normalizedQuery) return options;
  return options.filter((option) => {
    const haystack = `${option.name} ${option.modelId} ${option.provider}`.toLocaleLowerCase(locale);
    return haystack.includes(normalizedQuery);
  });
}

/**
 * Group filtered options by provider, preserving first-seen insertion order
 * of providers and the caller's option order within each group.
 */
export function groupModelOptions(options: ModelOption[]): ModelProviderGroup[] {
  const groups: ModelProviderGroup[] = [];
  const indexByProvider = new Map<string, number>();
  for (const option of options) {
    const existing = indexByProvider.get(option.provider);
    if (existing !== undefined) {
      groups[existing].options.push(option);
    } else {
      indexByProvider.set(option.provider, groups.length);
      groups.push({ provider: option.provider, options: [option] });
    }
  }
  return groups;
}

export const RECENT_MODELS_STORAGE_KEY = "omp-recent-models";
export const MAX_RECENT_MODELS = 6;

/**
 * Parses stored recent model keys (`${provider}:${modelId}`).
 */
export function parseRecentModelKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.includes(":"));
    }
  } catch {
    // ignore corrupted json
  }
  return [];
}

/**
 * Updates an array of recent keys: moves key to front, deduplicates, limits to max.
 */
export function pushRecentModelKey(existing: string[], newKey: string, max = MAX_RECENT_MODELS): string[] {
  if (!newKey || !newKey.includes(":")) return existing;
  const filtered = existing.filter((k) => k !== newKey);
  return [newKey, ...filtered].slice(0, max);
}
let cachedRecentKeys: string[] | null = null;
const RECENT_CHANGE_EVENT = "omp-recent-models-change";

export function getCachedRecentModelKeys(): string[] {
  return cachedRecentKeys ?? [];
}

export function setCachedRecentModelKeys(keys: string[]): void {
  cachedRecentKeys = keys;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(RECENT_CHANGE_EVENT, { detail: keys }));
  }
}

export function subscribeRecentModelKeys(callback: (keys: string[]) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const keys = (e as CustomEvent<string[]>).detail;
    if (Array.isArray(keys)) callback(keys);
  };
  window.addEventListener(RECENT_CHANGE_EVENT, handler);
  return () => window.removeEventListener(RECENT_CHANGE_EVENT, handler);
}

export async function fetchServerRecentModelKeys(): Promise<string[]> {
  if (typeof window === "undefined") return [];
  try {
    const res = await fetch("/api/models/recent", { cache: "no-store" });
    if (!res.ok) return cachedRecentKeys ?? [];
    const data = (await res.json()) as { recentKeys?: unknown };
    const raw = Array.isArray(data.recentKeys) ? JSON.stringify(data.recentKeys) : null;
    const keys = parseRecentModelKeys(raw);
    setCachedRecentModelKeys(keys);
    return keys;
  } catch {
    return cachedRecentKeys ?? [];
  }
}

export function readStoredRecentModelKeys(): string[] {
  return cachedRecentKeys ?? [];
}

export function storeRecentModelKey(provider: string, modelId: string): string[] {
  const key = `${provider}:${modelId}`;
  const existing = cachedRecentKeys ?? [];
  const next = pushRecentModelKey(existing, key);
  setCachedRecentModelKeys(next);

  if (typeof window !== "undefined") {
    void fetch("/api/models/recent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, modelId }),
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ recentKeys?: unknown }>) : null))
      .then((data) => {
        if (data && Array.isArray(data.recentKeys)) {
          const raw = JSON.stringify(data.recentKeys);
          const synced = parseRecentModelKeys(raw);
          setCachedRecentModelKeys(synced);
        }
      })
      .catch(() => {});
  }

  return next;
}
