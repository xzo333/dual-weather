interface CircuitState {
  consecutiveFailures: number;
  openedUntil: number;
  totalSuccesses: number;
  totalFailures: number;
}

const circuits = new Map<string, CircuitState>();

export class CircuitOpenError extends Error {
  constructor(public readonly circuit: string, retryAfterMs: number) {
    super(`${circuit} 熔断器已开启，请在约 ${Math.ceil(retryAfterMs / 1_000)} 秒后重试或执行健康检查。`);
    this.name = "CircuitOpenError";
  }
}

export async function withCircuitBreaker<T>(
  circuit: string | undefined,
  request: () => Promise<T>,
  bypass = false,
): Promise<T> {
  if (!circuit) return request();
  const state = getState(circuit);
  const now = Date.now();
  if (!bypass && state.openedUntil > now) {
    throw new CircuitOpenError(circuit, state.openedUntil - now);
  }
  try {
    const value = await request();
    state.consecutiveFailures = 0;
    state.openedUntil = 0;
    state.totalSuccesses += 1;
    return value;
  } catch (error) {
    if (!isCircuitFailure(error)) throw error;
    state.consecutiveFailures += 1;
    state.totalFailures += 1;
    if (state.consecutiveFailures >= failureThreshold()) {
      state.openedUntil = Date.now() + cooldownMs();
    }
    throw error;
  }
}

function isCircuitFailure(error: unknown): boolean {
  return !(
    typeof error === "object" &&
    error !== null &&
    "circuitFailure" in error &&
    (error as { circuitFailure?: unknown }).circuitFailure === false
  );
}

export function circuitBreakerStats(): Record<string, unknown> {
  const now = Date.now();
  return Object.fromEntries(
    [...circuits].map(([name, state]) => [
      name,
      {
        status: state.openedUntil > now ? "open" : state.consecutiveFailures ? "degraded" : "closed",
        consecutiveFailures: state.consecutiveFailures,
        retryAfterMs: Math.max(0, state.openedUntil - now),
        totalSuccesses: state.totalSuccesses,
        totalFailures: state.totalFailures,
      },
    ]),
  );
}

export function resetCircuitBreakers(): void {
  circuits.clear();
}

function getState(name: string): CircuitState {
  const existing = circuits.get(name);
  if (existing) return existing;
  const state = { consecutiveFailures: 0, openedUntil: 0, totalSuccesses: 0, totalFailures: 0 };
  circuits.set(name, state);
  return state;
}

function failureThreshold(): number {
  return integerEnv("WEATHER_CIRCUIT_FAILURES", 3, 1, 20);
}

function cooldownMs(): number {
  return integerEnv("WEATHER_CIRCUIT_COOLDOWN_MS", 60_000, 1_000, 600_000);
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
