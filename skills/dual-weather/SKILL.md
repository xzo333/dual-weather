---
name: dual-weather
description: Query weather for Chinese addresses by geocoding with AMap and comparing QWeather with Caiyun, with routed access to QWeather professional grid, air-quality, astronomy, solar-radiation, recent weather and air history, tropical-cyclone proximity, ocean-tide, city, and POI APIs plus provider health, cache, circuit-breaker, usage, and finance controls. Use when a user asks for current weather, forecasts, rain timing, warnings, AQI or station pollutants, UV, comfort, LocationID, sunrise or moon phase, solar angle or irradiance, recent historical weather or air quality, typhoon tracks or distance to a place, tide times, scenic POIs, provider health, cache or circuit status, QWeather request usage or cost, or a cross-source comparison for a place in China.
---

# Dual Weather

Use the plugin tools to return a concise Chinese weather answer backed by two providers.

## Workflow

1. Prefer `weather_report` when the user supplies a place name or street address. It performs geocoding and weather aggregation in one call.
2. Use `geocode_address` followed by `dual_weather` when the coordinates must be inspected, reused, or confirmed separately.
3. Use `qweather_location` for QWeather identifiers:
   - `city_lookup`: resolve a city LocationID, timezone, or same-name ambiguity. Pass `adm` when known.
   - `top_city`: list popular cities for a country/region.
   - `poi_lookup`: find a named scenic POI or tide station. Set `poiType` to `scenic` or `TSTA`.
   - `poi_range`: find scenic POIs or tide stations around `lng,lat`; set a small `radius`.
4. Use `qweather_professional` only for the requested professional action:
   - `air_station`: inspect pollutants at a station ID returned by `weather_details(topic=air_quality)`; requires a custom QWeather API Host.
   - `solar_angle`: calculate solar elevation/azimuth for exact coordinates, `date`, `time`, timezone offset, and altitude.
   - `historical_weather`: query one of the last 10 complete days. Resolve `locationId` with `qweather_location(city_lookup)` first; today is not accepted.
   - `historical_air`: query hourly AQI and pollutants for the same recent-day and LocationID constraints.
   - `tropical_list`: list storms for the current or previous year, normally with basin `NP` for China.
   - `tropical_track` or `tropical_forecast`: pass a `stormId` from `tropical_list`.
     To compare the path with a place, pass `targetLng` and `targetLat`; optionally set `riskRadiusKm`.
   - `tide`: pass a TSTA `stationId` from `qweather_location(poi_lookup|poi_range)` and a date from today through the supported 10-day window.
5. Use `weather_details` when the user asks for a specific forecast dimension. Select exactly one topic per call unless the user explicitly asks for multiple independent dimensions:
   - `hourly`: exact hour, hourly temperature, humidity, wind, rain probability, visibility, pressure, or hourly AQI.
   - `daily`: tomorrow, a named future date, the next several days, sunrise, sunset, daily high/low, or daily rain.
   - `minutely`: whether it will rain soon, when rain starts/stops, or precipitation within the next two hours.
   - `radiation`: Caiyun downward shortwave radiation (`dswrf`) and its trend.
   - `indices`: UV, comfort, dressing, exercise, car washing, cold risk, or other life indices.
   - `alerts`: active severe-weather warnings and their details.
   - `air_quality`: AQI, PM2.5, PM10, ozone, NO2, SO2, or CO.
   - `air_quality_hourly`: hourly pollutant and AQI forecast. QWeather supports up to 72 hours; Caiyun can supply a longer hourly series when available.
   - `air_quality_daily`: daily pollutant and AQI outlook. QWeather supports up to 5 days; Caiyun supplies its available daily series.
   - `grid_hourly`: model/grid weather for an exact coordinate, up to 72 hours. Times from QWeather grid APIs are UTC+0.
   - `grid_daily`: model/grid daily forecast for an exact coordinate, up to 7 days.
   - `astronomy`: sunrise, sunset, moonrise, moonset, and hourly moon phases for `date` in `yyyyMMdd` format.
   - `solar_radiation`: QWeather professional DNI, DHI, GHI, and optional photovoltaic-plane POA forecast. Set `hours` to 1-60 and `interval` to 15, 30, or 60. For POA, set `includePoa=true` and provide both `tilt` (0-90) and `azimuth` (0-359, 0 is north).
   - `history`: weather during the past 24 hours.
