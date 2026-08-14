import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type QWeatherAuth =
  | { mode: "api-key"; apiKey: string }
  | {
      mode: "jwt";
      kid: string;
      projectId: string;
      privateKey: string;
      tokenTtlSeconds: number;
    };

export interface QWeatherConfig {
  auth: QWeatherAuth;
  apiHost: string;
  geoHost: string;
  timeoutMs: number;
}

export interface CaiyunConfig {
  key: string;
  timeoutMs: number;
}

export interface WeatherConfig {
  qweather: QWeatherConfig;
  caiyun: CaiyunConfig;
  timeoutMs: number;
}

function requireOneOf(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`缺少环境变量 ${names.join(" 或 ")}，请配置对应凭据后重试。`);
}

function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function readTimeout(): number {
  const raw = process.env.WEATHER_TIMEOUT_MS;
  if (!raw) return 5_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 500 || value > 30_000) {
    throw new Error("WEATHER_TIMEOUT_MS 必须是 500 到 30000 之间的毫秒数。");
  }
  return Math.round(value);
}

export function readQWeatherConfig(): QWeatherConfig {
  const timeoutMs = readTimeout();
  const apiHost =
    optionalEnv("QWEATHER_BASE_URL") ||
    optionalEnv("QWEATHER_API_HOST") ||
    "https://devapi.qweather.com";
  const geoHost = optionalEnv("QWEATHER_GEO_URL") || defaultGeoHost(apiHost);
  const kid = optionalEnv("QWEATHER_KID");
  const projectId = optionalEnv("QWEATHER_PROJECT_ID");
  const privateKeyInput = optionalEnv("QWEATHER_PRIVATE_KEY");
  const jwtValues = [kid, projectId, privateKeyInput];
  const hasAnyJwtValue = jwtValues.some(Boolean);
  const hasAllJwtValues = jwtValues.every(Boolean);

  let auth: QWeatherAuth;
  if (hasAnyJwtValue && !hasAllJwtValues) {
    throw new Error(
      "和风 JWT 配置不完整，必须同时设置 QWEATHER_KID、QWEATHER_PROJECT_ID 和 QWEATHER_PRIVATE_KEY。",
    );
  }
  if (kid && projectId && privateKeyInput) {
    if (/devapi\.qweather\.com|api\.qweather\.com/i.test(apiHost)) {
      throw new Error("和风 JWT 必须配合控制台分配的自定义 QWEATHER_BASE_URL 使用。");
    }
    auth = {
      mode: "jwt",
      kid,
      projectId,
      privateKey: resolvePrivateKey(privateKeyInput),
      tokenTtlSeconds: readJwtTtl(),
    };
  } else {
    auth = { mode: "api-key", apiKey: requireOneOf(["QWEATHER_API_KEY", "HEFENG_KEY"]) };
  }

  return { auth, apiHost, geoHost, timeoutMs };
}

export function readCaiyunConfig(): CaiyunConfig {
  return {
    key: requireOneOf(["CAIYUN_WEATHER_API_TOKEN", "CAIYUN_KEY"]),
    timeoutMs: readTimeout(),
  };
}

export function readWeatherConfig(): WeatherConfig {
  const qweather = readQWeatherConfig();
  const caiyun = readCaiyunConfig();
  return { qweather, caiyun, timeoutMs: qweather.timeoutMs };
}

export function readAmapKey(): string {
  return requireOneOf(["AMAP_KEY"]);
}

function resolvePrivateKey(input: string): string {
  const normalized = input.replace(/\\n/g, "\n");
  if (normalized.includes("-----BEGIN")) return normalized;
  const path = normalized.startsWith("~/") || normalized.startsWith("~\\")
    ? resolve(homedir(), normalized.slice(2))
    : resolve(normalized);
  if (!existsSync(path)) {
    throw new Error(`QWEATHER_PRIVATE_KEY 文件不存在：${path}`);
  }
  return readFileSync(path, "utf8");
}

function readJwtTtl(): number {
  const raw = optionalEnv("QWEATHER_JWT_TTL_SECONDS");
  if (!raw) return 900;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 1_800) {
    throw new Error("QWEATHER_JWT_TTL_SECONDS 必须是 60 到 1800 之间的整数。");
  }
  return value;
}

function defaultGeoHost(apiHost: string): string {
  if (/devapi\.qweather\.com|api\.qweather\.com/i.test(apiHost)) {
    return "https://geoapi.qweather.com/v2";
  }
  const normalized = /^https?:\/\//i.test(apiHost) ? apiHost : `https://${apiHost}`;
  const url = new URL(normalized);
  url.pathname = `${url.pathname.replace(/\/(?:v7)?\/*$/, "")}/geo/v2`.replace(/\/{2,}/g, "/");
  return url.toString().replace(/\/$/, "");
}
