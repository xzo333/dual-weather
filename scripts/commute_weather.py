import datetime
import json
import subprocess
import os
import sys
import time

try:
    from weather import (
        WeatherError,
        caiyun_auth_state,
        caiyun_json,
        format_qweather_coord,
        qweather_json,
    )
except ImportError as error:
    raise RuntimeError(
        "commute_weather.py 必须与同目录的 weather.py 一起安装"
    ) from error

try:
    from chinese_calendar import get_holiday_detail, is_workday
    CALENDAR_IMPORT_ERROR = None
except ImportError as error:
    get_holiday_detail = None
    is_workday = None
    CALENDAR_IMPORT_ERROR = error

# ==================== 配置区 ====================
ENV_FILE = os.environ.get(
    "COMMUTE_WEATHER_ENV_FILE", "/home/node/.openclaw/.private/commute-weather.env"
)
WECOM_TARGET_FILE = os.environ.get(
    "COMMUTE_WEATHER_TARGET_FILE",
    "/home/node/.openclaw/workspace/.private/commute-weather-target",
)
CALENDAR_ALERT_FILE = os.environ.get(
    "COMMUTE_WEATHER_CALENDAR_ALERT_FILE",
    "/home/node/.openclaw/workspace/.state/commute-weather-calendar-alert",
)
HISTORY_FILE = os.environ.get(
    "COMMUTE_WEATHER_HISTORY_FILE",
    "/home/node/.openclaw/workspace/.state/commute-weather-history.jsonl",
)
HISTORY_RETENTION_DAYS = 30
CALENDAR_PACKAGE = "chinese-calendar"
CALENDAR_ALERT_INTERVAL = 7 * 24 * 60 * 60
CAIYUN_KEY = os.environ.get("CAIYUN_WEATHER_API_TOKEN", "")
QWEATHER_KEY = os.environ.get("QWEATHER_API_KEY", "")
WECOM_TARGET = os.environ.get("WECOM_TARGET", "")

if os.path.exists(ENV_FILE):
    with open(ENV_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            value = value.strip().strip('"\'')
            if name in {
                "CAIYUN_APP_KEY",
                "CAIYUN_APP_SECRET",
                "CAIYUN_WEATHER_API_TOKEN",
                "CAIYUN_KEY",
                "QWEATHER_API_KEY",
                "QWEATHER_KEY",
                "QWEATHER_BASE_URL",
                "WECOM_TARGET",
            }:
                os.environ.setdefault(name, value)

CAIYUN_KEY = os.environ.get("CAIYUN_WEATHER_API_TOKEN") or os.environ.get(
    "CAIYUN_KEY", ""
)
QWEATHER_KEY = os.environ.get("QWEATHER_API_KEY") or os.environ.get(
    "QWEATHER_KEY", ""
)
if CAIYUN_KEY:
    os.environ.setdefault("CAIYUN_WEATHER_API_TOKEN", CAIYUN_KEY)
if QWEATHER_KEY:
    os.environ.setdefault("QWEATHER_API_KEY", QWEATHER_KEY)
WECOM_TARGET = os.environ.get("WECOM_TARGET", WECOM_TARGET)

if not WECOM_TARGET and os.path.exists(WECOM_TARGET_FILE):
    with open(WECOM_TARGET_FILE, "r", encoding="utf-8") as target_file:
        WECOM_TARGET = target_file.read().strip()

AIRPORT_EAST = os.environ.get("COMMUTE_WEATHER_AIRPORT", "113.822634,22.647001")
UNIV_TOWN = os.environ.get("COMMUTE_WEATHER_UNIV_TOWN", "113.965307,22.581946")
QWEATHER_HOST = os.environ.get("QWEATHER_BASE_URL", "")
RAIN_THRESHOLD = 0.1
LIGHT_RAIN_MAX = 2.5
MODERATE_RAIN_MAX = 8.0
HEAVY_RAIN_MAX = 15.0
STORM_RAIN_MAX = 30.0
SKYCON_NAMES = {
    "CLEAR_DAY": "晴",
    "CLEAR_NIGHT": "晴",
    "PARTLY_CLOUDY_DAY": "多云",
    "PARTLY_CLOUDY_NIGHT": "多云",
    "CLOUDY": "阴",
    "LIGHT_RAIN": "小雨",
    "MODERATE_RAIN": "中雨",
    "HEAVY_RAIN": "大雨",
    "STORM_RAIN": "暴雨",
    "LIGHT_SNOW": "小雪",
    "MODERATE_SNOW": "中雪",
    "HEAVY_SNOW": "大雪",
    "STORM_SNOW": "暴雪",
    "FOG": "雾",
    "HAZE": "霾",
}
PERIOD_COPY = {
    "all": ("早晚通勤", "早高峰和晚高峰"),
    "morning": ("早通勤", "早高峰"),
    "evening": ("晚通勤更新", "晚高峰"),
}
# ===============================================


def parse_history_time(value):
    """Parse an ISO timestamp written by this script."""
    parsed = datetime.datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed


def append_history(record):
    """Append one run and retain only records from the last 30 days."""
    history_dir = os.path.dirname(HISTORY_FILE)
    os.makedirs(history_dir, mode=0o700, exist_ok=True)
    os.chmod(history_dir, 0o700)
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
        days=HISTORY_RETENTION_DAYS
    )
    retained = []
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as history_file:
            for line in history_file:
                try:
                    existing = json.loads(line)
                    if parse_history_time(existing["run_at"]) >= cutoff:
                        retained.append(existing)
                except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                    continue
    except FileNotFoundError:
        pass

    retained.append(record)
    temp_file = f"{HISTORY_FILE}.tmp"
    with open(temp_file, "w", encoding="utf-8") as history_file:
        for item in retained:
            history_file.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")))
            history_file.write("\n")
    os.chmod(temp_file, 0o600)
    os.replace(temp_file, HISTORY_FILE)


