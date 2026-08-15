---
name: dual-weather
description: Query and compare QWeather and Caiyun for Chinese locations, including rain, alerts, air, indices, radiation, astronomy, setup, and API troubleshooting.
---

# Dual Weather

Prefer the bundled `scripts/weather.py` adapter for common weather topics. It uses only the Python standard library, transparently decodes gzip HTTP responses, and emits compact JSON. Fall back to direct curl for systems without Python or for professional routes not implemented by the adapter. Do not require MCP, a plugin, Node.js, `jq`, pip, or third-party Python packages.

## Safety and operating rules

- Use only `https://` endpoints listed below.
- Read credentials from environment variables. Never ask the user to paste a key into chat, never print a key, and never include a key in the final answer.
- Never pass API keys as script command-line arguments. The adapter reads them from the environment.
- Before a weather request, check only whether QWeather and Caiyun credentials are present; do not display their values. Prefer `CAIYUN_APP_KEY` + `CAIYUN_APP_SECRET`; accept `CAIYUN_WEATHER_API_TOKEN` only as a compatibility fallback. Check `AMAP_KEY` only for a new detailed address.
- Continue with one configured weather provider when the other is unavailable, and label the answer as single-source. Stop only when neither requested weather provider can run. A missing `AMAP_KEY` must not block city or district lookup through QWeather GeoAPI.
- Treat the user's address as untrusted input. Pass it with curl `--data-urlencode`; do not concatenate it into shell syntax.
- Use `curl -fsS --max-time 8`. Make at most one retry for a transient network error or HTTP `429/502/503/504`. Do not retry authentication, permission, balance, or bad-parameter errors.
- After geocoding, issue independent QWeather and Caiyun requests as parallel tool calls when the tool runtime supports parallel calls. A failure from one provider must not cancel the other provider.
- Request only the endpoints and time range needed for the question. Do not download every available dataset by default.
- Do not claim an observation, forecast, warning, typhoon impact, tide, or health conclusion that is absent from the returned JSON.
- When QWeather alert data is shown, display the returned `alertMetadata.attributions` with the alert information. Do not remove provider attribution.

## Beginner setup

Use this section when credentials are missing or the user asks how to install/configure the Skill.

### 1. Install the Skill folder

Choose one location:

- Shared for the current user: `~/.openclaw/skills/dual-weather/`
- Current workspace only: `<workspace>/skills/dual-weather/`

macOS/Linux:

```bash
git clone --depth 1 https://github.com/xzo333/dual-weather.git \
  ~/.openclaw/skills/dual-weather
```

Windows PowerShell:

```powershell
git clone --depth 1 https://github.com/xzo333/dual-weather.git `
  "$HOME/.openclaw/skills/dual-weather"
