import { fetchCaiyunRaw } from "./caiyun.js";
import { readWeatherConfig } from "./config.js";
import { geocodeAddress } from "./geocoding.js";
import { errorMessage } from "./http.js";
import {
  finiteNumber,
  humidityPercent,
  probabilityPercent,
  round,
  skyconChinese,
} from "./normalize.js";
import {
  fetchQWeatherAirCurrent,
  fetchQWeatherAirForecast,
  fetchQWeatherRaw,
  fetchQWeatherSolarRadiation,
} from "./qweather.js";
import type { QWeatherOptions, QWeatherResponse } from "./qweather.js";

export const WEATHER_DETAIL_TOPICS = [
  "hourly",
  "daily",
  "minutely",
  "radiation",
  "indices",
  "alerts",
  "air_quality",
  "air_quality_hourly",
  "air_quality_daily",
  "grid_hourly",
  "grid_daily",
  "astronomy",
  "solar_radiation",
  "history",
] as const;

export type WeatherDetailTopic = (typeof WEATHER_DETAIL_TOPICS)[number];

export interface WeatherDetailOptions {
  topic: WeatherDetailTopic;
  hours?: number;
  days?: number;
  date?: string;
  interval?: 15 | 30 | 60;
  tilt?: number;
  azimuth?: number;
  includeWeather?: boolean;
  includePoa?: boolean;
}

interface ProviderPlan {
  endpoint: string;
  params?: Record<string, string>;
}

