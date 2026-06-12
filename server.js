const MARKER = '[[CACHE_BREAK]]';
const MAX_BREAKPOINTS = 4;
const DEFAULT_UPSTREAM_BASE_URL = 'https://api.pioneer.ai';

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || '127.0.0.1';
const upstreamBaseUrl = normalizeBaseUrl(process.env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL);
let cacheTtl = normalizeCacheTtl(process.env.CACHE_TTL || '');
let upstreamMode = normalizeUpstreamMode(process.env.UPSTREAM_MODE || 'openai');
let captureRequests = process.env.CAPTURE_REQUESTS === '1';
const requestCaptures = [];
const MAX_REQUEST_CAPTURES = 20;

function normalizeBaseUrl(baseUrl) {
    return baseUrl.trim().replace(/\/+$/, '');
}

function getApiRoot(baseUrl) {
    return normalizeBaseUrl(baseUrl)
        .replace(/\/v1\/chat\/completions$/i, '')
        .replace(/\/v1\/models$/i, '')
        .replace(/\/v1$/i, '');
}

function buildApiUrl(baseUrl, path) {
    return `${getApiRoot(baseUrl)}${path}`;
}

function normalizeCacheTtl(ttl) {
    const normalized = String(ttl || '').trim();

    if (!normalized || normalized.toLowerCase() === 'default' || normalized.toLowerCase() === 'none') {
        return '';
    }

    return normalized;
}

function normalizeUpstreamMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    return normalized === 'anthropic' ? 'anthropic' : 'openai';
}

function getCacheTtlLabel() {
    return cacheTtl || 'provider-default';
}

function getCacheControl() {
    const cacheControl = { type: 'ephemeral' };

    if (cacheTtl) {
        cacheControl.ttl = cacheTtl;
    }

    return cacheControl;
}

function getRuntimeState() {
    return {
        ok: true,
        host,
        port,
        upstreamBaseUrl,
        upstreamMode,
        cacheTtl: getCacheTtlLabel(),
        cacheControl: getCacheControl(),
        captureRequests,
        capturedRequests: requestCaptures.length,
    };
}

function log(message, details = null) {
    const time = new Date().toLocaleTimeString();

    if (details) {
        console.log(`[${time}] [Cache Gateway] ${message}`, details);
    } else {
        console.log(`[${time}] [Cache Gateway] ${message}`);
    }
}

function isTextBlock(block) {
    return block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string';
}

function stripMarkers(value) {
    return value.split(MARKER).join('');
}

function countMarkers(value) {
    return value.split(MARKER).length - 1;
}

function isMarkerOnlyText(text) {
    return text.includes(MARKER) && stripMarkers(text).trim() === '';
}

function isMarkerOnlyContent(content) {
    if (typeof content === 'string') {
        return isMarkerOnlyText(content);
    }

    if (!Array.isArray(content) || content.length === 0) {
        return false;
    }

    return content.every((block) => isTextBlock(block) && stripMarkers(block.text).trim() === '')
        && content.some((block) => block.text.includes(MARKER));
}

function countMarkersInContent(content) {
    if (typeof content === 'string') {
        return countMarkers(content);
    }

    if (!Array.isArray(content)) {
        return 0;
    }

    return content.reduce((total, block) => total + (isTextBlock(block) ? countMarkers(block.text) : 0), 0);
}

function getTextContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return null;
    }

    if (!content.every(isTextBlock)) {
        return null;
    }

    return content.map((block) => block.text).join('');
}

function addCacheControlToLastTextBlock(message) {
    if (typeof message?.content === 'string') {
        if (!message.content.trim()) {
            return null;
        }

        message.content = [{
            type: 'text',
            text: message.content,
            cache_control: getCacheControl(),
        }];

        return {
            blockIndex: 0,
            cachedBlockTextLength: message.content[0].text.length,
        };
    }

    if (!Array.isArray(message?.content)) {
        return null;
    }

    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
        const block = message.content[blockIndex];

        if (isTextBlock(block) && block.text.trim()) {
            block.cache_control = getCacheControl();
            return {
                blockIndex,
                cachedBlockTextLength: block.text.length,
            };
        }
    }

    return null;
}

