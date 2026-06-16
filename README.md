# ST Claude Cache Gateway 使用指南

ST Claude Cache Gateway 是一个面向 SillyTavern / 酒馆的本地 Claude 缓存网关。它接收 OpenAI-compatible 聊天补全请求，在发送给上游前处理 `[[CACHE_BREAK]]`、Claude prompt cache、Prefix 锁定、渠道 Profile 和高级参数。

默认监听：

```text
http://127.0.0.1:8788
```

酒馆 / 客户端推荐填写：

```text
Base URL: http://127.0.0.1:8788/v1
API Key: 你的上游供应商 API Key
```

> 不要把 API Key 写进渠道 Profile 或高级配置。Key 应放在客户端请求头，或仅在可信本机环境里通过 `UPSTREAM_API_KEY` 环境变量传入。

## 功能概览

- 接收 OpenAI-compatible `POST /v1/chat/completions` 请求。
- 默认使用 Pioneer 的 OpenAI-compatible 上游格式，也可切换为 Anthropic native `/v1/messages`。
- 支持 `[[CACHE_BREAK]]` 手动缓存标记。
- 支持 Claude `cache_control` 注入，最多 4 个缓存断点。
- 支持 1 小时缓存 TTL 或供应商默认缓存窗口。
- 支持首页“缓存转译”总开关。
- 支持 Prefix 锁定，降低前缀漂移导致的缓存不命中。
- 支持多渠道 Profile：Pioneer、OpenRouter、Anthropic、Vertex、Bedrock、自定义渠道。
- 支持 OpenRouter 供应商锁定和自定义供应商名。
- 支持高级配置：包含 / 排除主体参数，包含 / 排除请求头。
- 支持内存诊断日志，不持久化私密请求记录。
- 默认只绑定 `127.0.0.1`，适合本机使用。

## 安装与启动

需要 Node.js 18 或更新版本。

### Windows

可以双击：

```text
start-gateway.bat
```

也可以在终端运行：

```powershell
git clone https://github.com/shanye5593/ST-ClaudeCacheGateway.git
cd ST-ClaudeCacheGateway
npm start
```

### macOS / Linux

`.bat` 只适用于 Windows，macOS / Linux 不要运行它。

```sh
git clone https://github.com/shanye5593/ST-ClaudeCacheGateway.git
cd ST-ClaudeCacheGateway
chmod +x start-gateway.sh
./start-gateway.sh
```

也可以直接运行：

```sh
npm start
```

### Termux / Android

```sh
pkg update
pkg install git nodejs-lts
git clone https://github.com/shanye5593/ST-ClaudeCacheGateway.git
cd ST-ClaudeCacheGateway
npm start
```

如果 SillyTavern 和网关在同一台 Android / Termux 设备上：

```text
Base URL: http://127.0.0.1:8788/v1
```

## 控制台

启动后打开：

```text
http://127.0.0.1:8788/console
```

控制台包含：

- 网关概览：当前渠道、缓存转译、上游格式、TTL、Prefix 状态。
- 渠道配置：切换 / 保存渠道 Profile。
- 缓存策略：查看缓存标记、切换 TTL、管理 Prefix 锁定。
- 请求日志：临时打开诊断、查看最终请求体和缓存结果。
- 高级配置：处理主体参数和请求头。

## 客户端接入

推荐在 SillyTavern / 酒馆里使用 OpenAI-compatible / Chat Completion 接入方式。

```text
Base URL: http://127.0.0.1:8788/v1
API Key: 你的上游供应商 API Key
Model: 你的上游模型名
```

也可以使用 Claude / Anthropic-compatible 原生入站：

```text
POST http://127.0.0.1:8788/v1/messages
POST http://127.0.0.1:8788/v1/messages/count_tokens
```

使用 Claude 原生入站时，请把当前渠道的上游格式保持为 Anthropic native。酒馆场景仍优先推荐 OpenAI-compatible / Chat Completion 接入：