def source_record(data, source):
    """Keep useful forecast fields without credentials or request metadata."""
    if data is None:
        return None
    return {
        "signal": rain_signal(data),
        "precipitation_mm_h": data["precipitation"],
        "probability_pct": data["probability"],
        "weather": SKYCON_NAMES.get(data.get("skycon"), data.get("skycon") or None),
        "temperature_c": data.get("temperature"),
        "apparent_temperature_c": data.get("apparent_temperature"),
        "wind_speed": data.get("wind_speed"),
        "visibility_km": data.get("visibility"),
    }


def observation_record(observation):
    merged = observation["merged"]
    return {
        "hour": observation["hour"],
        "location": observation["location"],
        "caiyun": source_record(observation["caiyun"], "caiyun"),
        "qweather": source_record(observation["qweather"], "qweather"),
        "decision": {
            "actionable": merged["rainy"],
            "certainty": merged["certainty"],
            "agreement": merged["agreement"],
            "precipitation_mm_h": merged["precipitation"],
            "probability_pct": merged["probability"],
            "rain_level": rain_level(merged["precipitation"]),
        },
    }

def send_via_openclaw(message):
    """通过本地 OpenClaw 命令行发送企业微信私聊。"""
    if not WECOM_TARGET:
        raise RuntimeError("缺少私密的企微接收目标配置")
    subprocess.run(
        ["openclaw", "message", "send", "-t", WECOM_TARGET, "--message", message],
        check=True,
    )
    print(f"[{datetime.datetime.now()}] 消息已成功推送至企微。")

def should_send_calendar_alert(alert_key):
    """同类日历故障最多每 7 天提醒一次。"""
    try:
        with open(CALENDAR_ALERT_FILE, "r") as alert_file:
            saved_key, saved_time = alert_file.read().strip().split("|", 1)
        if saved_key == alert_key and time.time() - float(saved_time) < CALENDAR_ALERT_INTERVAL:
            return False
    except (FileNotFoundError, OSError, ValueError):
        pass
    return True

def record_calendar_alert(alert_key):
    os.makedirs(os.path.dirname(CALENDAR_ALERT_FILE), exist_ok=True)
    with open(CALENDAR_ALERT_FILE, "w") as alert_file:
        alert_file.write(f"{alert_key}|{time.time()}")

def notify_calendar_failure(alert_key, detail):
    """通知一次并让定时任务以失败状态退出。"""
    if should_send_calendar_alert(alert_key):
        send_via_openclaw(
            "通勤天气任务异常\n\n"
            f"节假日日历不可用：{detail}\n"
            "已停止本次天气判断，避免节假日误提醒。请检查 chinese-calendar。"
        )
        record_calendar_alert(alert_key)
    raise RuntimeError(detail)

def install_or_upgrade_calendar(upgrade=False):
    """容器升级导致依赖丢失或日历过期时，尝试自动修复。"""
    command = [sys.executable, "-m", "pip", "install", "--user"]
    if upgrade:
        command.append("--upgrade")
    command.append(CALENDAR_PACKAGE)
    subprocess.run(command, check=True, timeout=120)

