const MARKER = '[[CACHE_BREAK]]';
const MAX_BREAKPOINTS = 4;
const DEFAULT_UPSTREAM_BASE_URL = 'https://api.pioneer.ai';

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || '127.0.0.1';
const upstreamBaseUrl = normalizeBaseUrl(process.env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL);

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

function findStandaloneMarkerMergeRange(messages, markerIndex) {
    const markerRole = messages[markerIndex]?.role;
    let startIndex = markerIndex;

    for (let index = markerIndex - 1; index >= 0; index--) {
        const message = messages[index];
        const text = getTextContent(message?.content);

        if (message?.role !== markerRole || isMarkerOnlyContent(message?.content) || text === null || !text.trim()) {
            break;
        }

        startIndex = index;
    }

    return startIndex < markerIndex ? { startIndex, endIndex: markerIndex - 1 } : null;
}

function mergeStandaloneMarkerPrefix(messages, markerIndex) {
    const range = findStandaloneMarkerMergeRange(messages, markerIndex);

    if (!range) {
        return null;
    }

    const mergedText = messages
        .slice(range.startIndex, range.endIndex + 1)
        .map((message) => getTextContent(message.content))
        .join('\n');

    messages.splice(range.startIndex, markerIndex - range.startIndex + 1, {
        role: messages[range.startIndex].role,
        content: [{
            type: 'text',
            text: mergedText,
            cache_control: { type: 'ephemeral' },
        }],
    });

    return {
        targetIndex: range.startIndex,
        mergedMessageCount: range.endIndex - range.startIndex + 1,
        cachedBlockTextLength: mergedText.length,
    };
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
                block.cache_control = { type: 'ephemeral' };
                injected++;
            }

            content.push(block);
        }

        if (hasMarkerAfterPart && !part && injected < remainingBreakpoints) {
            const previousBlock = content[content.length - 1];

            if (isTextBlock(previousBlock) && !previousBlock.cache_control) {
                previousBlock.cache_control = { type: 'ephemeral' };
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
            const mergeResult = mergeStandaloneMarkerPrefix(messages, index);

            removed += markerCount;
            changedMessages++;

            if (mergeResult) {
                injected++;
                remainingBreakpoints--;
                modifiedMessages.push({
                    index,
                    role: message.role,
                    source: 'merged-standalone-marker',
                    appliedTo: mergeResult.targetIndex,
                    mergedMessageCount: mergeResult.mergedMessageCount,
                    cachedBlockTextLength: mergeResult.cachedBlockTextLength,
                });
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

async function proxyChatCompletions(request) {
    const url = buildApiUrl(upstreamBaseUrl, '/v1/chat/completions');
    const body = await readJsonRequest(request);

    if (!body || !Array.isArray(body.messages)) {
        return jsonResponse({ error: 'Request body must include messages array.' }, 400);
    }

    const convertedBody = JSON.parse(JSON.stringify(body));
    const result = applyCacheBreaks(convertedBody.messages);

    log('Forwarding chat completion.', {
        model: convertedBody.model,
        stream: Boolean(convertedBody.stream),
        messages: convertedBody.messages.length,
        injected: result.injected,
        removed: result.removed,
        overflowRemoved: result.overflowRemoved,
    });

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

async function handleRequest(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: addCorsHeaders() });
    }

    try {
        if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
            return await proxyChatCompletions(request);
        }

        if (request.method === 'GET' && url.pathname === '/v1/models') {
            return await proxyJsonRequest(request, '/v1/models');
        }

        if (request.method === 'GET' && url.pathname === '/health') {
            return jsonResponse({ ok: true, host, port, upstreamBaseUrl });
        }

        return jsonResponse({ error: 'Not found.' }, 404);
    } catch (error) {
        log('Request failed.', { message: error.message, name: error.name });
        return jsonResponse({ error: error.message, name: error.name }, 500);
    }
}

if (typeof Bun !== 'undefined') {
    Bun.serve({ hostname: host, port, fetch: handleRequest });
    log(`Running at http://${host}:${port}`, { upstreamBaseUrl });
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
        log(`Running at http://${host}:${port}`, { upstreamBaseUrl });
    });
}
