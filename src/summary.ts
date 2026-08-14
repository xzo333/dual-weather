import type { CaiyunData, HourlyWeather, QWeatherData } from "./types.js";
import { temperatureText } from "./normalize.js";

export function temperatureComparison(
  qweather?: QWeatherData,
  caiyun?: CaiyunData,
): string {
  const q = qweather?.realtime.temperature ?? null;
  const c = caiyun?.realtime.temperature ?? null;
  if (q === null || c === null) return "双源实时温度数据不完整，暂无法比较";
  const difference = Math.abs(q - c);
  const verdict = difference <= 1 ? "高度一致" : difference <= 3 ? "较为接近" : "差异较大";
  return `和风 ${temperatureText(q)} vs 彩云 ${temperatureText(c)} (${verdict})`;
}

export function rainComparison(qweather?: QWeatherData, caiyun?: CaiyunData): string {
  const qRain = firstRain(qweather?.hourly ?? []);
  const cRain = firstRain(caiyun?.hourly ?? []);
  const parts: string[] = [];

  if (caiyun?.shortPrecipitation) parts.push(`彩云：${caiyun.shortPrecipitation}`);
  else if (cRain) parts.push(`彩云预计${rainText(cRain)}`);
  else if (caiyun) parts.push("彩云未来12小时未见明显降水信号");

  if (qRain) parts.push(`和风预计${rainText(qRain)}`);
  else if (qweather) parts.push("和风未来12小时未见明显降水信号");

  return parts.length > 0 ? parts.join("；") : "双源降水预报均不可用";
}

function firstRain(hourly: HourlyWeather[]): HourlyWeather | undefined {
  return hourly.find(
    (item) =>
      (item.precipitationProbability ?? 0) >= 50 ||
      (item.precipitation ?? 0) >= 0.1 ||
      /雨|雪|雷/.test(item.text),
  );
}

function rainText(item: HourlyWeather): string {
  const time = formatHour(item.time);
  const probability = item.precipitationProbability === null
    ? ""
    : `，概率${item.precipitationProbability}%`;
  const amount = item.precipitation === null ? "" : `，${item.precipitation}mm`;
  return `${time}起${item.text || "有降水"}${probability}${amount}`;
}

function formatHour(value: string): string {
  const match = value.match(/(?:T|\s)(\d{2}):/);
  return match ? `${match[1]}时` : value || "稍后";
}