function applyStandaloneMarkerToPreviousMessage(messages, markerIndex) {
    const markerRole = messages[markerIndex]?.role;

    for (let index = markerIndex - 1; index >= 0; index--) {
        const message = messages[index];

        if (message?.role !== markerRole || isMarkerOnlyContent(message?.content)) {
            continue;
        }

        const result = addCacheControlToLastTextBlock(message);

        if (result) {
            messages.splice(markerIndex, 1);
            return {
                targetIndex: index,
                targetBlockIndex: result.blockIndex,
                cachedBlockTextLength: result.cachedBlockTextLength,
            };
        }
    }

    return null;
}

function countExistingCacheBreakpoints(messages) {
    let count = 0;

    for (const message of messages) {
        if (!Array.isArray(message?.content)) {
            continue;
        }

        for (const block of message.content) {
            if (block?.cache_control) {
                count++;
            }
        }
    }

    return count;
}

function transformText(text, remainingBreakpoints) {
    if (!text.includes(MARKER)) {
        return { changed: false, content: text, injected: 0, removed: 0 };
    }

    const parts = text.split(MARKER);
    const markerCount = parts.length - 1;
    const content = [];
    let injected = 0;

    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        const hasMarkerAfterPart = index < parts.length - 1;

        if (part) {
            const block = {
                type: 'text',
                text: part,
            };

            if (hasMarkerAfterPart && injected < remainingBreakpoints) {
                block.cache_control = getCacheControl();
                injected++;
            }

            content.push(block);
        }

        if (hasMarkerAfterPart && !part && injected < remainingBreakpoints) {
            const previousBlock = content[content.length - 1];

            if (isTextBlock(previousBlock) && !previousBlock.cache_control) {
                previousBlock.cache_control = getCacheControl();
                injected++;
            }
        }
    }

    if (content.length === 0) {
        return { changed: true, content: '', injected: 0, removed: markerCount };
    }

    return {
        changed: true,
        content,
        injected,
        removed: markerCount,
    };
}

function transformContentArray(content, remainingBreakpoints) {
    const nextContent = [];
    let changed = false;
    let injected = 0;
    let removed = 0;

    for (const block of content) {
        if (!isTextBlock(block) || !block.text.includes(MARKER)) {
            nextContent.push(block);
            continue;
        }

        const result = transformText(block.text, remainingBreakpoints - injected);
        changed = changed || result.changed;
        injected += result.injected;
        removed += result.removed;

        if (Array.isArray(result.content)) {
            for (const transformedBlock of result.content) {
                nextContent.push({ ...block, ...transformedBlock });
            }
        } else if (result.content) {
            nextContent.push({ ...block, text: result.content });
        }
    }

    return { changed, content: nextContent, injected, removed };
}

function removeOverflowMarkers(messages) {
    let removed = 0;

    for (const message of messages) {
        if (typeof message?.content === 'string' && message.content.includes(MARKER)) {
            const before = message.content;
            message.content = stripMarkers(message.content);
            removed += countMarkers(before);
            continue;
        }

        if (Array.isArray(message?.content)) {
            for (const block of message.content) {
                if (isTextBlock(block) && block.text.includes(MARKER)) {
                    const before = block.text;
                    block.text = stripMarkers(block.text);
                    removed += countMarkers(before);
                }
            }
        }
    }

    return removed;
}

