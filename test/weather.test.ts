import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { fetchCaiyun } from "../src/caiyun.js";
import { clearWeatherCache, weatherCacheStats } from "../src/cache.js";
import { circuitBreakerStats, resetCircuitBreakers } from "../src/circuit-breaker.js";
import { queryWeatherDetailsByAddress } from "../src/details.js";
import { queryQWeatherAccount } from "../src/qweather-account.js";
import { queryQWeatherLocation } from "../src/qweather-location.js";
import { queryQWeatherGeo } from "../src/qweather-location.js";
import { queryQWeatherProfessional } from "../src/qweather-professional.js";
import { queryWeatherServiceStatus } from "../src/service-status.js";
import { fetchQWeather, fetchQWeatherAirCurrent, fetchQWeatherRaw } from "../src/qweather.js";
import { requestMetricsStats, resetRequestMetrics } from "../src/request-metrics.js";
import { queryDualWeather } from "../src/weather.js";
import {
  caiyunWeather,
  amapGeocode,
  caiyunDaily,
  caiyunMinutely,
  caiyunRadiation,
  qweatherHourly,
  qweatherAirHourly,
  qweatherAirStation,
  qweatherGeo,
  qweatherGridHourly,
  qweatherIndices,
  qweatherMoon,
  qweatherNow,
  qweatherFinance,
  qweatherRequestStats,
  qweatherSolarRadiation,
  qweatherSolarAngle,
  qweatherHistory,
  qweatherHistoricalAir,
  qweatherStormList,
  qweatherStormTrack,
  qweatherSun,
  qweatherTide,
  qweatherTidePoi,
  qweatherWarning,
} from "./fixtures.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  clearWeatherCache();
  resetCircuitBreakers();
  resetRequestMetrics();
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

test("normalizes QWeather and keeps only 12 hours", async () => {
  globalThis.fetch = mockFetch((url) => {
    if (url.pathname.endsWith("weather/now")) return qweatherNow;
    if (url.pathname.endsWith("weather/24h")) return qweatherHourly;
    return qweatherWarning;
  });

  const data = await fetchQWeather({
    auth: { mode: "api-key", apiKey: "test" },
    apiHost: "https://devapi.qweather.com",
    timeoutMs: 5_000,
    lng: 113.88,
    lat: 22.55,
  });

  assert.equal(data.realtime.temperature, 33);
  assert.equal(data.realtime.humidity, 67);
  assert.equal(data.hourly.length, 12);
  assert.equal(data.hourly[8]?.precipitationProbability, 70);
});

test("normalizes Caiyun fractional values and skycon", async () => {
  globalThis.fetch = mockFetch(() => caiyunWeather);
  const data = await fetchCaiyun({
    key: "test",
    timeoutMs: 5_000,
    lng: 113.88,
    lat: 22.55,
  });

  assert.equal(data.realtime.humidity, 67);
  assert.equal(data.realtime.skycon, "多云");
  assert.equal(data.hourly[10]?.precipitationProbability, 65);
});

test("produces a compact fused payload", async () => {
  process.env.HEFENG_KEY = "q-key";
  process.env.CAIYUN_KEY = "c-key";
  globalThis.fetch = mockFetch((url) => {
    if (url.hostname === "api.caiyunapp.com") return caiyunWeather;
    if (url.pathname.endsWith("weather/now")) return qweatherNow;
    if (url.pathname.endsWith("weather/24h")) return qweatherHourly;
    return qweatherWarning;
  });

  const payload = await queryDualWeather({
    formatted_address: "广东省深圳市宝安区",
    lng: 113.883115,
    lat: 22.55371,
  });

  assert.equal(payload.caiyun?.realtime.skycon, "多云");
  assert.equal(payload.qweather?.realtime.wind, "西南风 1-3级");
  assert.match(payload.comparison_summary.temp_diff, /高度一致/);
  assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") <= 2_048);
});

