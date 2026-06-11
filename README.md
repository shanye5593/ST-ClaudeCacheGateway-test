# ST Claude Cache Gateway

OpenAI-compatible local gateway for SillyTavern. It converts `[[CACHE_BREAK]]` markers into Claude prompt-cache `cache_control` blocks immediately before forwarding requests to an upstream provider such as Pioneer.

This route keeps SillyTavern's normal send flow intact, so memory/world-info/regex/prompt plugins can finish their normal interception before the final request reaches this gateway.

## Features

- `POST /v1/chat/completions` forwards chat completions after converting markers.
- `GET /v1/models` forwards model listing.
- `GET /health` checks the gateway.
- Supports streaming by piping the upstream response body.
- Defaults to provider ephemeral cache lifetime, usually about 5 minutes.
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
    "type": "ephemeral"
  }
}
```

Claude supports up to 4 cache breakpoints per request. Extra markers are removed without cache control.

The default provider ephemeral window is usually about 5 minutes. If your upstream supports 1-hour cache TTL, you can opt in with `CACHE_TTL=1h` or the debug console. Pioneer currently documents `ttl: "1h"`, but OpenAI-compatible chat completions may still behave as provider-default depending on the upstream.

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
| `CACHE_TTL` | empty | Cache lifetime. Empty/default/none omits `ttl`; use `1h` to try Anthropic's 1-hour TTL. |

Examples:

```sh
UPSTREAM_BASE_URL=https://api.pioneer.ai PORT=8788 npm start
```

Try 1-hour TTL if your upstream supports it:

```sh
CACHE_TTL=1h npm start
```

```powershell
$env:UPSTREAM_BASE_URL = 'https://api.pioneer.ai'
$env:PORT = '8788'
# Optional experimental 1-hour TTL:
# $env:CACHE_TTL = '1h'
npm start
```

## Debug console

Open the local console in a browser:

```text
http://127.0.0.1:8788/console
```

The console can:

- switch cache TTL between provider default and `1h` without restarting the gateway;
- show current runtime state;
- enable capture and store the latest converted request JSON bodies in memory;
- download a captured JSON file for debugging.

Captured requests can include private prompts. Review them before sharing.

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
  "cacheTtl": "provider-default"
}
```

## Notes

- Do not publish logs or exported requests that contain private prompts or API keys.
- Prefer passing the API key from SillyTavern. Use `UPSTREAM_API_KEY` only on a private machine/network.
- Keep stable content before `[[CACHE_BREAK]]`; dynamic content before the marker reduces cache hits.
