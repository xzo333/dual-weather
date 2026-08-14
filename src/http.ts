import { withWeatherCache } from "./cache.js";
import { withCircuitBreaker } from "./circuit-breaker.js";
import {
  recordCacheMetric,
  recordLogicalRequest,
  recordUpstreamAttempt,
  recordUpstreamOutcome,
} from "./request-metrics.js";

export class UpstreamError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly circuitFailure = true,
  ) {
    super(`${provider}: ${message}`);
    this.name = "UpstreamError";
  }
}

export interface FetchPolicy {
  cacheKey?: string;
  cacheTtlMs?: number;
  bypassCache?: boolean;
  retries?: number;
  circuitKey?: string;
  bypassCircuit?: boolean;
  metricsKey?: string;
  validate?: (data: unknown) => void;
}

export async function fetchJson<T>(
  provider: string,
  url: URL,
  timeoutMs: number,
  init?: RequestInit,
  policy: FetchPolicy = {},
): Promise<T> {
  const metricsKey = policy.metricsKey ?? policy.circuitKey ?? provider;
  recordLogicalRequest(metricsKey);
  return withWeatherCache(
    policy.cacheKey,
    policy.cacheTtlMs ?? 0,
    () => withCircuitBreaker(
      policy.circuitKey,
      () => fetchJsonUncached<T>(provider, metricsKey, url, timeoutMs, init, policy),
      policy.bypassCircuit,
    ),
    policy.bypassCache,
    (event) => recordCacheMetric(metricsKey, event),
  );
}

async function fetchJsonUncached<T>(
  provider: string,
  metricsKey: string,
  url: URL,
  timeoutMs: number,
  init: RequestInit | undefined,
  policy: FetchPolicy,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const startedAt = recordUpstreamAttempt(metricsKey, attempt > 0);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { Accept: "application/json", ...init?.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error && error.name === "TimeoutError"
        ? `${timeoutMs}ms 请求超时`
        : "网络请求失败";
      recordUpstreamOutcome(metricsKey, startedAt, false, "network_error", message);
      if (attempt < (policy.retries ?? 0)) {
        await backoff(attempt);
        continue;
      }
      throw new UpstreamError(provider, message);
    }

    if (response.status === 204) {
      const message = "HTTP 204（当前区域暂无数据）";
      recordUpstreamOutcome(metricsKey, startedAt, false, "204", message);
      throw new UpstreamError(provider, message, false);
    }
    if (!response.ok) {
      const message = `HTTP ${response.status}`;
      recordUpstreamOutcome(metricsKey, startedAt, false, String(response.status), message);
      if (attempt < (policy.retries ?? 0) && shouldRetry(response.status)) {
        await backoff(attempt);
        continue;
      }
      throw new UpstreamError(provider, message, isCircuitHttpStatus(response.status));
    }

    let data: T;
    try {
      data = (await response.json()) as T;
    } catch {
      const message = "响应不是有效 JSON";
      recordUpstreamOutcome(metricsKey, startedAt, false, "invalid_json", message);
      throw new UpstreamError(provider, message);
    }
    try {
      policy.validate?.(data);
    } catch (error) {
      recordUpstreamOutcome(
        metricsKey,
        startedAt,
        false,
        "provider_error",
        error instanceof Error ? error.message : "业务状态失败",
      );
      throw error;
    }
    recordUpstreamOutcome(metricsKey, startedAt, true, String(response.status));
    return data;
  }
}

function isCircuitHttpStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

function shouldRetry(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function backoff(attempt: number): Promise<void> {
  const base = Math.min(250 * 2 ** attempt, 2_000);
  const jitter = Math.floor(Math.random() * Math.max(1, base / 4));
  await new Promise((resolve) => setTimeout(resolve, base + jitter));
}

export function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return "未知错误";
}
