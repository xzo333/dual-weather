import { fetchJson, UpstreamError } from "./http.js";
import {
  finiteNumber,
  humidityPercent,
  probabilityPercent,
  round,
  skyconChinese,
} from "./normalize.js";
import type { CaiyunData } from "./types.js";

export interface CaiyunResponse {
  status?: string;
  error?: string;
  result?: Record<string, any>;
}

export interface CaiyunOptions {
  key: string;
  timeoutMs: number;
  lng: number;
  lat: number;
  bypassCache?: boolean;
  bypassCircuit?: boolean;
}

export async function fetchCaiyun(options: CaiyunOptions): Promise<CaiyunData> {
  const url = new URL(
    `https://api.caiyunapp.com/v2.6/${encodeURIComponent(options.key)}/${options.lng},${options.lat}/weather.json`,
  );
  url.searchParams.set("dailysteps", "1");
  url.searchParams.set("hourlysteps", "24");
  const data = await fetchJson<CaiyunResponse>("彩云天气", url, options.timeoutMs, undefined, {
    cacheKey: caiyunCacheKey(options, "weather", url.searchParams),
    cacheTtlMs: 5 * 60_000,
    bypassCache: cacheDisabled(options),
    retries: 1,
    circuitKey: "caiyun",
    validate: validateCaiyunResponse("彩云天气"),
    ...(options.bypassCircuit === undefined ? {} : { bypassCircuit: options.bypassCircuit }),
  });

  const result = data.result!;
  const realtime = result.realtime ?? {};
  const hourly = result.hourly ?? {};
  const hourlyTemperature = array(hourly.temperature);
  const hourlySkycon = array(hourly.skycon);
  const hourlyPrecipitation = array(hourly.precipitation);
  const length = Math.min(
    12,
    Math.max(hourlyTemperature.length, hourlySkycon.length, hourlyPrecipitation.length),
  );

  return {
    keypoint: stringValue(result.forecast_keypoint),
    shortPrecipitation:
      stringValue(result.minutely?.description) || stringValue(hourly.description),
    realtime: {
      temperature: round(finiteNumber(realtime.temperature)),
      apparentTemp: round(
        finiteNumber(realtime.apparent_temperature ?? realtime.apparent_temperatures),
      ),
      skycon: skyconChinese(realtime.skycon),
      humidity: humidityPercent(realtime.humidity, true),
      precipitation: round(finiteNumber(realtime.precipitation?.local?.intensity), 2),
      comfort: stringValue(realtime.life_index?.comfort?.desc),
      uv: stringValue(realtime.life_index?.ultraviolet?.desc),
      aqi: round(finiteNumber(realtime.air_quality?.aqi?.chn), 0),
    },
    hourly: Array.from({ length }, (_, index) => {
      const temperature = hourlyTemperature[index] ?? {};
      const skycon = hourlySkycon[index] ?? {};
      const precipitation = hourlyPrecipitation[index] ?? {};
      return {
        time: stringValue(temperature.datetime ?? skycon.datetime ?? precipitation.datetime),
        temperature: round(finiteNumber(temperature.value)),
        text: skyconChinese(skycon.value),
        precipitationProbability: probabilityPercent(precipitation.probability),
        precipitation: round(
          finiteNumber(precipitation.value ?? precipitation.local?.intensity),
          2,
        ),
      };
    }),
  };
}

export async function fetchCaiyunRaw(
  options: CaiyunOptions,
  endpoint: string,
  searchParams: Record<string, string> = {},
): Promise<CaiyunResponse> {
  const suffix = endpoint.endsWith(".json") ? endpoint : `${endpoint}.json`;
  const url = new URL(
    `https://api.caiyunapp.com/v2.6/${encodeURIComponent(options.key)}/${options.lng},${options.lat}/${suffix}`,
  );
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  const data = await fetchJson<CaiyunResponse>("彩云天气详情", url, options.timeoutMs, undefined, {
    cacheKey: caiyunCacheKey(options, endpoint, url.searchParams),
    cacheTtlMs: caiyunCacheTtl(endpoint),
    bypassCache: cacheDisabled(options),
    retries: 1,
    circuitKey: "caiyun",
    validate: validateCaiyunResponse("彩云天气详情"),
    ...(options.bypassCircuit === undefined ? {} : { bypassCircuit: options.bypassCircuit }),
  });
  return data;
}

function validateCaiyunResponse(label: string): (data: unknown) => void {
  return (data) => {
    const response = data as CaiyunResponse | undefined;
    if (response?.status === "ok" && response.result) return;
    throw new UpstreamError(label, response?.error || "接口返回失败");
  };
}

function array(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function caiyunCacheKey(
  options: CaiyunOptions,
  endpoint: string,
  params: URLSearchParams,
): string {
  return `caiyun:${endpoint}:${options.lng.toFixed(4)},${options.lat.toFixed(4)}?${params.toString()}`;
}

function caiyunCacheTtl(endpoint: string): number {
  const minute = 60_000;
  if (endpoint.includes("minutely") || endpoint.includes("realtime") || endpoint.includes("weather")) {
    return 5 * minute;
  }
  if (endpoint.includes("hourly")) return 30 * minute;
  if (endpoint.includes("daily")) return 60 * minute;
  return 15 * minute;
}

function cacheDisabled(options: CaiyunOptions): boolean {
  return options.bypassCache === true || process.env.WEATHER_CACHE_DISABLED === "1";
}
