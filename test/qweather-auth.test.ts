import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test, { afterEach } from "node:test";

import { readQWeatherConfig } from "../src/config.js";
import { createQWeatherAuthHeaders } from "../src/qweather.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

test("accepts the documented QWEATHER_API_KEY name", () => {
  clearQWeatherEnv();
  process.env.QWEATHER_API_KEY = "documented-key";
  const config = readQWeatherConfig();
  assert.deepEqual(config.auth, { mode: "api-key", apiKey: "documented-key" });
});

test("derives GeoAPI path from a custom QWeather API host", () => {
  clearQWeatherEnv();
  process.env.QWEATHER_API_KEY = "documented-key";
  process.env.QWEATHER_BASE_URL = "https://weather.example.com/v7";
  const config = readQWeatherConfig();
  assert.equal(config.geoHost, "https://weather.example.com/geo/v2");
});

test("rejects partial JWT configuration", () => {
  clearQWeatherEnv();
  process.env.QWEATHER_KID = "kid-only";
  assert.throws(() => readQWeatherConfig(), /JWT 配置不完整/);
});

test("creates a verifiable Ed25519 QWeather JWT", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const headers = createQWeatherAuthHeaders({
    mode: "jwt",
    kid: "test-kid",
    projectId: "test-project",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    tokenTtlSeconds: 900,
  });
  const token = headers.Authorization?.replace(/^Bearer /, "") ?? "";
  const [header, payload, signature] = token.split(".");
  assert.equal(JSON.parse(Buffer.from(header!, "base64url").toString()).alg, "EdDSA");
  assert.equal(JSON.parse(Buffer.from(payload!, "base64url").toString()).sub, "test-project");
  assert.equal(
    verify(
      null,
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature!, "base64url"),
    ),
    true,
  );
});

function clearQWeatherEnv(): void {
  for (const name of [
    "QWEATHER_API_KEY",
    "HEFENG_KEY",
    "QWEATHER_KID",
    "QWEATHER_PROJECT_ID",
    "QWEATHER_PRIVATE_KEY",
    "QWEATHER_BASE_URL",
    "QWEATHER_API_HOST",
  ]) {
    delete process.env[name];
  }
}
