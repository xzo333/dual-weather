# OpenClaw Dual Weather

一个轻量的 OpenClaw Skill。用户提供详细地址时，它会先通过高德解析坐标；已有坐标或同一会话继续追问时则直接复用。随后根据问题并行调用和风天气与彩云天气官方 API，查询该位置附近的天气详情并进行双源比较。

本项目仍是轻量 Skill：`SKILL.md` 负责路由和回答规则，`scripts/weather.py` 使用 Python 标准库稳定完成地址解析、双源并发、超时重试、字段归一化和紧凑 JSON 输出。不依赖 MCP、Plugin、Node.js、npm、pip 或第三方 Python 包；没有 Python 时仍可按 Skill 使用 curl 回退。

## 能做什么

- 当前天气、体感温度、风向风力和湿度
- 未来小时、每日预报和两小时分钟降水
- 和风天气预警与彩云预警
- AQI、PM2.5、PM10、臭氧等空气质量
- UV、舒适度、穿衣、运动和洗车指数
- 彩云短波辐照 `dswrf` 与和风专业太阳辐射
- 日出、日落、月升、月落和月相
- 和风格点天气、近期历史天气和历史空气质量
- 台风路径、目标距离和潮汐
- 和风控制台请求量、余额和费用查询（仅在明确询问时）

## 安装

OpenClaw Skill 是一个目录，目录内必须有 `SKILL.md`。推荐直接克隆仓库，这样会同时获得 Python 适配器。

### 克隆安装

macOS/Linux：

```bash
git clone --depth 1 https://github.com/xzo333/openclaw-dual-weather.git \
  ~/.openclaw/skills/dual-weather
```

Windows PowerShell：

```powershell
git clone --depth 1 https://github.com/xzo333/openclaw-dual-weather.git `
  "$HOME/.openclaw/skills/dual-weather"
```

Python 3.10+ 为推荐运行环境，但无需执行 `pip install`。如果机器没有 Python，Skill 会退回 curl 方式。

安装后新建聊天会话：

```text
/new
```

如果没有识别到 Skill，再执行：

```bash
openclaw gateway restart
```

OpenClaw 会从工作区 `skills/`、用户管理目录和其他配置目录加载 Skill；同名 Skill 优先使用工作区版本。

## Python 适配器

检查配置，不显示密钥内容：

```bash
python scripts/weather.py check --pretty
```

按详细地址查询：

```bash
python scripts/weather.py query \
  --address "深圳市宝安区" \
  --topics current,hourly,minutely,alerts \
  --pretty
```

复用经纬度查询空气质量和辐照：

```bash
python scripts/weather.py query \
  --lng 113.88 --lat 22.55 \
  --topics air,radiation --hours 24 \
  --pretty
```

离线自检：

```bash
python scripts/weather.py self-test --pretty
```

脚本支持 `current`、`hourly`、`daily`、`minutely`、`alerts`、`indices`、`air`、`radiation`、`astronomy`、`grid-hourly` 和 `grid-daily`。台风、潮汐、历史、监测站与账户接口仍由 Skill 按官方专业接口直接请求，避免脚本再次膨胀成大型 Plugin。

## 申请 API 密钥

### 高德地图

1. 打开[高德开放平台控制台](https://console.amap.com/)并注册登录。
2. 创建应用。
3. 添加 Key，服务平台选择 **Web服务**。
4. 参考[高德申请 Key 官方说明](https://lbs.amap.com/api/webservice/guide/create-project/get-key)。
5. 保存为 `AMAP_KEY`。

高德只负责把“深圳市宝安区”这类地址转换成经度和纬度。用户已经提供坐标，或者同一会话正在继续询问已确认的地点时，可以跳过高德，因此 `AMAP_KEY` 只在需要地址解析时使用。

### 和风天气

1. 打开[和风天气控制台](https://console.qweather.com/)并注册登录。
2. 创建项目并创建 **API KEY** 凭据。新手优先使用 API Key，不必先配置 JWT。
3. 根据需要开通天气、空气质量、专业辐照、历史、台风或潮汐产品。
4. 保存凭据为 `QWEATHER_API_KEY`。
5. 从项目中复制分配的 API Host 为 `QWEATHER_BASE_URL`，保留 `https://`，不要附加 `/v7`。它通常类似 `https://xxxxxx.qweatherapi.com`。
6. 参考[项目与凭据说明](https://dev.qweather.com/docs/configuration/project-and-key/)和[API Host 说明](https://dev.qweather.com/docs/configuration/api-host/)。

### 彩云天气

1. 打开[彩云天气开放平台](https://platform.caiyunapp.com/)并注册登录。
2. 创建应用并开通 Weather API。
3. 保存应用 Token 为 `CAIYUN_WEATHER_API_TOKEN`。
4. 参考[彩云天气 API 文档](https://docs.caiyunapp.com/weather-api/dev.html)。

## 配置 OpenClaw 会话

推荐先在操作系统或 Secret Manager 中设置环境变量，再在 `~/.openclaw/openclaw.json` 中引用：

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
          CAIYUN_WEATHER_API_TOKEN: "${CAIYUN_WEATHER_API_TOKEN}"
        }
      }
    }
  }
}
```

不要把真实 Key 提交到 GitHub，也不要在聊天中发送 Key。若运行 Gateway 的服务进程拿不到操作系统环境变量，可以把值写入本机配置文件，并限制文件权限。

## 第一次测试

在新会话中发送：

> 深圳市宝安区现在天气怎么样？请比较和风和彩云，并告诉我未来两小时会不会下雨。

再测试详细查询：

> 查询深圳明天的小时降雨概率、空气质量、UV 和体感建议。

如果只配置了一家 Provider，Skill 应明确说明这是单源结果，不要伪装成双源比较。

## 工作方式

1. AI 优先调用 `scripts/weather.py`，并根据问题选择 topics。
2. 脚本优先使用用户提供的坐标；只有收到新的详细地址时才调用高德。
3. 脚本并行请求和风与彩云，统一温度、湿度、降水、概率和 Skycon。
4. 脚本只向 AI 输出紧凑 JSON，避免巨大原始响应占用上下文。
5. AI 根据结构化结果回答，并在单源失败时明确标记来源。
6. Python 不可用或查询专业端点时，Skill 使用 curl 官方接口回退。

详细地址只是帮助定位天气网格。回答应使用“该地址附近天气”，不能声称是某栋楼或某个房间的精确天气；和风格点天气属于约 3–5 公里空间分辨率的数值模式数据。

完整接口路径、字段映射、错误处理和密钥排查规则都写在 [SKILL.md](SKILL.md) 中。

## 许可证

[MIT License](LICENSE)