def load_calendar_package(upgrade=False):
    global get_holiday_detail, is_workday, CALENDAR_IMPORT_ERROR
    install_or_upgrade_calendar(upgrade=upgrade)
    import importlib
    import sys as runtime_sys

    importlib.invalidate_caches()
    for module_name in list(runtime_sys.modules):
        if module_name == "chinese_calendar" or module_name.startswith("chinese_calendar."):
            del runtime_sys.modules[module_name]
    chinese_calendar = importlib.import_module("chinese_calendar")
    get_holiday_detail = chinese_calendar.get_holiday_detail
    is_workday = chinese_calendar.is_workday
    CALENDAR_IMPORT_ERROR = None

def ensure_calendar_available(target_date):
    """确保依赖存在且包含目标年份；必要时自动安装或升级。"""
    if CALENDAR_IMPORT_ERROR is not None:
        try:
            load_calendar_package()
        except Exception as error:
            notify_calendar_failure("package-missing", f"依赖缺失且自动安装失败：{error}")

    try:
        is_workday(target_date)
    except NotImplementedError:
        try:
            load_calendar_package(upgrade=True)
            is_workday(target_date)
        except Exception as error:
            notify_calendar_failure(
                f"year-{target_date.year}",
                f"当前日历数据不支持 {target_date.year} 年，自动升级后仍不可用：{error}",
            )

def get_caiyun_hourly(location, hourly_steps=24):
    """获取未来 24 小时通勤相关数据，按日期和小时索引。"""
    auth_mode, _ = caiyun_auth_state()
    if not auth_mode:
        return {}, "天气数据暂时未获取"
    try:
        lng_text, lat_text = location.split(",", 1)
        res = caiyun_json(
            float(lng_text),
            float(lat_text),
            hours=min(max(int(hourly_steps), 1), 360),
            days=1,
            timeout=10,
        )
    except (ValueError, WeatherError):
        return {}, "天气数据暂时未获取"

    try:
        hourly = res["result"]["hourly"]
        precip_by_time = {item["datetime"]: item for item in hourly["precipitation"]}
        temp_by_time = {item["datetime"]: item["value"] for item in hourly["temperature"]}
        apparent_temp_by_time = {
            item["datetime"]: item["value"] for item in hourly["apparent_temperature"]
        }
        skycon_by_time = {item["datetime"]: item["value"] for item in hourly["skycon"]}
        wind_by_time = {item["datetime"]: item for item in hourly["wind"]}
        visibility_by_time = {
            item["datetime"]: item["value"] for item in hourly["visibility"]
        }
        forecast = {}
        for timestamp, precip in precip_by_time.items():
            date_time = datetime.datetime.fromisoformat(timestamp)
            forecast[(date_time.date(), date_time.hour)] = {
                "precipitation": float(precip["value"]),
                "probability": int(precip.get("probability", 0)),
                "temperature": temp_by_time.get(timestamp),
                "apparent_temperature": apparent_temp_by_time.get(timestamp),
                "skycon": skycon_by_time.get(timestamp),
                "wind_speed": wind_by_time.get(timestamp, {}).get("speed"),
                "visibility": visibility_by_time.get(timestamp),
            }
    except (KeyError, TypeError, ValueError):
        return {}, "天气数据暂时未获取"
    return forecast, None

def get_qweather_hourly(location, forecast_hours=24):
    """获取和风未来 24 小时预报，按日期和小时索引。"""
    if not QWEATHER_KEY or not QWEATHER_HOST:
        return {}, "天气数据暂时未获取"
    endpoint = "72h" if forecast_hours > 24 else "24h"
    try:
        lng_text, lat_text = location.split(",", 1)
        normalized_location = ",".join(
            (
                format_qweather_coord(float(lng_text)),
                format_qweather_coord(float(lat_text)),
            )
        )
        res = qweather_json(
            f"/v7/weather/{endpoint}",
            {"location": normalized_location},
            timeout=10,
        )
    except (ValueError, WeatherError):
        return {}, "天气数据暂时未获取"

    try:
        forecast = {}
        for item in res.get("hourly", []):
            date_time = datetime.datetime.fromisoformat(item["fxTime"])
            forecast[(date_time.date(), date_time.hour)] = {
                "precipitation": float(item.get("precip") or 0),
                "probability": int(item.get("pop") or 0),
                "temperature": float(item["temp"]) if item.get("temp") is not None else None,
                "apparent_temperature": None,
                "skycon": item.get("text"),
                "wind_speed": (
                    float(item["windSpeed"])
                    if item.get("windSpeed") is not None
                    else None
                ),
                "visibility": None,
            }
    except (KeyError, TypeError, ValueError):
        return {}, "天气数据暂时未获取"
    return forecast, None