export async function queryWeatherDetailsByAddress(
  address: string,
  options: WeatherDetailOptions,
): Promise<Record<string, unknown>> {
  const location = await geocodeAddress(address);
  const config = readWeatherConfig();
  const hours = clampInteger(options.hours ?? 24, 1, 168);
  const days = clampInteger(options.days ?? 7, 1, 30);
  const qPlan = qweatherPlan(options.topic, hours, days, options.date);
  const cPlan = caiyunPlan(options.topic, hours, days);

  const qOptions = {
    auth: config.qweather.auth,
    apiHost: config.qweather.apiHost,
    timeoutMs: config.timeoutMs,
    lng: location.lng,
    lat: location.lat,
  };
  const qPromise = qweatherRequest(options, qOptions, qPlan, hours, days);
  const cPromise = cPlan
    ? fetchCaiyunRaw(
        {
          key: config.caiyun.key,
          timeoutMs: config.timeoutMs,
          lng: location.lng,
          lat: location.lat,
        },
        cPlan.endpoint,
        cPlan.params,
      )
    : Promise.resolve(undefined);

  const [qResult, cResult] = await Promise.allSettled([qPromise, cPromise]);
  const errors: Record<string, string> = {};
  if (qResult.status === "rejected") errors.qweather = errorMessage(qResult.reason);
  if (cResult.status === "rejected") errors.caiyun = errorMessage(cResult.reason);

  const qRaw = qResult.status === "fulfilled" ? qResult.value : undefined;
  const cRaw = cResult.status === "fulfilled" ? cResult.value?.result : undefined;
  return {
    location: `${location.formatted_address} (${location.lng.toFixed(4)}, ${location.lat.toFixed(4)})`,
    topic: options.topic,
    units: unitsFor(options.topic),
    ...(qRaw ? { qweather: parseQWeather(options.topic, qRaw, hours, days) } : {}),
    ...(cRaw ? { caiyun: parseCaiyun(options.topic, cRaw, hours, days) } : {}),
    ...(options.topic === "radiation"
      ? {
          source_note:
            "彩云 dswrf 是向下短波辐射通量；如需 DNI、DHI、GHI 或光伏板 POA，请改查 solar_radiation 专题。",
        }
      : {}),
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}

async function qweatherRequest(
  options: WeatherDetailOptions,
  qOptions: QWeatherOptions,
  plan: ProviderPlan | undefined,
  hours: number,
  days: number,
): Promise<QWeatherResponse | undefined> {
  switch (options.topic) {
    case "air_quality":
      return fetchQWeatherAirCurrent(qOptions);
    case "air_quality_hourly":
      return fetchQWeatherAirForecast(qOptions, "hourly", Math.min(hours, 72));
    case "air_quality_daily":
      return fetchQWeatherAirForecast(qOptions, "daily", Math.min(days, 5));
    case "astronomy": {
      const date = normalizedDate(options.date);
      const [sun, moon] = await Promise.allSettled([
        fetchQWeatherRaw(qOptions, "astronomy/sun", "和风日出日落", { date }),
        fetchQWeatherRaw(qOptions, "astronomy/moon", "和风月升月落和月相", { date }),
      ]);
      if (sun.status === "rejected" && moon.status === "rejected") throw sun.reason;
      return {
        sun: sun.status === "fulfilled" ? sun.value : undefined,
        moon: moon.status === "fulfilled" ? moon.value : undefined,
        partialErrors: {
          ...(sun.status === "rejected" ? { sun: errorMessage(sun.reason) } : {}),
          ...(moon.status === "rejected" ? { moon: errorMessage(moon.reason) } : {}),
        },
      };
    }
    case "solar_radiation": {
      const requestedHours = clampInteger(options.hours ?? 24, 1, 60);
      const interval = options.interval ?? 60;
      const extras: string[] = [];
      if (options.includeWeather !== false) extras.push("weather");
      if (options.includePoa) {
        if (options.tilt === undefined || options.azimuth === undefined) {
          throw new Error("查询光伏板 POA 时必须同时提供 tilt（0-90）和 azimuth（0-359）。");
        }
        extras.push("poa");
      }
      return fetchQWeatherSolarRadiation(qOptions, {
        hours: String(requestedHours),
        interval: String(interval),
        localTime: "true",
        ...(extras.length ? { extra: extras.join(",") } : {}),
        ...(options.includePoa
          ? { tilt: String(options.tilt), azimuth: String(options.azimuth) }
          : {}),
      });
    }
    default:
      return plan
        ? fetchQWeatherRaw(
            qOptions,
            plan.endpoint,
            `和风${topicLabel(options.topic)}`,
            plan.params,
          )
        : undefined;
  }
}

function qweatherPlan(
  topic: WeatherDetailTopic,
  hours: number,
  days: number,
  date?: string,
): ProviderPlan | undefined {
  switch (topic) {
    case "hourly":
      return { endpoint: `weather/${qweatherHours(hours)}h` };
    case "daily":
      return { endpoint: `weather/${qweatherDays(days)}d` };
    case "minutely":
      return { endpoint: "minutely/5m" };
    case "indices":
      return { endpoint: `indices/${days >= 2 ? 3 : 1}d`, params: { type: "0" } };
    case "alerts":
      return { endpoint: "warning/now" };
    case "air_quality":
    case "air_quality_hourly":
    case "air_quality_daily":
    case "solar_radiation":
      return undefined;
    case "grid_hourly":
      return { endpoint: `grid-weather/${hours <= 24 ? 24 : 72}h` };
    case "grid_daily":
      return { endpoint: `grid-weather/${days <= 3 ? 3 : 7}d` };
    case "astronomy":
      return { endpoint: "astronomy/sun", params: { date: normalizedDate(date) } };
    case "radiation":
    case "history":
      return undefined;
  }
}

function caiyunPlan(
  topic: WeatherDetailTopic,
  hours: number,
  days: number,
): Required<ProviderPlan> | undefined {
  switch (topic) {
    case "hourly":
      return { endpoint: "hourly", params: { hourlysteps: String(hours) } };
    case "daily":
    case "indices":
      return { endpoint: "daily", params: { dailysteps: String(Math.min(days, 15)) } };
    case "minutely":
      return { endpoint: "minutely", params: {} };
    case "alerts":
      return { endpoint: "realtime", params: { alert: "true" } };
    case "air_quality":
      return { endpoint: "realtime", params: {} };
    case "air_quality_hourly":
      return { endpoint: "hourly", params: { hourlysteps: String(Math.min(hours, 360)) } };
    case "air_quality_daily":
      return { endpoint: "daily", params: { dailysteps: String(Math.min(days, 15)) } };
    case "radiation":
      return {
        endpoint: "weather",
        params: { hourlysteps: String(hours), dailysteps: String(Math.min(days, 15)) },
      };
    case "history":
      return {
        endpoint: "hourly",
        params: {
          hourlysteps: "24",
          begin: String(Math.floor(Date.now() / 1_000) - 24 * 60 * 60),
        },
      };
    case "grid_hourly":
    case "grid_daily":
    case "astronomy":
    case "solar_radiation":
      return undefined;
  }
}

function parseQWeather(
  topic: WeatherDetailTopic,
  raw: Record<string, any>,
  hours: number,
  days: number,
): unknown {
  switch (topic) {
    case "hourly":
      return array(raw.hourly).slice(0, hours).map((item) => ({
        time: item.fxTime,
        temperature: number(item.temp),
        feelsLike: number(item.feelsLike),
        weather: item.text,
        humidity: number(item.humidity),
        precipitationProbability: number(item.pop),
        precipitation: number(item.precip, 2),
        wind: joinWind(item.windDir, item.windScale),
        pressure: number(item.pressure),
        cloudCover: number(item.cloud),
        dewPoint: number(item.dew),
      }));
    case "daily":
      return array(raw.daily).slice(0, days).map((item) => ({
        date: item.fxDate,
        weatherDay: item.textDay,
        weatherNight: item.textNight,
        temperatureMin: number(item.tempMin),
        temperatureMax: number(item.tempMax),
        precipitation: number(item.precip, 2),
        humidity: number(item.humidity),
        uvIndex: number(item.uvIndex),
        windDay: joinWind(item.windDirDay, item.windScaleDay),
        windNight: joinWind(item.windDirNight, item.windScaleNight),
        sunrise: item.sunrise,
        sunset: item.sunset,
      }));
    case "minutely":
      return {
        summary: raw.summary ?? "",
        points: array(raw.minutely).map((item) => ({
          time: item.fxTime,
          precipitation: number(item.precip, 2),
          type: item.type,
        })),
      };
    case "indices":
      return array(raw.daily).map((item) => ({
        date: item.date,
        type: item.type,
        name: item.name,
        level: item.level,
        category: item.category,
        advice: item.text,
      }));
    case "alerts":
      return array(raw.warning).map((item) => ({
        title: item.title,
        type: item.typeName,
        severity: item.severity,
        color: item.severityColor,
        startTime: item.startTime,
        endTime: item.endTime,
        text: item.text,
      }));
    case "air_quality":
      return parseQWeatherAir(raw);
    case "air_quality_hourly":
      return parseQWeatherAirForecast(raw, "hourly", hours);
    case "air_quality_daily":
      return parseQWeatherAirForecast(raw, "daily", days);
    case "grid_hourly":
      return array(raw.hourly).slice(0, Math.min(hours, 72)).map(parseGridHour);
    case "grid_daily":
      return array(raw.daily).slice(0, Math.min(days, 7)).map(parseGridDay);
    case "astronomy":
      return parseAstronomy(raw);
    case "solar_radiation":
      return array(raw.forecasts).map((item) => ({
        time: item.forecastTime,
        solarAzimuth: number(item.solarAngle?.azimuth, 2),
        solarElevation: number(item.solarAngle?.elevation, 2),
        dni: number(item.dni?.value, 2),
        dhi: number(item.dhi?.value, 2),
        ghi: number(item.ghi?.value, 2),
        temperature: number(item.weather?.temperature?.value, 1),
        windSpeed: number(item.weather?.windSpeed?.value, 2),
        humidity: number(item.weather?.humidity),
        poaGlobal: number(item.poa?.global?.value, 2),
        poaDirect: number(item.poa?.direct?.value, 2),
        poaDiffuse: number(item.poa?.diffuse?.value, 2),
        poaReflected: number(item.poa?.reflected?.value, 2),
      }));
    case "radiation":
    case "history":
      return undefined;
  }
}

function parseCaiyun(
  topic: WeatherDetailTopic,
  result: Record<string, any>,
  hours: number,
  days: number,
): unknown {
  switch (topic) {
    case "hourly":
      return parseCaiyunHourly(result.hourly ?? {}, hours);
    case "daily":
      return parseCaiyunDaily(result.daily ?? {}, days);
    case "minutely": {
      const minutely = result.minutely ?? {};
      return {
        description: minutely.description ?? result.forecast_keypoint ?? "",
        datasource: minutely.datasource,
        probabilityBy30Minutes: array(minutely.probability).map((value, index) => ({
          minuteOffset: index * 30,
          probability: probabilityPercent(value),
        })),
        precipitationEvery5Minutes: array(minutely.precipitation_2h)
          .map((value, index) => ({ minuteOffset: index, intensity: number(value, 3) }))
          .filter((_, index) => index % 5 === 0),
      };
    }
    case "radiation":
      return {
        realtime: {
          dswrf: number(result.realtime?.dswrf, 2),
        },
        hourly: zipSeries(result.hourly?.dswrf, hours, (item) => ({
          time: item.datetime,
          dswrf: number(item.value, 2),
        })),
        daily: array(result.daily?.dswrf).slice(0, days).map((item) => ({
          date: item.date,
          min: number(item.min, 2),
          average: number(item.avg, 2),
          max: number(item.max, 2),
        })),
      };
    case "indices": {
      const life = result.daily?.life_index ?? {};
      return Object.fromEntries(
        Object.entries(life).map(([name, values]) => [
          name,
          array(values).slice(0, days).map((item) => ({
            date: item.date,
            index: item.index,
            description: item.desc,
          })),
        ]),
      );
    }
    case "alerts":
      return array(result.alert?.content).map((item) => ({
        title: item.title,
        status: item.status,
        location: item.location,
        publishedAt: item.pubtimestamp,
        source: item.source,
        description: item.description,
      }));
    case "air_quality": {
      const air = result.realtime?.air_quality ?? {};
      return {
        aqiChina: number(air.aqi?.chn),
        aqiUsa: number(air.aqi?.usa),
        descriptionChina: air.description?.chn,
        pm25: number(air.pm25),
        pm10: number(air.pm10),
        o3: number(air.o3),
        no2: number(air.no2),
        so2: number(air.so2),
        co: number(air.co, 2),
      };
    }
    case "air_quality_hourly":
      return parseCaiyunAirSeries(result.hourly?.air_quality, hours, "datetime");
    case "air_quality_daily":
      return parseCaiyunAirSeries(result.daily?.air_quality, days, "date");
    case "history":
      return parseCaiyunHourly(result.hourly ?? {}, 24);
    case "grid_hourly":
    case "grid_daily":
    case "astronomy":
    case "solar_radiation":
      return undefined;
  }
}

function parseCaiyunHourly(hourly: Record<string, any>, hours: number): unknown[] {
  const temperatures = array(hourly.temperature);
  return temperatures.slice(0, hours).map((temperature, index) => ({
    time: temperature.datetime,
    temperature: number(temperature.value),
    apparentTemperature: number(at(hourly.apparent_temperature, index)?.value),
    weather: skyconChinese(at(hourly.skycon, index)?.value),
    humidity: humidityPercent(at(hourly.humidity, index)?.value, true),
    precipitationProbability: probabilityPercent(at(hourly.precipitation, index)?.probability),
    precipitation: number(at(hourly.precipitation, index)?.value, 2),
    windSpeed: number(at(hourly.wind, index)?.speed, 2),
    windDirection: number(at(hourly.wind, index)?.direction),
    visibility: number(at(hourly.visibility, index)?.value, 2),
    pressure: pascalToHpa(at(hourly.pressure, index)?.value),
    radiation: number(at(hourly.dswrf, index)?.value, 2),
    aqi: number(at(hourly.air_quality?.aqi, index)?.value?.chn),
    pm25: number(at(hourly.air_quality?.pm25, index)?.value),
  }));
}

function parseCaiyunDaily(daily: Record<string, any>, days: number): unknown[] {
  return array(daily.temperature).slice(0, days).map((temperature, index) => ({
    date: temperature.date,
    weather: skyconChinese(at(daily.skycon, index)?.value),
    weatherDay: skyconChinese(at(daily.skycon_08h_20h, index)?.value),
    weatherNight: skyconChinese(at(daily.skycon_20h_32h, index)?.value),
    temperatureMin: number(temperature.min),
    temperatureAverage: number(temperature.avg),
    temperatureMax: number(temperature.max),
    precipitationProbability: probabilityPercent(at(daily.precipitation, index)?.probability),
    precipitationAverage: number(at(daily.precipitation, index)?.avg, 2),
    humidityAverage: humidityPercent(at(daily.humidity, index)?.avg, true),
    radiationAverage: number(at(daily.dswrf, index)?.avg, 2),
    radiationMax: number(at(daily.dswrf, index)?.max, 2),
    sunrise: at(daily.astro, index)?.sunrise?.time,
    sunset: at(daily.astro, index)?.sunset?.time,
  }));
}

function topicLabel(topic: WeatherDetailTopic): string {
  return {
    hourly: "逐小时预报",
    daily: "逐日预报",
    minutely: "分钟级降水",
    radiation: "太阳辐照",
    indices: "天气生活指数",
    alerts: "天气预警",
    air_quality: "空气质量",
    air_quality_hourly: "逐小时空气质量",
    air_quality_daily: "逐日空气质量",
    grid_hourly: "格点逐小时天气",
    grid_daily: "格点逐日天气",
    astronomy: "日月天文",
    solar_radiation: "专业太阳辐射",
    history: "过去24小时天气",
  }[topic];
}

function unitsFor(topic: WeatherDetailTopic): Record<string, string> {
  const common = { temperature: "°C", precipitation: "mm", humidity: "%" };
  if (topic === "radiation") return { dswrf: "W/m²" };
  if (topic === "solar_radiation") {
    return { dni: "W/m²", dhi: "W/m²", ghi: "W/m²", poa: "W/m²" };
  }
  if (topic.startsWith("air_quality")) return { pollutants: "按接口返回单位" };
  if (topic === "astronomy") return { illumination: "%", angle: "°" };
  return common;
}

function parseQWeatherAir(raw: Record<string, any>): Record<string, unknown> {
  if (Array.isArray(raw.indexes)) {
    return {
      indexes: raw.indexes.map((item: any) => ({
        code: item.code,
        name: item.name,
        aqi: number(item.aqi),
        level: item.level,
        category: item.category,
        primaryPollutant: item.primaryPollutant?.name,
        healthAdvice: item.health?.advice?.generalPopulation,
      })),
      pollutants: array(raw.pollutants).map((item) => ({
        code: item.code,
        name: item.name,
        concentration: number(item.concentration?.value, 2),
        unit: item.concentration?.unit,
      })),
      stations: array(raw.stations).slice(0, 5).map((item) => ({
        id: item.id,
        name: item.name,
      })),
    };
  }
  const current = raw.now ?? raw;
  return {
    aqi: number(current.aqi),
    category: current.category,
    primaryPollutant: current.primary,
    pm25: number(current.pm2p5),
    pm10: number(current.pm10),
    o3: number(current.o3),
    no2: number(current.no2),
    so2: number(current.so2),
    co: number(current.co, 2),
  };
}

function parseQWeatherAirForecast(
  raw: Record<string, any>,
  period: "hourly" | "daily",
  limit: number,
): unknown[] {
  const values = period === "hourly"
    ? array(raw.hours).length ? array(raw.hours) : array(raw.hourly)
    : array(raw.days).length ? array(raw.days) : array(raw.daily);
  return values.slice(0, limit).map((item) => ({
    time: item.forecastTime ?? item.forecastStartTime ?? item.fxTime ?? item.fxDate,
    ...(item.forecastEndTime ? { endTime: item.forecastEndTime } : {}),
    ...parseQWeatherAir(item),
  }));
}

function parseGridHour(item: any): Record<string, unknown> {
  return {
    time: item.fxTime,
    temperature: number(item.temp),
    weather: item.text,
    humidity: number(item.humidity),
    precipitation: number(item.precip, 2),
    wind: joinWind(item.windDir, item.windScale),
    windSpeed: number(item.windSpeed),
    pressure: number(item.pressure),
    cloudCover: number(item.cloud),
    dewPoint: number(item.dew),
  };
}

function parseGridDay(item: any): Record<string, unknown> {
  return {
    date: item.fxDate,
    weatherDay: item.textDay,
    weatherNight: item.textNight,
    temperatureMin: number(item.tempMin),
    temperatureMax: number(item.tempMax),
    humidity: number(item.humidity),
    precipitation: number(item.precip, 2),
    pressure: number(item.pressure),
    cloudCover: number(item.cloud),
    windDay: joinWind(item.windDirDay, item.windScaleDay),
    windNight: joinWind(item.windDirNight, item.windScaleNight),
  };
}

function parseAstronomy(raw: Record<string, any>): Record<string, unknown> {
  const sun = raw.sun ?? {};
  const moon = raw.moon ?? {};
  return {
    sunrise: sun.sunrise ?? null,
    sunset: sun.sunset ?? null,
    moonrise: moon.moonrise ?? null,
    moonset: moon.moonset ?? null,
    moonPhases: array(moon.moonPhase).map((item) => ({
      time: item.fxTime,
      value: number(item.value, 3),
      name: item.name,
      illumination: number(item.illumination),
    })),
    ...(Object.keys(raw.partialErrors ?? {}).length ? { partialErrors: raw.partialErrors } : {}),
  };
}

function parseCaiyunAirSeries(
  airQuality: unknown,
  limit: number,
  timeField: "datetime" | "date",
): unknown[] {
  const air = (airQuality && typeof airQuality === "object" ? airQuality : {}) as Record<string, any>;
  const anchor = array(air.aqi);
  return anchor.slice(0, limit).map((item, index) => ({
    time: item[timeField] ?? item.datetime ?? item.date,
    aqiChina: number(item.value?.chn ?? item.avg?.chn ?? item.chn),
    aqiUsa: number(item.value?.usa ?? item.avg?.usa ?? item.usa),
    pm25: seriesNumber(air.pm25, index),
    pm10: seriesNumber(air.pm10, index),
    o3: seriesNumber(air.o3, index),
    no2: seriesNumber(air.no2, index),
    so2: seriesNumber(air.so2, index),
    co: seriesNumber(air.co, index, 2),
  }));
}

function seriesNumber(value: unknown, index: number, digits = 1): number | null {
  const item = at(value, index);
  return number(item?.value ?? item?.avg ?? item, digits);
}

function qweatherHours(requested: number): 24 | 72 | 168 {
  if (requested <= 24) return 24;
  if (requested <= 72) return 72;
  return 168;
}

function qweatherDays(requested: number): 3 | 7 | 10 | 15 | 30 {
  if (requested <= 3) return 3;
  if (requested <= 7) return 7;
  if (requested <= 10) return 10;
  if (requested <= 15) return 15;
  return 30;
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function at(value: unknown, index: number): any {
  return array(value)[index];
}

function zipSeries(
  value: unknown,
  limit: number,
  mapper: (item: any) => unknown,
): unknown[] {
  return array(value).slice(0, limit).map(mapper);
}

function number(value: unknown, digits = 1): number | null {
  return round(finiteNumber(value), digits);
}

function pascalToHpa(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed === null ? null : round(parsed / 100, 1);
}

function joinWind(direction: unknown, scale: unknown): string {
  return [direction, scale ? `${scale}级` : ""].filter(Boolean).join(" ");
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizedDate(value: string | undefined): string {
  if (value !== undefined) {
    if (!/^\d{8}$/.test(value)) throw new Error("date 必须使用 yyyyMMdd 格式，例如 20260814。");
    return value;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}