```text
酒馆 OpenAI-compatible 请求 -> 本地网关 -> Anthropic native 或 OpenAI-compatible 上游
```

## 缓存标记 `[[CACHE_BREAK]]`

把下面的标记放在大段稳定内容之后：

```text
[[CACHE_BREAK]]
```

网关会在发送上游前移除这个标记，并在对应位置注入 Claude prompt cache：

```json
{
  "cache_control": {
    "type": "ephemeral",
    "ttl": "1h"
  }
}
```

适合放在缓存标记之前：

- 系统提示词
- 角色卡
- 蓝灯世界书 / 蓝灯 World Info
- 长篇固定设定
- 固定规则和格式要求

适合放在缓存标记之后：

- 绿灯世界书 / 绿灯 World Info
- 最近聊天记录
- 当前用户输入
- 短期记忆
- 会频繁变化的上下文

简单理解：蓝灯世界书放在 `[[CACHE_BREAK]]` 前面，绿灯世界书放在 `[[CACHE_BREAK]]` 后面。

Claude 每个请求最多支持 4 个缓存断点。超过 4 个时，多余标记会被移除，但不会注入 `cache_control`。

## Prefix 锁定 / 强制锁定

Prefix 锁定是给“缓存点前面的内容不够稳定”准备的保护功能。它不是必须开启的功能；如果你的缓存点前内容本来就稳定，可以先不开。

它解决的问题是“前缀漂移”：有些酒馆配置、插件、世界书、正则、数据库填表内容或动态注入内容，可能会在 `[[CACHE_BREAK]]` 之前插入变化内容。只要缓存点之前有细微变化，Claude 看到的稳定前缀就不再完全一致，缓存命中率就会下降。

开启后：

1. 第一个带缓存点的最终请求会教会网关“稳定前缀”。
2. 网关会记录从请求开头到第一个 `cache_control` 为止的内容。
3. 后续请求会丢弃当前请求里的缓存点前缀，强制替换为已经学习到的稳定前缀。
4. 缓存点之后的内容仍使用当前请求的新内容，例如近期聊天、当前输入、绿灯世界书等。

这是一种替换，不是追加，所以不会把世界书、系统提示词或角色卡重复拼接。

适合开启 Prefix 锁定的情况：

- 你已经正确放置了 `[[CACHE_BREAK]]`，但缓存仍然不稳定。
- 怀疑世界书、正则、插件、数据库填表在缓存点前产生了动态变化。
- 想临时验证缓存不命中是否由前缀漂移造成。

不建议长期无脑开启的情况：

- 你经常切换角色卡、世界书或预设。
- 你希望缓存点之前的内容每轮都能自然更新。
- 你还没有确认哪些内容应该放在缓存点前、哪些应该放在缓存点后。

更换以下内容后，请清空并重新学习 Prefix：

- 角色卡
- 世界书
- 预设
- 主要系统提示词
- 任何应该位于缓存标记之前的内容

如果关闭首页“缓存转译”，Prefix 锁定也会跳过，不会参与请求处理。

## 缓存转译总开关

首页的“缓存转译”是总开关。

开启时：

- 网关识别 `[[CACHE_BREAK]]`。
- 网关注入 `cache_control`。
- Prefix 锁定可以参与请求处理。

关闭时：

- 网关不处理 `[[CACHE_BREAK]]`。
- 网关不注入 `cache_control`。
- Prefix 锁定会跳过。
- 高级配置仍然生效。
- 渠道 Profile 和上游格式转换仍然生效。

如果你只是想临时绕过缓存处理，但仍想保留渠道、高级参数、请求头规则，可以关闭“缓存转译”。

## 缓存 TTL

缓存策略页可以切换 TTL：

- `1 小时`：发送 Claude 原生 1 小时缓存窗口：`ttl: "1h"`。
- `默认窗口`：不发送 `ttl`，交给上游供应商默认 ephemeral 缓存窗口处理。

