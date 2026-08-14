import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const envIndex = args.indexOf("--env");
const explicitEnv = envIndex >= 0 ? args[envIndex + 1] : undefined;
const envName = explicitEnv ||
  (process.env.CAIYUN_WEATHER_API_TOKEN ? "CAIYUN_WEATHER_API_TOKEN" : "CAIYUN_KEY");

if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) {
  throw new Error("--env 必须是有效的环境变量名。");
}
if (!printOnly && !process.env[envName]) {
  throw new Error(`环境变量 ${envName} 未设置；请先配置彩云 API Key。`);
}

const config = {
  url: "https://mcp-weather.caiyunapp.com/mcp",
  transport: "streamable-http",
  headers: { "X-Caiyun-API-Key": `\${${envName}}` },
  connectionTimeoutMs: 10_000,
};
const serialized = JSON.stringify(config);

if (printOnly) {
  process.stdout.write(`${serialized}\n`);
} else {
  const command = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  const result = spawnSync(command, ["mcp", "set", "caiyun-weather", serialized], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
