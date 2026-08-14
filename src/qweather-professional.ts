import { readQWeatherConfig } from "./config.js";
import {
  fetchQWeatherV1Raw,
  fetchQWeatherV7Raw,
  usesPublicLegacyHost,
} from "./qweather.js";

export type QWeatherProfessionalAction =
  | "air_station"
  | "solar_angle"
  | "historical_weather"
  | "historical_air"
  | "tropical_list"
  | "tropical_track"
  | "tropical_forecast"
  | "tide";

export interface QWeatherProfessionalQuery {
  action: QWeatherProfessionalAction;
  stationId?: string;
  locationId?: string;
  stormId?: string;
  lng?: number;
  lat?: number;
  date?: string;
  time?: string;
  timezone?: string;
  altitude?: number;
  basin?: "AL" | "EP" | "NP" | "SP" | "NI" | "SI";
  year?: number;
  limit?: number;
  targetLng?: number;
  targetLat?: number;
  riskRadiusKm?: number;
}

export async function queryQWeatherProfessional(
  query: QWeatherProfessionalQuery,
): Promise<Record<string, unknown>> {
  const config = readQWeatherConfig();
  const base = {
    auth: config.auth,
    apiHost: config.apiHost,
    timeoutMs: config.timeoutMs,
  };
  const limit = clampInteger(query.limit ?? 100, 1, 200);

  switch (query.action) {
    case "air_station": {
      requireCustomHost(config.apiHost, "空气质量监测站");
      const stationId = requireText(query.stationId, "air_station 需要 stationId。");
      const raw = await fetchQWeatherV1Raw(
        base,
        `airquality/v1/station/${encodeURIComponent(stationId)}`,
        "和风空气质量监测站",
        { lang: "zh" },
      );
      return {
        action: query.action,
        stationId,
        pollutants: array(raw.pollutants).map(parsePollutant),
      };
    }
    case "solar_angle": {
      const lng = requireNumber(query.lng, "solar_angle 需要 lng。");
      const lat = requireNumber(query.lat, "solar_angle 需要 lat。");
      const date = requirePattern(query.date, /^\d{8}$/, "date 必须是 yyyyMMdd。");
      const time = requirePattern(query.time, /^(?:[01]\d|2[0-3])[0-5]\d$/, "time 必须是 HHmm。");
      const timezone = requirePattern(
        query.timezone,
        /^[+-]\d{4}$/,
        "timezone 必须是 +0800 或 -0530 格式。",
      );
      const altitude = requireNumber(query.altitude, "solar_angle 需要 altitude（米）。");
      const raw = await fetchQWeatherV7Raw(base, "astronomy/solar-elevation-angle", "和风太阳高度角", {
        location: `${lng.toFixed(2)},${lat.toFixed(2)}`,
        date,
        time,
        tz: timezone,
        alt: String(altitude),
      });
      return {
        action: query.action,
        solarElevationAngle: number(raw.solarElevationAngle, 2),
        solarAzimuthAngle: number(raw.solarAzimuthAngle, 2),
        solarTime: raw.solarHour,
        hourAngle: number(raw.hourAngle, 2),
        units: { angle: "°", altitude: "m" },
      };
    }
    case "historical_weather": {
      const locationId = requireText(query.locationId, "historical_weather 需要 locationId。");
      const date = requirePattern(query.date, /^\d{8}$/, "date 必须是 yyyyMMdd。");
      validateRecentHistoryDate(date);
      const raw = await fetchQWeatherV7Raw(base, "historical/weather", "和风历史天气", {
        location: locationId,
        date,
        lang: "zh",
        unit: "m",
      });
      return {
        action: query.action,
        locationId,
        date,
        daily: parseHistoricalDaily(raw.weatherDaily),
        hourly: array(raw.weatherHourly).slice(0, 24).map(parseHistoricalHour),
      };
    }
    case "historical_air": {
      const locationId = requireText(query.locationId, "historical_air 需要 locationId。");
      const date = requirePattern(query.date, /^\d{8}$/, "date 必须是 yyyyMMdd。");
      validateRecentHistoryDate(date);
      const raw = await fetchQWeatherV7Raw(base, "historical/air", "和风历史空气质量", {
        location: locationId,
        date,
        lang: "zh",
      });
      return {
        action: query.action,
        locationId,
        date,
        hourly: array(raw.airHourly).slice(0, 24).map((item) => ({
          time: item.pubTime,
          aqi: number(item.aqi),
          level: item.level,
          category: item.category,
          primaryPollutant: item.primary,
          pm25: number(item.pm2p5),
          pm10: number(item.pm10),
          o3: number(item.o3),
          no2: number(item.no2),
          so2: number(item.so2),
          co: number(item.co, 2),
        })),
      };
    }
    case "tropical_list": {
      const year = query.year ?? currentYear();
      const thisYear = currentYear();
      if (year !== thisYear && year !== thisYear - 1) {
        throw new Error(`台风列表只支持本年度或上一年度：${thisYear}、${thisYear - 1}。`);
      }
      const basin = query.basin ?? "NP";
      const raw = await fetchQWeatherV7Raw(base, "tropical/storm-list", "和风台风列表", {
        basin,
        year: String(year),
      });
      return {
        action: query.action,
        basin,
        year,
        storms: array(raw.storm).map((item) => ({
          id: item.id ?? item.stormId,
          name: item.name,
          basin: item.basin,
          year: number(item.year, 0),
          active: item.isActive === "1",
        })),
      };
    }
    case "tropical_track":
    case "tropical_forecast": {
      const stormId = requireText(query.stormId, `${query.action} 需要 stormId。`);
      const isTrack = query.action === "tropical_track";
      const raw = await fetchQWeatherV7Raw(
        base,
        `tropical/${isTrack ? "storm-track" : "storm-forecast"}`,
        isTrack ? "和风台风路径" : "和风台风预报",
        { stormid: stormId },
      );
      const rawPoints = array(isTrack ? raw.track : raw.forecast).slice(-limit);
      const proximity = stormProximity(query, raw.now ? [raw.now, ...rawPoints] : rawPoints);
      return {
        action: query.action,
        stormId,
        active: raw.isActive === undefined ? undefined : raw.isActive === "1",
        ...(raw.now ? { current: parseStormPoint(raw.now) } : {}),
        points: rawPoints.map(parseStormPoint),
        ...(proximity ? { proximity } : {}),
      };
    }
    case "tide": {
      const stationId = requireText(query.stationId, "tide 需要 TSTA 潮汐站 stationId。");
      const date = requirePattern(query.date, /^\d{8}$/, "date 必须是 yyyyMMdd。");
      const raw = await fetchQWeatherV7Raw(base, "ocean/tide", "和风潮汐", {
        location: stationId,
        date,
      });
      return {
        action: query.action,
        stationId,
        date,
        tideTable: array(raw.tideTable).map((item) => ({
          time: item.fxTime,
          height: number(item.height, 2),
          type: item.type === "H" ? "高潮" : item.type === "L" ? "低潮" : item.type,
        })),
        hourly: array(raw.tideHourly).map((item) => ({
          time: item.fxTime,
          height: number(item.height, 2),
        })),
        units: { height: "m" },
      };
    }
  }
}