function applyCacheBreaks(messages) {
    const existingBreakpoints = countExistingCacheBreakpoints(messages);
    let remainingBreakpoints = Math.max(0, MAX_BREAKPOINTS - existingBreakpoints);
    let injected = 0;
    let removed = 0;
    let changedMessages = 0;
    const modifiedMessages = [];
    const indexesToRemove = [];

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];

        if (remainingBreakpoints > 0 && isMarkerOnlyContent(message?.content)) {
            const markerCount = countMarkersInContent(message.content);
            const previousMessageResult = applyStandaloneMarkerToPreviousMessage(messages, index);

            removed += markerCount;
            changedMessages++;

            if (previousMessageResult) {
                injected++;
                remainingBreakpoints--;
                modifiedMessages.push({
                    index,
                    role: message.role,
                    source: 'previous-message-standalone-marker',
                    appliedTo: previousMessageResult.targetIndex,
                    appliedToBlock: previousMessageResult.targetBlockIndex,
                    cachedBlockTextLength: previousMessageResult.cachedBlockTextLength,
                });
                index--;
            } else {
                indexesToRemove.push(index);
                modifiedMessages.push({ index, role: message.role, source: 'standalone-marker', appliedTo: null });
            }

            continue;
        }

        if (remainingBreakpoints <= 0) {
            continue;
        }

        if (typeof message?.content === 'string') {
            const result = transformText(message.content, remainingBreakpoints);

            if (result.changed) {
                message.content = result.content;
                injected += result.injected;
                removed += result.removed;
                remainingBreakpoints -= result.injected;
                changedMessages++;
                modifiedMessages.push({ index, role: message.role, source: 'string' });
            }

            continue;
        }

        if (Array.isArray(message?.content)) {
            const result = transformContentArray(message.content, remainingBreakpoints);

            if (result.changed) {
                message.content = result.content;
                injected += result.injected;
                removed += result.removed;
                remainingBreakpoints -= result.injected;
                changedMessages++;
                modifiedMessages.push({ index, role: message.role, source: 'content-array' });
            }
        }
    }

    for (let index = indexesToRemove.length - 1; index >= 0; index--) {
        messages.splice(indexesToRemove[index], 1);
    }

    const overflowRemoved = removeOverflowMarkers(messages);
    removed += overflowRemoved;

    return {
        existingBreakpoints,
        injected,
        removed,
        changedMessages,
        modifiedMessages,
        overflowRemoved,
    };
}

function extractUsage(responseJson) {
    const usage = responseJson?.usage || {};
    const promptTokensDetails = usage.prompt_tokens_details || {};

    return {
        cachedTokens: promptTokensDetails.cached_tokens ?? null,
        cacheReadTokens: usage.cache_read_tokens ?? responseJson?.cache_read_tokens ?? null,
        cacheWriteTokens: promptTokensDetails.cache_write_tokens ?? usage.cache_write_tokens ?? responseJson?.cache_write_tokens ?? null,
        anthropicCacheReadInputTokens: usage.cache_read_input_tokens ?? null,
        anthropicCacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
    };
}

function safeJsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function addRequestCapture({ originalBody, convertedBody, result, anthropicBody = null }) {
    if (!captureRequests) {
        return null;
    }

    const capture = {
        id: `${Date.now()}-${requestCaptures.length + 1}`,
        capturedAt: new Date().toISOString(),
        cacheTtl: getCacheTtlLabel(),
        cacheControl: getCacheControl(),
        conversion: safeJsonClone(result),
        upstreamMode,
        originalBody: safeJsonClone(originalBody),
        convertedBody: safeJsonClone(convertedBody),
        anthropicBody: anthropicBody ? safeJsonClone(anthropicBody) : null,
    };

    requestCaptures.unshift(capture);

    if (requestCaptures.length > MAX_REQUEST_CAPTURES) {
        requestCaptures.length = MAX_REQUEST_CAPTURES;
    }

    return capture;
}

async function readJsonRequest(request) {
    const text = await request.text();

    if (!text) {
        return null;
    }

    return JSON.parse(text);
}

function getForwardHeaders(request) {
    const headers = new Headers();
    const authorization = request.headers.get('authorization') || process.env.UPSTREAM_API_KEY;

    if (authorization) {
        headers.set('authorization', authorization.startsWith('Bearer ') ? authorization : `Bearer ${authorization}`);
    }

    headers.set('content-type', 'application/json');

    return headers;
}

function addCorsHeaders(headers = new Headers()) {
    headers.set('access-control-allow-origin', '*');
    headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
    headers.set('access-control-allow-headers', 'authorization,content-type');
    return headers;
}

