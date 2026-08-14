export const qweatherNow = {
  code: "200",
  now: {
    temp: "33",
    feelsLike: "36",
    text: "多云",
    windDir: "西南风",
    windScale: "1-3",
    humidity: "67",
    precip: "0.0",
  },
};

export const qweatherHourly = {
  code: "200",
  hourly: Array.from({ length: 15 }, (_, index) => ({
    fxTime: `2026-08-13T${String((15 + index) % 24).padStart(2, "0")}:00+08:00`,
    temp: String(33 - Math.floor(index / 3)),
    text: index >= 8 ? "小雨" : "多云",
    pop: index >= 8 ? "70" : "10",
    precip: index >= 8 ? "0.3" : "0.0",
  })),
};

export const qweatherWarning = { code: "200", warning: [] };

export const caiyunWeather = {
  status: "ok",
  result: {
    forecast_keypoint: "多云，明天凌晨3点钟后转小雨，其后多云",
    minutely: { description: "未来两小时不会下雨" },
    realtime: {
      temperature: 33.2,
      apparent_temperature: 35.7,
      skycon: "PARTLY_CLOUDY_DAY",
      humidity: 0.67,
      precipitation: { local: { intensity: 0 } },
      air_quality: { aqi: { chn: 45 } },
      life_index: {
        comfort: { desc: "热" },
        ultraviolet: { desc: "强" },
      },
    },
    hourly: {
      description: "未来24小时有雨",
      temperature: Array.from({ length: 12 }, (_, index) => ({
        datetime: `2026-08-13T${String((15 + index) % 24).padStart(2, "0")}:00+08:00`,
        value: 33 - index / 3,
      })),
      skycon: Array.from({ length: 12 }, (_, index) => ({
        datetime: `2026-08-13T${String((15 + index) % 24).padStart(2, "0")}:00+08:00`,
        value: index >= 10 ? "LIGHT_RAIN" : "PARTLY_CLOUDY_DAY",
      })),
      precipitation: Array.from({ length: 12 }, (_, index) => ({
        datetime: `2026-08-13T${String((15 + index) % 24).padStart(2, "0")}:00+08:00`,
        value: index >= 10 ? 0.2 : 0,
        probability: index >= 10 ? 0.65 : 0.1,
      })),
    },
  },
};

export const amapGeocode = {
  status: "1",
  info: "OK",
  geocodes: [
    {
      formatted_address: "广东省深圳市宝安区",
      location: "113.883115,22.553710",
    },
  ],
};

export const caiyunMinutely = {
  status: "ok",
  result: {
    forecast_keypoint: "40分钟后开始下小雨",
    minutely: {
      datasource: "radar",
      description: "40分钟后开始下小雨",
      probability: [0.1, 0.6, 0.8, 0.4],
      precipitation_2h: Array.from({ length: 120 }, (_, index) =>
        index >= 40 && index < 90 ? 0.35 : 0,
      ),
    },
  },
};

export const caiyunRadiation = {
  status: "ok",
  result: {
    realtime: { dswrf: 512.34 },
    hourly: {
      dswrf: Array.from({ length: 24 }, (_, index) => ({
        datetime: `2026-08-13T${String(index).padStart(2, "0")}:00+08:00`,
        value: Math.max(0, 700 - Math.abs(12 - index) * 80),
      })),
    },
    daily: {
      dswrf: [
        { date: "2026-08-13T00:00+08:00", min: 0, avg: 320.5, max: 812.4 },
      ],
    },
  },
};