test("keeps Caiyun result when QWeather fails", async () => {
  process.env.HEFENG_KEY = "bad-q-key";
  process.env.CAIYUN_KEY = "c-key";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.caiyunapp.com") return jsonResponse(caiyunWeather);
    return new Response("bad gateway", { status: 502 });
  };

  const payload = await queryDualWeather({ lng: 113.88, lat: 22.55 });
  assert.ok(payload.caiyun);
  assert.equal(payload.qweather, undefined);
  assert.match(payload.errors?.qweather ?? "", /HTTP 502/);
});

test("throws a clear error when a required weather key is missing", async () => {
  delete process.env.HEFENG_KEY;
  process.env.CAIYUN_KEY = "c-key";
  await assert.rejects(
    () => queryDualWeather({ lng: 113.88, lat: 22.55 }),
    /缺少环境变量 QWEATHER_API_KEY 或 HEFENG_KEY/,
  );
});

test("uses QWeather air-quality v1 with latitude before longitude on custom hosts", async () => {
  let requestedUrl: URL | undefined;
  let apiKeyHeader = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = new URL(String(input));
    apiKeyHeader = new Headers(init?.headers).get("X-QW-Api-Key") ?? "";
    return jsonResponse({ metadata: {}, indexes: [], pollutants: [], stations: [] });
  };

  await fetchQWeatherAirCurrent({
    auth: { mode: "api-key", apiKey: "q-key" },
    apiHost: "https://custom.qweatherapi.com/v7",
    timeoutMs: 5_000,
    lng: 113.883115,
    lat: 22.55371,
  });
  assert.equal(requestedUrl?.pathname, "/airquality/v1/current/22.55/113.88");
  assert.equal(apiKeyHeader, "q-key");
});

test("returns sampled two-hour minute precipitation details", async () => {
  setKeys();
  globalThis.fetch = mockFetch((url) => {
    if (url.hostname === "restapi.amap.com") return amapGeocode;
    if (url.hostname === "api.caiyunapp.com") return caiyunMinutely;
    return { code: "200", summary: "40分钟后有雨", minutely: [] };
  });

  const payload = await queryWeatherDetailsByAddress("深圳市宝安区", {
    topic: "minutely",
  });
  const caiyun = payload.caiyun as any;
  assert.equal(caiyun.precipitationEvery5Minutes.length, 24);
  assert.equal(caiyun.probabilityBy30Minutes[1].probability, 60);
  assert.match(caiyun.description, /40分钟/);
});

test("returns radiation flux without calling unsupported QWeather v1 API", async () => {
  setKeys();
  let qweatherCalls = 0;
  globalThis.fetch = mockFetch((url) => {
    if (url.hostname === "restapi.amap.com") return amapGeocode;
    if (url.hostname === "api.caiyunapp.com") return caiyunRadiation;
    qweatherCalls += 1;
    return { code: "200" };
  });

  const payload = await queryWeatherDetailsByAddress("深圳市宝安区", {
    topic: "radiation",
    hours: 12,
    days: 1,
  });
  const caiyun = payload.caiyun as any;
  assert.equal(qweatherCalls, 0);
  assert.equal(caiyun.realtime.dswrf, 512.34);
  assert.equal(caiyun.hourly.length, 12);
  assert.equal((payload.units as any).dswrf, "W/m²");
});

test("returns life indices from both providers", async () => {
  setKeys();
  globalThis.fetch = mockFetch((url) => {
    if (url.hostname === "restapi.amap.com") return amapGeocode;
    if (url.hostname === "api.caiyunapp.com") return caiyunDaily;
    return qweatherIndices;
  });

  const payload = await queryWeatherDetailsByAddress("深圳市宝安区", {
    topic: "indices",
    days: 1,
  });
  assert.equal((payload.qweather as any)[0].name, "运动指数");
  assert.equal((payload.caiyun as any).ultraviolet[0].description, "强");
  assert.equal((payload.caiyun as any).dressing[0].description, "炎热");
});