function getAnthropicHeaders(request) {
    const headers = getForwardHeaders(request);

    if (!headers.has('x-api-key')) {
        const authorization = headers.get('authorization');

        if (authorization?.startsWith('Bearer ')) {
            headers.set('x-api-key', authorization.slice('Bearer '.length));
        }
    }

    headers.set('anthropic-version', process.env.ANTHROPIC_VERSION || '2023-06-01');
    headers.delete('authorization');
    return headers;
}

async function proxyJsonRequest(request, path) {
    const url = buildApiUrl(upstreamBaseUrl, path);
    const upstreamResponse = await fetch(url, {
        method: request.method,
        headers: getForwardHeaders(request),
    });
    const text = await upstreamResponse.text();
    const headers = addCorsHeaders(new Headers({
        'content-type': upstreamResponse.headers.get('content-type') || 'application/json',
    }));

    return new Response(text, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
    });
}

function normalizeAnthropicContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return '';
    }

    return content.map((block) => {
        if (block?.type === 'text') {
            return { ...block };
        }

        return { ...block };
    });
}

function convertOpenAiToAnthropicBody(body) {
    const system = [];
    const messages = [];

    for (const message of body.messages || []) {
        if (message.role === 'system') {
            const content = normalizeAnthropicContent(message.content);

            if (typeof content === 'string') {
                if (content) {
                    system.push({ type: 'text', text: content });
                }
            } else {
                system.push(...content);
            }
            continue;
        }

        if (message.role === 'user' || message.role === 'assistant') {
            messages.push({
                role: message.role,
                content: normalizeAnthropicContent(message.content),
            });
        }
    }

    const anthropicBody = {
        model: body.model,
        max_tokens: Number(body.max_tokens) || 512,
        messages,
    };

    if (system.length > 0) {
        anthropicBody.system = system;
    }

    if (body.temperature !== undefined) {
        anthropicBody.temperature = body.temperature;
    }

    if (body.top_p !== undefined) {
        anthropicBody.top_p = body.top_p;
    }

    if (body.stop !== undefined) {
        anthropicBody.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    }

    if (body.stream) {
        anthropicBody.stream = true;
    }

    return anthropicBody;
}

function getOpenAiUsageFromAnthropic(usage = {}) {
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const inputTokens = usage.input_tokens ?? 0;

    return {
        prompt_tokens: inputTokens + cacheRead + cacheCreation,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: inputTokens + cacheRead + cacheCreation + (usage.output_tokens ?? 0),
        prompt_tokens_details: {
            cached_tokens: cacheRead,
            cache_write_tokens: cacheCreation,
        },
    };
}

function convertAnthropicResponseToOpenAi(json, model) {
    const text = Array.isArray(json?.content)
        ? json.content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('')
        : '';

    return {
        id: json?.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: json?.model || model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: json?.stop_reason || 'stop',
        }],
        usage: getOpenAiUsageFromAnthropic(json?.usage || {}),
    };
}

function convertAnthropicSseLine(line, model) {
    if (!line.startsWith('data: ')) {
        return line;
    }

    const data = line.slice('data: '.length);

    if (data === '[DONE]') {
        return line;
    }

    try {
        const event = JSON.parse(data);

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            return `data: ${JSON.stringify({
                id: 'chatcmpl-anthropic-stream',
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
            })}`;
        }

        if (event.type === 'message_stop') {
            return 'data: [DONE]';
        }
    } catch {}

    return '';
}

function convertAnthropicStreamToOpenAi(stream, model) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';

    return new ReadableStream({
        async start(controller) {
            const reader = stream.getReader();

            try {
                while (true) {
                    const { done, value } = await reader.read();

                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const converted = convertAnthropicSseLine(line.trimEnd(), model);

                        if (converted) {
                            controller.enqueue(encoder.encode(`${converted}\n\n`));
                        }
                    }
                }
            } finally {
                controller.close();
            }
        },
    });
}

