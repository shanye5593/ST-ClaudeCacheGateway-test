# ST Claude Cache Gateway

Local gateway for SillyTavern. It converts `[[CACHE_BREAK]]` markers into Claude prompt-cache `cache_control` blocks immediately before forwarding requests to an upstream provider such as Pioneer.

This route keeps SillyTavern's normal send flow intact, so memory/world-info/regex/prompt plugins can finish their normal interception before the final request reaches this gateway.

## Features

- `POST /v1/chat/completions` accepts SillyTavern/OpenAI-compatible chat completions after converting markers.
- `POST /v1/messages` accepts Claude/Anthropic-compatible requests after converting markers.
- Defaults to Anthropic native `/v1/messages` upstream mode for Claude cache compatibility.
- Can switch back to OpenAI-compatible upstream mode with `UPSTREAM_MODE=openai` or the debug console.
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
http://127.0.0.1:8788
```

and forwards to:

```text
https://api.pioneer.ai
```

In SillyTavern OpenAI-compatible / Chat Completion settings:

```text
Base URL: http://127.0.0.1:8788
API Key:  your Pioneer API key
Model:    your Pioneer model name
```

In SillyTavern Claude/Anthropic-compatible settings, use the same local base URL:

```text
Base URL: http://127.0.0.1:8788
API Key:  your Pioneer API key
Model:    your Claude model name
```

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
Base URL: http://127.0.0.1:8788
```

If another device needs to connect to the Termux phone, bind to all interfaces:

```sh
HOST=0.0.0.0 npm start
```

Then use the phone's LAN IP in SillyTavern:

```text
Base URL: http://PHONE_LAN_IP:8788
```

Only do this on a trusted private network. Anyone who can reach the gateway can send requests through it if they also have an API key or if `UPSTREAM_API_KEY` is set.

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen host. Use `0.0.0.0` for LAN access. |
| `PORT` | `8788` | Listen port. |
| `UPSTREAM_BASE_URL` | `https://api.pioneer.ai` | Upstream provider root, `/v1`, or full endpoint. |
| `UPSTREAM_MODE` | `anthropic` | Upstream request format. `anthropic` converts chat completions to Claude native `/v1/messages`; `openai` forwards to `/v1/chat/completions`. |
| `UPSTREAM_API_KEY` | empty | Optional fallback API key if the client does not send `Authorization`. |
| `CACHE_TTL` | `1h` | Cache lifetime. `1h` sends Anthropic's 1-hour TTL; empty/default/none/provider-default omits `ttl`. |

Examples:

```sh
UPSTREAM_BASE_URL=https://api.pioneer.ai PORT=8788 npm start
```

Use OpenAI-compatible upstream mode if your provider/model does not support Claude native `/v1/messages`:

```sh
UPSTREAM_MODE=openai npm start
```

Note: Claude/Anthropic-compatible inbound `POST /v1/messages` requires Anthropic upstream mode. OpenAI-compatible inbound `POST /v1/chat/completions` can use either upstream mode.

Use provider-default cache TTL if your upstream/model does not support `1h`:

```sh
CACHE_TTL=default npm start
```

```powershell
$env:UPSTREAM_BASE_URL = 'https://api.pioneer.ai'
$env:PORT = '8788'
# Optional: omit ttl and use provider default cache lifetime
# $env:CACHE_TTL = 'default'
npm start
```

## Debug console

Open the local console in a browser:

```text
http://127.0.0.1:8788/console
```

The console can:

- switch cache TTL between `1h` and provider default without restarting the gateway;
- switch upstream request format between Anthropic native and OpenAI-compatible without restarting the gateway;
- remember the last selected TTL/upstream mode after restart in local `gateway-settings.json`;
- show current runtime state;
- enable capture and store the latest converted request JSON bodies in memory;
- download a captured JSON file for debugging.

Captured requests can include private prompts. Capture is always off when the gateway starts.

## Health check

```sh
curl http://127.0.0.1:8788/health
```

Expected response:

```json
{
  "ok": true,
  "host": "127.0.0.1",
  "port": 8788,
  "upstreamBaseUrl": "https://api.pioneer.ai",
  "upstreamMode": "anthropic",
  "cacheTtl": "1h"
}
```

## Notes

- Do not publish logs or exported requests that contain private prompts or API keys.
- Prefer passing the API key from SillyTavern. Use `UPSTREAM_API_KEY` only on a private machine/network.
- Keep stable content before `[[CACHE_BREAK]]`; dynamic content before the marker reduces cache hits.