test("returns Caiyun past 24-hour history using the official MCP query shape", async () => {
  setKeys();
  let begin = "";
  let qweatherCalls = 0;
  globalThis.fetch = mockFetch((url) => {
    if (url.hostname === "restapi.amap.com") return amapGeocode;
    if (url.hostname === "api.caiyunapp.com") {
      begin = url.searchParams.get("begin") ?? "";
      return caiyunWeather;
    }
    qweatherCalls += 1;
    return { code: "200" };
  });

  const payload = await queryWeatherDetailsByAddress("深圳市宝安区", {
    topic: "history",
  });
  assert.equal(qweatherCalls, 0);
  assert.match(begin, /^\d{10}$/);
  assert.equal((payload.caiyun as any).length, 12);
});

test("resolves QWeather LocationID through GeoAPI", async () => {
  process.env.HEFENG_KEY = "q-key";
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    requestedUrl = url;
    return qweatherGeo;
  });

  const payload = await queryQWeatherLocation("深圳宝安", { range: "CN", number: 3 });
  assert.equal(requestedUrl?.pathname, "/v2/city/lookup");
  assert.equal(requestedUrl?.searchParams.get("range"), "cn");
  assert.equal((payload.locations as any[])[0]?.id, "101280604");
  assert.equal((payload.locations as any[])[0]?.timezone, "Asia/Shanghai");
});

test("uses QWeather air-quality v1 hourly forecast on custom hosts", async () => {
  setKeys();
  process.env.QWEATHER_BASE_URL = "https://weather.example.com";
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    if (url.hostname === "restapi.amap.com") return amapGeocode;
    if (url.hostname === "api.caiyunapp.com") {
      return { status: "ok", result: { hourly: { air_quality: { aqi: [] } } } };
    }
    requestedUrl = url;
    return qweatherAirHourly;
  });

  const payload = await queryWeatherDetailsByAddress("深圳市宝安区", {
    topic: "air_quality_hourly",
    hours: 12,
  });
  assert.equal(requestedUrl?.pathname, "/airquality/v1/hourly/22.55/113.88");
  assert.equal((payload.qweather as any[])[0]?.indexes[0]?.aqi, 45);
});

test("returns QWeather UTC grid-hourly forecast", async () => {
  setKeys();
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    if (url.hostname === "restapi.amap.com") return amapGeocode;
    requestedUrl = url;
    return qweatherGridHourly;
  });

  const payload = await queryWeatherDetailsByAddress("深圳市宝安区", {
    topic: "grid_hourly",
    hours: 24,
  });
  assert.equal(requestedUrl?.pathname, "/v7/grid-weather/24h");
  assert.equal((payload.qweather as any[])[0]?.time, "2026-08-14T08:00+00:00");
  assert.equal((payload.qweather as any[])[0]?.precipitation, 0.2);
});

test("combines QWeather sun and moon astronomy calls", async () => {
  setKeys();
  const paths: string[] = [];
  globalThis.fetch = mockFetch((url) => {
    if (url.hostname === "restapi.amap.com") return amapGeocode;
    paths.push(`${url.pathname}?${url.searchParams.toString()}`);
    return url.pathname.endsWith("astronomy/sun") ? qweatherSun : qweatherMoon;
  });

  const payload = await queryWeatherDetailsByAddress("深圳市宝安区", {
    topic: "astronomy",
    date: "20260814",
  });
  assert.equal(paths.length, 2);
  assert.ok(paths.every((path) => path.includes("date=20260814")));
  assert.equal((payload.qweather as any).sunrise, "2026-08-14T05:59+08:00");
  assert.equal((payload.qweather as any).moonPhases[0]?.illumination, 3);
});

test("requests professional solar radiation with POA geometry", async () => {
  setKeys();
  process.env.QWEATHER_BASE_URL = "https://weather.example.com";
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    if (url.hostname === "restapi.amap.com") return amapGeocode;
    requestedUrl = url;
    return qweatherSolarRadiation;
  });

  const payload = await queryWeatherDetailsByAddress("深圳市宝安区", {
    topic: "solar_radiation",
    hours: 12,
    interval: 15,
    includePoa: true,
    tilt: 25,
    azimuth: 180,
  });
  assert.equal(requestedUrl?.pathname, "/solarradiation/v1/forecast/22.55/113.88");
  assert.equal(requestedUrl?.searchParams.get("extra"), "weather,poa");
  assert.equal(requestedUrl?.searchParams.get("interval"), "15");
  assert.equal((payload.qweather as any[])[0]?.ghi, 574.9);
  assert.equal((payload.qweather as any[])[0]?.poaGlobal, 551.2);
});

