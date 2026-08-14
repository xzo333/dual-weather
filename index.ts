import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { geocodeAddress } from "./src/geocoding.js";
import { queryWeatherDetailsByAddress } from "./src/details.js";
import { queryQWeatherGeo } from "./src/qweather-location.js";
import { queryQWeatherProfessional } from "./src/qweather-professional.js";
import { queryQWeatherAccount } from "./src/qweather-account.js";
import { queryWeatherServiceStatus } from "./src/service-status.js";
import { queryDualWeather, queryWeatherByAddress } from "./src/weather.js";
import { toToolResult } from "./src/tool-result.js";

const coordinatesSchema = {
  lng: Type.Number({ minimum: -180, maximum: 180 }),
  lat: Type.Number({ minimum: -90, maximum: 90 }),
};

export default definePluginEntry({
  id: "dual-weather",
  name: "Dual Weather",
  description: "地址解析与和风天气、彩云天气双源聚合。",
  register(api) {
    api.registerTool({
      name: "geocode_address",
      label: "地址转坐标",
      description: "将中国地址解析为标准地址和经纬度。天气查询前先调用此工具。",
      parameters: Type.Object({
        address: Type.String({ minLength: 2, maxLength: 200 }),
      }),
      async execute(_id, params) {
        return toToolResult(await geocodeAddress(params.address));
      },
    });

    api.registerTool({
      name: "qweather_location",
      label: "和风 GeoAPI 查询",
      description:
        "查询和风城市 LocationID、热门城市、景点或潮汐站。历史天气需要城市 LocationID，潮汐需要 poiType=TSTA 返回的站点 ID。",
      parameters: Type.Object({
        action: Type.Optional(
          Type.Union([
            Type.Literal("city_lookup"),
            Type.Literal("top_city"),
            Type.Literal("poi_lookup"),
            Type.Literal("poi_range"),
          ], { default: "city_lookup" }),
        ),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        adm: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        range: Type.Optional(Type.String({ minLength: 2, maxLength: 2, default: "cn" })),
        number: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
        poiType: Type.Optional(
          Type.Union([Type.Literal("scenic"), Type.Literal("TSTA")]),
        ),
        city: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        lng: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
        lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
        radius: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 5 })),
      }),
      async execute(_id, params) {
        return toToolResult(
          await queryQWeatherGeo({
            ...(params.action === undefined ? {} : { action: params.action }),
            ...(params.query === undefined ? {} : { query: params.query }),
            ...(params.adm === undefined ? {} : { adm: params.adm }),
            ...(params.range === undefined ? {} : { range: params.range }),
            ...(params.number === undefined ? {} : { number: params.number }),
            ...(params.poiType === undefined ? {} : { poiType: params.poiType }),
            ...(params.city === undefined ? {} : { city: params.city }),
            ...(params.lng === undefined ? {} : { lng: params.lng }),
            ...(params.lat === undefined ? {} : { lat: params.lat }),
            ...(params.radius === undefined ? {} : { radius: params.radius }),
          }),
        );
      },
    });

    api.registerTool({
      name: "qweather_professional",
      label: "和风专业天气能力",
      description:
        "按 action 查询和风空气监测站、太阳高度角、最近10日历史天气、台风列表/路径/预报或潮汐。仅传对应 action 需要的参数。",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("air_station"),
          Type.Literal("solar_angle"),
          Type.Literal("historical_weather"),
          Type.Literal("historical_air"),
          Type.Literal("tropical_list"),
          Type.Literal("tropical_track"),
          Type.Literal("tropical_forecast"),
          Type.Literal("tide"),
        ]),
        stationId: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
        locationId: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
        stormId: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
        lng: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
        lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
        date: Type.Optional(Type.String({ pattern: "^[0-9]{8}$" })),
        time: Type.Optional(Type.String({ pattern: "^[0-9]{4}$" })),
        timezone: Type.Optional(Type.String({ pattern: "^[+-][0-9]{4}$", default: "+0800" })),
        altitude: Type.Optional(Type.Number({ minimum: -500, maximum: 9000, default: 0 })),
        basin: Type.Optional(
          Type.Union([
            Type.Literal("AL"), Type.Literal("EP"), Type.Literal("NP"),
            Type.Literal("SP"), Type.Literal("NI"), Type.Literal("SI"),
          ], { default: "NP" }),
        ),
        year: Type.Optional(Type.Integer({ minimum: 2000, maximum: 2100 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 100 })),
        targetLng: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
        targetLat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
        riskRadiusKm: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000, default: 300 })),
      }),
      async execute(_id, params) {
        return toToolResult(await queryQWeatherProfessional(params));
      },
    });

    api.registerTool({
      name: "weather_service_status",
      label: "天气服务状态、缓存与熔断",
      description:
        "检查和风/彩云 API 的真实连通性，查看或清空缓存、熔断状态与本进程双源请求统计。health 会消耗两家各一次 API 请求，并绕过缓存和熔断。",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("health"),
          Type.Literal("cache_stats"),
          Type.Literal("cache_clear"),
          Type.Literal("circuit_stats"),
          Type.Literal("circuit_reset"),
          Type.Literal("request_stats"),
          Type.Literal("request_stats_reset"),
        ]),
        lng: Type.Optional(Type.Number({ minimum: -180, maximum: 180, default: 114.06 })),
        lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90, default: 22.55 })),
      }),
      async execute(_id, params) {
        return toToolResult(
          await queryWeatherServiceStatus(params.action, params.lng, params.lat),
        );
      },
    });

    api.registerTool({
      name: "qweather_account",
      label: "和风请求量与费用",
      description:
        "查询和风控制台最近24小时 API 请求统计或财务汇总。需要自定义 API Host，并在凭据中开启对应控制台 API 权限；仅在用户明确询问用量或费用时调用。",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("request_stats"),
          Type.Literal("finance_summary"),
        ]),
        project: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        credential: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        balanceWarningBelow: Type.Optional(Type.Number()),
        monthlyChargeWarningAbove: Type.Optional(Type.Number({ minimum: 0 })),
      }),
      async execute(_id, params) {
        return toToolResult(await queryQWeatherAccount(params));
      },
    });

    api.registerTool({
      name: "weather_details",
      label: "天气专题详情",
      description:
        "按用户问题查询一个天气专题，包括双源预报、分钟降水、生活指数、空气质量，以及和风格点、天文和专业太阳辐射。不要一次查询全部专题。",
      parameters: Type.Object({
        address: Type.String({ minLength: 2, maxLength: 200 }),
        topic: Type.Union([
          Type.Literal("hourly"),
          Type.Literal("daily"),
          Type.Literal("minutely"),
          Type.Literal("radiation"),
          Type.Literal("indices"),
          Type.Literal("alerts"),
          Type.Literal("air_quality"),
          Type.Literal("air_quality_hourly"),
          Type.Literal("air_quality_daily"),
          Type.Literal("grid_hourly"),
          Type.Literal("grid_daily"),
          Type.Literal("astronomy"),
          Type.Literal("solar_radiation"),
          Type.Literal("history"),
        ]),
        hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168, default: 24 })),
        days: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 7 })),
        date: Type.Optional(
          Type.String({ pattern: "^[0-9]{8}$", description: "天文日期，yyyyMMdd" }),
        ),
        interval: Type.Optional(
          Type.Union([Type.Literal(15), Type.Literal(30), Type.Literal(60)], { default: 60 }),
        ),
        tilt: Type.Optional(Type.Integer({ minimum: 0, maximum: 90 })),
        azimuth: Type.Optional(Type.Integer({ minimum: 0, maximum: 359 })),
        includeWeather: Type.Optional(Type.Boolean({ default: true })),
        includePoa: Type.Optional(Type.Boolean({ default: false })),
      }),
      async execute(_id, params) {
        return toToolResult(
          await queryWeatherDetailsByAddress(params.address, {
            topic: params.topic,
            ...(params.hours === undefined ? {} : { hours: params.hours }),
            ...(params.days === undefined ? {} : { days: params.days }),
            ...(params.date === undefined ? {} : { date: params.date }),
            ...(params.interval === undefined ? {} : { interval: params.interval }),
            ...(params.tilt === undefined ? {} : { tilt: params.tilt }),
            ...(params.azimuth === undefined ? {} : { azimuth: params.azimuth }),
            ...(params.includeWeather === undefined
              ? {}
              : { includeWeather: params.includeWeather }),
            ...(params.includePoa === undefined ? {} : { includePoa: params.includePoa }),
          }),
        );
      },
    });

    api.registerTool({
      name: "dual_weather",
      label: "双源天气查询",
      description: "按经纬度并行查询和风天气与彩云天气，返回精简的归一化对比 JSON。",
      parameters: Type.Object({
        ...coordinatesSchema,
        formatted_address: Type.Optional(Type.String({ maxLength: 200 })),
      }),
      async execute(_id, params) {
        return toToolResult(await queryDualWeather(params));
      },
    });

    api.registerTool({
      name: "weather_report",
      label: "地址天气聚合",
      description: "一步完成地址解析和双天气源聚合。用户直接询问某地天气时优先调用。",
      parameters: Type.Object({
        address: Type.String({ minLength: 2, maxLength: 200 }),
      }),
      async execute(_id, params) {
        return toToolResult(await queryWeatherByAddress(params.address));
      },
    });
  },
});