function parsePollutant(item: any): Record<string, unknown> {
  return {
    code: item.code,
    name: item.name,
    concentration: number(item.concentration?.value, 2),
    unit: item.concentration?.unit,
  };
}

function parseHistoricalDaily(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, any>;
  return {
    date: item.date,
    temperatureMin: number(item.tempMin),
    temperatureMax: number(item.tempMax),
    humidity: number(item.humidity),
    precipitation: number(item.precip, 2),
    pressure: number(item.pressure),
    sunrise: item.sunrise,
    sunset: item.sunset,
    moonrise: item.moonrise,
    moonset: item.moonset,
    moonPhase: item.moonPhase,
  };
}

function parseHistoricalHour(item: any): Record<string, unknown> {
  return {
    time: item.time,
    temperature: number(item.temp),
    weather: item.text,
    precipitation: number(item.precip, 2),
    humidity: number(item.humidity),
    pressure: number(item.pressure),
    wind: [item.windDir, item.windScale ? `${item.windScale}级` : ""].filter(Boolean).join(" "),
    windSpeed: number(item.windSpeed),
  };
}

function parseStormPoint(item: any): Record<string, unknown> {
  return {
    time: item.time ?? item.fxTime ?? item.pubTime,
    lat: number(item.lat, 2),
    lng: number(item.lon, 2),
    type: item.type,
    pressure: number(item.pressure),
    windSpeed: number(item.windSpeed),
    moveSpeed: number(item.moveSpeed),
    moveDirection: item.moveDir,
    windRadius30: parseWindRadius(item.windRadius30),
    windRadius50: parseWindRadius(item.windRadius50),
    windRadius64: parseWindRadius(item.windRadius64),
  };
}

