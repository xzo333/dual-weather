import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clearWeatherCache, weatherCacheStats, withWeatherCache } from "../src/cache.js";

test("persists cached provider payloads only when WEATHER_CACHE_FILE is configured", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dual-weather-cache-"));
  const cacheFile = join(directory, "cache.json");
  const previous = process.env.WEATHER_CACHE_FILE;
  process.env.WEATHER_CACHE_FILE = cacheFile;

  try {
    clearWeatherCache();
    const value = await withWeatherCache("provider:test", 60_000, async () => ({ ok: true }));
    assert.deepEqual(value, { ok: true });
    assert.equal(existsSync(cacheFile), true);
    const persisted = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.entries[0][0], "provider:test");
    assert.equal(weatherCacheStats().persistentEnabled, true);
    assert.equal(weatherCacheStats().persistentFile, "configured");
  } finally {
    clearWeatherCache();
    if (previous === undefined) delete process.env.WEATHER_CACHE_FILE;
    else process.env.WEATHER_CACHE_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
