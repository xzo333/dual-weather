import { createPrivateKey, sign } from "node:crypto";

import type { QWeatherAuth } from "./config.js";
import { fetchJson, UpstreamError } from "./http.js";
import { finiteNumber, humidityPercent, probabilityPercent, round } from "./normalize.js";
import type { QWeatherData } from "./types.js";

export interface QWeatherResponse {
  code?: string;
  now?: Record<string, unknown>;
  hourly?: Array<Record<string, unknown>>;
  warning?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface QWeatherBaseOptions {
  auth: QWeatherAuth;
  apiHost: string;
  timeoutMs: number;
  bypassCache?: boolean;
  bypassCircuit?: boolean;
}

export interface QWeatherOptions extends QWeatherBaseOptions {
  lng: number;
  lat: number;
}

export interface QWeatherGeoOptions {
  auth: QWeatherAuth;
  geoHost: string;
  timeoutMs: number;
}

const jwtCache = new WeakMap<object, { token: string; expiresAt: number }>();

export async function fetchQWeather(options: QWeatherOptions): Promise<QWeatherData> {
  const requests = await Promise.allSettled([
    request(options, "weather/now", "和风实时天气"),
    request(options, "weather/24h", "和风逐小时天气"),
    request(options, "warning/now", "和风天气预警"),
  ]);

  const nowResponse = settledValue(requests[0], true);
  const hourlyResponse = settledValue(requests[1], false);
  const warningResponse = settledValue(requests[2], false);
  const now = nowResponse?.now ?? {};

  return {
    realtime: {
      temperature: round(finiteNumber(now.temp)),
      feelsLike: round(finiteNumber(now.feelsLike)),
      text: stringValue(now.text),
      humidity: humidityPercent(now.humidity, false),
      windDir: stringValue(now.windDir),
      windScale: stringValue(now.windScale),
      precipitation: round(finiteNumber(now.precip), 2),
    },
    hourly: (hourlyResponse?.hourly ?? []).slice(0, 12).map((item) => ({
      time: stringValue(item.fxTime),
      temperature: round(finiteNumber(item.temp)),
      text: stringValue(item.text),
      precipitationProbability: probabilityPercent(item.pop),
      precipitation: round(finiteNumber(item.precip), 2),
    })),
    warning: (warningResponse?.warning ?? [])
      .map((item) => stringValue(item.title || item.text))
      .filter(Boolean)
      .slice(0, 3),
  };
}

async function request(
  options: QWeatherOptions,
  endpoint: string,
  label: string,
): Promise<QWeatherResponse> {
  return fetchQWeatherRaw(options, endpoint, label);
}

export async function fetchQWeatherRaw(
  options: QWeatherOptions,
  endpoint: string,
  label: string,
  searchParams: Record<string, string> = {},
): Promise<QWeatherResponse> {
  return fetchQWeatherV7Raw(options, endpoint, label, {
    location: `${options.lng},${options.lat}`,
    ...searchParams,
  });
}

export async function fetchQWeatherV7Raw(
  options: QWeatherBaseOptions,
  endpoint: string,
  label: string,
  searchParams: Record<string, string> = {},
): Promise<QWeatherResponse> {
  const url = qweatherV7Url(options.apiHost, endpoint);
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value);
  const data = await fetchJson<QWeatherResponse>(label, url, options.timeoutMs, {
    headers: createQWeatherAuthHeaders(options.auth),
  }, {
    cacheKey: `qweather:${url.host}${url.pathname}?${url.searchParams.toString()}`,
    cacheTtlMs: qweatherCacheTtl(endpoint),
    bypassCache: cacheDisabled(options),
    retries: 1,
    circuitKey: "qweather",
    validate: validateQWeatherResponse(label),
    ...(options.bypassCircuit === undefined ? {} : { bypassCircuit: options.bypassCircuit }),
  });
  return data;
}

