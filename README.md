# ST Claude Cache Gateway

Local gateway for SillyTavern. It converts `[[CACHE_BREAK]]` markers into Claude prompt-cache `cache_control` blocks immediately before forwarding requests to an upstream provider such as Pioneer.

This route keeps SillyTavern's normal send flow intact, so memory/world-info/regex/prompt plugins can finish their normal interception before the final request reaches this gateway.

## Features

- `POST /v1/chat/completions` accepts SillyTavern/OpenAI-compatible chat completions after converting markers.
- Claude/Anthropic-compatible inbound (`POST /v1/messages`) is intentionally disabled because SillyTavern Claude-compatible requests may repeatedly rewrite cache.
- Defaults to Anthropic native `/v1/messages` upstream mode for Claude cache compatibility after receiving OpenAI-compatible inbound requests.
- Can switch back to OpenAI-compatible upstream mode with `UPSTREAM_MODE=openai` or the debug console.
- Supports optional upstream extra JSON body parameters for OpenRouter/provider routing tests.
- `GET /v1/models` forwards model listing.
- `GET /health` checks the gateway.
- Supports streaming by piping the upstream response body.
- Defaults to Claude native 1-hour cache TTL.
- Works on PC and Android Termux with Node.js 18+.
- No dependencies.

## How marker conversion works

Put this marker after large stable prompt content:

```text
[[CACHE_BREAK]]
```

The gateway removes the marker and adds this by default:

```json
{
  "cache_control": {
    "type": "ephemeral",
    "ttl": "1h"
  }
}
```

Claude supports up to 4 cache breakpoints per request. Extra markers are removed without cache control.

The default cache TTL is now `1h` because the gateway defaults to Anthropic native `/v1/messages` upstream mode. If you need the provider default ephemeral window instead, use `CACHE_TTL=default` or switch it in the debug console.

## PC quick start

```powershell
git clone https://github.com/shanye5593/ST-ClaudeCacheGateway.git
cd ST-ClaudeCacheGateway
npm start
```

By default it listens on:

```text
http://127.0.0.1:8789
```

and forwards to:

```text
https://api.pioneer.ai
```

Recommended SillyTavern setup: use OpenAI-compatible / Chat Completion settings, while keeping this gateway's upstream format as Anthropic native in the console.

```text
Base URL: http://127.0.0.1:8789
API Key:  your Pioneer API key
Model:    your Pioneer model name
```

Do not use SillyTavern Claude/Anthropic-compatible settings with this gateway. That inbound route is disabled because it may repeatedly rewrite cache in SillyTavern tests.

## Termux quick start

```sh
pkg update
pkg install git nodejs-lts
git clone https://github.com/shanye5593/ST-ClaudeCacheGateway.git
cd ST-ClaudeCacheGateway
npm start
```

If SillyTavern runs on the same Termux/Android device, use:

```text
Base URL: http://127.0.0.1:8789
```

If another device needs to connect to the Termux phone, bind to all interfaces:

```sh
HOST=0.0.0.0 npm start
```

Then use the phone's LAN IP in SillyTavern:

```text
Base URL: http://PHONE_LAN_IP:8789
```

Only do this on a trusted private network. Anyone who can reach the gateway can send requests through it if they also have an API key or if `UPSTREAM_API_KEY` is set.

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen host. Use `0.0.0.0` for LAN access. |
| `PORT` | `8789` | Listen port. |
| `UPSTREAM_BASE_URL` | `https://api.pioneer.ai` | Upstream provider root, `/v1`, or full endpoint. |
| `UPSTREAM_MODE` | `anthropic` | Upstream request format. `anthropic` converts chat completions to Claude native `/v1/messages`; `openai` forwards to `/v1/chat/completions`. |
| `UPSTREAM_EXTRA_JSON` | `{}` | Optional JSON object merged into OpenAI-compatible upstream request bodies, useful for OpenRouter provider routing parameters. |
| `UPSTREAM_API_KEY` | empty | Optional fallback API key if the client does not send `Authorization`. |
| `CACHE_TTL` | `1h` | Cache lifetime. `1h` sends Anthropic's 1-hour TTL; empty/default/none/provider-default omits `ttl`. |

