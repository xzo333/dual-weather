# OpenClaw Dual Weather｜双源天气

让 OpenClaw 同时参考和风天气与彩云天气，不再只用一个天气源回答你。

你只需要说出地点和问题，它会自动解析地址、比较两家数据，并按需查询分钟降水、空气质量、生活指数、辐照、台风、潮汐、天文等详细信息。日常回答保持精简，需要专业数据时再深入查询。

## 你可以这样问

- “深圳市宝安区现在多少度，体感怎么样？”
- “今晚几点开始下雨？两家预报一致吗？”
- “明天适合跑步、洗车和晒被子吗？”
- “未来 24 小时 PM2.5 和臭氧会怎么变化？”
- “今天的太阳辐照强不强？光伏板大概什么时候辐照最高？”
- “这个台风离厦门最近有多远？”
- “深圳湾今天几点涨潮和退潮？”
- “和风和彩云的 API 是否正常？最近调用了多少次？”

## 为什么用双源

- **交叉验证**：同时展示和风与彩云的关键结果，并指出明显分歧。
- **按问题查询**：不会每次拉取所有庞大接口，只查询回答当前问题所需的数据。
- **单源故障可用**：一家超时或报错时，另一家仍可继续生成报告，并明确说明数据来源。
- **专业能力渐进开放**：日常天气简单回答，空气监测站、格点预报、太阳辐射、台风、潮汐等按需调用。
- **长期运行保护**：内置缓存、并发合并、有限重试、双源熔断和本地请求统计，减少重复调用与配额浪费。

## 快速开始

```bash
git clone https://github.com/xzo333/openclaw-dual-weather.git
cd openclaw-dual-weather
npm install
npm run check
npm test
npm pack
openclaw plugins install ./openclaw-dual-weather-0.8.0.tgz --force
```

复制 [.env.example](.env.example) 中需要的配置。日常双源天气至少需要：

```dotenv
AMAP_KEY=your_amap_web_service_key
QWEATHER_API_KEY=your_qweather_api_key
CAIYUN_WEATHER_API_TOKEN=your_caiyun_api_key
```

不需要专业接口时，无须配置和风 JWT 或专属 API Host。

## 工具

- `geocode_address`：地址转标准坐标。
- `qweather_location`：查询和风 LocationID、行政区、时区与标准坐标。
- `qweather_professional`：按需查询空气监测站、太阳高度角、历史天气、台风和潮汐。
- `weather_service_status`：真实检查双 API 连通性，或查看、清空缓存与熔断状态。
- `qweather_account`：按需查询和风控制台最近 24 小时请求量或财务汇总。
- `dual_weather`：按坐标查询双天气源。
- `weather_report`：一步完成地址解析与精简天气聚合。
- `weather_details`：按专题返回详细数据。

默认聚合报告保持在 2KB 内；详细问题只查询需要的专题。

## 0.8.0 Provider 架构

### 和风内建适配器

支持两种认证：

- API Key：优先读取 `QWEATHER_API_KEY`，兼容 `HEFENG_KEY`。
- Ed25519 JWT：读取 `QWEATHER_KID`、`QWEATHER_PROJECT_ID`、`QWEATHER_PRIVATE_KEY` 和专属 `QWEATHER_BASE_URL`。

JWT 会在进程内生成并短时缓存，不会把私钥发送给和风。自定义 Host 的空气质量自动使用 `/airquality/v1/current/{lat}/{lon}`；旧公共 Host 保持 `/v7/air/now` 兼容。

和风预报范围按官方端点向上匹配：城市小时 `24/72/168`，城市日级 `3/7/10/15/30`，生活指数 `1/3` 天；新增能力包括：

- GeoAPI 城市查询：返回 LocationID、行政区、时区与坐标。使用专属 API Host 时自动派生 `/geo/v2`，也可用 `QWEATHER_GEO_URL` 覆盖。
- 格点天气：小时 `24/72`、日级 `3/7`，用于精确坐标的数值模式结果。格点时间为 UTC+0，不能等同于观测站实况。
- 空气质量：当前、逐小时、逐日；专属 Host 使用新版 `/airquality/v1`，旧公共 Host 兼容 v7。
- 日月天文：未来 60 天内指定日期的日出、日落、月升、月落和小时月相。
- 专业太阳辐射：未来 `1-60` 小时、`15/30/60` 分钟粒度，输出 DNI/DHI/GHI；提供板面倾角和方位角时可附加 POA。

`radiation` 与 `solar_radiation` 不同：前者是彩云 `dswrf`（向下短波辐射通量），后者是和风专业太阳辐射产品。专业太阳辐射必须配置控制台分配的 `QWEATHER_BASE_URL`。

### 专业能力链路

- 最近 10 日历史：先用 `qweather_location(action=city_lookup)` 获取城市 LocationID，再调用 `qweather_professional(action=historical_weather)`。日期必须是最近 10 天内且不包含今天。
- 最近 10 日历史空气质量：使用相同的 LocationID 和日期，调用 `qweather_professional(action=historical_air)` 获取逐小时 AQI 与污染物。
- 空气监测站：先从 `weather_details(topic=air_quality)` 的和风结果中取得站点 ID，再调用 `qweather_professional(action=air_station)`。新版站点接口需要专属 API Host。
- 潮汐：先用 `qweather_location(action=poi_lookup|poi_range, poiType=TSTA)` 获取潮汐站 ID，再调用 `qweather_professional(action=tide)`。
- 台风：先用 `tropical_list` 获取当前或上一年度 StormID，再按问题调用 `tropical_track` 或 `tropical_forecast`；中国沿海默认使用 `basin=NP`。
- 台风距离：在路径或预报查询中提供 `targetLng`、`targetLat` 和可选 `riskRadiusKm`，可计算台风中心路径点到目标位置的最近几何距离。该结果不是登陆概率、风圈影响或官方风险预警。
- 太阳高度角：`solar_angle` 接收精确经纬度、日期、时刻、时区偏移和海拔，返回太阳高度角、方位角、太阳时与时角。