def rain_signal(data):
    """Classify one provider without promoting probability-only risk to rain."""
    if not data:
        return None
    precipitation = data["precipitation"]
    probability = data["probability"]
    weather_text = SKYCON_NAMES.get(data.get("skycon"), data.get("skycon") or "")
    if precipitation >= RAIN_THRESHOLD:
        return "confirmed"
    if "雨" in weather_text and probability >= 50:
        return "confirmed"
    if ("雨" in weather_text and probability >= 30) or probability >= 60:
        return "possible"
    return "none"

def merge_forecasts(caiyun, qweather):
    """合并双源结果，并保守采用较高降雨风险。"""
    available = [data for data in (caiyun, qweather) if data]
    if not available:
        return None

    caiyun_signal = rain_signal(caiyun)
    qweather_signal = rain_signal(qweather)
    signals = [signal for signal in (caiyun_signal, qweather_signal) if signal is not None]
    confirmed = "confirmed" in signals
    jointly_possible = len(signals) == 2 and all(signal == "possible" for signal in signals)
    actionable = confirmed or jointly_possible
    certainty = "confirmed" if confirmed else "possible" if jointly_possible else "none"
    risk_source = max(available, key=lambda data: (data["precipitation"], data["probability"]))
    temperatures = [data["temperature"] for data in available if data["temperature"] is not None]
    return {
        "rainy": actionable,
        "certainty": certainty,
        "agreement": caiyun_signal == qweather_signal if caiyun and qweather else None,
        "caiyun_signal": caiyun_signal,
        "qweather_signal": qweather_signal,
        "precipitation": max(data["precipitation"] for data in available),
        "probability": max(data["probability"] for data in available),
        "temperature": sum(temperatures) / len(temperatures) if temperatures else None,
        "skycon": risk_source.get("skycon"),
        "sources": len(available),
    }

def rain_level(precipitation):
    """按预计单小时降水量生成人可理解的动态雨势。"""
    if precipitation < RAIN_THRESHOLD:
        return "无明显降雨"
    if precipitation <= LIGHT_RAIN_MAX:
        return "小雨"
    if precipitation <= MODERATE_RAIN_MAX:
        return "中雨"
    if precipitation <= HEAVY_RAIN_MAX:
        return "大雨"
    if precipitation <= STORM_RAIN_MAX:
        return "暴雨"
    return "强暴雨"

def rain_level_rank(precipitation):
    """返回雨势等级序号，用于识别双源雨势明显分歧。"""
    levels = {
        "无明显降雨": 0,
        "小雨": 1,
        "中雨": 2,
        "大雨": 3,
        "暴雨": 4,
        "强暴雨": 5,
    }
    return levels[rain_level(precipitation)]

def source_comparison_text(merged, caiyun, qweather):
    """只在双源结论有实际决策差异时展示来源说明。"""
    if not caiyun and qweather:
        return "仅和风数据可用，单源参考"
    if caiyun and not qweather:
        return "仅彩云数据可用，单源参考"
    if not caiyun and not qweather:
        return None
    if merged["caiyun_signal"] != merged["qweather_signal"]:
        if merged["caiyun_signal"] in {"confirmed", "possible"}:
            return "彩云报雨 / 和风报无雨，按有雨提醒"
        return "和风报雨 / 彩云报无雨，按有雨提醒"
    if merged["caiyun_signal"] == "confirmed" and merged["qweather_signal"] == "confirmed":
        rank_gap = abs(
            rain_level_rank(caiyun["precipitation"])
            - rain_level_rank(qweather["precipitation"])
        )
        if rank_gap >= 2:
            return "均预计有雨，雨势判断存在差异"
    return None

def format_forecast_detail(hour, location, caiyun, qweather, merged):
    """生成核对模式使用的双源逐时预报。"""
    details = [f"• {hour:02d}:00 {location}"]
    if caiyun:
        skycon = SKYCON_NAMES.get(caiyun["skycon"], caiyun["skycon"] or "未知")
        temp_text = f"，{caiyun['temperature']:.0f}°C" if caiyun["temperature"] is not None else ""
        details.append(
            f"  彩云：{skycon}，降雨 {caiyun['probability']}% / "
            f"{caiyun['precipitation']:.2f} mm/h{temp_text}"
        )
    else:
        details.append("  彩云：数据暂未获取")
    if qweather:
        temp_text = f"，{qweather['temperature']:.0f}°C" if qweather["temperature"] is not None else ""
        details.append(
            f"  和风：{qweather['skycon'] or '未知'}，降雨 {qweather['probability']}% / "
            f"{qweather['precipitation']:.2f} mm/h{temp_text}"
        )
    else:
        details.append("  和风：数据暂未获取")
    if merged and merged["agreement"] is not None:
        details.append(f"  对比：{'一致' if merged['agreement'] else '存在分歧'}")
    elif merged:
        details.append("  对比：单一来源，未交叉验证")
    return "\n".join(details)