async function proxyChatCompletionsAnthropic(request, body, convertedBody, result, capture) {
    const anthropicBody = convertOpenAiToAnthropicBody(convertedBody);

    if (capture) {
        capture.anthropicBody = safeJsonClone(anthropicBody);
    }

    const upstreamResponse = await fetch(buildApiUrl(upstreamBaseUrl, '/v1/messages'), {
        method: 'POST',
        headers: getAnthropicHeaders(request),
        body: JSON.stringify(anthropicBody),
    });

    if (anthropicBody.stream) {
        const headers = addCorsHeaders(new Headers({
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
        }));

        return new Response(convertAnthropicStreamToOpenAi(upstreamResponse.body, anthropicBody.model), {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers,
        });
    }

    const text = await upstreamResponse.text();
    let json = null;

    try {
        json = JSON.parse(text);
    } catch {}

    if (!upstreamResponse.ok) {
        return new Response(text, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: addCorsHeaders(new Headers({
                'content-type': upstreamResponse.headers.get('content-type') || 'application/json',
            })),
        });
    }

    return jsonResponse(convertAnthropicResponseToOpenAi(json, anthropicBody.model));
}

async function proxyChatCompletions(request) {
    const url = buildApiUrl(upstreamBaseUrl, '/v1/chat/completions');
    const body = await readJsonRequest(request);

    if (!body || !Array.isArray(body.messages)) {
        return jsonResponse({ error: 'Request body must include messages array.' }, 400);
    }

    const convertedBody = JSON.parse(JSON.stringify(body));
    const result = applyCacheBreaks(convertedBody.messages);
    const capture = addRequestCapture({ originalBody: body, convertedBody, result });

    log('Forwarding chat completion.', {
        model: convertedBody.model,
        stream: Boolean(convertedBody.stream),
        messages: convertedBody.messages.length,
        injected: result.injected,
        removed: result.removed,
        overflowRemoved: result.overflowRemoved,
        cacheTtl: getCacheTtlLabel(),
        upstreamMode,
        captureId: capture?.id ?? null,
    });

    if (upstreamMode === 'anthropic') {
        return proxyChatCompletionsAnthropic(request, body, convertedBody, result, capture);
    }

    const upstreamResponse = await fetch(url, {
        method: 'POST',
        headers: getForwardHeaders(request),
        body: JSON.stringify(convertedBody),
    });

    if (convertedBody.stream) {
        const headers = addCorsHeaders(new Headers({
            'content-type': upstreamResponse.headers.get('content-type') || 'text/event-stream',
            'cache-control': upstreamResponse.headers.get('cache-control') || 'no-cache',
        }));

        return new Response(upstreamResponse.body, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers,
        });
    }

    const text = await upstreamResponse.text();
    let json = null;

    try {
        json = JSON.parse(text);
    } catch {}

    if (json?.usage) {
        log('Upstream usage.', extractUsage(json));
    }

    return new Response(text, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: addCorsHeaders(new Headers({
            'content-type': upstreamResponse.headers.get('content-type') || 'application/json',
        })),
    });
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body, null, 2), {
        status,
        headers: addCorsHeaders(new Headers({ 'content-type': 'application/json' })),
    });
}

function htmlResponse(html) {
    return new Response(html, {
        status: 200,
        headers: addCorsHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8' })),
    });
}

function getCaptureSummary(capture) {
    return {
        id: capture.id,
        capturedAt: capture.capturedAt,
        model: capture.convertedBody?.model ?? null,
        stream: Boolean(capture.convertedBody?.stream),
        messages: Array.isArray(capture.convertedBody?.messages) ? capture.convertedBody.messages.length : 0,
        cacheTtl: capture.cacheTtl,
        upstreamMode: capture.upstreamMode,
        injected: capture.conversion?.injected ?? 0,
        removed: capture.conversion?.removed ?? 0,
        overflowRemoved: capture.conversion?.overflowRemoved ?? 0,
    };
}

