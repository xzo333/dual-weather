import { clearWeatherCache, weatherCacheStats } from "./cache.js";
import { fetchCaiyunRaw } from "./caiyun.js";
import { circuitBreakerStats, resetCircuitBreakers } from "./circuit-breaker.js";
import { readCaiyunConfig, readQWeatherConfig } from "./config.js";
import { errorMessage } from "./http.js";
import { fetchQWeatherRaw } from "./qweather.js";
import { requestMetricsStats, resetRequestMetrics } from "./request-metrics.js";

export type WeatherServiceAction =
  | "health"
  | "cache_stats"
  | "cache_clear"
  | "circuit_stats"
  | "circuit_reset"
  | "request_stats"
  | "request_stats_reset";

export async function queryWeatherServiceStatus(
  action: WeatherServiceAction,
  lng = 114.06,
  lat = 22.55,
): Promise<Record<string, unknown>> {
  if (action === "cache_stats") return { action, cache: weatherCacheStats() };
  if (action === "cache_clear") {
    clearWeatherCache();
    return { action, cleared: true, cache: weatherCacheStats() };
  }
  if (action === "circuit_stats") return { action, circuits: circuitBreakerStats() };
  if (action === "circuit_reset") {
    resetCircuitBreakers();
    return { action, reset: true, circuits: circuitBreakerStats() };
  }
  if (action === "request_stats") return { action, providers: requestMetricsStats() };
  if (action === "request_stats_reset") {
    resetRequestMetrics();
    return { action, reset: true, providers: requestMetricsStats() };
  }

  const providers = await Promise.all([
    checkProvider("qweather", async () => {
      const config = readQWeatherConfig();
      await fetchQWeatherRaw(
        {
          auth: config.auth,
          apiHost: config.apiHost,
          timeoutMs: config.timeoutMs,
          lng,
          lat,
          bypassCache: true,
          bypassCircuit: true,
        },
        "weather/now",
        "和风健康检查",
      );
      return { authMode: config.auth.mode };
    }),
    checkProvider("caiyun", async () => {
      const config = readCaiyunConfig();
      await fetchCaiyunRaw(
        {
          key: config.key,
          timeoutMs: config.timeoutMs,
          lng,
          lat,
          bypassCache: true,
          bypassCircuit: true,
        },
        "realtime",
      );
      return {};
    }),
  ]);

  return {
    action,
    checkedAt: new Date().toISOString(),
    coordinates: { lng, lat },
    healthy: providers.every((provider) => provider.status === "ok"),
    providers: Object.fromEntries(providers.map((provider) => [provider.name, provider])),
    cache: weatherCacheStats(),
    circuits: circuitBreakerStats(),
    requests: requestMetricsStats(),
  };
}

async function checkProvider(
  name: string,
  request: () => Promise<Record<string, unknown>>,
): Promise<Record<string, any>> {
  const started = performance.now();
  try {
    const details = await request();
    return {
      name,
      status: "ok",
      latencyMs: Math.round(performance.now() - started),
      ...details,
    };
  } catch (error) {
    return {
      name,
      status: "error",
      latencyMs: Math.round(performance.now() - started),
      error: errorMessage(error),
    };
  }
}