def source_weather_text(data, source):
    """Return the source's user-facing rain conclusion for one slot."""
    if data is None:
        return None
    signal = rain_signal(data)
    if signal == "none":
        return "无雨"
    if signal == "possible":
        return "可能有雨"
    level = rain_level(data["precipitation"])
    if level != "无明显降雨":
        return level
    weather_text = SKYCON_NAMES.get(data.get("skycon"), data.get("skycon") or "")
    return weather_text if "雨" in weather_text else "有雨"


def format_source_comparison(caiyun, qweather):
    """Name both providers and retain their individual conclusions."""
    caiyun_text = source_weather_text(caiyun, "caiyun")
    qweather_text = source_weather_text(qweather, "qweather")
    if caiyun_text is None:
        return f"和风报{qweather_text}；彩云数据暂未获取，本次只有单一来源。"
    if qweather_text is None:
        return f"彩云报{caiyun_text}；和风数据暂未获取，本次只有单一来源。"
    if caiyun_text == qweather_text:
        return f"彩云、和风均报{caiyun_text}。"
    return f"彩云报{caiyun_text}，和风报{qweather_text}。"


def format_slot_line(observation):
    return (
        f"{observation['hour']:02d}:00 {observation['location']}："
        f"{format_source_comparison(observation['caiyun'], observation['qweather'])}"
    )

def format_data_issue(locations):
    """说明数据不完整，避免把未获取误判为无雨。"""
    location_text = "、".join(locations)
    return (
        "天气数据不完整\n\n"
        f"{location_text} 的预报暂未获取。本次不对该地点作无雨判断；"
        "出门前请再查看天气应用。"
    )


def apparent_temperature(observations):
    """Choose the most commute-relevant apparent temperature."""
    values = []
    for observation in observations:
        for source in (observation.get("caiyun"), observation.get("qweather")):
            if source and source.get("apparent_temperature") is not None:
                values.append(source["apparent_temperature"])
    if not values:
        return None
    if max(values) >= 30:
        return max(values)
    if min(values) <= 10:
        return min(values)
    return sum(values) / len(values)


def apparent_temperature_advice(observations, commute_period, preview=False):
    """Describe how the corresponding commute period will feel outdoors."""
    temperature = apparent_temperature(observations)
    if temperature is None:
        return None

    rounded = round(temperature)
    if commute_period == "morning":
        subject = "早上"
    elif preview:
        subject = "预计下班时"
    else:
        subject = "下班时"

    if temperature >= 38:
        return f"{subject}体感约 {rounded}℃，天气炎热，注意防晒和补水。"
    if temperature >= 35:
        return f"{subject}体感约 {rounded}℃，体感较热，注意补水。"
    if temperature >= 30:
        suffix = "通勤会有些热。" if commute_period == "morning" else "返程仍有些热。"
        return f"{subject}体感约 {rounded}℃，{suffix}"
    if temperature <= 5:
        return f"{subject}体感约 {rounded}℃，天气较冷，注意保暖。"
    if temperature <= 10:
        return f"{subject}体感约 {rounded}℃，体感偏凉，建议添件外套。"
    if temperature < 18:
        return f"{subject}体感约 {rounded}℃，稍有凉意。"
    if temperature < 26:
        return f"{subject}体感约 {rounded}℃，体感舒适。"
    return f"{subject}体感约 {rounded}℃，体感偏暖。"


def append_apparent_temperature(action, observations, commute_period, preview=False):
    feeling = apparent_temperature_advice(observations, commute_period, preview=preview)
    return f"{action} {feeling}" if feeling else action