6. Set `hours` or `days` only as large as required by the question. Do not request all available history or forecast ranges by default.
7. Treat the returned JSON as the factual source. Do not invent unavailable values.
8. Lead with the direct answer, then mention meaningful provider disagreement, rain timing, and active warnings.
9. If `errors` contains one provider, explicitly state that the report is based on the remaining provider. Do not present a single-source result as a confirmed comparison.
10. If both providers fail, report the errors concisely and ask the user to retry later or verify API configuration.

Use `weather_service_status` only for operational questions:

- Use `health` when the user asks whether credentials or upstream APIs are working. State that it makes two uncached billable/API-counted requests.
- Use `cache_stats` to inspect memory and optional persistent-cache status without contacting providers.
- Use `cache_clear` only when the user explicitly asks to refresh or clear cached weather data.
- Use `circuit_stats` to inspect automatic provider protection without contacting providers.
- Use `circuit_reset` only when the user explicitly asks to reset recovery state during troubleshooting.
- Use `request_stats` for process-local request, cache, retry, failure, and latency counters covering both providers. Distinguish it from `qweather_account(request_stats)`, which is QWeather's account-wide last-24-hour view.
- Use `request_stats_reset` only when the user explicitly asks to clear local operational counters.

Use `qweather_account` only for explicit account-operations questions:

- Use `request_stats` for QWeather's most recent 24-hour success/error counts. Pass at most one of `project` or `credential`.
- Use `finance_summary` only when the user explicitly asks about QWeather balance, charges, pending bills, or cost thresholds. Treat the result as sensitive account information and do not volunteer it in ordinary weather answers.
- Both actions require a custom QWeather API Host and matching Console API permissions on the credential.
- Account usage and finance responses deliberately bypass weather caching and persistent storage.
- Finance thresholds are advisory messages for the current query, not provider-side hard budgets or automatic shutdown rules.

## Official Caiyun MCP

When tools prefixed with `caiyun-weather__` are available, use the official MCP selectively:

- Prefer `caiyun-weather__get_historical_weather` for past-24-hour questions.
- Prefer `caiyun-weather__get_hourly_forecast` when the requested horizon exceeds 168 hours.
- Use `caiyun-weather__get_realtime_weather`, `caiyun-weather__get_weekly_forecast`, or `caiyun-weather__get_weather_alerts` when the user explicitly asks for the official Caiyun result.
- Continue to use `weather_report` or `weather_details` for cross-provider comparison. An official single-source tool does not replace fusion.
- Fall back to the plugin's built-in Caiyun HTTP adapter when official MCP tools are unavailable.

## Interpretation

- Temperatures and humidity are already normalized to `°C` and `%`.
- `comparison_summary.temp_diff` classifies cross-source agreement.
- `comparison_summary.rain_forecast` summarizes the first meaningful rain signal found in each provider's next 12 hours.
- `qweather.warning` contains up to three active warning titles.
- Caiyun supplies air quality, comfort, UV, and short-term precipitation language when available.
- Caiyun `dswrf` is downward shortwave radiation flux in `W/m²`; it is useful for irradiance trends but is not a photovoltaic power-output estimate.
- QWeather `solar_radiation` is a different professional product: DNI is direct normal irradiance, DHI is diffuse horizontal irradiance, GHI is global horizontal irradiance, and POA is irradiance on the configured panel plane.
- QWeather grid weather is numerical-model output at roughly 3-5 km resolution. Do not describe it as an observation station reading or directly use disagreement with city weather as a provider-quality verdict.
- Monitoring-station readings can be delayed or unavailable. Present them as reference station data, not guaranteed live truth.
- `history` in `weather_details` means Caiyun's past 24 hours; `historical_weather` means QWeather's selected complete day from the last 10 days.
- Treat typhoon `proximity` as center-point geometry only. Never convert it into a landing probability, wind/rain impact boundary, evacuation instruction, or official warning.
- Do not claim ocean-current support. The current QWeather ocean API exposes tide data only.
- Minute precipitation points are sampled every five minutes from Caiyun's next-two-hour sequence to keep tool output manageable.
- Provider results are memory-cached by default. Persistent caching is opt-in through `WEATHER_CACHE_FILE`; QWeather GeoAPI results are never persisted.
- A circuit breaker temporarily blocks repeated failing provider calls, while cached results remain usable. `health` deliberately bypasses it for diagnosis.
- QWeather account, authentication, balance/quota, QPM, and service errors (`401/402/403/429/500`) count toward circuit protection. Location/no-data/parameter errors (`204/400/404`) do not open a provider-wide circuit.
- Detailed topic responses are intentionally larger than the default report and are not subject to the default 2KB summary limit.

Keep the final answer compact. Include the resolved `location` so the user can catch geocoding mistakes.