test("finds nearby QWeather tide stations through GeoAPI POI range", async () => {
  process.env.HEFENG_KEY = "q-key";
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    requestedUrl = url;
    return qweatherTidePoi;
  });

  const payload = await queryQWeatherGeo({
    action: "poi_range",
    lng: 113.91,
    lat: 22.48,
    poiType: "TSTA",
    radius: 20,
  });
  assert.equal(requestedUrl?.pathname, "/v2/poi/range");
  assert.equal(requestedUrl?.searchParams.get("type"), "TSTA");
  assert.equal(requestedUrl?.searchParams.get("radius"), "20");
  assert.equal((payload.locations as any[])[0]?.id, "P2951");
});

test("returns QWeather monitoring-station pollutant values", async () => {
  process.env.HEFENG_KEY = "q-key";
  process.env.QWEATHER_BASE_URL = "https://weather.example.com";
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    requestedUrl = url;
    return qweatherAirStation;
  });

  const payload = await queryQWeatherProfessional({ action: "air_station", stationId: "P53763" });
  assert.equal(requestedUrl?.pathname, "/airquality/v1/station/P53763");
  assert.equal((payload.pollutants as any[])[0]?.concentration, 16.25);
});

test("calculates the solar elevation and azimuth for an exact time", async () => {
  process.env.HEFENG_KEY = "q-key";
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    requestedUrl = url;
    return qweatherSolarAngle;
  });

  const payload = await queryQWeatherProfessional({
    action: "solar_angle",
    lng: 113.88,
    lat: 22.55,
    date: "20260814",
    time: "1230",
    timezone: "+0800",
    altitude: 10,
  });
  assert.equal(requestedUrl?.pathname, "/v7/astronomy/solar-elevation-angle");
  assert.equal(requestedUrl?.searchParams.get("tz"), "+0800");
  assert.equal(payload.solarElevationAngle, 42.88);
});

test("queries QWeather recent historical weather by LocationID", async () => {
  process.env.HEFENG_KEY = "q-key";
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    requestedUrl = url;
    return qweatherHistory;
  });

  const payload = await queryQWeatherProfessional({
    action: "historical_weather",
    locationId: "101280604",
    date: "20260813",
  });
  assert.equal(requestedUrl?.pathname, "/v7/historical/weather");
  assert.equal(requestedUrl?.searchParams.get("location"), "101280604");
  assert.equal((payload.daily as any).temperatureMax, 34);
  assert.equal((payload.hourly as any[])[0]?.wind, "南风 2级");
});

test("lists and tracks Northwest Pacific tropical cyclones", async () => {
  process.env.HEFENG_KEY = "q-key";
  const paths: string[] = [];
  globalThis.fetch = mockFetch((url) => {
    paths.push(url.pathname);
    return url.pathname.endsWith("storm-list") ? qweatherStormList : qweatherStormTrack;
  });

  const list = await queryQWeatherProfessional({
    action: "tropical_list",
    basin: "NP",
    year: 2026,
  });
  const track = await queryQWeatherProfessional({
    action: "tropical_track",
    stormId: "NP_2026",
  });
  assert.deepEqual(paths, ["/v7/tropical/storm-list", "/v7/tropical/storm-track"]);
  assert.equal((list.storms as any[])[0]?.active, true);
  assert.equal((track.points as any[])[0]?.windRadius30.northeast, 300);
});

test("returns tide table and hourly heights by TSTA station ID", async () => {
  process.env.HEFENG_KEY = "q-key";
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    requestedUrl = url;
    return qweatherTide;
  });

  const payload = await queryQWeatherProfessional({
    action: "tide",
    stationId: "P2951",
    date: "20260814",
  });
  assert.equal(requestedUrl?.pathname, "/v7/ocean/tide");
  assert.equal((payload.tideTable as any[])[0]?.type, "高潮");
  assert.equal((payload.hourly as any[])[0]?.height, 2.02);
});

