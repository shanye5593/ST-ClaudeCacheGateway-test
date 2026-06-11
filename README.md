# ST Claude Cache Gateway

OpenAI-compatible local gateway for SillyTavern. It converts `[[CACHE_BREAK]]` markers into Claude prompt-cache `cache_control` blocks immediately before forwarding requests to an upstream provider such as Pioneer.

This route keeps SillyTavern's normal send flow intact, so memory/world-info/regex/prompt plugins can finish their normal interception before the final request reaches this gateway.

## Features

- `POST /v1/chat/completions` forwards chat completions after converting markers.
- `GET /v1/models` forwards model listing.
- `GET /health` checks the gateway.
- Supports streaming by piping the upstream response body.
- Defaults to `cache_control: { "type": "ephemeral", "ttl": "1h" }`.
- Works on PC and Android Termux with Node.js 18+.
- No dependencies.

## How marker conversion works

Put this marker after large stable prompt content:

```text
[[CACHE_BREAK]]
```

The gateway removes the marker and adds:

```json
{
  "cache_control": {
    "type": "ephemeral"
  }
}
```

Claude supports up to 4 cache breakpoints per request. Extra markers are removed without cache control.

By default the gateway sends 1-hour cache controls:

```json
{
  "cache_control": {
    "type": "ephemeral",
    "ttl": "1h"
  }
}
```

Set `CACHE_TTL=default` or `CACHE_TTL=none` to omit `ttl` and use the provider's default ephemeral window.

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

In SillyTavern Chat Completion settings:

```text
Base URL: http://127.0.0.1:8788
API Key:  your Pioneer API key
Model:    your Pioneer model name
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
| `UPSTREAM_BASE_URL` | `https://api.pioneer.ai` | Upstream OpenAI-compatible provider root, `/v1`, or full endpoint. |
| `UPSTREAM_API_KEY` | empty | Optional fallback API key if the client does not send `Authorization`. |
| `CACHE_TTL` | `1h` | Cache lifetime. Use `default` or `none` to omit `ttl`. |

Examples:

```sh
UPSTREAM_BASE_URL=https://api.pioneer.ai PORT=8788 CACHE_TTL=1h npm start
```

Use provider default TTL instead:

```sh
CACHE_TTL=default npm start
```

```powershell
$env:UPSTREAM_BASE_URL = 'https://api.pioneer.ai'
$env:PORT = '8788'
$env:CACHE_TTL = '1h'
npm start
```

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
  "upstreamBaseUrl": "https://api.pioneer.ai"
}
```

## Notes

- Do not publish logs or exported requests that contain private prompts or API keys.
- Prefer passing the API key from SillyTavern. Use `UPSTREAM_API_KEY` only on a private machine/network.
- Keep stable content before `[[CACHE_BREAK]]`; dynamic content before the marker reduces cache hits.
