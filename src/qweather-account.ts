import { readQWeatherConfig } from "./config.js";
import { fetchQWeatherV1Raw, usesPublicLegacyHost } from "./qweather.js";

export type QWeatherAccountAction = "request_stats" | "finance_summary";

export interface QWeatherAccountQuery {
  action: QWeatherAccountAction;
  project?: string;
  credential?: string;
  balanceWarningBelow?: number;
  monthlyChargeWarningAbove?: number;
}

export async function queryQWeatherAccount(
  query: QWeatherAccountQuery,
): Promise<Record<string, unknown>> {
  const config = readQWeatherConfig();
  if (usesPublicLegacyHost(config.apiHost)) {
    throw new Error("和风控制台 API 需要控制台分配的自定义 QWEATHER_BASE_URL。");
  }
  const base = {
    auth: config.auth,
    apiHost: config.apiHost,
    timeoutMs: config.timeoutMs,
  };

  if (query.action === "request_stats") {
    if (query.project && query.credential) {
      throw new Error("request_stats 不能同时传 project 和 credential。");
    }
    const raw = await fetchQWeatherV1Raw(base, "metrics/v1/stats", "和风请求量统计", {
      ...(query.project ? { project: query.project } : {}),
      ...(query.credential ? { credential: query.credential } : {}),
    });
    const success = parseTrafficSeries(raw.success);
    const errors = parseTrafficSeries(raw.errors);
    const successTotal = success.reduce((sum, item) => sum + item.total, 0);
    const errorTotal = errors.reduce((sum, item) => sum + item.total, 0);
    return {
      action: query.action,
      asOf: raw.asOf,
      scope: query.project
        ? { project: query.project }
        : query.credential
          ? { credential: query.credential }
          : "account",
      totals: {
        success: successTotal,
        errors: errorTotal,
        errorRate: ratio(errorTotal, successTotal + errorTotal),
      },
      success,
      errors,
    };
  }

  const raw = await fetchQWeatherV1Raw(base, "finance/v1/summary", "和风财务汇总");
  const balance = number(raw.balance, 2);
  const monthCharge = number((raw.accruedCharges as any)?.thisMonth, 2);
  const alerts: string[] = [];
  if (
    query.balanceWarningBelow !== undefined &&
    balance !== null &&
    balance < query.balanceWarningBelow
  ) {
    alerts.push(`余额 ${balance} 低于阈值 ${query.balanceWarningBelow}`);
  }
  if (
    query.monthlyChargeWarningAbove !== undefined &&
    monthCharge !== null &&
    monthCharge > query.monthlyChargeWarningAbove
  ) {
    alerts.push(`本月累计费用 ${monthCharge} 高于阈值 ${query.monthlyChargeWarningAbove}`);
  }
  return {
    action: query.action,
    asOf: raw.asOf,
    currency: raw.currency,
    balance,
    accruedCharges: {
      previousDay: number((raw.accruedCharges as any)?.previousDay, 2),
      thisMonth: monthCharge,
      sinceLastBill: number((raw.accruedCharges as any)?.sinceLastBill, 2),
    },
    pendingBills: array(raw.pendingBills).map((item) => ({
      number: item.number,
      date: item.date,
      type: item.type,
      status: item.status,
      amount: number(item.amount, 2),
      amountDue: number(item.amountDue, 2),
      dueDate: item.dueDate,
    })),
    savingsPlans: array(raw.availableSavingsPlans).map(parsePlan),
    resourcePlans: array(raw.availableResourcePlans).map(parsePlan),
    alerts,
  };
}

function parseTrafficSeries(value: unknown): Array<{ api: string; total: number; hours: number[] }> {
  return array(value).map((item) => {
    const hours = array(item.hours).map((count) => number(count, 0) ?? 0);
    return { api: String(item.api ?? "unknown"), total: hours.reduce((sum, count) => sum + count, 0), hours };
  });
}

function parsePlan(item: any): Record<string, unknown> {
  return {
    billNumber: item.billNumber,
    status: item.status,
    term: item.term,
    commitments: number(item.commitments, 2),
    requests: number(item.requests, 0),
    utilized: number(item.utilized, 2),
    effectiveTime: item.effectiveTime,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 100 : 0;
}

function number(value: unknown, digits = 1): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}