export const caiyunDaily = {
  status: "ok",
  result: {
    daily: {
      temperature: [
        { date: "2026-08-13T00:00+08:00", min: 27, avg: 30, max: 34 },
      ],
      skycon: [{ date: "2026-08-13T00:00+08:00", value: "PARTLY_CLOUDY_DAY" }],
      skycon_08h_20h: [
        { date: "2026-08-13T00:00+08:00", value: "PARTLY_CLOUDY_DAY" },
      ],
      skycon_20h_32h: [{ date: "2026-08-13T00:00+08:00", value: "LIGHT_RAIN" }],
      precipitation: [
        { date: "2026-08-13T00:00+08:00", avg: 0.2, probability: 0.7 },
      ],
      humidity: [{ date: "2026-08-13T00:00+08:00", avg: 0.71 }],
      dswrf: [{ date: "2026-08-13T00:00+08:00", avg: 310, max: 800 }],
      astro: [
        {
          date: "2026-08-13T00:00+08:00",
          sunrise: { time: "05:58" },
          sunset: { time: "18:57" },
        },
      ],
      life_index: {
        ultraviolet: [
          { date: "2026-08-13T00:00+08:00", index: "4", desc: "强" },
        ],
        comfort: [{ date: "2026-08-13T00:00+08:00", index: "7", desc: "热" }],
        dressing: [
          { date: "2026-08-13T00:00+08:00", index: "1", desc: "炎热" },
        ],
      },
    },
  },
};

export const qweatherIndices = {
  code: "200",
  daily: [
    {
      date: "2026-08-13",
      type: "1",
      name: "运动指数",
      level: "3",
      category: "较不宜",
      text: "天气炎热，建议减少户外运动。",
    },
  ],
};

export const qweatherGeo = {
  code: "200",
  location: [
    {
      name: "宝安",
      id: "101280604",
      lat: "22.55371",
      lon: "113.88312",
      adm2: "深圳",
      adm1: "广东省",
      country: "中国",
      tz: "Asia/Shanghai",
      utcOffset: "+08:00",
      type: "city",
      rank: "35",
    },
  ],
};

export const qweatherAirHourly = {
  metadata: {},
  hours: [
    {
      forecastTime: "2026-08-14T15:00+08:00",
      indexes: [
        { code: "cn-mee", name: "AQI（中国）", aqi: 45, level: "1", category: "优" },
      ],
      pollutants: [
        { code: "pm2p5", name: "PM2.5", concentration: { value: 18.2, unit: "μg/m3" } },
      ],
    },
  ],
};

export const qweatherGridHourly = {
  code: "200",
  hourly: [
    {
      fxTime: "2026-08-14T08:00+00:00",
      temp: "32",
      text: "多云",
      windDir: "南风",
      windScale: "2",
      windSpeed: "8",
      humidity: "70",
      precip: "0.2",
      pressure: "1002",
      cloud: "65",
      dew: "25",
    },
  ],
};

export const qweatherSun = {
  code: "200",
  sunrise: "2026-08-14T05:59+08:00",
  sunset: "2026-08-14T18:56+08:00",
};

export const qweatherMoon = {
  code: "200",
  moonrise: "2026-08-14T06:45+08:00",
  moonset: "2026-08-14T19:38+08:00",
  moonPhase: [
    {
      fxTime: "2026-08-14T12:00+08:00",
      value: "0.03",
      name: "蛾眉月",
      illumination: "3",
    },
  ],
};

export const qweatherSolarRadiation = {
  metadata: {},
  forecasts: [
    {
      forecastTime: "2026-08-14T15:00+08:00",
      solarAngle: { azimuth: 236.5, elevation: 47.2 },
      dni: { value: 602.34, unit: "W/m²" },
      dhi: { value: 122.4, unit: "W/m²" },
      ghi: { value: 574.9, unit: "W/m²" },
      weather: {
        temperature: { value: 32.3, unit: "°C" },
        windSpeed: { value: 2.8, unit: "m/s" },
        humidity: 70,
      },
      poa: {
        global: { value: 551.2, unit: "W/m²" },
        direct: { value: 420.1, unit: "W/m²" },
        diffuse: { value: 120.2, unit: "W/m²" },
        reflected: { value: 10.9, unit: "W/m²" },
      },
    },
  ],
};