Examples:

```sh
UPSTREAM_BASE_URL=https://api.pioneer.ai PORT=8789 npm start
```

Use OpenAI-compatible upstream mode if your provider/model does not support Claude native `/v1/messages`:

```sh
UPSTREAM_MODE=openai npm start
```

OpenRouter AWS supplier test example:

```powershell
$env:UPSTREAM_BASE_URL = 'https://openrouter.ai/api/v1'
$env:UPSTREAM_MODE = 'openai'
$env:UPSTREAM_API_KEY = 'sk-or-v1-...'
npm start
```

Then open the console, apply the `OpenRouter AWS 锁定` preset, enable diagnostics, and confirm the selected diagnostic JSON contains:

```json
"provider": {
  "order": ["Amazon Bedrock"],
  "allow_fallbacks": false
}
```

The returned-provider display is best-effort. Some upstreams return provider information in headers/body; if OpenRouter does not return it, the gateway will show `unknown/not returned`, but the final upstream request body still proves whether the provider lock was sent.

Note: Claude/Anthropic-compatible inbound `POST /v1/messages` and `POST /v1/messages/count_tokens` are disabled. Use OpenAI-compatible inbound `POST /v1/chat/completions`; it can use either upstream mode, with Anthropic native recommended for Claude cache.

Use provider-default cache TTL if your upstream/model does not support `1h`:

```sh
CACHE_TTL=default npm start
```

```powershell
$env:UPSTREAM_BASE_URL = 'https://api.pioneer.ai'
$env:PORT = '8789'
# Optional: omit ttl and use provider default cache lifetime
# $env:CACHE_TTL = 'default'
npm start
```

## Debug console

Open the local console in a browser:

```text
http://127.0.0.1:8789/console
```

The console can:

- switch cache TTL between `1h` and provider default without restarting the gateway;
- switch upstream request format between Anthropic native and OpenAI-compatible without restarting the gateway;
- remember the last selected TTL/upstream mode after restart in local `gateway-settings.json`;
- show current runtime state;
- enable diagnostics and store the latest request records in memory;
- record the exact final upstream request body that the gateway sends, including model/system/messages/tools/thinking and other parameters;
- summarize cache-control path, prefix hash, suffix hash, response status, and cache read/write token usage when the upstream returns usage fields;
- enable memory-only Force Prefix Lock;
- apply OpenRouter/provider extra JSON parameters and show best-effort returned provider information when the upstream exposes it;
- download a diagnostic JSON file for debugging.

Diagnostic records can include private prompts. Diagnostics are always off when the gateway starts. API-key headers are redacted, but request bodies are intentionally kept intact for cache debugging.

## Force Prefix Lock

Force Prefix Lock is an optional safety feature for unstable or incorrectly placed cache prefixes. It is off by default and only stored in memory.

When enabled:

1. The first final upstream request that contains a `cache_control` block teaches the gateway the locked prefix from the beginning of the prompt through the first `cache_control`.
2. Later requests discard their current prefix and send the locked prefix plus the current suffix after the first `cache_control`.
3. This is replacement, not append, so the same world-info/system prompt is not duplicated.

Clear the lock after changing character cards, world-info, presets, chats, or any content that should live before the cache marker. Dynamic memory should be placed after `[[CACHE_BREAK]]` if you want it to keep changing.

## Health check

```sh
curl http://127.0.0.1:8789/health
```

Expected response:

```json
{
  "ok": true,
  "host": "127.0.0.1",
  "port": 8789,
  "upstreamBaseUrl": "https://api.pioneer.ai",
  "upstreamMode": "anthropic",
  "cacheTtl": "1h"
}
```

## Notes

- Do not publish logs or exported requests that contain private prompts or API keys.
- Prefer passing the API key from SillyTavern. Use `UPSTREAM_API_KEY` only on a private machine/network.
- Keep stable content before `[[CACHE_BREAK]]`; dynamic content before the marker reduces cache hits.