export async function fetchQWeatherAirCurrent(
  options: QWeatherOptions,
): Promise<QWeatherResponse> {
  if (usesPublicLegacyHost(options.apiHost) && options.auth.mode === "api-key") {
    return fetchQWeatherRaw(options, "air/now", "和风实时空气质量");
  }
  return fetchQWeatherV1Raw(
    options,
    `airquality/v1/current/${options.lat.toFixed(2)}/${options.lng.toFixed(2)}`,
    "和风实时空气质量",
  );
}

export async function fetchQWeatherAirForecast(
  options: QWeatherOptions,
  period: "hourly" | "daily",
  amount: number,
): Promise<QWeatherResponse> {
  if (usesPublicLegacyHost(options.apiHost) && options.auth.mode === "api-key") {
    const endpoint = period === "hourly"
      ? `air/${amount <= 24 ? 24 : 72}h`
      : `air/${amount <= 1 ? 1 : amount <= 3 ? 3 : 5}d`;
    return fetchQWeatherRaw(options, endpoint, `和风空气质量${period === "hourly" ? "小时" : "每日"}预报`);
  }
  return fetchQWeatherV1Raw(
    options,
    `airquality/v1/${period}/${options.lat.toFixed(2)}/${options.lng.toFixed(2)}`,
    `和风空气质量${period === "hourly" ? "小时" : "每日"}预报`,
  );
}

export async function fetchQWeatherSolarRadiation(
  options: QWeatherOptions,
  searchParams: Record<string, string>,
): Promise<QWeatherResponse> {
  if (usesPublicLegacyHost(options.apiHost)) {
    throw new Error(
      "和风专业太阳辐射 API 需要控制台分配的自定义 QWEATHER_BASE_URL，公共 devapi/api Host 不支持该 v1 接口。",
    );
  }
  return fetchQWeatherV1Raw(
    options,
    `solarradiation/v1/forecast/${options.lat.toFixed(2)}/${options.lng.toFixed(2)}`,
    "和风专业太阳辐射预报",
    searchParams,
  );
}

export async function fetchQWeatherGeoLookup(
  options: QWeatherGeoOptions,
  location: string,
  searchParams: Record<string, string> = {},
): Promise<QWeatherResponse> {
  return fetchQWeatherGeoRaw(options, "city/lookup", {
    location,
    ...searchParams,
  });
}

export async function fetchQWeatherGeoRaw(
  options: QWeatherGeoOptions,
  endpoint: string,
  searchParams: Record<string, string> = {},
): Promise<QWeatherResponse> {
  const url = qweatherGeoUrl(options.geoHost, endpoint);
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value);
  const data = await fetchJson<QWeatherResponse>("和风 GeoAPI", url, options.timeoutMs, {
    headers: createQWeatherAuthHeaders(options.auth),
  }, {
    retries: 1,
    circuitKey: "qweather",
    validate: validateQWeatherResponse("和风 GeoAPI"),
  });
  return data;
}

export async function fetchQWeatherV1Raw(
  options: QWeatherBaseOptions,
  endpoint: string,
  label: string,
  searchParams: Record<string, string> = {},
): Promise<QWeatherResponse> {
  const url = qweatherRootUrl(options.apiHost);
  url.pathname = `/${endpoint}`.replace(/\/{2,}/g, "/");
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value);
  return fetchJson<QWeatherResponse>(label, url, options.timeoutMs, {
    headers: createQWeatherAuthHeaders(options.auth),
  }, {
    cacheKey: `qweather:${url.host}${url.pathname}?${url.searchParams.toString()}`,
    cacheTtlMs: qweatherCacheTtl(endpoint),
    bypassCache: cacheDisabled(options),
    retries: 1,
    circuitKey: "qweather",
    validate: validateQWeatherResponse(label),
    ...(options.bypassCircuit === undefined ? {} : { bypassCircuit: options.bypassCircuit }),
  });
}

function validateQWeatherResponse(label: string): (data: unknown) => void {
  return (data) => {
    const code = (data as QWeatherResponse | undefined)?.code;
    if (code === undefined || code === "200") return;
    const circuitFailure = code === "401" || code === "402" || code === "403" || code === "429" || code === "500";
    throw new UpstreamError(label, `接口状态码 ${code}`, circuitFailure);
  };
}