test("queries QWeather recent historical air quality by LocationID", async () => {
  process.env.HEFENG_KEY = "q-key";
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    requestedUrl = url;
    return qweatherHistoricalAir;
  });

  const payload = await queryQWeatherProfessional({
    action: "historical_air",
    locationId: "101280604",
    date: "20260813",
  });
  assert.equal(requestedUrl?.pathname, "/v7/historical/air");
  assert.equal((payload.hourly as any[])[0]?.aqi, 52);
  assert.equal((payload.hourly as any[])[0]?.primaryPollutant, "O3");
});

test("calculates geometric proximity from a storm path to a target", async () => {
  process.env.HEFENG_KEY = "q-key";
  globalThis.fetch = mockFetch(() => qweatherStormTrack);

  const payload = await queryQWeatherProfessional({
    action: "tropical_track",
    stormId: "NP_2026",
    targetLng: 126.8,
    targetLat: 18,
    riskRadiusKm: 100,
  });
  const proximity = payload.proximity as any;
  assert.equal(proximity.nearestDistanceKm, 0);
  assert.equal(proximity.withinThreshold, true);
  assert.equal(proximity.proximityLevel, "very_close");
  assert.match(proximity.interpretation, /几何距离/);
});

test("caches provider responses and avoids duplicate upstream calls", async () => {
  let calls = 0;
  globalThis.fetch = mockFetch((url) => {
    calls += 1;
    if (url.pathname.endsWith("weather/now")) return qweatherNow;
    if (url.pathname.endsWith("weather/24h")) return qweatherHourly;
    return qweatherWarning;
  });
  const options = {
    auth: { mode: "api-key" as const, apiKey: "test" },
    apiHost: "https://devapi.qweather.com",
    timeoutMs: 5_000,
    lng: 113.88,
    lat: 22.55,
  };

  await fetchQWeather(options);
  await fetchQWeather(options);
  assert.equal(calls, 3);
  assert.equal(weatherCacheStats().hits, 3);
  const metrics = requestMetricsStats().qweather as any;
  assert.equal(metrics.logicalRequests, 6);
  assert.equal(metrics.cacheHits, 3);
  assert.equal(metrics.upstreamAttempts, 3);
  assert.equal(metrics.upstreamSuccesses, 3);
});

test("runs uncached health checks for both weather providers", async () => {
  process.env.HEFENG_KEY = "q-key";
  process.env.CAIYUN_KEY = "c-key";
  let calls = 0;
  globalThis.fetch = mockFetch((url) => {
    calls += 1;
    return url.hostname === "api.caiyunapp.com"
      ? { status: "ok", result: { realtime: {} } }
      : qweatherNow;
  });

  const payload = await queryWeatherServiceStatus("health", 113.88, 22.55);
  assert.equal(payload.healthy, true);
  assert.equal(calls, 2);
  assert.equal((payload.providers as any).qweather.status, "ok");
  assert.equal((payload.cache as any).entries, 0);
});

test("summarizes QWeather request statistics for the last 24 hours", async () => {
  process.env.QWEATHER_API_KEY = "q-key";
  process.env.QWEATHER_BASE_URL = "https://example.qweatherapi.com";
  let requestedUrl: URL | undefined;
  globalThis.fetch = mockFetch((url) => {
    requestedUrl = url;
    return qweatherRequestStats;
  });

  const payload = await queryQWeatherAccount({ action: "request_stats", project: "project-1" });
  assert.equal(requestedUrl?.pathname, "/metrics/v1/stats");
  assert.equal(requestedUrl?.searchParams.get("project"), "project-1");
  assert.deepEqual(payload.totals, { success: 104, errors: 5, errorRate: 4.59 });
  assert.equal((payload.success as any)[0].hours.length, 24);
});

