import { readQWeatherConfig } from "./config.js";
import { fetchQWeatherGeoRaw } from "./qweather.js";

export type QWeatherGeoAction = "city_lookup" | "top_city" | "poi_lookup" | "poi_range";

export interface QWeatherGeoQuery {
  action?: QWeatherGeoAction;
  query?: string;
  adm?: string;
  range?: string;
  number?: number;
  poiType?: "scenic" | "TSTA";
  city?: string;
  lng?: number;
  lat?: number;
  radius?: number;
}

export async function queryQWeatherLocation(
  query: string,
  options: Omit<QWeatherGeoQuery, "action" | "query"> = {},
): Promise<Record<string, unknown>> {
  return queryQWeatherGeo({ ...options, action: "city_lookup", query });
}

export async function queryQWeatherGeo(
  options: QWeatherGeoQuery,
): Promise<Record<string, unknown>> {
  const config = readQWeatherConfig();
  const action = options.action ?? "city_lookup";
  const number = clampInteger(options.number ?? 5, 1, 20);
  const request = geoRequest(action, options, number);
  const raw = await fetchQWeatherGeoRaw(
    {
      auth: config.auth,
      geoHost: config.geoHost,
      timeoutMs: config.timeoutMs,
    },
    request.endpoint,
    request.params,
  );

  const values = action === "top_city"
    ? raw.topCityList
    : action.startsWith("poi_")
      ? raw.poi
      : raw.location;
  const locations = Array.isArray(values) ? values : [];
  return {
    action,
    ...(options.query ? { query: options.query } : {}),
    locations: locations.slice(0, number).map(normalizeLocation),
  };
}

function geoRequest(
  action: QWeatherGeoAction,
  options: QWeatherGeoQuery,
  number: number,
): { endpoint: string; params: Record<string, string> } {
  const common = {
    number: String(number),
    lang: "zh",
    ...(options.range ? { range: options.range.toLowerCase() } : {}),
  };
  switch (action) {
    case "city_lookup":
      return {
        endpoint: "city/lookup",
        params: {
          ...common,
          location: requireText(options.query, "city_lookup 需要 query（城市名、坐标或 LocationID）"),
          ...(options.adm ? { adm: options.adm } : {}),
        },
      };
    case "top_city":
      return { endpoint: "city/top", params: common };
    case "poi_lookup":
      return {
        endpoint: "poi/lookup",
        params: {
          ...common,
          location: requireText(options.query, "poi_lookup 需要 query（POI 名称、坐标或 Adcode）"),
          type: requireText(options.poiType, "poi_lookup 需要 poiType=scenic 或 TSTA"),
          ...(options.city ? { city: options.city } : {}),
        },
      };
    case "poi_range":
      if (options.lng === undefined || options.lat === undefined) {
        throw new Error("poi_range 需要 lng 和 lat 坐标。");
      }
      return {
        endpoint: "poi/range",
        params: {
          ...common,
          location: `${options.lng.toFixed(2)},${options.lat.toFixed(2)}`,
          type: requireText(options.poiType, "poi_range 需要 poiType=scenic 或 TSTA"),
          radius: String(clampInteger(options.radius ?? 5, 1, 50)),
        },
      };
  }
}

function normalizeLocation(item: any): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    lat: numberValue(item.lat),
    lng: numberValue(item.lon),
    adm2: item.adm2,
    adm1: item.adm1,
    country: item.country,
    timezone: item.tz,
    utcOffset: item.utcOffset,
    type: item.type,
    rank: numberValue(item.rank),
  };
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
