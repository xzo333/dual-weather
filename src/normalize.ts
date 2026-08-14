export const SKYCON_MAP: Readonly<Record<string, string>> = {
  CLEAR_DAY: "晴",
  CLEAR_NIGHT: "晴",
  PARTLY_CLOUDY_DAY: "多云",
  PARTLY_CLOUDY_NIGHT: "多云",
  CLOUDY: "阴",
  LIGHT_HAZE: "轻度雾霾",
  MODERATE_HAZE: "中度雾霾",
  HEAVY_HAZE: "重度雾霾",
  LIGHT_RAIN: "小雨",
  MODERATE_RAIN: "中雨",
  HEAVY_RAIN: "大雨",
  STORM_RAIN: "暴雨",
  FOG: "雾",
  LIGHT_SNOW: "小雪",
  MODERATE_SNOW: "中雪",
  HEAVY_SNOW: "大雪",
  STORM_SNOW: "暴雪",
  DUST: "浮尘",
  SAND: "沙尘",
  WIND: "大风",
};

export function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function round(value: number | null, digits = 1): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function probabilityPercent(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.round(number <= 1 ? number * 100 : number);
}

export function humidityPercent(value: unknown, fractional: boolean): number | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.round(fractional ? number * 100 : number);
}

export function skyconChinese(code: unknown): string {
  if (typeof code !== "string" || !code) return "未知";
  return SKYCON_MAP[code] ?? code;
}

export function temperatureText(value: number | null): string {
  return value === null ? "未知" : `${Number(value.toFixed(1))}°C`;
}

export function percentText(value: number | null): string {
  return value === null ? "未知" : `${Math.round(value)}%`;
}