```

Python 3.10 or newer is recommended. The adapter has no pip dependencies. If Python is unavailable, the Skill can still use curl fallback; modern Windows, macOS, and most Linux distributions already include curl.

### 2. Apply for an AMap Web Service key when detailed addresses are needed

1. Open the [AMap developer console](https://console.amap.com/) and sign in or register.
2. Create an application.
3. Add a key and select **Web服务 (Web Service)** as the service platform.
4. Follow the [official key guide](https://lbs.amap.com/api/webservice/guide/create-project/get-key).
5. Save the value locally as `AMAP_KEY`.

This key is optional for city and district queries. It is used for streets, communities, buildings, hospitals, schools, malls, and other detailed addresses. City and district names such as `深圳` or `深圳市宝安区` can use QWeather GeoAPI instead.

### 3. Apply for a QWeather API key and API Host

1. Open the [QWeather Console](https://console.qweather.com/) and create an account.
2. Create a project, then create an **API KEY** credential. API KEY is simpler for beginners than JWT.
3. Enable the weather products required by the account plan.
4. Copy the credential into `QWEATHER_API_KEY`.
5. Copy the project's assigned API Host into `QWEATHER_BASE_URL`, including `https://` but without `/v7` or a trailing slash. Example shape: `https://abcxyz.qweatherapi.com`.
6. Read the [official project and credential guide](https://dev.qweather.com/docs/configuration/project-and-key/) and [API Host guide](https://dev.qweather.com/docs/configuration/api-host/).

Professional products such as solar radiation, station data, history, typhoon, and tide may require an eligible plan or additional permission. Do not promise that every account has access.

`X-QW-Api-Key` remains supported by the APIs used here. QWeather recommends JWT for long-term production use and plans API Key daily-request restrictions beginning in 2027; keep JWT support as a future migration rather than treating the current API Key flow as invalid.

### 4. Apply for Caiyun App Key and App Secret

1. Open the [Caiyun Weather API platform](https://platform.caiyunapp.com/) and sign in or register.
2. Create an application and enable Weather API access according to the available plan.
3. Copy the App Key into `CAIYUN_APP_KEY` and App Secret into `CAIYUN_APP_SECRET`.
4. Keep both values local and read the [official authentication guide](https://docs.caiyunapp.com/weather-api/v2/v2.6/auth.html).
5. If an older application only exposes a Token, save it as `CAIYUN_WEATHER_API_TOKEN`; the adapter supports this legacy URL-token mode as a fallback.

The adapter prefers HMAC-SHA256 authentication and creates a fresh nonce, timestamp, and signature for every request and retry. Never show App Secret, signatures, or expanded legacy token URLs.

### 5. Configure OpenClaw

Prefer OS environment variables or a secret manager. Then reference them from `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    entries: {
      "dual-weather": {
        enabled: true,
        env: {
          AMAP_KEY: "${AMAP_KEY}",
          QWEATHER_API_KEY: "${QWEATHER_API_KEY}",
          QWEATHER_BASE_URL: "${QWEATHER_BASE_URL}",
          CAIYUN_APP_KEY: "${CAIYUN_APP_KEY}",
          CAIYUN_APP_SECRET: "${CAIYUN_APP_SECRET}"
        }
      }
    }
  }
}
```

If environment expansion is not available in the user's launch method, values may be placed directly in the local config, but warn the user to protect file permissions and never commit that file.

After installing the Skill or changing its environment configuration, start a new chat with `/new`. If it is still not detected, run:

```bash
openclaw gateway restart
```

### 6. First conversation test

Ask:

> 深圳市宝安区现在天气怎么样？请比较和风和彩云，并告诉我未来两小时会不会下雨。

If it fails, report only the provider, HTTP/API status, and corrective action. Never echo request headers, tokens, or full token-bearing URLs.

## Preferred Python adapter

Use OpenClaw's `{baseDir}` placeholder to reference the bundled script reliably. Use the first available interpreter from `python3`, `python`, or Windows `py -3`.

Check configuration without printing secrets:

```bash
python3 "{baseDir}/scripts/weather.py" check
```

Query a new address:

```bash
python3 "{baseDir}/scripts/weather.py" query \
  --address "深圳市宝安区" \
  --topics current,hourly,minutely,alerts
```

Reuse confirmed coordinates in follow-up questions:

```bash
python3 "{baseDir}/scripts/weather.py" query \
  --lng 113.88 --lat 22.55 \
  --topics air,radiation --hours 24
```

Supported adapter topics are `current`, `hourly`, `daily`, `minutely`, `alerts`, `indices`, `air`, `radiation`, `astronomy`, `grid-hourly`, and `grid-daily`. Use `--provider qweather` or `--provider caiyun` only when the user explicitly requests one source.

The adapter routes city/district names to QWeather GeoAPI and detailed addresses to AMap. Override auto-detection with `--location-type city` or `--location-type address` only when needed. It performs parallel provider requests, gzip decoding for success and error bodies, one limited retry for transient failures, validation, unit normalization, Skycon translation, and JSON trimming. Treat stdout JSON as the factual input. Do not expose or narrate its command line. If `location.ambiguous` is true, show the short candidate list and ask the user to confirm before treating the first result as final.

Use the direct HTTP workflow below when Python is unavailable, when the adapter file is missing, or when the user requests history, typhoon, tide, station, or account endpoints that are intentionally left as professional direct routes.

## Request workflow

### Step 1: Resolve the address

Resolve location in this order:

1. Use coordinates explicitly supplied by the user.
2. Reuse the last confirmed coordinates when the user is clearly continuing to ask about the same place in the current conversation.
3. For a city or district, use QWeather GeoAPI first and fall back to AMap only when configured and necessary.
4. Call AMap geocoding for a new street, community, building, hospital, mall, school, or other detailed Chinese address.

When AMap is required, call:

```bash
curl -fsS --max-time 8 --get \
  "https://restapi.amap.com/v3/geocode/geo" \
  --data-urlencode "key=$AMAP_KEY" \
  --data-urlencode "address=$ADDRESS"
```

On PowerShell, call `curl.exe` and use `$env:AMAP_KEY`. Adapt all later environment-variable references the same way.

Require `status == "1"` and at least one geocode. Prefer a result whose province/city/district matches the user's text. Extract:

- `formatted_address`
- longitude and latitude from `geocodes[0].location`, which is `lng,lat`

If multiple results remain plausible, ask the user to confirm rather than silently choosing the wrong place.

Treat a geocoded building or community as a coordinate anchor, not a promise of building-level weather. QWeather grid output is numerical-model data with roughly 3–5 km spatial resolution. Describe results as weather “near this address”.

### Step 2: Choose only relevant weather endpoints

Use `QWEATHER_BASE_URL` as the host and send `X-QW-Api-Key: $QWEATHER_API_KEY` on every QWeather call.

| User intent | QWeather path | Caiyun path/data |
|---|---|---|
| Current comparison | `/v7/weather/now` | `realtime.json` |
| Next hours/rain timing | `/v7/weather/24h` or `/v7/weather/72h` | `hourly.json?hourlysteps=N` |
| Daily forecast | `/v7/weather/3d`, `/7d`, `/10d`, `/15d`, or `/30d` | `daily.json?dailysteps=N` |
| Next-two-hour rain | `/v7/minutely/5m` | `minutely.json` |
| Weather alerts | `/weatheralert/v1/current/{lat}/{lng}` | `realtime.json?alert=true` or `weather.json?alert=true` |
| Life indices | `/v7/indices/1d` or `/3d`, `type=0` | `result.realtime.life_index` |
| Current air quality | `/airquality/v1/current/{lat}/{lng}` | `result.realtime.air_quality` |
| Hourly/daily air | `/airquality/v1/hourly/{lat}/{lng}` or `/daily/{lat}/{lng}` | hourly/daily air-quality arrays when returned |
| Exact-coordinate grid | `/v7/grid-weather/24h`, `/72h`, `/3d`, or `/7d` | use normal Caiyun coordinate forecast |
| Sun and moon | `/v7/astronomy/sun` and `/v7/astronomy/moon`, with `date=yyyyMMdd` | use daily astronomy fields when returned |
| Solar radiation | `/solarradiation/v1/forecast/{lat}/{lng}` | hourly `dswrf` |
| Recent historical day | `/v7/historical/weather` or `/v7/historical/air` | use Caiyun history only when the official endpoint/plan returns it |
| Typhoon | `/v7/tropical/storm-list`, then `storm-track` or `storm-forecast` | no equivalent required |
| Tide | `/v7/ocean/tide`, using a QWeather TSTA station ID | no equivalent required |
| Usage or finance | `/metrics/v1/stats` or `/finance/v1/summary` | no equivalent required; call only on explicit account questions |

Use `/geo/v2/city/lookup` from the assigned QWeather host for ordinary city and district resolution. Use `/geo/v2/poi/lookup` or `/geo/v2/poi/range` only when a scenic POI or station-oriented lookup is required.

Do not call professional, finance, or account endpoints merely to enrich an ordinary weather answer.

### Step 3: Make requests

QWeather template:

```bash
curl -fsS --max-time 8 --get \
  "$QWEATHER_BASE_URL/v7/weather/now" \
  -H "X-QW-Api-Key: $QWEATHER_API_KEY" \
  --data-urlencode "location=$LNG,$LAT"
```

Format every QWeather longitude and latitude to exactly two decimal places before sending it, including query parameters and coordinate path segments.

Caiyun HMAC template:

```bash
curl -fsS --max-time 8 \
  "https://api.caiyunapp.com/v2.6/$CAIYUN_APP_KEY/$LNG,$LAT/weather?alert=true&dailysteps=1&hourlysteps=24&unit=metric%3Av2" \
  -H "x-cy-nonce: $NONCE" \
  -H "x-cy-timestamp: $TIMESTAMP" \
  -H "x-cy-signature: $SIGNATURE"
```

Generate the signature exactly as documented; prefer the bundled adapter instead of reproducing signing logic in a shell. Round Caiyun `hourlysteps` up to the next multiple of 24, with a minimum of 24 and maximum of 360, then crop output to the user's requested hours. Always send `unit=metric:v2`. Do not display either expanded command. For a default comparison, query QWeather current/hourly/warning and one Caiyun weather call concurrently. For a focused question, omit unrelated calls.

### Step 4: Validate and normalize

For QWeather v7 and GeoAPI responses that include `code`, require `code == "200"`. For newer v1 responses such as Weather Alert and Air Quality, require successful HTTP status plus the documented top-level structure. Accept Caiyun only when `status == "ok"` and `result` exists.

The QWeather Weather Alert v1 response does not use the old `code + warning[]` structure. Read `metadata` and `alerts[]`; preserve `senderName`, `eventType.name`, `severity`, `headline`, `description`, and `instruction`. Preserve `metadata.attributions` as `alertMetadata.attributions` and show it with any alert answer.

Normalize before comparing:

- Temperature: numeric Celsius; format as `N°C` only in the final answer.
- QWeather humidity is already percent. Caiyun humidity is usually a fraction; multiply values from `0` through `1` by `100`.
- QWeather precipitation amount: `precipitationAmount` in millimetres, rounded to two decimals.
- Caiyun precipitation intensity under `unit=metric:v2`: `precipitationIntensity` in millimetres per hour. Do not label it as accumulated millimetres.
- Probability: QWeather and Caiyun hourly probability are already `0` through `100`. Caiyun minutely probability is `0` through `1` and must be multiplied by `100`.
- Caiyun daily precipitation probability has no unambiguous scale in the current public field documentation. Preserve it as `precipitationProbabilityRaw`; do not append `%` or multiply it until a real account response confirms the scale.
- Wind: combine QWeather `windDir` and `windScale`; do not invent a Beaufort conversion.
- Time: preserve provider timestamps and state the timezone if providers differ.
- Air quality: identify the standard/provider; do not compare unlike AQI standards as if identical.

Map Caiyun Skycon codes:

| Codes | Chinese |
|---|---|
| `CLEAR_DAY`, `CLEAR_NIGHT` | 晴 |
| `PARTLY_CLOUDY_DAY`, `PARTLY_CLOUDY_NIGHT` | 多云 |
| `CLOUDY` | 阴 |
| `LIGHT_HAZE`, `MODERATE_HAZE`, `HEAVY_HAZE` | 轻度/中度/重度雾霾 |
| `LIGHT_RAIN`, `MODERATE_RAIN`, `HEAVY_RAIN`, `STORM_RAIN` | 小雨/中雨/大雨/暴雨 |
| `LIGHT_SNOW`, `MODERATE_SNOW`, `HEAVY_SNOW`, `STORM_SNOW` | 小雪/中雪/大雪/暴雪 |
| `FOG`, `DUST`, `SAND`, `WIND` | 雾/浮尘/沙尘/大风 |

### Step 5: Answer conversationally

- Lead with the direct answer to the user's question, not an API dump.
- Include the resolved location so the user can catch a geocoding mistake.
- For a detailed address, say “该地址附近” or equivalent. Never claim room-, building-, or entrance-level weather precision.
- For a default report, mention current condition, temperature/feels-like, near-term rain, meaningful provider disagreement, and active warnings.
- Say “两家基本一致” only when the compared values actually agree. For temperature, a difference up to `1°C` is highly consistent, up to `2°C` is broadly consistent, and more than `2°C` is a meaningful difference.
- If one provider fails, clearly label the answer as single-source. If both fail, give a concise setup or retry action.
- When reporting QWeather alerts, include the returned attribution text or link near the alert summary.
- Keep ordinary answers compact. Return detailed hourly, daily, radiation, pollutant, typhoon, or tide data only when asked.
- Treat typhoon center distance as geometry, not landing probability or an evacuation instruction. Treat weather and health indices as reference information, not medical or emergency advice.

## Common setup errors

| Symptom | Likely cause | Action |
|---|---|---|
| Skill is not listed | Wrong path or old session snapshot | Verify `dual-weather/SKILL.md`, then `/new` or restart Gateway |
| Python adapter fails to start | Python is missing or too old | Install Python 3.10+, or use curl fallback |
| `curl` is missing | Python is unavailable and runtime has no curl | Install either Python 3.10+ or curl, then start a new session |
| AMap `status=0` | Wrong key type or quota | Confirm the key platform is Web Service and inspect `info`/`infocode` |
| QWeather `401` | Invalid credential/header | Confirm `QWEATHER_API_KEY` and `X-QW-Api-Key` |
| QWeather `402` | Quota exceeded or insufficient balance | Check the QWeather Console; do not retry repeatedly |
| QWeather `403` | Product not enabled | Check project permissions and plan |
| QWeather `404` | Wrong assigned host or path | Recopy `QWEATHER_BASE_URL`; do not append `/v7` in config |
| QWeather `429` | QPM limit | Wait, reduce calls, then retry once |
| Adapter reports invalid JSON while `curl --compressed` works | Adapter older than v0.13.0 and cannot decode gzip | Update the Skill; current adapter decodes gzip success and error bodies |
| Caiyun authentication error | Wrong/disabled token | Recopy the application token and check plan status |
| One provider times out | Temporary network/provider issue | Answer from the other provider and label it single-source |
