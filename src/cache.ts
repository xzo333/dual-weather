import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CacheMetricEvent } from "./request-metrics.js";

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const MAX_ENTRIES = 256;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
const counters = { hits: 0, misses: 0, coalesced: 0 };
let generation = 0;
let loadedPersistentPath: string | undefined;
let persistentError: string | undefined;

export async function withWeatherCache<T>(
  key: string | undefined,
  ttlMs: number,
  loader: () => Promise<T>,
  bypass = false,
  onEvent?: (event: CacheMetricEvent) => void,
): Promise<T> {
  if (!key || ttlMs <= 0 || bypass) {
    onEvent?.("bypass");
    return loader();
  }
  ensurePersistentLoaded();

  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    counters.hits += 1;
    onEvent?.("hit");
    return existing.value as T;
  }
  if (existing) cache.delete(key);

  const pending = inflight.get(key);
  if (pending) {
    counters.coalesced += 1;
    onEvent?.("coalesced");
    return pending as Promise<T>;
  }

  counters.misses += 1;
  onEvent?.("miss");
  const requestGeneration = generation;
  const request = loader()
    .then((value) => {
      if (generation !== requestGeneration) return value;
      if (cache.size >= MAX_ENTRIES) evictOldest();
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      persistCache();
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

export function clearWeatherCache(): void {
  ensurePersistentLoaded();
  generation += 1;
  cache.clear();
  inflight.clear();
  counters.hits = 0;
  counters.misses = 0;
  counters.coalesced = 0;
  persistCache();
}

export function weatherCacheStats(): Record<string, number | boolean | string | null> {
  ensurePersistentLoaded();
  pruneExpired();
  return {
    entries: cache.size,
    inflight: inflight.size,
    hits: counters.hits,
    misses: counters.misses,
    coalesced: counters.coalesced,
    maxEntries: MAX_ENTRIES,
    persistentEnabled: Boolean(persistentPath()),
    persistentFile: persistentPath() ? "configured" : null,
    persistentError: persistentError ?? null,
  };
}

function ensurePersistentLoaded(): void {
  const path = persistentPath();
  if (!path || path === loadedPersistentPath) return;
  loadedPersistentPath = path;
  persistentError = undefined;
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size > 5 * 1024 * 1024) {
      persistentError = "缓存文件超过 5MB，已忽略";
      return;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: number;
      entries?: Array<[string, CacheEntry]>;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
    const now = Date.now();
    for (const [key, entry] of parsed.entries.slice(-MAX_ENTRIES)) {
      if (typeof key === "string" && entry?.expiresAt > now) cache.set(key, entry);
    }
  } catch (error) {
    persistentError = error instanceof Error ? error.message : "持久化缓存读取失败";
  }
}

function persistCache(): void {
  const path = persistentPath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries: [...cache] });
    writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    persistentError = undefined;
  } catch (error) {
    persistentError = error instanceof Error ? error.message : "持久化缓存写入失败";
  }
}

function persistentPath(): string | undefined {
  const value = process.env.WEATHER_CACHE_FILE?.trim();
  return value ? resolve(value) : undefined;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

function evictOldest(): void {
  pruneExpired();
  if (cache.size < MAX_ENTRIES) return;
  const oldest = cache.keys().next().value;
  if (typeof oldest === "string") cache.delete(oldest);
}