def commute_advice(precipitation, commute_period, observations=None):
    """Return a concrete action tied to the relevant commute period."""
    level = rain_level(precipitation)
    if level == "强暴雨":
        action = "带雨伞和鞋套；如非必要，避开最强降雨时段。"
    elif level in {"暴雨", "大雨"}:
        if commute_period == "morning":
            action = "带雨伞和鞋套；留意积水，建议提前 15-20 分钟出发。"
        else:
            action = "带雨伞和鞋套；留意积水和打车延迟，建议为下班通勤预留 15-20 分钟。"
    elif level == "中雨":
        if commute_period == "morning":
            action = "带伞；注意积水和路面湿滑，建议提前约 10 分钟出发。"
        else:
            action = "带伞；注意积水和路面湿滑，建议为下班通勤预留约 10 分钟。"
    elif level == "小雨":
        action = "丝丝小雨，伞记得带上；注意路面湿滑。"
    else:
        action = "伞记得带上；注意路面湿滑。"
    return append_apparent_temperature(
        action,
        observations or [],
        commute_period,
    )


def max_period_precip(observations):
    rainy = [item["merged"]["precipitation"] for item in observations if item["merged"]["rainy"]]
    return max(rainy, default=0)


def has_source_disagreement(observations):
    return any(item["merged"]["agreement"] is False for item in observations)


def period_heading(observations, commute_period):
    rainy = [item for item in observations if item["merged"]["rainy"]]
    max_precip = max_period_precip(observations)
    level = rain_level(max_precip)
    possible_only = all(item["merged"]["certainty"] == "possible" for item in rainy)
    uncertain = has_source_disagreement(rainy)
    if possible_only:
        qualifier = "存在降雨可能"
    elif uncertain:
        qualifier = "可能有雨"
    else:
        qualifier = f"有{level}"

    if len(rainy) == 1:
        item = rainy[0]
        if commute_period == "morning":
            return f"{item['hour']:02d}:00 {item['location']}{qualifier}"
        if "出发" in item["location"]:
            return f"下班出发时{qualifier}"
        return "返程后段可能有雨"

    first_rank = rain_level_rank(observations[0]["merged"]["precipitation"])
    last_rank = rain_level_rank(observations[-1]["merged"]["precipitation"])
    if commute_period == "morning" and last_rank > first_rank:
        return "早高峰雨势增强"
    return f"{'早高峰' if commute_period == 'morning' else '下班时段'}{qualifier}"


def morning_advice(observations):
    departure = next((item for item in observations if "出门" in item["location"]), None)
    arrival = next((item for item in observations if "到公司" in item["location"]), None)
    if departure is None or arrival is None:
        return commute_advice(max_period_precip(observations), "morning", observations)
    departure_rain = departure["merged"]["rainy"]
    arrival_rain = arrival["merged"]["rainy"]
    max_precip = max_period_precip(observations)
    if not departure_rain and arrival_rain:
        return append_apparent_temperature(
            "伞记得带上，下车后注意积水和路滑。",
            observations,
            "morning",
        )
    if departure_rain and not arrival_rain:
        if rain_level_rank(departure["merged"]["precipitation"]) >= rain_level_rank(MODERATE_RAIN_MAX):
            return commute_advice(
                departure["merged"]["precipitation"],
                "morning",
                observations,
            )
        return append_apparent_temperature(
            "伞记得带上，出门时注意路滑。",
            observations,
            "morning",
        )
    return commute_advice(max_precip, "morning", observations)


def evening_preview_advice(observations, morning_has_rain):
    departure = next((item for item in observations if "出发" in item["location"]), None)
    first_rain = departure is not None and departure["merged"]["rainy"]
    later_rain = any(
        item["merged"]["rainy"]
        for item in observations
        if item is not departure
    )
    if first_rain and not later_rain:
        action = "下班出发时注意积水和路滑"
    elif later_rain and not first_rain:
        action = "到机场东后注意路滑"
    else:
        action = "下班通勤注意积水和路滑"
    prefix = "伞不要落在公司" if morning_has_rain else "伞记得带上"
    return append_apparent_temperature(
        f"{prefix}，{action}；具体雨势下班前再更新。",
        observations,
        "evening",
        preview=True,
    )