export function createQWeatherAuthHeaders(auth: QWeatherAuth): Record<string, string> {
  if (auth.mode === "api-key") return { "X-QW-Api-Key": auth.apiKey };
  const now = Math.floor(Date.now() / 1_000);
  const cached = jwtCache.get(auth);
  if (cached && cached.expiresAt - 30 > now) {
    return { Authorization: `Bearer ${cached.token}` };
  }
  const issuedAt = now - 30;
  const expiresAt = issuedAt + auth.tokenTtlSeconds;
  const header = base64Url(JSON.stringify({ alg: "EdDSA", kid: auth.kid }));
  const payload = base64Url(
    JSON.stringify({ sub: auth.projectId, iat: issuedAt, exp: expiresAt }),
  );
  const signingInput = `${header}.${payload}`;
  let signature: Buffer;
  try {
    signature = sign(null, Buffer.from(signingInput), createPrivateKey(auth.privateKey));
  } catch {
    throw new Error("无法使用 QWEATHER_PRIVATE_KEY 生成 Ed25519 JWT，请检查私钥格式。");
  }
  const token = `${signingInput}.${signature.toString("base64url")}`;
  jwtCache.set(auth, { token, expiresAt });
  return { Authorization: `Bearer ${token}` };
}

function qweatherV7Url(host: string, endpoint: string): URL {
  const url = qweatherRootUrl(host);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path.endsWith("/v7") ? path : `${path}/v7`}/${endpoint}`.replace(
    /\/{2,}/g,
    "/",
  );
  return url;
}

function qweatherGeoUrl(host: string, endpoint: string): URL {
  const normalized = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  const url = new URL(normalized);
  let path = url.pathname.replace(/\/+$/, "");
  if (!/(?:\/geo)?\/v2$/i.test(path)) path = `${path}/geo/v2`;
  url.pathname = `${path}/${endpoint}`.replace(/\/{2,}/g, "/");
  return url;
}

function qweatherRootUrl(host: string): URL {
  const normalized = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  const url = new URL(normalized);
  if (url.pathname.endsWith("/v7")) url.pathname = url.pathname.slice(0, -3) || "/";
  return url;
}

export function usesPublicLegacyHost(host: string): boolean {
  return /(^|\.)((dev)?api\.qweather\.com)$/i.test(qweatherRootUrl(host).hostname);
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function settledValue(
  result: PromiseSettledResult<QWeatherResponse> | undefined,
  required: boolean,
): QWeatherResponse | undefined {
  if (result?.status === "fulfilled") return result.value;
  if (required) throw result?.reason ?? new Error("和风实时天气请求失败");
  return undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cacheDisabled(options: QWeatherBaseOptions): boolean {
  return options.bypassCache === true || process.env.WEATHER_CACHE_DISABLED === "1";
}

function qweatherCacheTtl(endpoint: string): number {
  const minute = 60_000;
  if (endpoint.includes("historical/")) return 24 * 60 * minute;
  if (endpoint.includes("metrics/v1/") || endpoint.includes("finance/v1/")) return 0;
  if (endpoint.includes("warning/")) return 5 * minute;
  if (endpoint.includes("minutely/")) return 5 * minute;
  if (endpoint.includes("weather/now") || endpoint.includes("grid-weather/now")) {
    return 10 * minute;
  }
  if (/weather\/(?:24|72|168)h/.test(endpoint) || /grid-weather\/(?:24|72)h/.test(endpoint)) {
    return 30 * minute;
  }
  if (/weather\/\d+d/.test(endpoint) || /grid-weather\/\d+d/.test(endpoint)) return 60 * minute;
  if (endpoint.includes("indices/")) return 6 * 60 * minute;
  if (endpoint.includes("airquality/v1/daily/")) return 8 * 60 * minute;
  if (endpoint.includes("airquality/v1/")) return 30 * minute;
  if (endpoint.includes("ocean/tide")) return 8 * 60 * minute;
  if (endpoint.includes("tropical/")) return 20 * minute;
  if (endpoint.includes("solarradiation/")) return 6 * 60 * minute;
  if (endpoint.includes("astronomy/")) return 12 * 60 * minute;
  return 15 * minute;
}