function parseWindRadius(value: unknown): Record<string, number | null> | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  return {
    northeast: number(item.neRadius),
    southeast: number(item.seRadius),
    southwest: number(item.swRadius),
    northwest: number(item.nwRadius),
  };
}

function stormProximity(
  query: QWeatherProfessionalQuery,
  points: any[],
): Record<string, unknown> | undefined {
  if (query.targetLng === undefined && query.targetLat === undefined) return undefined;
  if (query.targetLng === undefined || query.targetLat === undefined) {
    throw new Error("台风距离计算必须同时提供 targetLng 和 targetLat。");
  }
  const candidates = points
    .map((point) => {
      const lat = Number(point.lat);
      const lng = Number(point.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
      return {
        point,
        distanceKm: haversineKm(query.targetLat!, query.targetLng!, lat, lng),
      };
    })
    .filter((value): value is { point: any; distanceKm: number } => value !== undefined)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const nearest = candidates[0];
  if (!nearest) return undefined;
  const radius = Math.max(1, query.riskRadiusKm ?? 300);
  const distance = number(nearest.distanceKm, 1)!;
  return {
    target: { lng: query.targetLng, lat: query.targetLat },
    nearestDistanceKm: distance,
    nearestTime: nearest.point.time ?? nearest.point.fxTime ?? nearest.point.pubTime,
    nearestStormPoint: {
      lng: number(nearest.point.lon, 2),
      lat: number(nearest.point.lat, 2),
      type: nearest.point.type,
      windSpeed: number(nearest.point.windSpeed),
    },
    thresholdKm: radius,
    withinThreshold: nearest.distanceKm <= radius,
    proximityLevel:
      nearest.distanceKm <= 100 ? "very_close"
      : nearest.distanceKm <= 300 ? "close"
      : nearest.distanceKm <= 500 ? "watch"
      : "distant",
    interpretation:
      "仅表示台风中心路径点与目标坐标的几何距离，不等同于风雨影响范围、登陆概率或官方风险预警。",
  };
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = radians(lat2 - lat1);
  const deltaLng = radians(lng2 - lng1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLng / 2) ** 2;
  return 6_371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function requireCustomHost(host: string, capability: string): void {
  if (usesPublicLegacyHost(host)) {
    throw new Error(`${capability} API 需要控制台分配的自定义 QWEATHER_BASE_URL。`);
  }
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function requirePattern(value: unknown, pattern: RegExp, message: string): string {
  const text = requireText(value, message);
  if (!pattern.test(text)) throw new Error(message);
  return text;
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message);
  return value;
}

function number(value: unknown, digits = 1): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function currentYear(): number {
  return Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric" }).format(
      new Date(),
    ),
  );
}

function validateRecentHistoryDate(value: string): void {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const requested = Date.UTC(year, month - 1, day);
  const todayText = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [todayYear, todayMonth, todayDay] = todayText.split("-").map(Number);
  const today = Date.UTC(todayYear!, todayMonth! - 1, todayDay!);
  const difference = Math.round((today - requested) / 86_400_000);
  if (difference < 1 || difference > 10) {
    throw new Error("历史天气 date 必须是最近 10 天内且不包含今天的日期。");
  }
}