test("summarizes QWeather finance data and emits configured threshold alerts", async () => {
  process.env.QWEATHER_API_KEY = "q-key";
  process.env.QWEATHER_BASE_URL = "https://example.qweatherapi.com";
  let calls = 0;
  globalThis.fetch = mockFetch((url) => {
    calls += 1;
    assert.equal(url.pathname, "/finance/v1/summary");
    return qweatherFinance;
  });

  const payload = await queryQWeatherAccount({
    action: "finance_summary",
    balanceWarningBelow: 100,
    monthlyChargeWarningAbove: 200,
  });
  assert.equal(payload.currency, "CNY");
  assert.equal(payload.balance, 88.5);
  assert.equal((payload.accruedCharges as any).thisMonth, 238.75);
  assert.equal((payload.alerts as string[]).length, 2);

  await queryQWeatherAccount({ action: "finance_summary" });
  assert.equal(calls, 2);
});

test("opens the QWeather circuit after repeated failures and can reset it", async () => {
  process.env.WEATHER_CIRCUIT_FAILURES = "2";
  process.env.WEATHER_CIRCUIT_COOLDOWN_MS = "1000";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("forbidden", { status: 403 });
  };
  const options = {
    auth: { mode: "api-key" as const, apiKey: "test" },
    apiHost: "https://devapi.qweather.com",
    timeoutMs: 5_000,
    lng: 113.88,
    lat: 22.55,
    bypassCache: true,
  };

  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /HTTP 403/);
  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /HTTP 403/);
  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /CircuitOpenError|熔断器/);
  assert.equal(calls, 2);
  assert.equal((circuitBreakerStats().qweather as any).status, "open");

  const reset = await queryWeatherServiceStatus("circuit_reset");
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.circuits, {});
});

test("counts QWeather business quota errors toward circuit protection", async () => {
  process.env.WEATHER_CIRCUIT_FAILURES = "2";
  process.env.WEATHER_CIRCUIT_COOLDOWN_MS = "1000";
  let calls = 0;
  globalThis.fetch = mockFetch(() => {
    calls += 1;
    return { code: "402" };
  });
  const options = {
    auth: { mode: "api-key" as const, apiKey: "test" },
    apiHost: "https://devapi.qweather.com",
    timeoutMs: 5_000,
    lng: 113.88,
    lat: 22.55,
    bypassCache: true,
  };

  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /状态码 402/);
  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /状态码 402/);
  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /熔断器/);
  assert.equal(calls, 2);
  assert.equal((circuitBreakerStats().qweather as any).status, "open");
  const metrics = requestMetricsStats().qweather as any;
  assert.equal(metrics.upstreamFailures, 2);
  assert.equal(metrics.lastStatus, "provider_error");
});

test("does not open the provider circuit for location-specific QWeather 400 errors", async () => {
  process.env.WEATHER_CIRCUIT_FAILURES = "2";
  let calls = 0;
  globalThis.fetch = mockFetch(() => {
    calls += 1;
    return { code: "400" };
  });
  const options = {
    auth: { mode: "api-key" as const, apiKey: "test" },
    apiHost: "https://devapi.qweather.com",
    timeoutMs: 5_000,
    lng: 113.88,
    lat: 22.55,
    bypassCache: true,
  };

  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /状态码 400/);
  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /状态码 400/);
  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /状态码 400/);
  assert.equal(calls, 3);
  assert.equal((circuitBreakerStats().qweather as any).status, "closed");

  const reset = await queryWeatherServiceStatus("request_stats_reset");
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.providers, {});
});

test("treats an empty HTTP 204 response as no-data without opening the circuit", async () => {
  process.env.WEATHER_CIRCUIT_FAILURES = "1";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };
  const options = {
    auth: { mode: "api-key" as const, apiKey: "test" },
    apiHost: "https://devapi.qweather.com",
    timeoutMs: 5_000,
    lng: 113.88,
    lat: 22.55,
    bypassCache: true,
  };

  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /暂无数据/);
  await assert.rejects(fetchQWeatherRaw(options, "weather/now", "test"), /暂无数据/);
  assert.equal(calls, 2);
  assert.equal((circuitBreakerStats().qweather as any).status, "closed");
});

function mockFetch(resolve: (url: URL) => unknown): typeof fetch {
  return async (input) => jsonResponse(resolve(new URL(String(input))));
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function setKeys(): void {
  process.env.AMAP_KEY = "a-key";
  process.env.HEFENG_KEY = "q-key";
  process.env.CAIYUN_KEY = "c-key";
}