def format_commute_message(date_str, period, morning_observations, evening_observations):
    """Build an action-first alert while preserving each provider's conclusion."""
    morning_rain = any(item["merged"]["rainy"] for item in morning_observations)
    evening_rain = any(item["merged"]["rainy"] for item in evening_observations)
    sections = []

    if period in {"all", "morning"} and morning_rain:
        sections.append(
            period_heading(morning_observations, "morning")
            + "\n"
            + "\n".join(format_slot_line(item) for item in morning_observations)
            + "\n\n"
            + morning_advice(morning_observations)
        )
    elif period == "all" and evening_rain:
        sections.append("早高峰预计无雨。")

    if period == "all" and evening_rain:
        sections.append(
            period_heading(evening_observations, "evening")
            + "\n"
            + "\n".join(format_slot_line(item) for item in evening_observations)
            + "\n\n"
            + evening_preview_advice(evening_observations, morning_rain)
        )
    elif period == "all" and morning_rain:
        sections.append("下班时段预计无雨。")
    elif period == "evening" and evening_rain:
        sections.append(
            period_heading(evening_observations, "evening")
            + "\n"
            + "\n".join(format_slot_line(item) for item in evening_observations)
            + "\n\n"
            + commute_advice(
                max_period_precip(evening_observations),
                "evening",
                evening_observations,
            )
        )

    if not sections:
        return None
    all_observations = morning_observations + evening_observations
    severe = max_period_precip(all_observations) > MODERATE_RAIN_MAX
    if severe:
        title = "🌧️ 强降雨通勤提醒"
    elif period == "evening":
        title = "☔ 下班天气"
    else:
        title = "☔ 通勤天气"
    return f"{title}｜{date_str}\n\n" + "\n\n".join(sections)

