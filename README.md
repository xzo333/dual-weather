# OpenClaw Dual Weather

一个轻量的 OpenClaw Skill。它让 AI 直接调用高德、和风天气和彩云天气的官方 HTTP API，先把地址转换成坐标，再根据你的问题查询天气详情并进行双源比较。

本项目只有一个运行时文件：`SKILL.md`。不依赖 MCP、Plugin、Node.js、Python 或 npm 包；`scripts/` 不是必需项，所以当前没有创建。README 只用于 GitHub 首页和新人安装引导。

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

OpenClaw Skill 是一个目录，目录内必须有 `SKILL.md`。可以直接下载本文件，也可以克隆仓库。

### 直接下载

macOS/Linux：

```bash
mkdir -p ~/.openclaw/skills/dual-weather
curl -fsSL https://raw.githubusercontent.com/xzo333/openclaw-dual-weather/main/SKILL.md \
  -o ~/.openclaw/skills/dual-weather/SKILL.md
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force "$HOME/.openclaw/skills/dual-weather" | Out-Null
Invoke-WebRequest `
  "https://raw.githubusercontent.com/xzo333/openclaw-dual-weather/main/SKILL.md" `
  -OutFile "$HOME/.openclaw/skills/dual-weather/SKILL.md"
```

也可以从 [v0.9.0 Release](https://github.com/xzo333/openclaw-dual-weather/releases/tag/v0.9.0) 下载 `SKILL.md`。

安装后新建聊天会话：

```text
/new
```

如果没有识别到 Skill，再执行：

```bash
openclaw gateway restart
```

OpenClaw 会从工作区 `skills/`、用户管理目录和其他配置目录加载 Skill；同名 Skill 优先使用工作区版本。

## 申请 API 密钥

### 高德地图

1. 打开[高德开放平台控制台](https://console.amap.com/)并注册登录。
2. 创建应用。
3. 添加 Key，服务平台选择 **Web服务**。
4. 参考[高德申请 Key 官方说明](https://lbs.amap.com/api/webservice/guide/create-project/get-key)。
5. 保存为 `AMAP_KEY`。

高德只负责把“深圳市宝安区”这类地址转换成经度和纬度。

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

1. 使用高德 `/v3/geocode/geo` 取得标准坐标。
2. 根据问题选择需要的接口，不默认拉取所有大 JSON。
3. 让 AI 工具并行请求和风与彩云的独立接口。
4. 统一温度、湿度、降水量、降水概率和天气状况后再比较。
5. 只提取回答需要的字段，普通回答保持简洁，详细问题才展开小时、污染物或专业数据。

完整接口路径、字段映射、错误处理和密钥排查规则都写在 [SKILL.md](SKILL.md) 中。

## 许可证

[MIT License](LICENSE)