如果上游或模型不支持 1 小时 TTL，请切回默认窗口。

也可以用环境变量启动：

```sh
CACHE_TTL=default npm start
```

## 渠道 Profile

渠道 Profile 会持久化到本地 `gateway-settings.json`，保存：

- 渠道名称
- Base URL
- 上游格式
- 高级主体参数
- 高级请求头规则

不会保存 API Key。

默认渠道：

- Pioneer：默认自定义渠道，默认连接 `https://api.pioneer.ai`，上游格式默认 OpenAI-compatible。
- OpenRouter：内置模板，默认 `https://openrouter.ai/api/v1`，上游格式通常用 OpenAI-compatible。
- Anthropic：内置模板。
- Google Vertex AI：内置模板。
- Amazon Bedrock：内置模板。
- 自定义渠道：可以新建、重命名、保存、删除。

注意：Vertex 和 Bedrock 卡片目前是 Profile 模板，不包含 Google Auth 或 AWS SigV4 签名。如果你需要真实云厂商鉴权，建议先通过兼容供应商、自定义代理或后续专门实现的鉴权层接入。

## OpenRouter 供应商锁定

OpenRouter 渠道支持“锁定供应商”。它会把 provider 参数写入请求体，例如锁定 Amazon Bedrock：

```json
{
  "provider": {
    "order": ["Amazon Bedrock"],
    "allow_fallbacks": false
  }
}
```

控制台里可以：

- 选择常见供应商。
- 选择“自定义”后输入任意 OpenRouter 支持的供应商名。
- 关闭锁定，恢复不指定 provider。

如果 OpenRouter 没有在响应体或响应头返回实际供应商，诊断页可能显示 unknown；这不代表锁定没发送。以最终请求体里的 provider 字段为准。

## 高级配置

高级配置按当前渠道 Profile 保存。

### 包含主体参数

填写 JSON 对象，网关会把它深度合并进最终请求体。

示例：

```json
{
  "provider": {
    "order": ["Amazon Bedrock"],
    "allow_fallbacks": false
  }
}
```

这个功能只在 OpenAI-compatible 上游格式生效。Anthropic native 上游格式不会合并这些 OpenAI 请求体参数。

### 排除主体参数

一行一个字段路径，发送上游前删除对应字段。

示例：

```text
stream_options
metadata.trace_id
provider.allow_fallbacks
```

适合用于删除某些供应商不接受的请求体字段。

### 包含请求头

填写 JSON 对象，网关会添加或覆写非密钥请求头。

示例：

```json
{
  "HTTP-Referer": "https://example.com",
  "X-Title": "ST Claude Cache Gateway"
}
```

不允许保存密钥或协议敏感 header，例如：

- `authorization`
- `x-api-key`
- `cookie`
- `set-cookie`
- `host`
- `content-length`
- 包含 `token` / `secret` / `password` 的 header

### 排除请求头

一行一个 header 名，发送上游前删除。

示例：

```text
x-real-ip
x-forwarded-for
```

这可以用于删除某些代理、客户端或平台自动附带但你不想发给上游的 header。

## 请求诊断

请求诊断默认关闭，每次启动都是关闭状态。

开启后，网关会在内存里保存最近请求记录，用于查看：

- 最终发给上游的请求体
- 请求头摘要
- 缓存断点位置
- Prefix hash / suffix hash
- 上游状态码
- 上游返回的缓存 read / creation token 用量

