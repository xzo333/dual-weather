#!/usr/bin/env python3
"""Lightweight dual-provider weather adapter for the OpenClaw Skill.

Uses only the Python standard library. Credentials are read from environment
variables and are never included in output.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import gzip
import hashlib
import hmac
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable


VERSION = "0.13.0"
RETRYABLE_HTTP = {429, 502, 503, 504}
MAX_HTTP_BODY_BYTES = 8 * 1024 * 1024
DEFAULT_TOPICS = ("current", "hourly", "minutely", "alerts")
SUPPORTED_TOPICS = {
    "current",
    "hourly",
    "daily",
    "minutely",
    "alerts",
    "indices",
    "air",
    "radiation",
    "astronomy",
    "grid-hourly",
    "grid-daily",
}

SKYCON_MAP = {
    "CLEAR_DAY": "晴",
    "CLEAR_NIGHT": "晴",
    "PARTLY_CLOUDY_DAY": "多云",
    "PARTLY_CLOUDY_NIGHT": "多云",
    "CLOUDY": "阴",
    "LIGHT_HAZE": "轻度雾霾",
    "MODERATE_HAZE": "中度雾霾",
    "HEAVY_HAZE": "重度雾霾",
    "LIGHT_RAIN": "小雨",
    "MODERATE_RAIN": "中雨",
    "HEAVY_RAIN": "大雨",
    "STORM_RAIN": "暴雨",
    "FOG": "雾",
    "LIGHT_SNOW": "小雪",
    "MODERATE_SNOW": "中雪",
    "HEAVY_SNOW": "大雪",
    "STORM_SNOW": "暴雪",
    "DUST": "浮尘",
    "SAND": "沙尘",
    "WIND": "大风",
}


class WeatherError(Exception):
    def __init__(self, provider: str, message: str, status: int | str | None = None):
        super().__init__(message)
        self.provider = provider
        self.message = message
        self.status = status

    def as_dict(self, topic: str | None = None) -> dict[str, Any]:
        result: dict[str, Any] = {"provider": self.provider, "message": self.message}
        if topic:
            result["topic"] = topic
        if self.status is not None:
            result["status"] = self.status
        return result


def env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def json_output(value: Any, pretty: bool = False) -> None:
    print(
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2 if pretty else None,
            separators=None if pretty else (",", ":"),
        )
    )


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def compact_error_body(data: bytes) -> str | None:
    if not data:
        return None
    text = data[:4096].decode("utf-8", errors="replace")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        cleaned = re.sub(r"\s+", " ", text).strip()
        return cleaned[:180] or None
    if isinstance(payload, dict):
        for key in ("error", "message", "info", "reason"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:180]
        code = payload.get("code") or payload.get("status") or payload.get("infocode")
        if code is not None:
            return f"API status {code}"
    return None


def decode_http_body(
    data: bytes,
    headers: Any,
    provider: str,
    status: int | str | None,
) -> bytes:
    content_encoding = ""
    get_header = getattr(headers, "get", None)
    if callable(get_header):
        content_encoding = str(get_header("Content-Encoding", "") or "")
    encodings = [
        encoding.strip().lower()
        for encoding in content_encoding.split(",")
        if encoding.strip()
    ]
    if not encodings and data.startswith(b"\x1f\x8b"):
        encodings = ["gzip"]

    decoded = data
    for encoding in reversed(encodings):
        if encoding in ("identity", ""):
            continue
        if encoding not in ("gzip", "x-gzip"):
            raise WeatherError(
                provider,
                f"响应使用不支持的 Content-Encoding: {encoding}",
                status,
            )
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(decoded), mode="rb") as stream:
                decoded = stream.read(MAX_HTTP_BODY_BYTES + 1)
        except (EOFError, OSError, gzip.BadGzipFile) as exc:
            raise WeatherError(provider, "gzip 响应解压失败", status) from exc
        if len(decoded) > MAX_HTTP_BODY_BYTES:
            raise WeatherError(provider, "解压后的响应过大", status)
    return decoded


def read_http_body(
    response: Any,
    provider: str,
    status: int | str | None,
) -> bytes:
    raw = response.read(MAX_HTTP_BODY_BYTES + 1)
    if len(raw) > MAX_HTTP_BODY_BYTES:
        raise WeatherError(provider, "HTTP 响应过大", status)
    return decode_http_body(raw, getattr(response, "headers", {}), provider, status)


def http_json(
    provider: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 8.0,
    retries: int = 1,
) -> dict[str, Any]:
    request_headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "User-Agent": f"openclaw-dual-weather/{VERSION}",
        **(headers or {}),
    }
    for attempt in range(retries + 1):
        request = urllib.request.Request(url, headers=request_headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                status = getattr(response, "status", 200)
                if status == 204:
                    raise WeatherError(provider, "当前位置暂无可用数据", 204)
                raw = read_http_body(response, provider, status)
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise WeatherError(provider, "响应不是有效 JSON", status) from exc
                if not isinstance(payload, dict):
                    raise WeatherError(provider, "响应 JSON 顶层不是对象", status)
                return payload
        except urllib.error.HTTPError as exc:
            try:
                error_body = read_http_body(exc, provider, exc.code)
            except WeatherError:
                if exc.code in RETRYABLE_HTTP and attempt < retries:
                    time.sleep(0.25 * (2**attempt))
                    continue
                raise
            detail = compact_error_body(error_body)
            if exc.code in RETRYABLE_HTTP and attempt < retries:
                time.sleep(0.25 * (2**attempt))
                continue
            message = f"HTTP {exc.code}"
            if detail:
                message += f": {detail}"
            raise WeatherError(provider, message, exc.code) from exc
        except WeatherError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt < retries:
                time.sleep(0.25 * (2**attempt))
                continue
            reason = getattr(exc, "reason", None)
            message = "请求超时或网络不可用"
            if isinstance(reason, str) and reason:
                message = reason[:180]
            raise WeatherError(provider, message, "network") from exc
    raise WeatherError(provider, "请求失败", "unknown")


def validate_qweather_base(value: str) -> str:
    parsed = urllib.parse.urlsplit(value.rstrip("/"))
    hostname = (parsed.hostname or "").lower()
    allowed = hostname.endswith(".qweatherapi.com") or hostname in {
        "api.qweather.com",
        "devapi.qweather.com",
    }
    if (
        parsed.scheme != "https"
        or not allowed
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise WeatherError(
            "qweather",
            "QWEATHER_BASE_URL 必须是和风分配的 HTTPS API Host，且不要附加 /v7",
            "config",
        )
    path = parsed.path.rstrip("/")
    if path not in ("", "/"):
        raise WeatherError(
            "qweather",
            "QWEATHER_BASE_URL 只能包含主机名，不要附加接口路径",
            "config",
        )
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def query_url(base: str, path: str, params: dict[str, Any] | None = None) -> str:
    url = f"{base.rstrip('/')}/{path.lstrip('/')}"
    if params:
        clean = {key: value for key, value in params.items() if value is not None}
        url += "?" + urllib.parse.urlencode(clean)
    return url


def qweather_json(
    path: str,
    params: dict[str, Any],
    *,
    timeout: float,
) -> dict[str, Any]:
    key = env("QWEATHER_API_KEY")
    base_value = env("QWEATHER_BASE_URL")
    if not key or not base_value:
        raise WeatherError(
            "qweather",
            "缺少 QWEATHER_API_KEY 或 QWEATHER_BASE_URL",
            "config",
        )
    base = validate_qweather_base(base_value)
    payload = http_json(
        "qweather",
        query_url(base, path, params),
        headers={"X-QW-Api-Key": key},
        timeout=timeout,
    )
    code = payload.get("code")
    if code is not None and str(code) != "200":
        raise WeatherError("qweather", f"API 状态码 {code}", str(code))
    return payload


def caiyun_auth_state_for(
    app_key: str | None,
    app_secret: str | None,
    token: str | None,
) -> tuple[str | None, str | None]:
    if app_key and app_secret:
        return "hmac", None
    if token:
        warning = None
        if bool(app_key) != bool(app_secret):
            warning = "CAIYUN_APP_KEY 与 CAIYUN_APP_SECRET 必须成对配置；当前回退到旧 Token"
        return "token", warning
    if app_key or app_secret:
        return None, "CAIYUN_APP_KEY 与 CAIYUN_APP_SECRET 必须成对配置"
    return None, None


def caiyun_auth_state() -> tuple[str | None, str | None]:
    return caiyun_auth_state_for(
        env("CAIYUN_APP_KEY"),
        env("CAIYUN_APP_SECRET"),
        env("CAIYUN_WEATHER_API_TOKEN"),
    )


def canonical_query(params: dict[str, Any]) -> str:
    return "&".join(
        f"{urllib.parse.quote_plus(str(key), safe='')}="
        f"{urllib.parse.quote_plus(str(params[key]), safe='')}"
        for key in sorted(params)
        if params[key] is not None
    )


def caiyun_signature(
    app_key: str,
    app_secret: str,
    method: str,
    path: str,
    nonce: str,
    timestamp: str,
    params: dict[str, Any],
) -> str:
    string_to_sign = ":".join(
        (method, path, canonical_query(params), app_key, nonce, timestamp)
    )
    digest = hmac.new(
        app_secret.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii")


def caiyun_hourly_steps(hours: int) -> int:
    return max(24, min(360, math.ceil(hours / 24) * 24))


def retryable_weather_error(exc: WeatherError) -> bool:
    return exc.status in RETRYABLE_HTTP or exc.status == "network"


def caiyun_json(
    lng: float,
    lat: float,
    *,
    hours: int,
    days: int,
    timeout: float,
) -> dict[str, Any]:
    auth_mode, auth_warning = caiyun_auth_state()
    if not auth_mode:
        message = auth_warning or (
            "缺少 CAIYUN_APP_KEY + CAIYUN_APP_SECRET，或兼容用 CAIYUN_WEATHER_API_TOKEN"
        )
        raise WeatherError("caiyun", message, "config")
    location = f"{format_coord(lng)},{format_coord(lat)}"
    params = {
        "alert": "true",
        "dailysteps": min(days, 15),
        "hourlysteps": caiyun_hourly_steps(hours),
        "unit": "metric:v2",
    }

    if auth_mode == "hmac":
        app_key = env("CAIYUN_APP_KEY") or ""
        app_secret = env("CAIYUN_APP_SECRET") or ""
        safe_app_key = urllib.parse.quote(app_key, safe="")
        path = f"/v2.6/{safe_app_key}/{location}/weather"
        url = f"https://api.caiyunapp.com{path}?{canonical_query(params)}"
        payload = None
        for attempt in range(2):
            nonce = str(uuid.uuid4())
            timestamp = str(int(time.time()))
            headers = {
                "x-cy-nonce": nonce,
                "x-cy-timestamp": timestamp,
                "x-cy-signature": caiyun_signature(
                    app_key,
                    app_secret,
                    "GET",
                    path,
                    nonce,
                    timestamp,
                    params,
                ),
            }
            try:
                payload = http_json(
                    "caiyun", url, headers=headers, timeout=timeout, retries=0
                )
                break
            except WeatherError as exc:
                if attempt == 0 and retryable_weather_error(exc):
                    time.sleep(0.25)
                    continue
                raise
        if payload is None:  # defensive boundary
            raise WeatherError("caiyun", "请求失败", "unknown")
    else:
        token = env("CAIYUN_WEATHER_API_TOKEN") or ""
        safe_token = urllib.parse.quote(token, safe="")
        url = query_url(
            f"https://api.caiyunapp.com/v2.6/{safe_token}/{location}",
            "weather.json",
            params,
        )
        payload = http_json("caiyun", url, timeout=timeout)

    if payload.get("status") != "ok" or not isinstance(payload.get("result"), dict):
        message = payload.get("error") if isinstance(payload.get("error"), str) else "接口返回失败"
        raise WeatherError("caiyun", message, payload.get("status"))
    return payload


def amap_geocode(address: str, timeout: float) -> dict[str, Any]:
    key = env("AMAP_KEY")
    if not key:
        raise WeatherError("amap", "解析新地址需要 AMAP_KEY", "config")
    url = query_url(
        "https://restapi.amap.com",
        "/v3/geocode/geo",
        {"key": key, "address": address},
    )
    payload = http_json("amap", url, timeout=timeout)
    geocodes = payload.get("geocodes")
    if payload.get("status") != "1" or not isinstance(geocodes, list) or not geocodes:
        message = payload.get("info") if isinstance(payload.get("info"), str) else "地址解析失败"
        raise WeatherError("amap", message, payload.get("infocode"))
    candidates = [item for item in geocodes[:5] if isinstance(item, dict)]
    item = candidates[0] if candidates else {}
    location = item.get("location")
    if not isinstance(location, str) or "," not in location:
        raise WeatherError("amap", "地址结果缺少有效坐标", "invalid_response")
    lng_text, lat_text = location.split(",", 1)
    lng = finite_number(lng_text)
    lat = finite_number(lat_text)
    if lng is None or lat is None:
        raise WeatherError("amap", "地址坐标格式无效", "invalid_response")
    validate_coordinates(lng, lat)
    result = {
        "source": "amap",
        "query": address,
        "formattedAddress": text(item.get("formatted_address")) or address,
        "province": text(item.get("province")),
        "city": text(item.get("city")),
        "district": text(item.get("district")),
        "lng": round(lng, 6),
        "lat": round(lat, 6),
    }
    if len(candidates) > 1:
        result["ambiguous"] = True
        result["candidateCount"] = len(geocodes)
        result["candidates"] = [
            clean_dict(
                {
                    "formattedAddress": text(candidate.get("formatted_address")),
                    "province": text(candidate.get("province")),
                    "city": text(candidate.get("city")),
                    "district": text(candidate.get("district")),
                }
            )
            for candidate in candidates[:3]
        ]
    return result


def qweather_geocode(address: str, timeout: float) -> dict[str, Any]:
    payload = qweather_json(
        "/geo/v2/city/lookup",
        {"location": address, "number": 5, "lang": "zh"},
        timeout=timeout,
    )
    candidates = [
        item for item in array(payload.get("location"))[:5] if isinstance(item, dict)
    ]
    if not candidates:
        raise WeatherError("qweather-geo", "未找到匹配的城市或区县", "not_found")
    ranked = sorted(
        enumerate(candidates),
        key=lambda pair: (-qweather_candidate_score(address, pair[1]), pair[0]),
    )
    candidates = [candidate for _, candidate in ranked]
    top_score = qweather_candidate_score(address, candidates[0])
    plausible = [
        candidate
        for candidate in candidates
        if qweather_candidate_score(address, candidate) == top_score
    ]
    item = candidates[0]
    lng = finite_number(item.get("lon"))
    lat = finite_number(item.get("lat"))
    if lng is None or lat is None:
        raise WeatherError("qweather-geo", "城市结果缺少有效坐标", "invalid_response")
    validate_coordinates(lng, lat)

    def formatted(candidate: dict[str, Any]) -> str:
        parts: list[str] = []
        for value in (
            text(candidate.get("country")),
            text(candidate.get("adm1")),
            text(candidate.get("adm2")),
            text(candidate.get("name")),
        ):
            if value and value not in parts:
                parts.append(value)
        return " ".join(parts) or address

    result: dict[str, Any] = {
        "source": "qweather-geo",
        "query": address,
        "formattedAddress": formatted(item),
        "name": text(item.get("name")),
        "locationId": text(item.get("id")),
        "province": text(item.get("adm1")),
        "city": text(item.get("adm2")),
        "country": text(item.get("country")),
        "timezone": text(item.get("tz")),
        "lng": round(lng, 6),
        "lat": round(lat, 6),
    }
    if len(plausible) > 1:
        result["ambiguous"] = True
        result["candidateCount"] = len(plausible)
        result["candidates"] = [
            clean_dict(
                {
                    "formattedAddress": formatted(candidate),
                    "name": text(candidate.get("name")),
                    "locationId": text(candidate.get("id")),
                    "province": text(candidate.get("adm1")),
                    "city": text(candidate.get("adm2")),
                    "lng": number(candidate.get("lon"), 6),
                    "lat": number(candidate.get("lat"), 6),
                }
            )
            for candidate in plausible[:3]
        ]
    return result


PLACE_SUFFIXES = re.compile(
    r"(特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|自治县|省|市|区|县|州|盟)$"
)


def normalize_place_name(value: Any) -> str:
    normalized = re.sub(r"\s+", "", text(value) or "")
    previous = None
    while normalized and normalized != previous:
        previous = normalized
        normalized = PLACE_SUFFIXES.sub("", normalized)
    return normalized


def qweather_candidate_score(query: str, candidate: dict[str, Any]) -> int:
    normalized_query = normalize_place_name(query)
    name = normalize_place_name(candidate.get("name"))
    adm2 = normalize_place_name(candidate.get("adm2"))
    adm1 = normalize_place_name(candidate.get("adm1"))
    country = normalize_place_name(candidate.get("country"))
    score = 0
    if name and name in normalized_query:
        score += 8
    if adm2 and adm2 != name and adm2 in normalized_query:
        score += 4
    if adm1 and adm1 not in (name, adm2) and adm1 in normalized_query:
        score += 2
    if country and country not in (name, adm2, adm1) and country in normalized_query:
        score += 1
    return score


DETAILED_ADDRESS_MARKERS = (
    "路",
    "街",
    "街道",
    "大道",
    "巷",
    "弄",
    "号",
    "小区",
    "社区",
    "大厦",
    "广场",
    "中心",
    "医院",
    "学校",
    "大学",
    "机场",
    "车站",
    "园区",
    "苑",
    "楼",
    "栋",
    "室",
    "商场",
    "酒店",
)


def classify_location(address: str) -> str:
    normalized = re.sub(r"\s+", "", address)
    if any(marker in normalized for marker in DETAILED_ADDRESS_MARKERS):
        return "address"
    if re.search(r"\d", normalized):
        return "address"
    return "city"


def resolve_location(address: str, location_type: str, timeout: float) -> dict[str, Any]:
    selected_type = classify_location(address) if location_type == "auto" else location_type
    if selected_type == "address":
        return amap_geocode(address, timeout)

    qweather_ready = bool(env("QWEATHER_API_KEY") and env("QWEATHER_BASE_URL"))
    if qweather_ready:
        try:
            return qweather_geocode(address, timeout)
        except WeatherError:
            if not env("AMAP_KEY"):
                raise
    if env("AMAP_KEY"):
        return amap_geocode(address, timeout)
    raise WeatherError(
        "location",
        "城市/区县解析需要 QWEATHER_API_KEY + QWEATHER_BASE_URL；详细地址则需要 AMAP_KEY",
        "config",
    )


def finite_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def number(value: Any, digits: int = 1) -> float | int | None:
    parsed = finite_number(value)
    if parsed is None:
        return None
    rounded = round(parsed, digits)
    return int(rounded) if rounded.is_integer() else rounded


def percent(value: Any, fractional: bool = False) -> float | int | None:
    parsed = finite_number(value)
    if parsed is None:
        return None
    if fractional and 0 <= parsed <= 1:
        parsed *= 100
    return number(max(0, min(100, parsed)), 1)


def pressure_hpa(value: Any) -> float | int | None:
    parsed = finite_number(value)
    if parsed is None:
        return None
    if parsed > 2_000:
        parsed /= 100
    return number(parsed, 1)


def text(value: Any) -> str | None:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return None


def array(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def at(value: Any, index: int) -> dict[str, Any]:
    items = array(value)
    if 0 <= index < len(items) and isinstance(items[index], dict):
        return items[index]
    return {}


def clean_dict(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None and item != ""}


def skycon(value: Any) -> str | None:
    code = text(value)
    return SKYCON_MAP.get(code, code) if code else None


def format_coord(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".")


def format_qweather_coord(value: float) -> str:
    return f"{value:.2f}"


def validate_coordinates(lng: float, lat: float) -> None:
    if not (-180 <= lng <= 180 and -90 <= lat <= 90):
        raise WeatherError("location", "经纬度超出有效范围", "input")


def qweather_hour_bucket(hours: int) -> int:
    if hours <= 24:
        return 24
    if hours <= 72:
        return 72
    return 168


def qweather_day_bucket(days: int) -> int:
    for option in (3, 7, 10, 15, 30):
        if days <= option:
            return option
    return 30


def parse_topics(raw: str) -> tuple[str, ...]:
    topics = tuple(dict.fromkeys(part.strip().lower() for part in raw.split(",") if part.strip()))
    if not topics:
        raise WeatherError("input", "topics 不能为空", "input")
    unsupported = sorted(set(topics) - SUPPORTED_TOPICS)
    if unsupported:
        raise WeatherError(
            "input",
            f"不支持的 topics: {', '.join(unsupported)}",
            "input",
        )
    return topics


def qweather_tasks(
    topics: tuple[str, ...],
    lng: float,
    lat: float,
    hours: int,
    days: int,
    date: str,
    timeout: float,
) -> dict[str, Callable[[], dict[str, Any]]]:
    q_lng = format_qweather_coord(lng)
    q_lat = format_qweather_coord(lat)
    location = f"{q_lng},{q_lat}"
    tasks: dict[str, Callable[[], dict[str, Any]]] = {}

    def add(label: str, path: str, params: dict[str, Any]) -> None:
        tasks[label] = lambda path=path, params=params: qweather_json(
            path, params, timeout=timeout
        )

    if "current" in topics:
        add("current", "/v7/weather/now", {"location": location})
    if "hourly" in topics:
        add(
            "hourly",
            f"/v7/weather/{qweather_hour_bucket(hours)}h",
            {"location": location},
        )
    if "daily" in topics:
        add(
            "daily",
            f"/v7/weather/{qweather_day_bucket(days)}d",
            {"location": location},
        )
    if "minutely" in topics:
        add("minutely", "/v7/minutely/5m", {"location": location})
    if "alerts" in topics:
        add(
            "alerts",
            f"/weatheralert/v1/current/{q_lat}/{q_lng}",
            {"localTime": "true", "lang": "zh"},
        )
    if "indices" in topics:
        add(
            "indices",
            f"/v7/indices/{1 if days <= 1 else 3}d",
            {"location": location, "type": "0"},
        )
    if "air" in topics:
        add(
            "air",
            f"/airquality/v1/current/{q_lat}/{q_lng}",
            {},
        )
    if "grid-hourly" in topics:
        add(
            "gridHourly",
            f"/v7/grid-weather/{24 if hours <= 24 else 72}h",
            {"location": location},
        )
    if "grid-daily" in topics:
        add(
            "gridDaily",
            f"/v7/grid-weather/{3 if days <= 3 else 7}d",
            {"location": location},
        )
    if "radiation" in topics:
        add(
            "radiation",
            f"/solarradiation/v1/forecast/{q_lat}/{q_lng}",
            {
                "hours": min(hours, 60),
                "interval": 60,
                "localTime": "true",
                "extra": "weather",
            },
        )
    if "astronomy" in topics:
        add("sun", "/v7/astronomy/sun", {"location": location, "date": date})
        add("moon", "/v7/astronomy/moon", {"location": location, "date": date})
    return tasks


def run_tasks(
    tasks: dict[str, tuple[str, Callable[[], dict[str, Any]]]],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    results: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, Any]] = []
    if not tasks:
        return results, errors
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(tasks))) as pool:
        future_map = {
            pool.submit(call): (label, provider)
            for label, (provider, call) in tasks.items()
        }
        for future in concurrent.futures.as_completed(future_map):
            label, provider = future_map[future]
            try:
                results[label] = future.result()
            except WeatherError as exc:
                errors.append(exc.as_dict(label))
            except Exception as exc:  # defensive boundary: never leak request details
                errors.append(
                    {
                        "provider": provider,
                        "topic": label,
                        "message": f"未处理错误: {type(exc).__name__}",
                    }
                )
    return results, sorted(errors, key=lambda item: (str(item.get("provider")), str(item.get("topic"))))


def normalize_qweather(
    results: dict[str, dict[str, Any]],
    topics: tuple[str, ...],
    hours: int,
    days: int,
) -> dict[str, Any]:
    output: dict[str, Any] = {}
    if "current" in results:
        now = results["current"].get("now")
        now = now if isinstance(now, dict) else {}
        output["current"] = clean_dict(
            {
                "observationTime": text(now.get("obsTime")),
                "temperature": number(now.get("temp")),
                "feelsLike": number(now.get("feelsLike")),
                "weather": text(now.get("text")),
                "humidity": percent(now.get("humidity")),
                "precipitationAmount": number(now.get("precip"), 2),
                "wind": " ".join(
                    part for part in (text(now.get("windDir")), text(now.get("windScale"))) if part
                )
                or None,
                "visibility": number(now.get("vis"), 1),
                "pressure": number(now.get("pressure"), 1),
            }
        )
    if "hourly" in results:
        output["hourly"] = [
            clean_dict(
                {
                    "time": text(item.get("fxTime")),
                    "temperature": number(item.get("temp")),
                    "weather": text(item.get("text")),
                    "precipitationProbability": percent(item.get("pop")),
                    "precipitationAmount": number(item.get("precip"), 2),
                    "humidity": percent(item.get("humidity")),
                    "windDirection": text(item.get("windDir")),
                    "windScale": text(item.get("windScale")),
                }
            )
            for item in array(results["hourly"].get("hourly"))[:hours]
            if isinstance(item, dict)
        ]
    if "daily" in results:
        output["daily"] = [
            clean_dict(
                {
                    "date": text(item.get("fxDate")),
                    "temperatureMin": number(item.get("tempMin")),
                    "temperatureMax": number(item.get("tempMax")),
                    "weatherDay": text(item.get("textDay")),
                    "weatherNight": text(item.get("textNight")),
                    "precipitationAmount": number(item.get("precip"), 2),
                    "humidity": percent(item.get("humidity")),
                    "uvIndex": number(item.get("uvIndex")),
                    "sunrise": text(item.get("sunrise")),
                    "sunset": text(item.get("sunset")),
                }
            )
            for item in array(results["daily"].get("daily"))[:days]
            if isinstance(item, dict)
        ]
    if "minutely" in results:
        raw = results["minutely"]
        output["minutely"] = {
            "summary": text(raw.get("summary")),
            "points": [
                clean_dict(
                    {
                        "time": text(item.get("fxTime")),
                        "precipitationAmount": number(item.get("precip"), 2),
                        "type": text(item.get("type")),
                    }
                )
                for item in array(raw.get("minutely"))[:24]
                if isinstance(item, dict)
            ],
        }
    if "alerts" in results:
        raw_alerts = results["alerts"]
        metadata = raw_alerts.get("metadata")
        metadata = metadata if isinstance(metadata, dict) else {}
        output["alerts"] = [
            clean_dict(
                {
                    "id": text(item.get("id")),
                    "senderName": text(item.get("senderName")),
                    "issuedTime": text(item.get("issuedTime")),
                    "messageType": text((item.get("messageType") or {}).get("code")),
                    "eventType": text((item.get("eventType") or {}).get("name")),
                    "eventCode": text((item.get("eventType") or {}).get("code")),
                    "urgency": text(item.get("urgency")),
                    "severity": text(item.get("severity")),
                    "certainty": text(item.get("certainty")),
                    "color": text((item.get("color") or {}).get("code")),
                    "effectiveTime": text(item.get("effectiveTime")),
                    "onsetTime": text(item.get("onsetTime")),
                    "expireTime": text(item.get("expireTime")),
                    "headline": text(item.get("headline")),
                    "description": (text(item.get("description")) or "")[:500] or None,
                    "instruction": (text(item.get("instruction")) or "")[:500] or None,
                }
            )
            for item in array(raw_alerts.get("alerts"))[:5]
            if isinstance(item, dict)
        ]
        output["alertMetadata"] = clean_dict(
            {
                "tag": text(metadata.get("tag")),
                "zeroResult": metadata.get("zeroResult")
                if isinstance(metadata.get("zeroResult"), bool)
                else None,
                "attributions": [
                    attribution
                    for attribution in (text(value) for value in array(metadata.get("attributions")))
                    if attribution
                ],
            }
        )
    if "indices" in results:
        output["indices"] = [
            clean_dict(
                {
                    "date": text(item.get("date")),
                    "type": text(item.get("type")),
                    "name": text(item.get("name")),
                    "level": text(item.get("level")),
                    "category": text(item.get("category")),
                    "text": (text(item.get("text")) or "")[:220] or None,
                }
            )
            for item in array(results["indices"].get("daily"))[:48]
            if isinstance(item, dict)
        ]
    if "air" in results:
        output["air"] = normalize_qweather_air(results["air"])
    if "gridHourly" in results:
        output["gridHourly"] = [
            clean_dict(
                {
                    "time": text(item.get("fxTime")),
                    "temperature": number(item.get("temp")),
                    "weather": text(item.get("text")),
                    "humidity": percent(item.get("humidity")),
                    "precipitationAmount": number(item.get("precip"), 2),
                    "windDirection": text(item.get("windDir")),
                    "windScale": text(item.get("windScale")),
                }
            )
            for item in array(results["gridHourly"].get("hourly"))[: min(hours, 72)]
            if isinstance(item, dict)
        ]
    if "gridDaily" in results:
        output["gridDaily"] = [
            clean_dict(
                {
                    "date": text(item.get("fxDate")),
                    "temperatureMin": number(item.get("tempMin")),
                    "temperatureMax": number(item.get("tempMax")),
                    "weatherDay": text(item.get("textDay")),
                    "weatherNight": text(item.get("textNight")),
                    "precipitationAmount": number(item.get("precip"), 2),
                    "humidity": percent(item.get("humidity")),
                }
            )
            for item in array(results["gridDaily"].get("daily"))[: min(days, 7)]
            if isinstance(item, dict)
        ]
    if "radiation" in results:
        output["radiation"] = [
            clean_dict(
                {
                    "time": text(item.get("forecastTime")),
                    "solarAzimuth": number((item.get("solarAngle") or {}).get("azimuth"), 2),
                    "solarElevation": number((item.get("solarAngle") or {}).get("elevation"), 2),
                    "dni": number((item.get("dni") or {}).get("value"), 2),
                    "dhi": number((item.get("dhi") or {}).get("value"), 2),
                    "ghi": number((item.get("ghi") or {}).get("value"), 2),
                }
            )
            for item in array(results["radiation"].get("forecasts"))[: min(hours, 60)]
            if isinstance(item, dict)
        ]
    if "astronomy" in topics and ("sun" in results or "moon" in results):
        sun = results.get("sun", {})
        moon = results.get("moon", {})
        output["astronomy"] = clean_dict(
            {
                "sunrise": text(sun.get("sunrise")),
                "sunset": text(sun.get("sunset")),
                "moonrise": text(moon.get("moonrise")),
                "moonset": text(moon.get("moonset")),
                "moonPhases": [
                    clean_dict(
                        {
                            "time": text(item.get("fxTime")),
                            "name": text(item.get("name")),
                            "illumination": percent(item.get("illumination")),
                        }
                    )
                    for item in array(moon.get("moonPhase"))[:24]
                    if isinstance(item, dict)
                ],
            }
        )
    return output


def normalize_qweather_air(raw: dict[str, Any]) -> dict[str, Any]:
    indexes = array(raw.get("indexes"))
    pollutants = array(raw.get("pollutants"))
    if indexes or pollutants:
        return {
            "indexes": [
                clean_dict(
                    {
                        "code": text(item.get("code")),
                        "name": text(item.get("name")),
                        "aqi": number(item.get("aqi")),
                        "level": text(item.get("level")),
                        "category": text(item.get("category")),
                        "primaryPollutant": text((item.get("primaryPollutant") or {}).get("name")),
                        "healthAdvice": text(
                            ((item.get("health") or {}).get("advice") or {}).get("generalPopulation")
                        ),
                    }
                )
                for item in indexes
                if isinstance(item, dict)
            ],
            "pollutants": [
                clean_dict(
                    {
                        "code": text(item.get("code")),
                        "name": text(item.get("name")),
                        "concentration": number((item.get("concentration") or {}).get("value"), 2),
                        "unit": text((item.get("concentration") or {}).get("unit")),
                    }
                )
                for item in pollutants
                if isinstance(item, dict)
            ],
        }
    current = raw.get("now") if isinstance(raw.get("now"), dict) else raw
    return clean_dict(
        {
            "aqi": number(current.get("aqi")),
            "category": text(current.get("category")),
            "primaryPollutant": text(current.get("primary")),
            "pm25": number(current.get("pm2p5")),
            "pm10": number(current.get("pm10")),
            "o3": number(current.get("o3")),
            "no2": number(current.get("no2")),
            "so2": number(current.get("so2")),
            "co": number(current.get("co"), 2),
        }
    )


def normalize_caiyun(
    payload: dict[str, Any],
    topics: tuple[str, ...],
    hours: int,
    days: int,
) -> dict[str, Any]:
    result = payload.get("result")
    result = result if isinstance(result, dict) else {}
    output: dict[str, Any] = {}
    realtime = result.get("realtime") if isinstance(result.get("realtime"), dict) else {}
    hourly = result.get("hourly") if isinstance(result.get("hourly"), dict) else {}
    daily = result.get("daily") if isinstance(result.get("daily"), dict) else {}

    if "current" in topics:
        output["current"] = clean_dict(
            {
                "temperature": number(realtime.get("temperature")),
                "feelsLike": number(
                    realtime.get("apparent_temperature", realtime.get("apparent_temperatures"))
                ),
                "weather": skycon(realtime.get("skycon")),
                "humidity": percent(realtime.get("humidity"), True),
                "precipitationIntensity": number(
                    ((realtime.get("precipitation") or {}).get("local") or {}).get("intensity"),
                    2,
                ),
                "visibility": number(realtime.get("visibility"), 1),
                "pressure": pressure_hpa(realtime.get("pressure")),
                "comfort": text(((realtime.get("life_index") or {}).get("comfort") or {}).get("desc")),
                "uv": text(
                    ((realtime.get("life_index") or {}).get("ultraviolet") or {}).get("desc")
                ),
                "aqiChina": number(((realtime.get("air_quality") or {}).get("aqi") or {}).get("chn")),
            }
        )
        keypoint = text(result.get("forecast_keypoint"))
        if keypoint:
            output["keypoint"] = keypoint
    if "hourly" in topics:
        temperatures = array(hourly.get("temperature"))
        output["hourly"] = [
            clean_dict(
                {
                    "time": text(item.get("datetime")),
                    "temperature": number(item.get("value")),
                    "feelsLike": number(at(hourly.get("apparent_temperature"), index).get("value")),
                    "weather": skycon(at(hourly.get("skycon"), index).get("value")),
                    "humidity": percent(at(hourly.get("humidity"), index).get("value"), True),
                    "precipitationProbability": percent(
                        at(hourly.get("precipitation"), index).get("probability"), False
                    ),
                    "precipitationIntensity": number(
                        at(hourly.get("precipitation"), index).get("value"), 2
                    ),
                    "windSpeed": number(at(hourly.get("wind"), index).get("speed"), 2),
                    "windDirection": number(at(hourly.get("wind"), index).get("direction")),
                    "radiation": number(at(hourly.get("dswrf"), index).get("value"), 2),
                    "aqiChina": number(
                        ((at((hourly.get("air_quality") or {}).get("aqi"), index).get("value") or {}).get("chn"))
                    ),
                }
            )
            for index, item in enumerate(temperatures[:hours])
            if isinstance(item, dict)
        ]
        description = text(hourly.get("description"))
        if description:
            output["hourlyDescription"] = description
    if "daily" in topics:
        temperatures = array(daily.get("temperature"))
        output["daily"] = [
            clean_dict(
                {
                    "date": text(item.get("date")),
                    "temperatureMin": number(item.get("min")),
                    "temperatureAverage": number(item.get("avg")),
                    "temperatureMax": number(item.get("max")),
                    "weather": skycon(at(daily.get("skycon"), index).get("value")),
                    "precipitationProbabilityRaw": number(
                        at(daily.get("precipitation"), index).get("probability"), 3
                    ),
                    "precipitationIntensityAverage": number(
                        at(daily.get("precipitation"), index).get("avg"), 2
                    ),
                    "humidityAverage": percent(
                        at(daily.get("humidity"), index).get("avg"), True
                    ),
                    "radiationAverage": number(at(daily.get("dswrf"), index).get("avg"), 2),
                    "sunrise": text((at(daily.get("astro"), index).get("sunrise") or {}).get("time")),
                    "sunset": text((at(daily.get("astro"), index).get("sunset") or {}).get("time")),
                }
            )
            for index, item in enumerate(temperatures[:days])
            if isinstance(item, dict)
        ]
    if "minutely" in topics:
        minutely = result.get("minutely") if isinstance(result.get("minutely"), dict) else {}
        precipitation = array((minutely.get("precipitation_2h") or []))
        probability = array(minutely.get("probability"))
        output["minutely"] = {
            "summary": text(minutely.get("description")),
            "points": [
                {"minutesFromNow": index, "precipitationIntensity": number(value, 3)}
                for index, value in enumerate(precipitation[:120])
                if index % 5 == 0
            ],
            "probability": [
                {
                    "minutesFromNow": index * 30,
                    "probability": percent(value, True),
                }
                for index, value in enumerate(probability[:4])
            ],
        }
    if "alerts" in topics:
        alert = result.get("alert") if isinstance(result.get("alert"), dict) else {}
        output["alerts"] = [
            clean_dict(
                {
                    "title": text(item.get("title")),
                    "code": text(item.get("code")),
                    "status": text(item.get("status")),
                    "location": text(item.get("location")),
                    "description": (text(item.get("description")) or "")[:300] or None,
                }
            )
            for item in array(alert.get("content"))[:5]
            if isinstance(item, dict)
        ]
    if "indices" in topics:
        life = daily.get("life_index") if isinstance(daily.get("life_index"), dict) else {}
        output["indices"] = {
            name: [
                clean_dict(
                    {
                        "date": text(item.get("date")),
                        "index": text(item.get("index")),
                        "description": text(item.get("desc")),
                    }
                )
                for item in array(values)[:days]
                if isinstance(item, dict)
            ]
            for name, values in life.items()
            if isinstance(values, list)
        }
    if "air" in topics:
        air = realtime.get("air_quality") if isinstance(realtime.get("air_quality"), dict) else {}
        output["air"] = clean_dict(
            {
                "aqiChina": number((air.get("aqi") or {}).get("chn")),
                "aqiUsa": number((air.get("aqi") or {}).get("usa")),
                "pm25": number(air.get("pm25")),
                "pm10": number(air.get("pm10")),
                "o3": number(air.get("o3")),
                "no2": number(air.get("no2")),
                "so2": number(air.get("so2")),
                "co": number(air.get("co"), 2),
            }
        )
    if "radiation" in topics:
        output["radiation"] = {
            "realtimeDswrf": number(realtime.get("dswrf"), 2),
            "hourly": [
                clean_dict(
                    {"time": text(item.get("datetime")), "dswrf": number(item.get("value"), 2)}
                )
                for item in array(hourly.get("dswrf"))[:hours]
                if isinstance(item, dict)
            ],
        }
    if "astronomy" in topics:
        output["astronomy"] = [
            clean_dict(
                {
                    "date": text(item.get("date")),
                    "sunrise": text((item.get("sunrise") or {}).get("time")),
                    "sunset": text((item.get("sunset") or {}).get("time")),
                }
            )
            for item in array(daily.get("astro"))[:days]
            if isinstance(item, dict)
        ]
    return output


def command_check(args: argparse.Namespace) -> int:
    variables = {
        name: bool(env(name))
        for name in (
            "AMAP_KEY",
            "QWEATHER_API_KEY",
            "QWEATHER_BASE_URL",
            "CAIYUN_APP_KEY",
            "CAIYUN_APP_SECRET",
            "CAIYUN_WEATHER_API_TOKEN",
        )
    }
    qweather_host_valid = False
    host_error = None
    if variables["QWEATHER_BASE_URL"]:
        try:
            validate_qweather_base(env("QWEATHER_BASE_URL") or "")
            qweather_host_valid = True
        except WeatherError as exc:
            host_error = exc.message
    caiyun_auth_mode, caiyun_config_error = caiyun_auth_state()
    qweather_ready = variables["QWEATHER_API_KEY"] and qweather_host_valid
    json_output(
        {
            "ok": True,
            "version": VERSION,
            "python": sys.version.split()[0],
            "credentials": variables,
            "geocodingReady": variables["AMAP_KEY"] or qweather_ready,
            "cityGeocodingReady": qweather_ready or variables["AMAP_KEY"],
            "detailedAddressGeocodingReady": variables["AMAP_KEY"],
            "qweatherReady": qweather_ready,
            "caiyunReady": caiyun_auth_mode is not None,
            "caiyunAuthMode": caiyun_auth_mode,
            "caiyunConfigurationError": caiyun_config_error,
            "qweatherHostError": host_error,
        },
        args.pretty,
    )
    return 0


def command_query(args: argparse.Namespace) -> int:
    topics = parse_topics(args.topics)
    if args.date and not re.fullmatch(r"\d{8}", args.date):
        raise WeatherError("input", "date 必须是 yyyyMMdd", "input")
    date = args.date or dt.datetime.now().strftime("%Y%m%d")

    if args.address:
        location = resolve_location(
            args.address.strip(), args.location_type, args.timeout
        )
        lng = float(location["lng"])
        lat = float(location["lat"])
    elif args.lng is not None and args.lat is not None:
        lng, lat = float(args.lng), float(args.lat)
        validate_coordinates(lng, lat)
        location = {
            "source": "provided",
            "lng": round(lng, 6),
            "lat": round(lat, 6),
        }
    else:
        raise WeatherError(
            "input",
            "必须提供 --address，或同时提供 --lng 与 --lat",
            "input",
        )

    tasks: dict[str, tuple[str, Callable[[], dict[str, Any]]]] = {}
    configuration_errors: list[dict[str, Any]] = []

    if args.provider in ("both", "qweather"):
        if env("QWEATHER_API_KEY") and env("QWEATHER_BASE_URL"):
            try:
                validate_qweather_base(env("QWEATHER_BASE_URL") or "")
            except WeatherError as exc:
                configuration_errors.append(exc.as_dict())
            else:
                for label, call in qweather_tasks(
                    topics, lng, lat, args.hours, args.days, date, args.timeout
                ).items():
                    tasks[f"qweather:{label}"] = ("qweather", call)
        else:
            configuration_errors.append(
                WeatherError(
                    "qweather",
                    "缺少 QWEATHER_API_KEY 或 QWEATHER_BASE_URL",
                    "config",
                ).as_dict()
            )

    if args.provider in ("both", "caiyun"):
        caiyun_auth_mode, caiyun_config_error = caiyun_auth_state()
        if caiyun_config_error:
            configuration_errors.append(
                WeatherError("caiyun", caiyun_config_error, "config").as_dict()
            )
        if caiyun_auth_mode:
            tasks["caiyun:weather"] = (
                "caiyun",
                lambda: caiyun_json(
                    lng,
                    lat,
                    hours=args.hours,
                    days=args.days,
                    timeout=args.timeout,
                ),
            )
        else:
            if not caiyun_config_error:
                configuration_errors.append(
                    WeatherError(
                        "caiyun",
                        "缺少 CAIYUN_APP_KEY + CAIYUN_APP_SECRET，或兼容用 CAIYUN_WEATHER_API_TOKEN",
                        "config",
                    ).as_dict()
                )

    results, request_errors = run_tasks(tasks)
    qweather_raw = {
        label.split(":", 1)[1]: value
        for label, value in results.items()
        if label.startswith("qweather:")
    }
    providers: dict[str, Any] = {}
    qweather_data = normalize_qweather(qweather_raw, topics, args.hours, args.days)
    if qweather_data:
        providers["qweather"] = qweather_data
    if "caiyun:weather" in results:
        providers["caiyun"] = normalize_caiyun(
            results["caiyun:weather"], topics, args.hours, args.days
        )

    output = {
        "location": location,
        "queryTime": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "topics": list(topics),
        "providers": providers,
        "errors": configuration_errors + request_errors,
        "units": {
            "temperature": "°C",
            "humidity": "%",
            "precipitationAmount": "mm",
            "precipitationIntensity": "mm/h",
            "probability": "%",
            "precipitationProbabilityRaw": "provider-defined",
            "radiation": "W/m²",
        },
    }
    json_output(output, args.pretty)
    return 0 if providers else 2


def command_self_test(args: argparse.Namespace) -> int:
    checks = 0

    def expect(condition: bool, label: str) -> None:
        nonlocal checks
        checks += 1
        if not condition:
            raise AssertionError(label)

    expect(skycon("PARTLY_CLOUDY_DAY") == "多云", "skycon mapping")
    expect(percent(0.67, True) == 67, "fractional humidity")
    expect(percent("70", False) == 70, "integer humidity")
    expect(percent(1, False) == 1, "hourly probability stays percent")
    expect(percent(1, True) == 100, "minutely fractional probability")
    expect(pressure_hpa(100_250) == 1002.5, "pressure conversion")
    expect(number("33.24", 1) == 33.2, "number rounding")
    compressed_json = gzip.compress(b'{"status":"ok"}')
    expect(
        decode_http_body(
            compressed_json,
            {"Content-Encoding": "gzip"},
            "test",
            200,
        )
        == b'{"status":"ok"}',
        "gzip response decoding",
    )
    expect(qweather_hour_bucket(25) == 72, "hour bucket")
    expect(qweather_day_bucket(8) == 10, "day bucket")
    expect(parse_topics("current,hourly,current") == ("current", "hourly"), "topics")
    expect(format_coord(113.880000) == "113.88", "coordinate formatting")
    expect(format_qweather_coord(113.883115) == "113.88", "qweather coordinate formatting")
    expect(caiyun_hourly_steps(1) == 24, "caiyun minimum hourly steps")
    expect(caiyun_hourly_steps(24) == 24, "caiyun exact hourly steps")
    expect(caiyun_hourly_steps(25) == 48, "caiyun rounded hourly steps")
    expect(classify_location("深圳市宝安区") == "city", "city classification")
    expect(classify_location("深圳市宝安区新安街道1号") == "address", "address classification")
    expect(caiyun_auth_state_for("key", "secret", None) == ("hmac", None), "hmac auth mode")
    expect(caiyun_auth_state_for(None, None, "token") == ("token", None), "token auth mode")
    partial_mode, partial_error = caiyun_auth_state_for("key", None, None)
    expect(partial_mode is None and bool(partial_error), "partial hmac detection")
    expect(
        caiyun_signature(
            "demo-key",
            "demo-secret",
            "GET",
            "/v2.6/demo-key/113.88,22.55/weather",
            "0195c68a-42e7-7243-bff2-ac97a78b837d",
            "1742791910",
            {"hourlysteps": 24, "alert": "true"},
        )
        == "ro8JKqhRfneHjvc7nclJDW-6OrU2_9P9q04fZ-MK8ZE=",
        "caiyun hmac signature",
    )
    try:
        validate_qweather_base("http://example.com")
    except WeatherError:
        checks += 1
    else:
        raise AssertionError("unsafe host validation")

    qweather = normalize_qweather(
        {
            "current": {
                "code": "200",
                "now": {
                    "temp": "33",
                    "feelsLike": "36",
                    "text": "多云",
                    "humidity": "67",
                    "precip": "0.0",
                    "windDir": "西南风",
                    "windScale": "1-3级",
                },
            },
            "alerts": {
                "metadata": {
                    "tag": "fixture-tag",
                    "zeroResult": False,
                    "attributions": ["https://developer.qweather.com/attribution.html"],
                },
                "alerts": [
                    {
                        "id": "alert-1",
                        "senderName": "测试气象台",
                        "issuedTime": "2026-08-15T10:00+08:00",
                        "messageType": {"code": "alert"},
                        "eventType": {"name": "暴雨", "code": "1003"},
                        "severity": "severe",
                        "headline": "暴雨预警",
                        "description": "测试预警描述",
                        "instruction": "注意防范",
                    }
                ],
            },
        },
        ("current", "alerts"),
        12,
        1,
    )
    expect(qweather["current"]["temperature"] == 33, "qweather current")
    expect(qweather["current"]["wind"] == "西南风 1-3级", "qweather wind")
    expect(qweather["alerts"][0]["eventType"] == "暴雨", "qweather alert")
    expect(bool(qweather["alertMetadata"]["attributions"]), "qweather alert attribution")

    geo_candidates = [
        {"name": "宝安区", "adm2": "深圳市", "adm1": "广东省"},
        {"name": "深圳市", "adm2": "深圳市", "adm1": "广东省"},
    ]
    expect(
        qweather_candidate_score("深圳市宝安区", geo_candidates[0])
        > qweather_candidate_score("深圳市宝安区", geo_candidates[1]),
        "qweather geo candidate ranking",
    )

    caiyun = normalize_caiyun(
        {
            "status": "ok",
            "result": {
                "realtime": {
                    "temperature": 33.2,
                    "apparent_temperature": 35.7,
                    "skycon": "PARTLY_CLOUDY_DAY",
                    "humidity": 0.67,
                    "air_quality": {"aqi": {"chn": 45}},
                },
                "hourly": {
                    "temperature": [{"datetime": "2026-08-15T12:00+08:00", "value": 33}],
                    "precipitation": [{"value": 0.2, "probability": 1}],
                },
                "minutely": {
                    "precipitation_2h": [0.1, 0.2],
                    "probability": [1, 0.25],
                },
            },
        },
        ("current", "hourly", "minutely"),
        12,
        1,
    )
    expect(caiyun["current"]["humidity"] == 67, "caiyun humidity")
    expect(caiyun["current"]["weather"] == "多云", "caiyun weather")
    expect(caiyun["hourly"][0]["precipitationProbability"] == 1, "caiyun hourly probability")
    expect(caiyun["minutely"]["probability"][0]["probability"] == 100, "caiyun minutely probability")

    json_output({"ok": True, "version": VERSION, "checks": checks}, args.pretty)
    return 0


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("必须大于 0")
    return parsed


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="Query and normalize QWeather + Caiyun data for the dual-weather Skill."
    )
    subparsers = root.add_subparsers(dest="command", required=True)

    check = subparsers.add_parser("check", help="Check runtime and credential presence.")
    check.add_argument("--pretty", action="store_true")
    check.set_defaults(handler=command_check)

    query = subparsers.add_parser("query", help="Query weather by address or coordinates.")
    query.add_argument("--address", help="Chinese city, district, or detailed address.")
    query.add_argument(
        "--location-type",
        choices=("auto", "city", "address"),
        default="auto",
        help="Use QWeather Geo for cities or AMap for detailed addresses.",
    )
    query.add_argument("--lng", type=float, help="Longitude; must be paired with --lat.")
    query.add_argument("--lat", type=float, help="Latitude; must be paired with --lng.")
    query.add_argument(
        "--topics",
        default=",".join(DEFAULT_TOPICS),
        help="Comma-separated topics: " + ",".join(sorted(SUPPORTED_TOPICS)),
    )
    query.add_argument("--hours", type=positive_int, default=12)
    query.add_argument("--days", type=positive_int, default=3)
    query.add_argument("--date", help="Astronomy date in yyyyMMdd; defaults to local today.")
    query.add_argument(
        "--provider", choices=("both", "qweather", "caiyun"), default="both"
    )
    query.add_argument("--timeout", type=float, default=8.0)
    query.add_argument("--pretty", action="store_true")
    query.set_defaults(handler=command_query)

    self_test = subparsers.add_parser("self-test", help="Run offline normalization tests.")
    self_test.add_argument("--pretty", action="store_true")
    self_test.set_defaults(handler=command_self_test)
    return root


def main(argv: list[str] | None = None) -> int:
    configure_stdio()
    args = parser().parse_args(argv)
    try:
        if getattr(args, "timeout", 8.0) <= 0 or getattr(args, "timeout", 8.0) > 60:
            raise WeatherError("input", "timeout 必须在 0 到 60 秒之间", "input")
        if getattr(args, "hours", 1) > 360:
            raise WeatherError("input", "hours 最大为 360", "input")
        if getattr(args, "days", 1) > 30:
            raise WeatherError("input", "days 最大为 30", "input")
        return int(args.handler(args))
    except WeatherError as exc:
        json_output({"ok": False, "error": exc.as_dict()}, getattr(args, "pretty", False))
        return 2
    except KeyboardInterrupt:
        json_output({"ok": False, "error": {"provider": "runtime", "message": "已取消"}})
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