export const qweatherTidePoi = {
  code: "200",
  poi: [
    {
      name: "蛇口潮汐站",
      id: "P2951",
      lat: "22.48",
      lon: "113.91",
      adm2: "深圳",
      adm1: "广东省",
      country: "中国",
      tz: "Asia/Shanghai",
      utcOffset: "+08:00",
      type: "TSTA",
      rank: "10",
    },
  ],
};

export const qweatherAirStation = {
  metadata: {},
  pollutants: [
    { code: "pm2p5", name: "PM2.5", concentration: { value: 16.25, unit: "μg/m3" } },
    { code: "o3", name: "O3", concentration: { value: 52.8, unit: "μg/m3" } },
  ],
};

export const qweatherSolarAngle = {
  code: "200",
  solarElevationAngle: "42.88",
  solarAzimuthAngle: "185.92",
  solarHour: "1217",
  hourAngle: "-4.41",
};

export const qweatherHistory = {
  code: "200",
  weatherDaily: {
    date: "2026-08-13",
    sunrise: "05:58",
    sunset: "18:57",
    moonrise: "05:42",
    moonset: "18:44",
    moonPhase: "朔月",
    tempMax: "34",
    tempMin: "27",
    humidity: "68",
    precip: "1.2",
    pressure: "1002",
  },
  weatherHourly: [
    {
      time: "14:00",
      temp: "33",
      text: "多云",
      precip: "0.0",
      windDir: "南风",
      windScale: "2",
      windSpeed: "8",
      humidity: "66",
      pressure: "1001",
    },
  ],
};

export const qweatherHistoricalAir = {
  code: "200",
  airHourly: [
    {
      pubTime: "2026-08-13T14:00+08:00",
      aqi: "52",
      level: "2",
      category: "良",
      primary: "O3",
      pm10: "31",
      pm2p5: "18",
      no2: "12",
      so2: "4",
      co: "0.6",
      o3: "106",
    },
  ],
};

export const qweatherStormList = {
  code: "200",
  storm: [
    { id: "NP_2026", name: "测试台风", basin: "NP", year: "2026", isActive: "1" },
  ],
};

export const qweatherStormTrack = {
  code: "200",
  isActive: "1",
  now: {
    pubTime: "2026-08-14T12:00+08:00",
    lat: "18.4",
    lon: "126.2",
    type: "TY",
    pressure: "960",
    windSpeed: "40",
    moveSpeed: "18",
    moveDir: "NW",
  },
  track: [
    {
      time: "2026-08-14T09:00+08:00",
      lat: "18.0",
      lon: "126.8",
      type: "STY",
      pressure: "950",
      windSpeed: "45",
      moveSpeed: "16",
      moveDir: "NW",
      windRadius30: { neRadius: 300, seRadius: 280, swRadius: 250, nwRadius: 260 },
    },
  ],
};

export const qweatherTide = {
  code: "200",
  tideTable: [
    { fxTime: "2026-08-14T04:12+08:00", height: "2.17", type: "H" },
    { fxTime: "2026-08-14T10:36+08:00", height: "0.21", type: "L" },
  ],
  tideHourly: [{ fxTime: "2026-08-14T05:00+08:00", height: "2.02" }],
};

export const qweatherRequestStats = {
  asOf: "2026-08-14T14:00+08:00",
  success: [
    { api: "Weather", hours: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 1, 1, 1, 1] },
  ],
  errors: [
    { api: "Weather", hours: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  ],
};

export const qweatherFinance = {
  asOf: "2026-08-14T14:00+08:00",
  currency: "CNY",
  balance: 88.5,
  accruedCharges: {
    previousDay: 12.5,
    thisMonth: 238.75,
    sinceLastBill: 51.25,
  },
  pendingBills: [
    {
      number: "bill-1",
      date: "2026-08-01",
      type: "invoice",
      status: "pending",
      amount: 50,
      amountDue: 50,
      dueDate: "2026-08-31",
    },
  ],
  availableSavingsPlans: [],
  availableResourcePlans: [],
};