诊断记录可能包含私密提示词、聊天内容、世界书内容。不要公开分享导出的诊断 JSON。诊断数据只保存在内存中，重启后清空。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。默认仅本机访问。 |
| `PORT` | `8788` | 监听端口。 |
| `UPSTREAM_BASE_URL` | `https://api.pioneer.ai` | 启动时的上游地址默认 / 覆盖。 |
| `UPSTREAM_MODE` | `openai` | 上游格式：`anthropic` 或 `openai`。 |
| `UPSTREAM_EXTRA_JSON` | `{}` | 启动时包含主体参数。 |
| `UPSTREAM_EXCLUDE_PATHS` | 空 | 启动时排除主体参数，逗号或换行分隔。 |
| `UPSTREAM_HEADERS` | `{}` | 启动时包含请求头。不要写密钥。 |
| `UPSTREAM_EXCLUDE_HEADERS` | 空 | 启动时排除请求头，逗号或换行分隔。 |
| `UPSTREAM_API_KEY` | 空 | 当客户端没有传 API Key 时的 fallback。仅建议私有环境使用。 |
| `CACHE_TTL` | `1h` | `1h` 或 `default`。 |
| `CACHE_TRANSLATION_ENABLED` | `true` | 是否启用缓存转译。 |

示例：

```sh
UPSTREAM_BASE_URL=https://api.pioneer.ai PORT=8788 npm start
```

OpenAI-compatible 上游：

```sh
UPSTREAM_MODE=openai npm start
```

关闭缓存转译：

```sh
CACHE_TRANSLATION_ENABLED=false npm start
```

PowerShell 示例：

```powershell
$env:UPSTREAM_BASE_URL = 'https://api.pioneer.ai'
$env:PORT = '8788'
$env:CACHE_TTL = 'default'
npm start
```

## 健康检查

```sh
curl http://127.0.0.1:8788/health
```

示例响应：

```json
{
  "ok": true,
  "host": "127.0.0.1",
  "port": 8788,
  "upstreamBaseUrl": "https://api.pioneer.ai",
  "upstreamMode": "openai",
  "cacheTtl": "1h"
}
```

## 常见问题

### macOS 打不开 `start-gateway.bat`

`.bat` 是 Windows 批处理文件。macOS / Linux 请用：

```sh
chmod +x start-gateway.sh
./start-gateway.sh
```

或直接运行：

```sh
npm start
```

### 酒馆请求 404 或路径不对

优先把 Base URL 填完整：

```text
http://127.0.0.1:8788/v1
```

### 请求日志要一直开吗？

不要。请求诊断只在排查问题时临时开启；平常保持关闭即可。诊断结束后建议关闭并清空日志。

### 缓存不命中

检查：

- 稳定内容是否都在 `[[CACHE_BREAK]]` 之前。
- 蓝灯世界书是否在 `[[CACHE_BREAK]]` 之前，绿灯世界书是否在 `[[CACHE_BREAK]]` 之后。
- 最近聊天和当前输入是否在 `[[CACHE_BREAK]]` 之后。
- 是否有世界书、正则、插件在缓存点之前插入动态内容。
- 必要时开启 Prefix 锁定测试是否是前缀漂移。

### 使用数据库会影响缓存吗？

使用数据库本身不影响缓存。官方渠道验证正常；如果出现数据库相关异常，通常是第三方实现或接入方式的问题。

需要注意的是：如果数据库的蓝灯条目会随着填表内容更新，它就不再是稳定前缀。此时应把全局注入位置改到缓存点后面，例如“角色后”或“系统”这类位于缓存点后的注入位置，避免它在缓存点前变化导致缓存失效。

### 上游报不支持 `ttl: 1h`

到“缓存策略”把 TTL 切换为默认窗口，或启动时使用：

```sh
CACHE_TTL=default npm start
```

### 可以把 Key 保存到 Profile 吗？

不建议，也不允许。网关会拒绝明显密钥字段。请让客户端发送 API Key，或仅在私有本机环境下使用 `UPSTREAM_API_KEY`。

## 安全注意事项

- 不要公开诊断 JSON、请求日志、聊天导出、世界书内容。
- 不要把 API Key 写进 README、Profile、高级配置或截图。
- `gateway-settings.json` 是本地运行配置，不应该提交到公开仓库。
- 默认绑定 `127.0.0.1`，建议保持仅本机访问。
- 请求诊断每次启动默认关闭，避免意外记录私密内容。
