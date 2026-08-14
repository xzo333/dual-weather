import { fetchCaiyun } from "./caiyun.js";
import { readWeatherConfig } from "./config.js";
import { geocodeAddress } from "./geocoding.js";
import { errorMessage } from "./http.js";
import { percentText, temperatureText } from "./normalize.js";
import { fetchQWeather } from "./qweather.js";
import { rainComparison, temperatureComparison } from "./summary.js";
import type { CaiyunData, QWeatherData, WeatherPayload, WeatherQuery } from "./types.js";

const MAX_PAYLOAD_BYTES = 2_048;

export async function queryWeatherByAddress(address: string): Promise<WeatherPayload> {
  const location = await geocodeAddress(address);
  return queryDualWeather(location);
}

export async function queryDualWeather(query: WeatherQuery): Promise<WeatherPayload> {
  validateCoordinates(query.lng, query.lat);
  const config = readWeatherConfig();
  const [qweatherResult, caiyunResult] = await Promise.allSettled([
    fetchQWeather({
      auth: config.qweather.auth,
      apiHost: config.qweather.apiHost,
      timeoutMs: config.timeoutMs,
      lng: query.lng,
      lat: query.lat,
    }),
    fetchCaiyun({
      key: config.caiyun.key,
      timeoutMs: config.timeoutMs,
      lng: query.lng,
      lat: query.lat,
    }),
  ]);

  const qweather = fulfilled(qweatherResult);
  const caiyun = fulfilled(caiyunResult);
  const errors: Record<string, string> = {};
  if (qweatherResult.status === "rejected") errors.qweather = errorMessage(qweatherResult.reason);
  if (caiyunResult.status === "rejected") errors.caiyun = errorMessage(caiyunResult.reason);

  const payload: WeatherPayload = {
    location: `${query.formatted_address || "指定坐标"} (${query.lng.toFixed(2)}, ${query.lat.toFixed(2)})`,
    queryTime: chinaTime(new Date()),
    ...(caiyun ? { caiyun: publicCaiyun(caiyun) } : {}),
    ...(qweather ? { qweather: publicQWeather(qweather) } : {}),
    comparison_summary: {
      temp_diff: temperatureComparison(qweather, caiyun),
      rain_forecast: rainComparison(qweather, caiyun),
    },
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };

  return enforcePayloadLimit(payload);
}

function publicCaiyun(data: CaiyunData): NonNullable<WeatherPayload["caiyun"]> {
  return {
    keypoint: data.keypoint || "暂无一句话预报",
    ...(data.shortPrecipitation ? { shortPrecipitation: data.shortPrecipitation } : {}),
    realtime: {
      temperature: temperatureText(data.realtime.temperature),
      apparentTemp: temperatureText(data.realtime.apparentTemp),
      skycon: data.realtime.skycon,
      humidity: percentText(data.realtime.humidity),
      precipitation: data.realtime.precipitation,
      comfort: data.realtime.comfort || "未知",
      uv: data.realtime.uv || "未知",
      aqi: data.realtime.aqi,
    },
  };
}

function publicQWeather(data: QWeatherData): NonNullable<WeatherPayload["qweather"]> {
  const wind = [data.realtime.windDir, data.realtime.windScale && `${data.realtime.windScale}级`]
    .filter(Boolean)
    .join(" ");
  return {
    realtime: {
      temperature: temperatureText(data.realtime.temperature),
      feelsLike: temperatureText(data.realtime.feelsLike),
      text: data.realtime.text || "未知",
      humidity: percentText(data.realtime.humidity),
      precipitation: data.realtime.precipitation,
      wind: wind || "未知",
    },
    warning: data.warning,
  };
}

function enforcePayloadLimit(payload: WeatherPayload): WeatherPayload {
  if (byteLength(payload) <= MAX_PAYLOAD_BYTES) return payload;

  if (payload.qweather && payload.qweather.warning.length > 1) {
    payload.qweather.warning = payload.qweather.warning.slice(0, 1);
  }
  if (payload.caiyun?.shortPrecipitation) delete payload.caiyun.shortPrecipitation;
  if (byteLength(payload) <= MAX_PAYLOAD_BYTES) return payload;

  payload.comparison_summary.rain_forecast = truncate(
    payload.comparison_summary.rain_forecast,
    140,
  );
  if (payload.caiyun) payload.caiyun.keypoint = truncate(payload.caiyun.keypoint, 100);
  for (const key of Object.keys(payload.errors ?? {})) {
    payload.errors![key] = truncate(payload.errors![key]!, 80);
  }
  if (byteLength(payload) > MAX_PAYLOAD_BYTES) {
    throw new Error("聚合天气 Payload 超过 2KB，无法在不丢失核心字段的情况下返回。");
  }
  return payload;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncate(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters - 1)}…`;
}

function fulfilled<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}

function validateCoordinates(lng: number, lat: number): void {
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error("lng 必须是 -180 到 180 之间的有效经度。");
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error("lat 必须是 -90 到 90 之间的有效纬度。");
  }
}

function chinaTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}
