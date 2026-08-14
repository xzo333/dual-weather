export type CacheMetricEvent = "bypass" | "hit" | "miss" | "coalesced";

interface ProviderRequestMetrics {
  logicalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  cacheCoalesced: number;
  cacheBypasses: number;
  upstreamAttempts: number;
  upstreamSuccesses: number;
  upstreamFailures: number;
  retryAttempts: number;
  totalLatencyMs: number;
  lastLatencyMs: number | null;
  lastStatus: string | null;
  lastError: string | null;
  lastRequestAt: string | null;
}

const metrics = new Map<string, ProviderRequestMetrics>();

export function recordLogicalRequest(provider: string): void {
  const state = getMetrics(provider);
  state.logicalRequests += 1;
  state.lastRequestAt = new Date().toISOString();
}

export function recordCacheMetric(provider: string, event: CacheMetricEvent): void {
  const state = getMetrics(provider);
  if (event === "hit") state.cacheHits += 1;
  else if (event === "miss") state.cacheMisses += 1;
  else if (event === "coalesced") state.cacheCoalesced += 1;
  else state.cacheBypasses += 1;
}

export function recordUpstreamAttempt(provider: string, retry: boolean): number {
  const state = getMetrics(provider);
  state.upstreamAttempts += 1;
  if (retry) state.retryAttempts += 1;
  return performance.now();
}

export function recordUpstreamOutcome(
  provider: string,
  startedAt: number,
  success: boolean,
  status: string,
  error?: string,
): void {
  const state = getMetrics(provider);
  const latency = Math.max(0, Math.round(performance.now() - startedAt));
  if (success) state.upstreamSuccesses += 1;
  else state.upstreamFailures += 1;
  state.totalLatencyMs += latency;
  state.lastLatencyMs = latency;
  state.lastStatus = status;
  state.lastError = error ?? null;
}

export function requestMetricsStats(): Record<string, unknown> {
  return Object.fromEntries(
    [...metrics].map(([provider, state]) => [
      provider,
      {
        ...state,
        averageLatencyMs: state.upstreamAttempts
          ? Math.round(state.totalLatencyMs / state.upstreamAttempts)
          : null,
      },
    ]),
  );
}

export function resetRequestMetrics(): void {
  metrics.clear();
}

function getMetrics(provider: string): ProviderRequestMetrics {
  const existing = metrics.get(provider);
  if (existing) return existing;
  const state: ProviderRequestMetrics = {
    logicalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheCoalesced: 0,
    cacheBypasses: 0,
    upstreamAttempts: 0,
    upstreamSuccesses: 0,
    upstreamFailures: 0,
    retryAttempts: 0,
    totalLatencyMs: 0,
    lastLatencyMs: null,
    lastStatus: null,
    lastError: null,
    lastRequestAt: null,
  };
  metrics.set(provider, state);
  return state;
}