def check_rain():
    current_date = datetime.date.today()
    requested_date = os.environ.get("COMMUTE_WEATHER_DATE", "today")
    if requested_date == "today":
        target_date = current_date
    elif requested_date == "tomorrow":
        target_date = current_date + datetime.timedelta(days=1)
    else:
        target_date = datetime.date.fromisoformat(requested_date)

    ensure_calendar_available(target_date)
    forecast_hours = 48 if target_date > current_date else 24
    period = os.environ.get("COMMUTE_WEATHER_PERIOD", "all")
    if period not in {"all", "morning", "evening"}:
        raise ValueError("COMMUTE_WEATHER_PERIOD 仅支持 all、morning 或 evening")

    weekday = target_date.weekday() # 0-4 周一至周五, 5 周六, 6 周日
    is_holiday, holiday_name = get_holiday_detail(target_date)
    if is_workday(target_date):
        work_schedule = "full_day"
    elif weekday == 5 and not holiday_name:
        work_schedule = "half_day"
    else:
        reason = f"法定节假日 ({holiday_name})" if holiday_name else "休息日"
        print(
            f"[{datetime.datetime.now()}] {target_date} 为{reason}，未发送通勤提醒。"
        )
        return

    required_schedule = os.environ.get("COMMUTE_WEATHER_WORK_SCHEDULE")
    if required_schedule and required_schedule not in {"full_day", "half_day"}:
        raise ValueError("COMMUTE_WEATHER_WORK_SCHEDULE 仅支持 full_day 或 half_day")
    if required_schedule and required_schedule != work_schedule:
        print(
            f"[{datetime.datetime.now()}] {target_date} 班型为 {work_schedule}，"
            f"当前任务仅处理 {required_schedule}，未发送提醒。"
        )
        return

    # 日期与星期映射
    week_names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    date_str = f"{target_date.month}月{target_date.day}日 {week_names[weekday]}"

    print(f"[{datetime.datetime.now()}] 正在获取 {date_str} 的通勤天气预报...")

    caiyun_airport, caiyun_airport_error = get_caiyun_hourly(AIRPORT_EAST, forecast_hours)
    caiyun_univ, caiyun_univ_error = get_caiyun_hourly(UNIV_TOWN, forecast_hours)
    qweather_airport, qweather_airport_error = get_qweather_hourly(AIRPORT_EAST, forecast_hours)
    qweather_univ, qweather_univ_error = get_qweather_hourly(UNIV_TOWN, forecast_hours)

    report_mode = os.environ.get("COMMUTE_WEATHER_REPORT") == "1"
    morning_observations = []
    evening_observations = []
    forecast_details = []
    comparison_states = []
    missing_slots = []

    # 2. 5.5 天工作制时段匹配
    if work_schedule == "full_day": # 工作日及法定调休补班（全天班）
        morning_slots = [
            (7, caiyun_airport, qweather_airport, "机场东出门"),
            (8, caiyun_univ, qweather_univ, "到公司"),
        ]
        evening_slots = [
            (18, caiyun_univ, qweather_univ, "大学城出发"),
            (19, caiyun_airport, qweather_airport, "机场东到家途中"),
            (20, caiyun_airport, qweather_airport, "机场东到家"),
        ]
    else: # 普通周六（半天班）
        morning_slots = [
            (7, caiyun_airport, qweather_airport, "机场东出门"),
            (8, caiyun_univ, qweather_univ, "到公司"),
        ]
        evening_slots = [
            (12, caiyun_univ, qweather_univ, "大学城出发"),
            (13, caiyun_airport, qweather_airport, "机场东到家"),
        ]

    if period == "morning":
        check_slots = morning_slots
        period_label, period_description = PERIOD_COPY["morning"]
    elif period == "evening":
        check_slots = evening_slots
        period_label, period_description = PERIOD_COPY["evening"]
    else:
        check_slots = morning_slots + evening_slots
        period_label, period_description = PERIOD_COPY["all"]

    source_errors = {
        "机场东": (caiyun_airport_error, qweather_airport_error),
        "大学城": (caiyun_univ_error, qweather_univ_error),
    }
    unavailable_locations = [
        location for location, errors in source_errors.items() if all(errors)
    ]

    # 3. 对同一日期、地点和小时进行双源比较
    for hour, caiyun_forecast, qweather_forecast, loc_name in check_slots:
        caiyun_data = caiyun_forecast.get((target_date, hour))
        qweather_data = qweather_forecast.get((target_date, hour))
        merged = merge_forecasts(caiyun_data, qweather_data)
        if merged is None:
            slot_label = f"{hour:02d}:00 {loc_name}"
            missing_slots.append(slot_label)
            forecast_details.append(f"• {slot_label}：天气数据暂未获取")
            continue

        forecast_details.append(
            format_forecast_detail(hour, loc_name, caiyun_data, qweather_data, merged)
        )
        comparison_states.append(merged["agreement"])
        observation = {
            "hour": hour,
            "location": loc_name,
            "caiyun": caiyun_data,
            "qweather": qweather_data,
            "merged": merged,
        }
        if any(hour == slot[0] and loc_name == slot[3] for slot in morning_slots):
            morning_observations.append(observation)
        else:
            evening_observations.append(observation)

    if any(state is False for state in comparison_states):
        source_summary = "来源：彩云与和风存在分歧，已按较高风险提醒。"
    elif comparison_states and all(state is True for state in comparison_states):
        source_summary = "来源：彩云与和风判断一致。"
    elif any(state is None for state in comparison_states):
        source_summary = "来源：部分时段仅有单一来源，结果未完全交叉验证。"
    else:
        source_summary = "来源：彩云与和风判断一致。"

    actionable = any(
        item["merged"]["rainy"]
        for item in morning_observations + evening_observations
    )
    if report_mode:
        notification_result = "report"
    elif actionable:
        notification_result = "rain_alert"
    elif unavailable_locations or missing_slots:
        notification_result = "data_issue"
    else:
        notification_result = "silent_no_rain"

    append_history(
        {
            "run_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "target_date": target_date.isoformat(),
            "period": period,
            "work_schedule": work_schedule,
            "report_mode": report_mode,
            "sources": {
                "caiyun_airport_error": caiyun_airport_error,
                "caiyun_univ_error": caiyun_univ_error,
                "qweather_airport_error": qweather_airport_error,
                "qweather_univ_error": qweather_univ_error,
            },
            "observations": [
                observation_record(item)
                for item in morning_observations + evening_observations
            ],
            "missing_slots": missing_slots,
            "decision": {
                "actionable": actionable,
                "notification_result": notification_result,
            },
        }
    )

    # 4. 触发企微提醒或无雨静默
    if report_mode:
        msg = (
            f"通勤天气核对｜{date_str}\n"
            f"范围：{period_description}\n\n"
            + "\n".join(forecast_details)
            + f"\n\n{source_summary}"
            + f"\n判定：任一来源提示有雨即提醒；降水阈值为 {RAIN_THRESHOLD:.2f} mm/h。"
        )
        send_via_openclaw(msg)
    elif actionable:
        msg = format_commute_message(
            date_str,
            period,
            morning_observations,
            evening_observations,
        )
        if missing_slots:
            msg += "\n\n数据提示：" + "、".join(missing_slots) + "预报暂未获取。"
        send_via_openclaw(msg)
    elif unavailable_locations or missing_slots:
        affected = unavailable_locations or missing_slots
        msg = f"通勤预报异常｜{date_str}｜{period_label}\n\n{format_data_issue(affected)}"
        send_via_openclaw(msg)
    else:
        print(f"[{datetime.datetime.now()}] {period_description}预计无雨，未发送提醒。")

if __name__ == "__main__":
    if os.environ.get("COMMUTE_WEATHER_TEST") == "1":
        send_via_openclaw(
            "通勤提醒测试\n\n"
            "这是一条测试消息，已验证企业微信推送可用。"
        )
    else:
        check_rain()