async function handleConsoleApi(request, url) {
    if (request.method === 'GET' && url.pathname === '/console/state') {
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/cache-ttl') {
        const body = await readJsonRequest(request);
        cacheTtl = normalizeCacheTtl(body?.ttl || '');
        log('Updated cache TTL from console.', { cacheTtl: getCacheTtlLabel(), cacheControl: getCacheControl() });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/upstream-mode') {
        const body = await readJsonRequest(request);
        upstreamMode = normalizeUpstreamMode(body?.mode || 'openai');
        log('Updated upstream mode from console.', { upstreamMode });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/capture') {
        const body = await readJsonRequest(request);
        captureRequests = Boolean(body?.enabled);
        log('Updated capture setting from console.', { captureRequests });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'GET' && url.pathname === '/console/requests') {
        return jsonResponse({ requests: requestCaptures.map(getCaptureSummary) });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/console/requests/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop() || '');
        const capture = requestCaptures.find((item) => item.id === id);

        if (!capture) {
            return jsonResponse({ error: 'Capture not found.' }, 404);
        }

        return jsonResponse(capture);
    }

    if (request.method === 'POST' && url.pathname === '/console/clear') {
        requestCaptures.length = 0;
        return jsonResponse({ ok: true });
    }

    return null;
}

function getConsoleHtml() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ST Claude Cache Gateway 控制台</title>
<style>
:root { color-scheme: dark; --bg: #0f1117; --panel: #181b24; --panel2: #202431; --border: #343949; --text: #edf1ff; --muted: #9aa3b8; --accent: #7aa2ff; --good: #4ade80; --warn: #facc15; --danger: #fb7185; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; background: radial-gradient(circle at top left, #1d2540 0, var(--bg) 42%); color: var(--text); }
main { max-width: 1120px; margin: 0 auto; }
h1 { margin: 0 0 8px; font-size: 28px; }
h2 { margin: 0 0 12px; font-size: 18px; }
p { margin: 6px 0; }
button, select { font: inherit; color: var(--text); background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; }
button { cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); }
button.primary { background: #2f5cff; border-color: #5f82ff; }
button.danger { border-color: #7f3142; color: #ffd8df; }
button:disabled { cursor: not-allowed; opacity: 0.55; }
select { min-width: 220px; }
pre { margin: 0; background: #0b0d12; border: 1px solid var(--border); border-radius: 12px; padding: 12px; overflow: auto; max-height: 48vh; white-space: pre-wrap; word-break: break-word; }
.header { margin-bottom: 18px; }
.muted { color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.card { border: 1px solid var(--border); border-radius: 16px; padding: 16px; margin: 14px 0; background: rgba(24, 27, 36, 0.92); box-shadow: 0 12px 28px rgba(0,0,0,.22); }
.stat { background: var(--panel2); border: 1px solid var(--border); border-radius: 14px; padding: 12px; }
.stat .label { color: var(--muted); font-size: 12px; }
.stat .value { margin-top: 4px; font-size: 18px; font-weight: 700; word-break: break-word; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.help { border-left: 3px solid var(--accent); padding-left: 10px; color: var(--muted); }
.warn { border-left-color: var(--warn); }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 999px; background: var(--panel2); border: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.badge.good { color: #c8ffd9; border-color: #2f7b4a; }
.badge.warn { color: #fff3b0; border-color: #806d1d; }
.request { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; border: 1px solid var(--border); border-radius: 12px; padding: 12px; margin: 10px 0; background: #141722; }
.request-title { font-weight: 700; }
.request-meta { color: var(--muted); font-size: 13px; margin-top: 4px; }
.split { display: grid; grid-template-columns: 320px 1fr; gap: 14px; align-items: start; }
@media (max-width: 820px) { body { padding: 14px; } .grid, .split { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <section class="header">
    <h1>ST Claude Cache Gateway 控制台</h1>
    <p class="muted">本页面只连接本地网关，用于切换 TTL、检查状态、捕获转换后的请求 JSON。</p>
  </section>

  <section class="grid">
    <div class="stat"><div class="label">缓存模式</div><div id="cacheTtlText" class="value">加载中</div></div>
    <div class="stat"><div class="label">上游格式</div><div id="upstreamModeText" class="value">加载中</div></div>
    <div class="stat"><div class="label">请求捕获</div><div id="captureText" class="value">加载中</div></div>
  </section>

  <section class="card">
    <h2>1. 缓存 TTL 模式</h2>
    <p class="help">推荐默认模式：不发送 ttl，让供应商使用默认 ephemeral 窗口。Pioneer 当前实测约 5 分钟，并且命中会续期。</p>
    <div class="row" style="margin-top: 12px;">
      <label>当前模式
        <select id="ttl">
          <option value="">默认 / provider-default（推荐）</option>
          <option value="1h">1h 实验模式</option>
        </select>
      </label>
      <button id="saveTtl" class="primary">应用 TTL</button>
      <button id="refresh">刷新状态</button>
    </div>
    <p class="help warn">1h 只代表网关会发送 ttl: 1h；是否真的按 1 小时生效取决于上游供应商。</p>
  </section>

  <section class="card">
    <h2>2. 上游请求格式</h2>
    <p class="help">默认 OpenAI-compatible 会原样转发到 /v1/chat/completions。Anthropic native 实验模式会把酒馆请求转换成 /v1/messages，再把响应转回 OpenAI-compatible。</p>
    <div class="row" style="margin-top: 12px;">
      <label>当前上游格式
        <select id="upstreamMode">
          <option value="openai">OpenAI-compatible（推荐默认）</option>
          <option value="anthropic">Anthropic native /v1/messages（实验）</option>
        </select>
      </label>
      <button id="saveUpstreamMode" class="primary">应用上游格式</button>
    </div>
    <p class="help warn">Anthropic native 模式用于测试 1h TTL；工具调用等高级能力暂不保证完整兼容。</p>
  </section>

  <section class="card">
    <h2>3. 请求捕获</h2>
    <p class="help warn">捕获的 JSON 可能包含完整 prompt / 聊天记录。默认关闭；只在排查问题时开启，分享前必须打码。</p>
    <div class="row" style="margin-top: 12px;">
      <button id="captureOn" class="primary">开启捕获</button>
      <button id="captureOff">关闭捕获</button>
      <button id="clear" class="danger">清空捕获</button>
    </div>
  </section>

  <section class="split">
    <div class="card">
      <h2>4. 最近请求</h2>
      <div id="requests" class="muted">加载中...</div>
    </div>
    <div class="card">
      <h2>5. 选中的 JSON</h2>
      <div class="row" style="margin-bottom: 10px;">
        <button id="download" disabled>下载 JSON</button>
        <span id="selectedHint" class="muted">请选择左侧请求</span>
      </div>
      <pre id="details">暂无选择。</pre>
    </div>
  </section>

  <section class="card">
    <h2>当前 cache_control</h2>
    <pre id="cacheControl">加载中...</pre>
  </section>
</main>
<script>
let selected = null;
async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function ttlLabel(value) {
  return value === '1h' ? '1h 实验模式' : '默认 / provider-default';
}
function upstreamModeLabel(value) {
  return value === 'anthropic' ? 'Anthropic native' : 'OpenAI-compatible';
}
function setStatus(text) {
  document.getElementById('selectedHint').textContent = text;
}
async function loadState() {
  const state = await api('/console/state');
  document.getElementById('cacheTtlText').textContent = ttlLabel(state.cacheTtl);
  document.getElementById('upstreamModeText').textContent = upstreamModeLabel(state.upstreamMode);
  document.getElementById('captureText').textContent = (state.captureRequests ? '已开启' : '已关闭') + ' / ' + state.capturedRequests;
  document.getElementById('cacheControl').textContent = JSON.stringify({ upstreamMode: state.upstreamMode, cacheControl: state.cacheControl }, null, 2);
  document.getElementById('ttl').value = state.cacheTtl === 'provider-default' ? '' : state.cacheTtl;
  document.getElementById('upstreamMode').value = state.upstreamMode;
}
async function loadRequests() {
  const data = await api('/console/requests');
  const root = document.getElementById('requests');
  if (!data.requests.length) {
    root.innerHTML = '<p class="muted">还没有捕获请求。先点“开启捕获”，再从酒馆发一条消息。</p>';
    return;
  }
  root.innerHTML = '';
  for (const item of data.requests) {
    const div = document.createElement('div');
    div.className = 'request';
    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'request-title';
    title.textContent = item.model || '未知模型';
    const meta = document.createElement('div');
    meta.className = 'request-meta';
    meta.textContent = item.capturedAt + ' · ' + upstreamModeLabel(item.upstreamMode) + ' · 消息 ' + item.messages + ' · TTL ' + ttlLabel(item.cacheTtl) + ' · 注入 ' + item.injected + ' · 移除 ' + item.removed;
    info.append(title, meta);
    const button = document.createElement('button');
    button.textContent = '查看';
    button.onclick = () => viewRequest(item.id);
    div.append(info, button);
    root.appendChild(div);
  }
}
async function viewRequest(id) {
  selected = await api('/console/requests/' + encodeURIComponent(id));
  document.getElementById('details').textContent = JSON.stringify(selected, null, 2);
  document.getElementById('download').disabled = false;
  setStatus('已选择：' + selected.id);
}
async function refreshAll() {
  await loadState();
  await loadRequests();
}
document.getElementById('saveTtl').onclick = async () => {
  await api('/console/cache-ttl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ttl: document.getElementById('ttl').value }) });
  await refreshAll();
  setStatus('TTL 已应用');
};
document.getElementById('saveUpstreamMode').onclick = async () => {
  await api('/console/upstream-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: document.getElementById('upstreamMode').value }) });
  await refreshAll();
  setStatus('上游格式已应用');
};
document.getElementById('captureOn').onclick = async () => { await api('/console/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }); await refreshAll(); setStatus('请求捕获已开启'); };
document.getElementById('captureOff').onclick = async () => { await api('/console/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }); await refreshAll(); setStatus('请求捕获已关闭'); };
document.getElementById('clear').onclick = async () => { await api('/console/clear', { method: 'POST' }); selected = null; document.getElementById('details').textContent = '暂无选择。'; document.getElementById('download').disabled = true; await refreshAll(); setStatus('已清空捕获'); };
document.getElementById('refresh').onclick = async () => { await refreshAll(); setStatus('已刷新'); };
document.getElementById('download').onclick = () => selected && downloadJson(selected, 'st-claude-cache-gateway-request-' + selected.id + '.json');
refreshAll().catch((error) => { document.getElementById('cacheControl').textContent = error.message; });
</script>
</body>
</html>`;
}

async function handleRequest(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: addCorsHeaders() });
    }

    try {
        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/console')) {
            return htmlResponse(getConsoleHtml());
        }

        if (url.pathname.startsWith('/console/')) {
            const consoleResponse = await handleConsoleApi(request, url);

            if (consoleResponse) {
                return consoleResponse;
            }
        }

        if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
            return await proxyChatCompletions(request);
        }

        if (request.method === 'GET' && url.pathname === '/v1/models') {
            return await proxyJsonRequest(request, '/v1/models');
        }

        if (request.method === 'GET' && url.pathname === '/health') {
            return jsonResponse(getRuntimeState());
        }

        return jsonResponse({ error: 'Not found.' }, 404);
    } catch (error) {
        log('Request failed.', { message: error.message, name: error.name });
        return jsonResponse({ error: error.message, name: error.name }, 500);
    }
}

if (typeof Bun !== 'undefined') {
    Bun.serve({ hostname: host, port, fetch: handleRequest });
    log(`Running at http://${host}:${port}`, { upstreamBaseUrl, cacheTtl: getCacheTtlLabel() });
} else {
    const { createServer } = await import('node:http');

    createServer(async (req, res) => {
        const chunks = [];

        for await (const chunk of req) {
            chunks.push(chunk);
        }

        const request = new Request(`http://${host}:${port}${req.url}`, {
            method: req.method,
            headers: req.headers,
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
            duplex: 'half',
        });
        const response = await handleRequest(request);

        res.writeHead(response.status, response.statusText, Object.fromEntries(response.headers.entries()));

        if (response.body) {
            for await (const chunk of response.body) {
                res.write(chunk);
            }
        }

        res.end();
    }).listen(port, host, () => {
        log(`Running at http://${host}:${port}`, { upstreamBaseUrl, cacheTtl: getCacheTtlLabel() });
    });
}