`qweather_location` 同时支持热门城市、景点名称查询及坐标范围 POI 查询。

### 缓存、退避与健康检查

- 内置最多 256 项进程内缓存和相同请求并发合并；缓存键不包含 API Key。
- 默认仍是纯内存缓存；设置 `WEATHER_CACHE_FILE` 后会原子写入私有 JSON 文件，重启后可继续使用未过期结果。GeoAPI 始终不缓存。
- 按数据时效使用弹性 TTL：分钟降水/预警 5 分钟、实况 5-10 分钟、小时预报 30 分钟、日级预报 1 小时、潮汐 8 小时、太阳辐射 6 小时等。
- GeoAPI 不缓存，避免违反地理数据许可限制。
- `429`、`502`、`503`、`504` 和临时网络失败只重试一次并使用指数退避；鉴权或参数类 `4xx` 不重试。
- 每个天气源连续失败 3 次后默认熔断 60 秒，避免故障期间持续消耗配额；和风业务状态 `401/402/403/429/500` 也计入熔断，而位置或参数类 `204/400/404` 不会误伤整个 Provider。可通过 `WEATHER_CIRCUIT_FAILURES` 与 `WEATHER_CIRCUIT_COOLDOWN_MS` 调整。
- `weather_service_status(action=health)` 绕过缓存和熔断并各发起一次和风与彩云请求；`cache_stats`/`cache_clear` 管理缓存，`circuit_stats`/`circuit_reset` 管理熔断器。
- `request_stats` 返回本进程和风、彩云的逻辑调用数、缓存命中/合并/绕过、真实上游尝试、重试、成功失败与延迟；`request_stats_reset` 显式清零这些本地统计。它与和风控制台的 24 小时账户统计不是同一数据源。
- 设置 `WEATHER_CACHE_DISABLED=1` 可全局绕过缓存。

### 和风请求量与费用

`qweather_account(action=request_stats)` 汇总最近 24 小时成功量、错误量和错误率，可按 `project` 或 `credential` 过滤（二者不能同时使用）。`finance_summary` 返回余额、当月累计费用、待付账单与可用计划，并可设置余额和月费用提示阈值。

这两个控制台 API 需要和风控制台分配的自定义 `QWEATHER_BASE_URL`，且凭据必须开启对应的 Console API 权限。财务数据属于敏感账户信息，Skill 仅在用户明确询问用量、余额或费用时调用。
请求量与财务结果不会进入天气缓存或持久缓存，确保数据保持新鲜并避免账户信息落盘。
阈值只生成本次查询的提示，不是和风账户侧的强制预算或自动停用开关。

和风当前官方海洋 API 仅提供潮汐，没有可用的海洋潮流/洋流端点，因此插件不会构造不存在的接口。

### 彩云内建适配器

优先读取官方变量名 `CAIYUN_WEATHER_API_TOKEN`，兼容 `CAIYUN_KEY`。内建适配器继续承担双源聚合、分钟降水、辐照和详细专题的 HTTP 回退。

### 彩云官方 MCP

官方 Hosted MCP：`https://mcp-weather.caiyunapp.com/mcp`，使用 `X-Caiyun-API-Key` Header。运行下面的命令会显式写入 OpenClaw MCP 配置；安装插件本身不会自动修改全局配置。

```bash
npm run setup:caiyun-mcp
openclaw gateway restart
```

仅查看将要写入的配置：

```bash
npm run setup:caiyun-mcp -- --print --env CAIYUN_WEATHER_API_TOKEN
```

注册后可获得官方工具：实时天气、1–360 小时预报、7 天预报、过去 24 小时天气和天气预警。Skill 会在历史查询、超长小时预报或用户明确要求官方彩云结果时优先使用它；双源比较仍使用本插件工具。

## 完整配置

参考 [.env.example](.env.example)。最小 API Key 配置：

```dotenv
AMAP_KEY=your_amap_web_service_key
QWEATHER_API_KEY=your_qweather_api_key
CAIYUN_WEATHER_API_TOKEN=your_caiyun_api_key
WEATHER_TIMEOUT_MS=5000
# WEATHER_CACHE_FILE=C:/OpenClaw/data/dual-weather-cache.json
# WEATHER_CIRCUIT_FAILURES=3
# WEATHER_CIRCUIT_COOLDOWN_MS=60000
```

## 开发验证

```bash
npm install
npm run check
npm test
npm pack
openclaw plugins install ./openclaw-dual-weather-0.8.0.tgz --force
```

## 参考实现

- 彩云官方 MCP：`caiyunapp/mcp-caiyun-weather`。参考其工具粒度、参数边界、`metric:v2`、过去 24 小时查询、User-Agent/超时与测试结构。
- 彩云官方 Skill：`caiyunapp/skills/skills/caiyun-weather`。参考 Skycon、生活指数、降水阈值和自然语言路由。
- 第三方和风 Skill：`yinguobing/qweather-skill`。参考 API Key/JWT 双认证、专属 Host、v7/v1 空气质量切换、预报范围和专业能力分层。

第三方实现仅作为设计参考，没有复制其 GPL 源码。

## 开源许可

本项目使用 [MIT License](LICENSE)。
