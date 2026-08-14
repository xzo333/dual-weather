import { readAmapKey } from "./config.js";
import { fetchJson, UpstreamError } from "./http.js";
import type { GeocodeResult } from "./types.js";

interface AmapResponse {
  status?: string;
  info?: string;
  geocodes?: Array<{
    formatted_address?: string;
    location?: string;
  }>;
}

export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const normalizedAddress = address.trim();
  if (normalizedAddress.length < 2) {
    throw new Error("address 至少需要 2 个字符。");
  }

  const url = new URL("https://restapi.amap.com/v3/geocode/geo");
  url.searchParams.set("address", normalizedAddress);
  url.searchParams.set("key", readAmapKey());
  url.searchParams.set("output", "JSON");

  const data = await fetchJson<AmapResponse>("高德地理编码", url, 5_000);
  if (data.status !== "1") {
    throw new UpstreamError("高德地理编码", data.info || "接口返回失败");
  }

  const match = data.geocodes?.[0];
  const [lngRaw, latRaw] = match?.location?.split(",") ?? [];
  const lng = Number(lngRaw);
  const lat = Number(latRaw);
  if (!match || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new UpstreamError("高德地理编码", "未找到可用坐标");
  }

  const location_str = `${formatCoordinate(lng)},${formatCoordinate(lat)}`;
  return {
    formatted_address: match.formatted_address || normalizedAddress,
    lng,
    lat,
    location_str,
  };
}

function formatCoordinate(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}
