import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const MARKER = '[[CACHE_BREAK]]';
const MAX_BREAKPOINTS = 4;
const DEFAULT_UPSTREAM_BASE_URL = 'https://api.pioneer.ai';
const SETTINGS_FILE = new URL('./gateway-settings.json', import.meta.url);
const runtimeSettings = migrateRuntimeSettings(loadRuntimeSettings());

const DEFAULT_PORT = 8788;
const port = Number(process.env.PORT || DEFAULT_PORT);
const host = process.env.HOST || '127.0.0.1';
let channelProfiles = runtimeSettings.channels;
let activeChannelId = runtimeSettings.activeChannelId;
let cacheTranslationEnabled = normalizeBoolean(getRuntimeConfigValue('CACHE_TRANSLATION_ENABLED', runtimeSettings.cacheTranslationEnabled, true), true);
let upstreamBaseUrl = normalizeBaseUrl(getRuntimeConfigValue('UPSTREAM_BASE_URL', getActiveChannel()?.baseUrl, DEFAULT_UPSTREAM_BASE_URL));
let cacheTtl = normalizeCacheTtl(getRuntimeConfigValue('CACHE_TTL', runtimeSettings.cacheTtl, '1h'));
let upstreamMode = normalizeUpstreamMode(getRuntimeConfigValue('UPSTREAM_MODE', runtimeSettings.upstreamMode || getActiveChannel()?.upstreamMode, 'anthropic'));
let upstreamExtraJson = normalizeUpstreamExtraJson(getRuntimeConfigValue('UPSTREAM_EXTRA_JSON', runtimeSettings.upstreamExtraJson || getActiveChannel()?.upstreamExtraJson, {}));
let upstreamExcludePaths = normalizeUpstreamExcludePaths(getRuntimeConfigValue('UPSTREAM_EXCLUDE_PATHS', runtimeSettings.upstreamExcludePaths || getActiveChannel()?.upstreamExcludePaths, []));
let upstreamHeaders = normalizeUpstreamHeaders(getRuntimeConfigValue('UPSTREAM_HEADERS', runtimeSettings.upstreamHeaders || getActiveChannel()?.upstreamHeaders, {}));
let upstreamExcludeHeaders = normalizeUpstreamExcludeHeaders(getRuntimeConfigValue('UPSTREAM_EXCLUDE_HEADERS', runtimeSettings.upstreamExcludeHeaders || getActiveChannel()?.upstreamExcludeHeaders, []));
syncActiveChannelFromRuntime();
let captureRequests = false;
let prefixLockEnabled = false;
let prefixLock = null;
const prefixLockStats = {
    replacements: 0,
    lastAction: 'disabled',
    lastSkipReason: null,
    lastAppliedAt: null,
};
const requestCaptures = [];
const MAX_REQUEST_CAPTURES = 20;

function loadRuntimeSettings() {
    try {
        return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function getDefaultChannelProfiles() {
    return [
        {
            id: 'openrouter',
            name: 'OpenRouter',
            kind: 'builtin',
            baseUrl: 'https://openrouter.ai/api/v1',
            upstreamMode: 'openai',
            upstreamExtraJson: {},
            upstreamExcludePaths: [],
            upstreamHeaders: {},
            upstreamExcludeHeaders: [],
        },
        {
            id: 'anthropic',
            name: 'Anthropic',
            kind: 'builtin',
            baseUrl: 'https://api.anthropic.com',
            upstreamMode: 'anthropic',
            upstreamExtraJson: {},
            upstreamExcludePaths: [],
            upstreamHeaders: {},
            upstreamExcludeHeaders: [],
        },
        {
            id: 'vertex',
            name: 'Google Vertex AI',
            kind: 'builtin',
            baseUrl: 'https://us-east5-aiplatform.googleapis.com',
            upstreamMode: 'anthropic',
            upstreamExtraJson: {},
            upstreamExcludePaths: [],
            upstreamHeaders: {},
            upstreamExcludeHeaders: [],
        },
        {
            id: 'bedrock',
            name: 'Amazon Bedrock',
            kind: 'builtin',
            baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
            upstreamMode: 'anthropic',
            upstreamExtraJson: {},
            upstreamExcludePaths: [],
            upstreamHeaders: {},
            upstreamExcludeHeaders: [],
        },
        {
            id: 'pioneer',
            name: 'Pioneer',
            kind: 'custom',
            baseUrl: DEFAULT_UPSTREAM_BASE_URL,
            upstreamMode: 'anthropic',
            upstreamExtraJson: {},
            upstreamExcludePaths: [],
            upstreamHeaders: {},
            upstreamExcludeHeaders: [],
        }
    ];
}

function sanitizeChannelId(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
}

function makeUniqueChannelId(name) {
    const base = sanitizeChannelId(name) || 'custom-channel';
    let id = base;
    let index = 1;

    while (channelProfiles?.some((profile) => profile.id === id)) {
        index += 1;
        id = `${base}-${index}`;
    }

    return id;
}

function normalizeChannelBaseUrl(value) {
    const raw = String(value || '').trim();

    if (!raw) {
        throw new Error('Channel base URL is required.');
    }

    if (raw.length > 500) {
        throw new Error('Channel base URL is too long.');
    }

    let parsed;

    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('Channel base URL must be an absolute URL.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Channel base URL must use http or https.');
    }

    if (parsed.username || parsed.password) {
        throw new Error('Channel base URL must not include username or password.');
    }

    return normalizeBaseUrl(raw);
}

function assertSafeProfileJson(value, path = 'upstreamExtraJson', options = {}) {
    if (!value || typeof value !== 'object') {
        return;
    }

    const rejectSecrets = options.rejectSecrets !== false;
    const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
    const secretKeys = new Set(['authorization', 'x-api-key', 'api_key', 'apikey', 'token', 'secret', 'password']);

    for (const [key, child] of Object.entries(value)) {
        const normalized = key.toLowerCase();

        if (forbiddenKeys.has(normalized)) {
            throw new Error(`Unsafe JSON key is not allowed: ${path}.${key}`);
        }

        if (rejectSecrets && secretKeys.has(normalized)) {
            throw new Error(`Do not store secrets in channel profiles: ${path}.${key}`);
        }

        if (child && typeof child === 'object') {
            assertSafeProfileJson(child, `${path}.${key}`, options);
        }
    }
}

function normalizeChannelProfile(input, existingProfile = null, options = {}) {
    const allowGeneratedId = Boolean(options.allowGeneratedId);
    const rejectSecrets = options.rejectSecrets !== false;
    const current = existingProfile || {};
    const id = current.id || sanitizeChannelId(input?.id) || (allowGeneratedId ? makeUniqueChannelId(input?.name) : '');
    const kind = current.kind === 'builtin' ? 'builtin' : input?.kind === 'builtin' ? 'builtin' : 'custom';
    const name = String(input?.name ?? current.name ?? '').trim();

    if (!id) {
        throw new Error('Channel id is required.');
    }

    if (!name || name.length > 80) {
        throw new Error('Channel name must be 1-80 characters.');
    }

    const upstreamExtraJson = normalizeUpstreamExtraJson(
        Object.prototype.hasOwnProperty.call(input || {}, 'upstreamExtraJson')
            ? input.upstreamExtraJson
            : current.upstreamExtraJson || {},
    );
    const jsonSize = JSON.stringify(upstreamExtraJson).length;

    if (jsonSize > 32768) {
        throw new Error('Channel upstream extra JSON is too large.');
    }

    assertSafeProfileJson(upstreamExtraJson, 'upstreamExtraJson', { rejectSecrets });

    return {
        id,
        name,
        kind,
        baseUrl: normalizeChannelBaseUrl(input?.baseUrl ?? current.baseUrl),
        upstreamMode: normalizeUpstreamMode(input?.upstreamMode ?? current.upstreamMode),
        upstreamExtraJson,
        upstreamExcludePaths: normalizeUpstreamExcludePaths(
            Object.prototype.hasOwnProperty.call(input || {}, 'upstreamExcludePaths')
                ? input.upstreamExcludePaths
                : current.upstreamExcludePaths || [],
        ),
        upstreamHeaders: normalizeUpstreamHeaders(
            Object.prototype.hasOwnProperty.call(input || {}, 'upstreamHeaders')
                ? input.upstreamHeaders
                : current.upstreamHeaders || {},
        ),
        upstreamExcludeHeaders: normalizeUpstreamExcludeHeaders(
            Object.prototype.hasOwnProperty.call(input || {}, 'upstreamExcludeHeaders')
                ? input.upstreamExcludeHeaders
                : current.upstreamExcludeHeaders || [],
        ),
    };
}

function dedupeChannelProfiles(profiles) {
    const seen = new Set();
    const output = [];

    for (const profile of profiles) {
        if (!profile?.id || seen.has(profile.id)) {
            continue;
        }

        seen.add(profile.id);
        output.push(profile);
    }

    return output;
}

function findChannelByBaseUrl(baseUrl, profiles) {
    const normalized = normalizeBaseUrl(baseUrl);
    return profiles.find((profile) => normalizeBaseUrl(profile.baseUrl) === normalized) || null;
}

function migrateRuntimeSettings(rawSettings = {}) {
    const defaults = getDefaultChannelProfiles().map((profile) => normalizeChannelProfile(profile, null, { rejectSecrets: false }));
    const hasSavedChannels = Array.isArray(rawSettings.channels);
    const savedProfiles = hasSavedChannels
        ? rawSettings.channels.map((profile) => {
            const builtin = defaults.find((item) => item.kind === 'builtin' && item.id === profile?.id);
            return normalizeChannelProfile({
                ...profile,
                kind: builtin ? profile?.kind : 'custom',
            }, builtin || null, { rejectSecrets: false });
        })
        : [];
    const defaultsToSeed = hasSavedChannels ? defaults.filter((profile) => profile.kind === 'builtin') : defaults;
    const profileMap = new Map(defaultsToSeed.map((profile) => [profile.id, profile]));

    for (const profile of savedProfiles) {
        profileMap.set(profile.id, profile);
    }

    let channels = dedupeChannelProfiles([...profileMap.values()]);
    const envBaseUrl = process.env.UPSTREAM_BASE_URL ? normalizeChannelBaseUrl(process.env.UPSTREAM_BASE_URL) : null;
    let activeId = sanitizeChannelId(rawSettings.activeChannelId) || 'pioneer';

    if (envBaseUrl) {
        const match = findChannelByBaseUrl(envBaseUrl, channels);

        if (match) {
            activeId = match.id;
        } else {
            const envProfile = normalizeChannelProfile({
                id: 'env-upstream',
                name: '启动环境上游',
                kind: 'custom',
                baseUrl: envBaseUrl,
                upstreamMode: rawSettings.upstreamMode || 'anthropic',
                upstreamExtraJson: rawSettings.upstreamExtraJson || {},
            }, null, { rejectSecrets: false });
            channels = dedupeChannelProfiles([envProfile, ...channels]);
            activeId = envProfile.id;
        }
    } else if (!channels.some((profile) => profile.id === activeId)) {
        activeId = 'pioneer';
    }

    const activeProfile = channels.find((profile) => profile.id === activeId) || channels.find((profile) => profile.id === 'pioneer') || channels[0];
    activeId = activeProfile.id;

    if (!Array.isArray(rawSettings.channels)) {
        activeProfile.upstreamMode = normalizeUpstreamMode(rawSettings.upstreamMode || activeProfile.upstreamMode);
        activeProfile.upstreamExtraJson = normalizeUpstreamExtraJson(rawSettings.upstreamExtraJson || activeProfile.upstreamExtraJson || {});
        activeProfile.upstreamExcludePaths = normalizeUpstreamExcludePaths(rawSettings.upstreamExcludePaths || activeProfile.upstreamExcludePaths || []);
        activeProfile.upstreamHeaders = normalizeUpstreamHeaders(rawSettings.upstreamHeaders || activeProfile.upstreamHeaders || {});
        activeProfile.upstreamExcludeHeaders = normalizeUpstreamExcludeHeaders(rawSettings.upstreamExcludeHeaders || activeProfile.upstreamExcludeHeaders || []);
    }

    return {
        ...rawSettings,
        schemaVersion: 2,
        cacheTtl: rawSettings.cacheTtl,
        activeChannelId: activeId,
        channels,
        upstreamMode: activeProfile.upstreamMode,
        upstreamExtraJson: safeJsonClone(activeProfile.upstreamExtraJson),
        upstreamExcludePaths: normalizeUpstreamExcludePaths(activeProfile.upstreamExcludePaths || []),
        upstreamHeaders: normalizeUpstreamHeaders(activeProfile.upstreamHeaders || {}),
        upstreamExcludeHeaders: normalizeUpstreamExcludeHeaders(activeProfile.upstreamExcludeHeaders || []),
    };
}

function getActiveChannel() {
    return channelProfiles?.find((profile) => profile.id === activeChannelId) || null;
}

function getSafeChannelProfile(profile) {
    return profile ? safeJsonClone(profile) : null;
}

function syncRuntimeFromActiveChannel() {
    const active = getActiveChannel();

    if (!active) {
        return;
    }

    upstreamBaseUrl = normalizeBaseUrl(active.baseUrl);
    upstreamMode = normalizeUpstreamMode(active.upstreamMode);
    upstreamExtraJson = normalizeUpstreamExtraJson(active.upstreamExtraJson || {});
    upstreamExcludePaths = normalizeUpstreamExcludePaths(active.upstreamExcludePaths || []);
    upstreamHeaders = normalizeUpstreamHeaders(active.upstreamHeaders || {});
    upstreamExcludeHeaders = normalizeUpstreamExcludeHeaders(active.upstreamExcludeHeaders || []);
}

function syncActiveChannelFromRuntime() {
    const active = getActiveChannel();

    if (!active) {
        return;
    }

    active.baseUrl = normalizeBaseUrl(upstreamBaseUrl);
    active.upstreamMode = normalizeUpstreamMode(upstreamMode);
    active.upstreamExtraJson = normalizeUpstreamExtraJson(upstreamExtraJson || {});
    active.upstreamExcludePaths = normalizeUpstreamExcludePaths(upstreamExcludePaths || []);
    active.upstreamHeaders = normalizeUpstreamHeaders(upstreamHeaders || {});
    active.upstreamExcludeHeaders = normalizeUpstreamExcludeHeaders(upstreamExcludeHeaders || []);
}

function setActiveChannel(id) {
    const normalizedId = sanitizeChannelId(id);

    if (!channelProfiles.some((profile) => profile.id === normalizedId)) {
        throw new Error('Channel not found.');
    }

    activeChannelId = normalizedId;
    syncRuntimeFromActiveChannel();
}

function getChannelState() {
    return {
        ok: true,
        activeChannelId,
        activeChannel: getSafeChannelProfile(getActiveChannel()),
        channels: channelProfiles.map(getSafeChannelProfile),
    };
}

function saveRuntimeSettings() {
    syncActiveChannelFromRuntime();
    writeFileSync(SETTINGS_FILE, `${JSON.stringify({
        schemaVersion: 2,
        cacheTranslationEnabled,
        cacheTtl: getCacheTtlLabel(),
        activeChannelId,
        channels: channelProfiles.map(getSafeChannelProfile),
        upstreamMode,
        upstreamExtraJson,
        upstreamExcludePaths,
        upstreamHeaders,
        upstreamExcludeHeaders,
    }, null, 2)}\n`);
}

function getRuntimeConfigValue(name, savedValue, defaultValue) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
        return process.env[name];
    }

    if (savedValue !== undefined && savedValue !== null) {
        return savedValue;
    }

    return defaultValue;
}

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

function normalizeBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value).trim().toLowerCase();

    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
        return false;
    }

    return defaultValue;
}

function normalizeCacheTtl(ttl) {
    const normalized = String(ttl || '').trim();

    if (!normalized
        || normalized.toLowerCase() === 'default'
        || normalized.toLowerCase() === 'provider-default'
        || normalized.toLowerCase() === 'none') {
        return '';
    }

    return normalized;
}

function normalizeUpstreamMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    return normalized === 'anthropic' ? 'anthropic' : 'openai';
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUpstreamExtraJson(value) {
    if (value === undefined || value === null || value === '') {
        return {};
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();

        if (!trimmed || trimmed.toLowerCase() === 'default' || trimmed.toLowerCase() === 'none' || trimmed === '{}') {
            return {};
        }

        const parsed = JSON.parse(trimmed);

        if (!isPlainObject(parsed)) {
            throw new Error('UPSTREAM_EXTRA_JSON must be a JSON object.');
        }

        return parsed;
    }

    if (!isPlainObject(value)) {
        throw new Error('Upstream extra JSON must be a JSON object.');
    }

    return safeJsonClone(value);
}

function normalizeUpstreamExcludePaths(value) {
    const items = Array.isArray(value)
        ? value
        : String(value || '')
            .split(/\r?\n|,/)
            .map((item) => item.trim())
            .filter(Boolean);
    const seen = new Set();
    const output = [];

    for (const item of items) {
        const path = String(item || '').trim();

        if (!path) {
            continue;
        }

        if (path.length > 160) {
            throw new Error('Upstream exclude path is too long.');
        }

        if (!/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/.test(path)) {
            throw new Error(`Invalid upstream exclude path: ${path}`);
        }

        if (!seen.has(path)) {
            seen.add(path);
            output.push(path);
        }
    }

    if (output.length > 64) {
        throw new Error('Too many upstream exclude paths.');
    }

    return output;
}

function normalizeUpstreamHeaders(value) {
    const input = typeof value === 'string' ? normalizeUpstreamExtraJson(value) : value;

    if (input === undefined || input === null || input === '') {
        return {};
    }

    if (!isPlainObject(input)) {
        throw new Error('Upstream headers must be a JSON object.');
    }

    const blocked = new Set([
        'authorization',
        'x-api-key',
        'api-key',
        'cookie',
        'set-cookie',
        'host',
        'content-length',
        'content-type',
        'connection',
        'transfer-encoding',
        'proxy-authorization',
        'proxy-authenticate',
    ]);
    const output = {};

    for (const [name, rawValue] of Object.entries(input)) {
        const normalized = String(name || '').trim().toLowerCase();

        if (!normalized) {
            continue;
        }

        if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(normalized)) {
            throw new Error(`Invalid upstream header name: ${name}`);
        }

        if (blocked.has(normalized) || normalized.includes('secret') || normalized.includes('token') || normalized.includes('password')) {
            throw new Error(`Do not store secrets or protocol headers in channel profiles: ${name}`);
        }

        if (rawValue === undefined || rawValue === null || rawValue === '') {
            continue;
        }

        if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
            throw new Error(`Upstream header value must be a string, number, or boolean: ${name}`);
        }

        const headerValue = String(rawValue);

        if (headerValue.length > 1000 || /[\r\n]/.test(headerValue)) {
            throw new Error(`Invalid upstream header value: ${name}`);
        }

        output[normalized] = headerValue;
    }

    return output;
}

function normalizeHeaderName(name) {
    const normalized = String(name || '').trim().toLowerCase();

    if (!normalized || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(normalized)) {
        throw new Error(`Invalid upstream header name: ${name}`);
    }

    return normalized;
}

function normalizeUpstreamExcludeHeaders(value) {
    const items = Array.isArray(value)
        ? value
        : String(value || '')
            .split(/\r?\n|,/)
            .map((item) => item.trim())
            .filter(Boolean);
    const seen = new Set();
    const output = [];

    for (const item of items) {
        const name = normalizeHeaderName(item);

        if (name.length > 120) {
            throw new Error('Upstream exclude header name is too long.');
        }

        if (!seen.has(name)) {
            seen.add(name);
            output.push(name);
        }
    }

    if (output.length > 64) {
        throw new Error('Too many upstream exclude headers.');
    }

    return output;
}

function getUpstreamHeadersText() {
    return JSON.stringify(upstreamHeaders, null, 2);
}

function getUpstreamHeaderKeys() {
    return Object.keys(upstreamHeaders);
}

function getUpstreamExcludeHeadersText() {
    return upstreamExcludeHeaders.join('\n');
}

function getUpstreamExtraJsonText() {
    return JSON.stringify(upstreamExtraJson, null, 2);
}

function getUpstreamExcludePathsText() {
    return upstreamExcludePaths.join('\n');
}

function getUpstreamExtraJsonKeys() {
    return Object.keys(upstreamExtraJson);
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
        activeChannelId,
        activeChannel: getSafeChannelProfile(getActiveChannel()),
        channels: channelProfiles.map(getSafeChannelProfile),
        cacheTranslationEnabled,
        cacheTtl: getCacheTtlLabel(),
        cacheControl: getCacheControl(),
        upstreamExtraJsonEnabled: getUpstreamExtraJsonKeys().length > 0,
        upstreamExtraJson: safeJsonClone(upstreamExtraJson),
        upstreamExtraJsonText: getUpstreamExtraJsonText(),
        upstreamExtraJsonKeys: getUpstreamExtraJsonKeys(),
        upstreamExcludePaths: [...upstreamExcludePaths],
        upstreamExcludePathsText: getUpstreamExcludePathsText(),
        upstreamExcludePathsEnabled: upstreamExcludePaths.length > 0,
        upstreamHeaders: safeJsonClone(upstreamHeaders),
        upstreamHeadersText: getUpstreamHeadersText(),
        upstreamHeadersKeys: getUpstreamHeaderKeys(),
        upstreamHeadersEnabled: getUpstreamHeaderKeys().length > 0,
        upstreamExcludeHeaders: [...upstreamExcludeHeaders],
        upstreamExcludeHeadersText: getUpstreamExcludeHeadersText(),
        upstreamExcludeHeadersEnabled: upstreamExcludeHeaders.length > 0,
        captureRequests,
        capturedRequests: requestCaptures.length,
        anthropicInboundEnabled: false,
        prefixLockEnabled,
        prefixLockActive: Boolean(prefixLock),
        prefixLockHash: prefixLock?.prefixHash ?? null,
        prefixLockCreatedAt: prefixLock?.createdAt ?? null,
        prefixLockFirstCacheControlPath: prefixLock?.firstCacheControlPath ?? null,
        prefixLockReplacements: prefixLockStats.replacements,
        prefixLockLastAction: prefixLockStats.lastAction,
        prefixLockLastSkipReason: prefixLockStats.lastSkipReason,
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

function countCacheBreakpointsInContent(content) {
    if (!Array.isArray(content)) {
        return 0;
    }

    return content.reduce((total, block) => total + (block?.cache_control ? 1 : 0), 0);
}

function countExistingCacheBreakpoints(messages) {
    let count = 0;

    for (const message of messages) {
        count += countCacheBreakpointsInContent(message?.content);
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

        if (isMarkerOnlyText(block.text)) {
            const previousBlock = nextContent[nextContent.length - 1];
            const canInject = injected < remainingBreakpoints
                && isTextBlock(previousBlock)
                && previousBlock.text.trim()
                && !previousBlock.cache_control;

            if (canInject) {
                previousBlock.cache_control = getCacheControl();
                injected++;
            }

            changed = true;
            removed += countMarkers(block.text);
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

function removeOverflowMarkersFromContent(content) {
    let removed = 0;

    if (typeof content === 'string' && content.includes(MARKER)) {
        const before = content;
        return {
            content: stripMarkers(content),
            removed: countMarkers(before),
        };
    }

    if (Array.isArray(content)) {
        for (const block of content) {
            if (isTextBlock(block) && block.text.includes(MARKER)) {
                const before = block.text;
                block.text = stripMarkers(block.text);
                removed += countMarkers(before);
            }
        }
    }

    return { content, removed };
}

function removeOverflowMarkers(messages) {
    let removed = 0;

    for (const message of messages) {
        const result = removeOverflowMarkersFromContent(message?.content);
        message.content = result.content;
        removed += result.removed;
    }

    return removed;
}

function applyCacheBreaks(messages, initialExistingBreakpoints = 0) {
    if (!cacheTranslationEnabled) {
        return {
            existingBreakpoints: countExistingCacheBreakpoints(messages),
            injected: 0,
            removed: 0,
            changedMessages: 0,
            modifiedMessages: [],
            overflowRemoved: 0,
            disabled: true,
        };
    }

    const existingBreakpoints = initialExistingBreakpoints + countExistingCacheBreakpoints(messages);
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
        inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? null,
        outputTokens: usage.output_tokens ?? usage.completion_tokens ?? null,
        totalTokens: usage.total_tokens ?? null,
        cachedTokens: promptTokensDetails.cached_tokens ?? null,
        cacheReadTokens: usage.cache_read_tokens ?? responseJson?.cache_read_tokens ?? null,
        cacheWriteTokens: promptTokensDetails.cache_write_tokens ?? usage.cache_write_tokens ?? responseJson?.cache_write_tokens ?? null,
        anthropicCacheReadInputTokens: usage.cache_read_input_tokens ?? null,
        anthropicCacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
    };
}

function safeJsonClone(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function hashText(value) {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function getBodyHash(body) {
    return hashText(JSON.stringify(body ?? null));
}

function summarizeHeaders(headers) {
    const summary = {};

    for (const [name, value] of headers.entries()) {
        const normalized = name.toLowerCase();

        if (normalized === 'authorization' || normalized === 'x-api-key' || normalized === 'cookie') {
            summary[normalized] = value ? '[present]' : '[absent]';
            continue;
        }

        summary[normalized] = value;
    }

    return summary;
}

function getContentSegments(content, basePath) {
    if (typeof content === 'string') {
        return [{ path: basePath, value: content, cacheControl: null }];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    return content.map((block, index) => ({
        path: `${basePath}[${index}]`,
        value: block,
        cacheControl: block?.cache_control || null,
    }));
}

function getCacheSegments(body, mode) {
    const segments = [];

    if (mode === 'anthropic') {
        for (const segment of getContentSegments(body?.system, 'system')) {
            segments.push({ ...segment, groupKey: 'system' });
        }

        for (let messageIndex = 0; messageIndex < (body?.messages || []).length; messageIndex++) {
            const message = body.messages[messageIndex];
            const contentSegments = getContentSegments(message?.content, `messages[${messageIndex}].content`);

            for (const segment of contentSegments) {
                segments.push({
                    ...segment,
                    role: message?.role || null,
                    groupKey: `message:${messageIndex}`,
                    messageMeta: message ? { ...message, content: undefined } : null,
                });
            }
        }

        return segments;
    }

    for (let messageIndex = 0; messageIndex < (body?.messages || []).length; messageIndex++) {
        const message = body.messages[messageIndex];
        const contentSegments = getContentSegments(message?.content, `messages[${messageIndex}].content`);

        for (const segment of contentSegments) {
            segments.push({
                ...segment,
                role: message?.role || null,
                groupKey: `message:${messageIndex}`,
                messageMeta: message ? { ...message, content: undefined } : null,
            });
        }
    }

    return segments;
}

function getSegmentHash(segments) {
    return hashText(JSON.stringify(segments.map((segment) => segment.value)));
}

function getSegmentLength(segments) {
    return JSON.stringify(segments.map((segment) => segment.value)).length;
}

function getCacheDiagnostics(body, mode) {
    const segments = getCacheSegments(body, mode);
    const firstCacheIndex = segments.findIndex((segment) => segment.cacheControl);
    const cacheControlCount = segments.reduce((total, segment) => total + (segment.cacheControl ? 1 : 0), 0);
    const prefixSegments = firstCacheIndex >= 0 ? segments.slice(0, firstCacheIndex + 1) : [];
    const suffixSegments = firstCacheIndex >= 0 ? segments.slice(firstCacheIndex + 1) : segments;

    return {
        bodyHash: getBodyHash(body),
        markerRemaining: JSON.stringify(body).includes(MARKER),
        cacheControlCount,
        firstCacheControlPath: firstCacheIndex >= 0 ? `${segments[firstCacheIndex].path}.cache_control` : null,
        firstCacheControl: firstCacheIndex >= 0 ? safeJsonClone(segments[firstCacheIndex].cacheControl) : null,
        prefixHash: firstCacheIndex >= 0 ? getSegmentHash(prefixSegments) : null,
        prefixLength: firstCacheIndex >= 0 ? getSegmentLength(prefixSegments) : 0,
        prefixBlockCount: prefixSegments.length,
        suffixHash: getSegmentHash(suffixSegments),
        suffixLength: getSegmentLength(suffixSegments),
        suffixBlockCount: suffixSegments.length,
    };
}

function splitBodyAtFirstCacheControl(body, mode) {
    const segments = getCacheSegments(body, mode);
    const firstCacheIndex = segments.findIndex((segment) => segment.cacheControl);

    if (firstCacheIndex < 0) {
        return { ok: false, reason: 'no-cache-control' };
    }

    const prefixSegments = safeJsonClone(segments.slice(0, firstCacheIndex + 1));
    const suffixSegments = safeJsonClone(segments.slice(firstCacheIndex + 1));

    return {
        ok: true,
        prefixSegments,
        suffixSegments,
        firstCacheControlPath: `${segments[firstCacheIndex].path}.cache_control`,
        prefixHash: getSegmentHash(prefixSegments),
        prefixLength: getSegmentLength(prefixSegments),
        prefixBlockCount: prefixSegments.length,
        suffixHash: getSegmentHash(suffixSegments),
        suffixLength: getSegmentLength(suffixSegments),
        suffixBlockCount: suffixSegments.length,
    };
}

function buildContentFromValues(values) {
    if (values.every((value) => typeof value === 'string')) {
        return values.join('');
    }

    return values.map((value) => (typeof value === 'string' ? { type: 'text', text: value } : safeJsonClone(value)));
}

function buildAnthropicBodyFromSegments(body, segments) {
    const nextBody = safeJsonClone(body);
    const systemSegments = [];
    const messages = [];
    let currentMessage = null;

    delete nextBody.system;
    nextBody.messages = messages;

    for (const segment of segments) {
        if (segment.path.startsWith('system')) {
            systemSegments.push(safeJsonClone(segment.value));
            continue;
        }

        if (!currentMessage || currentMessage.groupKey !== segment.groupKey) {
            currentMessage = {
                ...(safeJsonClone(segment.messageMeta) || {}),
                role: segment.role || 'user',
                content: [],
                groupKey: segment.groupKey,
            };
            messages.push(currentMessage);
        }

        currentMessage.content.push(safeJsonClone(segment.value));
    }

    for (const message of messages) {
        message.content = buildContentFromValues(message.content);
        delete message.groupKey;
    }

    if (systemSegments.length > 0) {
        nextBody.system = buildContentFromValues(systemSegments);
    }

    return nextBody;
}

function buildOpenAiBodyFromSegments(body, segments) {
    const nextBody = safeJsonClone(body);
    const messages = [];
    let currentMessage = null;

    nextBody.messages = messages;

    for (const segment of segments) {
        if (!currentMessage || currentMessage.groupKey !== segment.groupKey) {
            currentMessage = {
                ...(safeJsonClone(segment.messageMeta) || {}),
                role: segment.role || 'user',
                content: [],
                groupKey: segment.groupKey,
            };
            messages.push(currentMessage);
        }

        currentMessage.content.push(safeJsonClone(segment.value));
    }

    for (const message of messages) {
        message.content = buildContentFromValues(message.content);
        delete message.groupKey;
    }

    return nextBody;
}

function buildBodyFromSegments(body, mode, segments) {
    return mode === 'anthropic'
        ? buildAnthropicBodyFromSegments(body, segments)
        : buildOpenAiBodyFromSegments(body, segments);
}

function rememberPrefixLock(split, mode) {
    prefixLock = {
        mode,
        prefixSegments: safeJsonClone(split.prefixSegments),
        prefixHash: split.prefixHash,
        prefixLength: split.prefixLength,
        prefixBlockCount: split.prefixBlockCount,
        firstCacheControlPath: split.firstCacheControlPath,
        createdAt: new Date().toISOString(),
    };
}

function updatePrefixLockStats(action, reason = null) {
    prefixLockStats.lastAction = action;
    prefixLockStats.lastSkipReason = reason;
    prefixLockStats.lastAppliedAt = new Date().toISOString();

    if (action === 'replaced') {
        prefixLockStats.replacements++;
    }
}

function clearPrefixLock() {
    prefixLock = null;
    prefixLockStats.replacements = 0;
    updatePrefixLockStats(prefixLockEnabled ? 'cleared' : 'disabled');
}

function applyPrefixLock(body, mode) {
    if (!cacheTranslationEnabled) {
        updatePrefixLockStats('skipped', 'cache-translation-disabled');
        return { body, diagnostics: { enabled: prefixLockEnabled, action: 'skipped', reason: 'cache-translation-disabled' } };
    }

    if (!prefixLockEnabled) {
        updatePrefixLockStats('disabled');
        return { body, diagnostics: { enabled: false, action: 'disabled' } };
    }

    const split = splitBodyAtFirstCacheControl(body, mode);

    if (!split.ok) {
        updatePrefixLockStats('skipped', split.reason);
        return {
            body,
            diagnostics: {
                enabled: true,
                locked: Boolean(prefixLock),
                action: 'skipped',
                reason: split.reason,
            },
        };
    }

    if (!prefixLock) {
        rememberPrefixLock(split, mode);
        updatePrefixLockStats('created');
        return {
            body,
            diagnostics: {
                enabled: true,
                locked: true,
                action: 'created',
                prefixHash: split.prefixHash,
                prefixLength: split.prefixLength,
                prefixBlockCount: split.prefixBlockCount,
                suffixHash: split.suffixHash,
                suffixLength: split.suffixLength,
                firstCacheControlPath: split.firstCacheControlPath,
            },
        };
    }

    if (prefixLock.mode !== mode) {
        updatePrefixLockStats('skipped', 'mode-mismatch');
        return {
            body,
            diagnostics: {
                enabled: true,
                locked: true,
                action: 'skipped',
                reason: 'mode-mismatch',
                lockedMode: prefixLock.mode,
                currentMode: mode,
            },
        };
    }

    const nextSegments = [
        ...safeJsonClone(prefixLock.prefixSegments),
        ...safeJsonClone(split.suffixSegments),
    ];
    const nextBody = buildBodyFromSegments(body, mode, nextSegments);
    const nextSplit = splitBodyAtFirstCacheControl(nextBody, mode);
    updatePrefixLockStats('replaced');

    return {
        body: nextBody,
        diagnostics: {
            enabled: true,
            locked: true,
            action: 'replaced',
            currentPrefixHash: split.prefixHash,
            lockedPrefixHash: prefixLock.prefixHash,
            finalPrefixHash: nextSplit.ok ? nextSplit.prefixHash : null,
            suffixHash: split.suffixHash,
            suffixLength: split.suffixLength,
            currentPrefixDiscarded: true,
            firstCacheControlPath: nextSplit.ok ? nextSplit.firstCacheControlPath : prefixLock.firstCacheControlPath,
            replacements: prefixLockStats.replacements,
        },
    };
}

function getCacheResultFromUsage(usage) {
    const read = usage?.anthropicCacheReadInputTokens ?? usage?.cachedTokens ?? usage?.cacheReadTokens ?? 0;
    const write = usage?.anthropicCacheCreationInputTokens ?? usage?.cacheWriteTokens ?? 0;

    if (read > 0) {
        return 'hit';
    }

    if (write > 0) {
        return 'creation';
    }

    return 'none';
}

function deepMergeJson(base, extra) {
    const merged = safeJsonClone(base);

    for (const [key, value] of Object.entries(extra)) {
        if (isPlainObject(value) && isPlainObject(merged[key])) {
            merged[key] = deepMergeJson(merged[key], value);
        } else {
            merged[key] = safeJsonClone(value);
        }
    }

    return merged;
}

function deleteJsonPath(root, path) {
    const parts = path.split('.');
    let current = root;

    for (const part of parts.slice(0, -1)) {
        if (!isPlainObject(current) || !(part in current)) {
            return false;
        }

        current = current[part];
    }

    const last = parts[parts.length - 1];

    if (!isPlainObject(current) || !(last in current)) {
        return false;
    }

    delete current[last];
    return true;
}

function applyUpstreamBodyParameters(body, mode) {
    const includeKeys = getUpstreamExtraJsonKeys();
    const excludePaths = upstreamExcludePaths;
    const diagnostics = {
        includeEnabled: includeKeys.length > 0,
        excludeEnabled: excludePaths.length > 0,
        applied: false,
        appliedKeys: [],
        excludedPaths: [],
        missingExcludePaths: [],
        bodyHashBefore: getBodyHash(body),
        bodyHashAfter: getBodyHash(body),
        skippedReason: null,
    };

    if (includeKeys.length === 0 && excludePaths.length === 0) {
        diagnostics.skippedReason = 'empty';
        return { body, diagnostics };
    }

    if (mode !== 'openai') {
        diagnostics.skippedReason = 'upstream-mode-not-openai';
        return { body, diagnostics };
    }

    const nextBody = includeKeys.length > 0 ? deepMergeJson(body, upstreamExtraJson) : safeJsonClone(body);

    for (const path of excludePaths) {
        if (deleteJsonPath(nextBody, path)) {
            diagnostics.excludedPaths.push(path);
        } else {
            diagnostics.missingExcludePaths.push(path);
        }
    }

    diagnostics.applied = includeKeys.length > 0 || diagnostics.excludedPaths.length > 0;
    diagnostics.appliedKeys = includeKeys;
    diagnostics.bodyHashAfter = getBodyHash(nextBody);

    return { body: nextBody, diagnostics };
}

function applyUpstreamExtraJson(body, mode) {
    return applyUpstreamBodyParameters(body, mode);
}

function pickProviderBodyField(json) {
    if (!json || typeof json !== 'object') {
        return null;
    }

    const fields = ['provider', 'provider_name', 'model_provider', 'upstream_provider', 'route'];

    for (const field of fields) {
        if (json[field] !== undefined && json[field] !== null) {
            return { source: `body.${field}`, value: json[field] };
        }
    }

    return null;
}

function extractUpstreamProviderInfo(headers, json = null) {
    const headerNames = [
        'x-openrouter-provider',
        'x-provider',
        'x-model-provider',
        'openrouter-provider',
        'x-openrouter-model',
        'x-ratelimit-provider',
    ];

    for (const name of headerNames) {
        const value = headers.get(name);

        if (value) {
            return {
                provider: value,
                source: `header.${name}`,
                responseModel: json?.model ?? null,
                responseId: json?.id ?? null,
            };
        }
    }

    const bodyField = pickProviderBodyField(json);

    return {
        provider: bodyField?.value ?? null,
        source: bodyField?.source ?? 'not-returned',
        responseModel: json?.model ?? null,
        responseId: json?.id ?? null,
    };
}

function addRequestCapture({ request, originalBody, convertedBody, result, inboundMode = 'openai', inboundPath = '/v1/chat/completions' }) {
    if (!captureRequests) {
        return null;
    }

    const capture = {
        id: `${Date.now()}-${requestCaptures.length + 1}`,
        capturedAt: new Date().toISOString(),
        inbound: {
            mode: inboundMode,
            path: inboundPath,
            method: request.method,
            headersSummary: summarizeHeaders(request.headers),
            body: safeJsonClone(originalBody),
            bodyHash: getBodyHash(originalBody),
        },
        gateway: {
            upstreamMode,
            cacheTranslationEnabled,
            cacheTtl: getCacheTtlLabel(),
            cacheControl: getCacheControl(),
            upstreamExtraJsonEnabled: getUpstreamExtraJsonKeys().length > 0,
            upstreamExtraJson: safeJsonClone(upstreamExtraJson),
            upstreamExtraJsonApplied: null,
            conversion: safeJsonClone(result),
            transformedBody: safeJsonClone(convertedBody),
            transformedBodyHash: getBodyHash(convertedBody),
        },
        upstream: null,
        response: null,
    };

    requestCaptures.unshift(capture);

    if (requestCaptures.length > MAX_REQUEST_CAPTURES) {
        requestCaptures.length = MAX_REQUEST_CAPTURES;
    }

    return capture;
}

function setCaptureUpstream(capture, { url, method, headers, body, mode }) {
    if (!capture) {
        return;
    }

    capture.upstream = {
        url,
        method,
        mode,
        headersSummary: summarizeHeaders(headers),
        body: safeJsonClone(body),
        bodyHash: getBodyHash(body),
        cache: getCacheDiagnostics(body, mode),
    };
}

function setCaptureResponse(capture, upstreamResponse, text = null, json = null) {
    if (!capture) {
        return;
    }

    const usage = json ? extractUsage(json) : null;
    const upstreamProvider = extractUpstreamProviderInfo(upstreamResponse.headers, json);

    capture.response = {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headersSummary: summarizeHeaders(upstreamResponse.headers),
        bodyCaptured: text !== null,
        bodyHash: text !== null ? hashText(text) : null,
        usage,
        cacheResult: usage ? getCacheResultFromUsage(usage) : 'unknown',
        upstreamProvider,
    };
}

async function readJsonRequest(request) {
    const text = await request.text();

    if (!text) {
        return null;
    }

    return JSON.parse(text);
}

function applyUpstreamHeaderOverrides(headers) {
    for (const [name, value] of Object.entries(upstreamHeaders)) {
        headers.set(name, value);
    }

    for (const name of upstreamExcludeHeaders) {
        headers.delete(name);
    }

    return headers;
}

function getForwardHeaders(request) {
    const headers = new Headers();
    const authorization = request.headers.get('authorization') || process.env.UPSTREAM_API_KEY;

    if (authorization) {
        headers.set('authorization', authorization.startsWith('Bearer ') ? authorization : `Bearer ${authorization}`);
    }

    headers.set('content-type', 'application/json');
    applyUpstreamHeaderOverrides(headers);

    return headers;
}

function addCorsHeaders(headers = new Headers()) {
    headers.set('access-control-allow-origin', '*');
    headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
    headers.set('access-control-allow-headers', 'authorization,content-type,x-api-key,anthropic-version,anthropic-beta');
    return headers;
}

function normalizeApiKey(value) {
    if (!value) {
        return null;
    }

    return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : value;
}

function getAnthropicHeaders(request) {
    const headers = new Headers();
    const apiKey = normalizeApiKey(
        request.headers.get('x-api-key')
        || request.headers.get('authorization')
        || process.env.UPSTREAM_API_KEY,
    );

    if (apiKey) {
        headers.set('x-api-key', apiKey);
    }

    headers.set('content-type', 'application/json');
    headers.set('anthropic-version', request.headers.get('anthropic-version') || process.env.ANTHROPIC_VERSION || '2023-06-01');

    const anthropicBeta = request.headers.get('anthropic-beta') || process.env.ANTHROPIC_BETA;

    if (anthropicBeta) {
        headers.set('anthropic-beta', anthropicBeta);
    }

    applyUpstreamHeaderOverrides(headers);

    return headers;
}

async function proxyJsonRequest(request, path) {
    const url = buildApiUrl(upstreamBaseUrl, path);
    const upstreamResponse = await fetch(url, {
        method: request.method,
        headers: upstreamMode === 'anthropic' ? getAnthropicHeaders(request) : getForwardHeaders(request),
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

function addCacheControlToLastSystemTextBlock(system) {
    if (typeof system === 'string') {
        if (!system.trim()) {
            return null;
        }

        return {
            system: [{ type: 'text', text: system, cache_control: getCacheControl() }],
            blockIndex: 0,
            cachedBlockTextLength: system.length,
        };
    }

    if (!Array.isArray(system)) {
        return null;
    }

    for (let blockIndex = system.length - 1; blockIndex >= 0; blockIndex--) {
        const block = system[blockIndex];

        if (isTextBlock(block) && block.text.trim()) {
            block.cache_control = getCacheControl();
            return {
                system,
                blockIndex,
                cachedBlockTextLength: block.text.length,
            };
        }
    }

    return null;
}

function transformAnthropicSystem(system, remainingBreakpoints) {
    if (system === undefined || system === null) {
        return {
            system,
            injected: 0,
            removed: 0,
            changed: false,
            modified: null,
            existingBreakpoints: 0,
        };
    }

    const existingBreakpoints = countCacheBreakpointsInContent(Array.isArray(system) ? system : []);
    let availableBreakpoints = Math.max(0, remainingBreakpoints - existingBreakpoints);

    if (remainingBreakpoints <= 0 || availableBreakpoints <= 0) {
        const overflow = removeOverflowMarkersFromContent(system);
        return {
            system: overflow.content,
            injected: 0,
            removed: overflow.removed,
            changed: overflow.removed > 0,
            modified: overflow.removed > 0 ? { source: 'system-overflow' } : null,
            existingBreakpoints,
        };
    }

    if (typeof system === 'string') {
        const result = transformText(system, availableBreakpoints);

        return {
            system: result.content,
            injected: result.injected,
            removed: result.removed,
            changed: result.changed,
            modified: result.changed ? { source: 'system-string' } : null,
            existingBreakpoints,
        };
    }

    if (!Array.isArray(system)) {
        return { system, injected: 0, removed: 0, changed: false, modified: null, existingBreakpoints };
    }

    for (let index = 0; index < system.length; index++) {
        const block = system[index];

        if (availableBreakpoints > 0 && isTextBlock(block) && isMarkerOnlyText(block.text)) {
            const result = addCacheControlToLastSystemTextBlock(system.slice(0, index));
            const markerCount = countMarkers(block.text);

            system.splice(index, 1);

            if (result) {
                availableBreakpoints--;
                return {
                    system,
                    injected: 1,
                    removed: markerCount,
                    changed: true,
                    modified: {
                        source: 'system-standalone-marker',
                        appliedToBlock: result.blockIndex,
                        cachedBlockTextLength: result.cachedBlockTextLength,
                    },
                    existingBreakpoints,
                };
            }

            return {
                system,
                injected: 0,
                removed: markerCount,
                changed: true,
                modified: { source: 'system-standalone-marker', appliedToBlock: null },
                existingBreakpoints,
            };
        }
    }

    const result = transformContentArray(system, availableBreakpoints);

    return {
        system: result.content,
        injected: result.injected,
        removed: result.removed,
        changed: result.changed,
        modified: result.changed ? { source: 'system-content-array' } : null,
        existingBreakpoints,
    };
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

function applyAnthropicCacheBreaks(body) {
    const result = {
        existingBreakpoints: 0,
        injected: 0,
        removed: 0,
        changedMessages: 0,
        modifiedMessages: [],
        overflowRemoved: 0,
    };

    if (!cacheTranslationEnabled) {
        result.disabled = true;
        return result;
    }

    let remainingBreakpoints = MAX_BREAKPOINTS;

    const systemResult = transformAnthropicSystem(body.system, remainingBreakpoints);
    result.existingBreakpoints += systemResult.existingBreakpoints;
    result.injected += systemResult.injected;
    result.removed += systemResult.removed;
    remainingBreakpoints = Math.max(0, remainingBreakpoints - systemResult.existingBreakpoints - systemResult.injected);

    if (systemResult.changed) {
        body.system = systemResult.system;
        result.changedMessages++;
        result.modifiedMessages.push({ index: 'system', role: 'system', ...systemResult.modified });
    }

    if (Array.isArray(body.messages)) {
        const reservedBreakpoints = result.existingBreakpoints + result.injected;
        const messagesResult = applyCacheBreaks(body.messages, reservedBreakpoints);
        result.existingBreakpoints += messagesResult.existingBreakpoints - reservedBreakpoints;
        result.injected += messagesResult.injected;
        result.removed += messagesResult.removed;
        result.changedMessages += messagesResult.changedMessages;
        result.modifiedMessages.push(...messagesResult.modifiedMessages);
        result.overflowRemoved += messagesResult.overflowRemoved;
    }

    return result;
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
    let anthropicBody = convertOpenAiToAnthropicBody(convertedBody);
    const prefixLockResult = applyPrefixLock(anthropicBody, 'anthropic');
    anthropicBody = prefixLockResult.body;

    if (capture) {
        capture.gateway.prefixLock = safeJsonClone(prefixLockResult.diagnostics);
        capture.gateway.upstreamExtraJsonApplied = safeJsonClone(applyUpstreamExtraJson(anthropicBody, 'anthropic').diagnostics);
    }

    const upstreamUrl = buildApiUrl(upstreamBaseUrl, '/v1/messages');
    const upstreamHeaders = getAnthropicHeaders(request);

    setCaptureUpstream(capture, {
        url: upstreamUrl,
        method: 'POST',
        headers: upstreamHeaders,
        body: anthropicBody,
        mode: 'anthropic',
    });

    const upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(anthropicBody),
    });

    if (anthropicBody.stream) {
        setCaptureResponse(capture, upstreamResponse);

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

    setCaptureResponse(capture, upstreamResponse, text, json);

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

async function proxyAnthropicCountTokens(request) {
    if (upstreamMode !== 'anthropic') {
        return jsonResponse({
            error: 'Anthropic count_tokens requires Anthropic upstream mode.',
            hint: 'Switch the debug console upstream format to Anthropic native, or start with UPSTREAM_MODE=anthropic.',
        }, 400);
    }

    const body = await readJsonRequest(request);

    if (!body || !Array.isArray(body.messages)) {
        return jsonResponse({ error: 'Request body must include messages array.' }, 400);
    }

    const convertedBody = safeJsonClone(body);
    applyAnthropicCacheBreaks(convertedBody);

    const upstreamResponse = await fetch(buildApiUrl(upstreamBaseUrl, '/v1/messages/count_tokens'), {
        method: 'POST',
        headers: getAnthropicHeaders(request),
        body: JSON.stringify(convertedBody),
    });
    const text = await upstreamResponse.text();

    return new Response(text, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: addCorsHeaders(new Headers({
            'content-type': upstreamResponse.headers.get('content-type') || 'application/json',
        })),
    });
}

async function proxyAnthropicMessages(request) {
    if (upstreamMode !== 'anthropic') {
        return jsonResponse({
            error: 'Anthropic inbound /v1/messages requires Anthropic upstream mode.',
            hint: 'Switch the debug console upstream format to Anthropic native, or start with UPSTREAM_MODE=anthropic.',
        }, 400);
    }

    const body = await readJsonRequest(request);

    if (!body || !Array.isArray(body.messages)) {
        return jsonResponse({ error: 'Request body must include messages array.' }, 400);
    }

    const convertedBody = safeJsonClone(body);
    const result = applyAnthropicCacheBreaks(convertedBody);
    const capture = addRequestCapture({
        request,
        originalBody: body,
        convertedBody,
        result,
        inboundMode: 'anthropic',
        inboundPath: '/v1/messages',
    });

    log('Forwarding Anthropic messages.', {
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

    const upstreamUrl = buildApiUrl(upstreamBaseUrl, '/v1/messages');
    const upstreamHeaders = getAnthropicHeaders(request);

    setCaptureUpstream(capture, {
        url: upstreamUrl,
        method: 'POST',
        headers: upstreamHeaders,
        body: convertedBody,
        mode: 'anthropic',
    });

    const upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(convertedBody),
    });

    const headers = addCorsHeaders(new Headers({
        'content-type': upstreamResponse.headers.get('content-type') || (convertedBody.stream ? 'text/event-stream' : 'application/json'),
    }));

    if (upstreamResponse.headers.get('cache-control') || convertedBody.stream) {
        headers.set('cache-control', upstreamResponse.headers.get('cache-control') || 'no-cache');
    }

    if (convertedBody.stream) {
        setCaptureResponse(capture, upstreamResponse);

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

    setCaptureResponse(capture, upstreamResponse, text, json);

    if (json?.usage) {
        log('Anthropic upstream usage.', extractUsage(json));
    }

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
    const capture = addRequestCapture({ request, originalBody: body, convertedBody, result });

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

    const prefixLockResult = applyPrefixLock(convertedBody, 'openai');
    const extraJsonResult = applyUpstreamExtraJson(prefixLockResult.body, 'openai');
    const upstreamBody = extraJsonResult.body;

    if (capture) {
        capture.gateway.prefixLock = safeJsonClone(prefixLockResult.diagnostics);
        capture.gateway.upstreamExtraJsonApplied = safeJsonClone(extraJsonResult.diagnostics);
    }

    const upstreamHeaders = getForwardHeaders(request);

    setCaptureUpstream(capture, {
        url,
        method: 'POST',
        headers: upstreamHeaders,
        body: upstreamBody,
        mode: 'openai',
    });

    const upstreamResponse = await fetch(url, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamBody),
    });

    if (convertedBody.stream) {
        setCaptureResponse(capture, upstreamResponse);

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

    setCaptureResponse(capture, upstreamResponse, text, json);

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

function anthropicInboundDisabledResponse(path) {
    return jsonResponse({
        error: 'Claude / Anthropic-compatible inbound is disabled in this gateway build.',
        path,
        reason: 'SillyTavern Claude-compatible inbound may cause repeated cache writes. Use OpenAI-compatible / Chat Completion in SillyTavern, then keep this gateway upstream format set to Anthropic native.',
        recommendedSetup: {
            sillyTavernBackend: 'OpenAI-compatible / Chat Completion',
            baseUrl: `http://${host}:${port}`,
            gatewayUpstreamMode: 'anthropic',
            endpoint: '/v1/chat/completions',
        },
    }, 403);
}

function htmlResponse(html) {
    return new Response(html, {
        status: 200,
        headers: addCorsHeaders(new Headers({ 'content-type': 'text/html; charset=utf-8' })),
    });
}

function staticTextResponse(path, contentType) {
    return new Response(readFileSync(new URL(path, import.meta.url), 'utf8'), {
        status: 200,
        headers: addCorsHeaders(new Headers({ 'content-type': contentType })),
    });
}

function consoleResponse() {
    return staticTextResponse('./public/console.html', 'text/html; charset=utf-8');
}

function getCaptureSummary(capture) {
    const upstreamBody = capture.upstream?.body;
    const usage = capture.response?.usage || {};

    return {
        id: capture.id,
        capturedAt: capture.capturedAt,
        model: upstreamBody?.model ?? capture.gateway?.transformedBody?.model ?? null,
        stream: Boolean(upstreamBody?.stream ?? capture.gateway?.transformedBody?.stream),
        messages: Array.isArray(upstreamBody?.messages) ? upstreamBody.messages.length : 0,
        cacheTranslationEnabled: capture.gateway?.cacheTranslationEnabled ?? true,
        cacheTtl: capture.gateway?.cacheTtl ?? null,
        inboundMode: capture.inbound?.mode ?? null,
        upstreamMode: capture.gateway?.upstreamMode ?? null,
        upstreamUrl: capture.upstream?.url ?? null,
        injected: capture.gateway?.conversion?.injected ?? 0,
        removed: capture.gateway?.conversion?.removed ?? 0,
        overflowRemoved: capture.gateway?.conversion?.overflowRemoved ?? 0,
        cacheControlCount: capture.upstream?.cache?.cacheControlCount ?? 0,
        firstCacheControlPath: capture.upstream?.cache?.firstCacheControlPath ?? null,
        prefixHash: capture.upstream?.cache?.prefixHash ?? null,
        prefixLength: capture.upstream?.cache?.prefixLength ?? 0,
        suffixHash: capture.upstream?.cache?.suffixHash ?? null,
        cacheReadTokens: usage.anthropicCacheReadInputTokens ?? usage.cachedTokens ?? usage.cacheReadTokens ?? null,
        cacheWriteTokens: usage.anthropicCacheCreationInputTokens ?? usage.cacheWriteTokens ?? null,
        cacheResult: capture.response?.cacheResult ?? 'unknown',
        responseStatus: capture.response?.status ?? null,
        prefixLockAction: capture.gateway?.prefixLock?.action ?? 'disabled',
        prefixLockReason: capture.gateway?.prefixLock?.reason ?? null,
        prefixLockHash: capture.gateway?.prefixLock?.lockedPrefixHash ?? capture.gateway?.prefixLock?.prefixHash ?? null,
        upstreamExtraJsonEnabled: Boolean(capture.gateway?.upstreamExtraJsonEnabled),
        upstreamExtraJsonApplied: Boolean(capture.gateway?.upstreamExtraJsonApplied?.applied),
        upstreamExtraJsonKeys: capture.gateway?.upstreamExtraJsonApplied?.appliedKeys || [],
        upstreamProvider: capture.response?.upstreamProvider?.provider ?? null,
        upstreamProviderSource: capture.response?.upstreamProvider?.source ?? 'not-returned',
        responseModel: capture.response?.upstreamProvider?.responseModel ?? null,
    };
}

async function handleConsoleChannels(request, url) {
    if (request.method === 'GET' && url.pathname === '/console/channels') {
        return jsonResponse(getChannelState());
    }

    if (request.method === 'POST' && url.pathname === '/console/channels') {
        try {
            const body = await readJsonRequest(request);
            const profile = normalizeChannelProfile({
                ...body,
                id: makeUniqueChannelId(body?.name || 'custom-channel'),
                kind: 'custom',
            }, null, { allowGeneratedId: true });
            channelProfiles.push(profile);
            activeChannelId = profile.id;
            syncRuntimeFromActiveChannel();
            saveRuntimeSettings();
            log('Created channel profile from console.', {
                channelId: profile.id,
                name: profile.name,
                baseUrl: profile.baseUrl,
                upstreamMode: profile.upstreamMode,
                upstreamExtraJsonKeys: Object.keys(profile.upstreamExtraJson),
            });
            return jsonResponse(getRuntimeState());
        } catch (error) {
            return jsonResponse({ error: error.message }, 400);
        }
    }

    if (!url.pathname.startsWith('/console/channels/')) {
        return null;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const id = sanitizeChannelId(decodeURIComponent(parts[2] || ''));
    const action = parts[3] || null;
    const index = channelProfiles.findIndex((profile) => profile.id === id);

    if (index < 0) {
        return jsonResponse({ error: 'Channel not found.' }, 404);
    }

    const profile = channelProfiles[index];

    if (request.method === 'POST' && action === 'activate') {
        try {
            setActiveChannel(profile.id);
            saveRuntimeSettings();
            log('Activated channel profile from console.', {
                channelId: profile.id,
                name: profile.name,
                baseUrl: profile.baseUrl,
                upstreamMode: profile.upstreamMode,
            });
            return jsonResponse(getRuntimeState());
        } catch (error) {
            return jsonResponse({ error: error.message }, 400);
        }
    }

    if (request.method === 'POST' && action === 'delete') {
        if (profile.kind === 'builtin') {
            return jsonResponse({ error: 'Built-in channels cannot be deleted.' }, 400);
        }

        channelProfiles.splice(index, 1);

        if (activeChannelId === profile.id) {
            setActiveChannel(channelProfiles.some((item) => item.id === 'pioneer') ? 'pioneer' : channelProfiles[0].id);
        }

        saveRuntimeSettings();
        log('Deleted channel profile from console.', { channelId: profile.id, name: profile.name });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && !action) {
        try {
            const body = await readJsonRequest(request);
            const nextProfile = normalizeChannelProfile({
                ...body,
                id: profile.id,
                kind: profile.kind,
                name: profile.kind === 'builtin' ? profile.name : body?.name,
            }, profile);
            channelProfiles[index] = nextProfile;

            if (activeChannelId === nextProfile.id) {
                syncRuntimeFromActiveChannel();
            }

            saveRuntimeSettings();
            log('Updated channel profile from console.', {
                channelId: nextProfile.id,
                name: nextProfile.name,
                baseUrl: nextProfile.baseUrl,
                upstreamMode: nextProfile.upstreamMode,
                upstreamExtraJsonKeys: Object.keys(nextProfile.upstreamExtraJson),
            });
            return jsonResponse(getRuntimeState());
        } catch (error) {
            return jsonResponse({ error: error.message }, 400);
        }
    }

    return null;
}

async function handleConsoleApi(request, url) {
    const channelResponse = await handleConsoleChannels(request, url);

    if (channelResponse) {
        return channelResponse;
    }

    if (request.method === 'GET' && url.pathname === '/console/state') {
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/cache-ttl') {
        const body = await readJsonRequest(request);
        cacheTtl = normalizeCacheTtl(body?.ttl || '');
        saveRuntimeSettings();
        log('Updated cache TTL from console.', { cacheTtl: getCacheTtlLabel(), cacheControl: getCacheControl() });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/cache-translation') {
        const body = await readJsonRequest(request);
        cacheTranslationEnabled = normalizeBoolean(body?.enabled, true);
        saveRuntimeSettings();
        log('Updated cache translation setting from console.', { cacheTranslationEnabled });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/upstream-mode') {
        const body = await readJsonRequest(request);
        upstreamMode = normalizeUpstreamMode(body?.mode || 'anthropic');
        syncActiveChannelFromRuntime();
        saveRuntimeSettings();
        log('Updated upstream mode from console.', { upstreamMode, activeChannelId });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/upstream-extra-json') {
        const body = await readJsonRequest(request);

        try {
            upstreamExtraJson = normalizeUpstreamExtraJson(Object.prototype.hasOwnProperty.call(body || {}, 'json') ? body.json : body?.value);
        } catch (error) {
            return jsonResponse({ error: error.message }, 400);
        }

        try {
            assertSafeProfileJson(upstreamExtraJson);
        } catch (error) {
            return jsonResponse({ error: error.message }, 400);
        }

        syncActiveChannelFromRuntime();
        saveRuntimeSettings();
        log('Updated upstream extra JSON from console.', { activeChannelId, upstreamExtraJsonKeys: getUpstreamExtraJsonKeys() });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/upstream-exclude-paths') {
        const body = await readJsonRequest(request);

        try {
            upstreamExcludePaths = normalizeUpstreamExcludePaths(Object.prototype.hasOwnProperty.call(body || {}, 'paths') ? body.paths : body?.value);
        } catch (error) {
            return jsonResponse({ error: error.message }, 400);
        }

        syncActiveChannelFromRuntime();
        saveRuntimeSettings();
        log('Updated upstream exclude paths from console.', { activeChannelId, upstreamExcludePaths });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/upstream-headers') {
        const body = await readJsonRequest(request);

        try {
            upstreamHeaders = normalizeUpstreamHeaders(Object.prototype.hasOwnProperty.call(body || {}, 'headers') ? body.headers : body?.value);
        } catch (error) {
            return jsonResponse({ error: error.message }, 400);
        }

        syncActiveChannelFromRuntime();
        saveRuntimeSettings();
        log('Updated upstream header overrides from console.', { activeChannelId, upstreamHeaderKeys: getUpstreamHeaderKeys() });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/upstream-exclude-headers') {
        const body = await readJsonRequest(request);

        try {
            upstreamExcludeHeaders = normalizeUpstreamExcludeHeaders(Object.prototype.hasOwnProperty.call(body || {}, 'headers') ? body.headers : body?.value);
        } catch (error) {
            return jsonResponse({ error: error.message }, 400);
        }

        syncActiveChannelFromRuntime();
        saveRuntimeSettings();
        log('Updated upstream excluded headers from console.', { activeChannelId, upstreamExcludeHeaders });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/capture') {
        const body = await readJsonRequest(request);
        captureRequests = Boolean(body?.enabled);
        log('Updated capture setting from console.', { captureRequests });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/prefix-lock') {
        const body = await readJsonRequest(request);
        prefixLockEnabled = Boolean(body?.enabled);

        if (!prefixLockEnabled) {
            clearPrefixLock();
        } else {
            updatePrefixLockStats(prefixLock ? 'enabled' : 'learning');
        }

        log('Updated prefix lock setting from console.', { prefixLockEnabled, prefixLockActive: Boolean(prefixLock) });
        return jsonResponse(getRuntimeState());
    }

    if (request.method === 'POST' && url.pathname === '/console/prefix-lock/clear') {
        clearPrefixLock();
        log('Cleared prefix lock from console.', { prefixLockEnabled });
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
button, select, textarea { font: inherit; color: var(--text); background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; }
textarea { width: 100%; min-height: 150px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
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
    <p class="muted">本页面只连接本地网关，用于切换 TTL、检查状态、诊断最终上游请求。推荐酒馆使用 OpenAI-compatible 入站，网关使用 Anthropic native 上游。</p>
  </section>

  <section class="grid">
    <div class="stat"><div class="label">缓存模式</div><div id="cacheTtlText" class="value">加载中</div></div>
    <div class="stat"><div class="label">上游格式</div><div id="upstreamModeText" class="value">加载中</div></div>
    <div class="stat"><div class="label">请求诊断</div><div id="captureText" class="value">加载中</div></div>
  </section>

  <section class="card">
    <h2>1. 缓存 TTL 模式</h2>
    <p class="help">推荐默认模式：发送 ttl: 1h，使用 Claude 原生 1 小时缓存。也可以切回 provider-default，不发送 ttl，让供应商使用默认 ephemeral 窗口。</p>
    <div class="row" style="margin-top: 12px;">
      <label>当前模式
        <select id="ttl">
          <option value="1h">1h（默认推荐）</option>
          <option value="">provider-default / 不发送 ttl</option>
        </select>
      </label>
      <button id="saveTtl" class="primary">应用 TTL</button>
      <button id="refresh">刷新状态</button>
    </div>
    <p class="help warn">网关会记住控制台上一次选择的 TTL 和上游格式，重启后继续沿用。环境变量会优先生效。</p>
  </section>

  <section class="card">
    <h2>2. 上游请求格式</h2>
    <p class="help">默认 Anthropic native 会把酒馆 OpenAI-compatible 请求转换成 /v1/messages，这是当前验证 1h TTL 成功的 Claude 官方格式。需要兼容其他上游时，可切回 OpenAI-compatible。</p>
    <div class="row" style="margin-top: 12px;">
      <label>当前上游格式
        <select id="upstreamMode">
          <option value="anthropic">Anthropic native /v1/messages（默认推荐）</option>
          <option value="openai">OpenAI-compatible（兼容模式）</option>
        </select>
      </label>
      <button id="saveUpstreamMode" class="primary">应用上游格式</button>
    </div>
    <p class="help warn">Anthropic native 是 Claude 缓存推荐模式；工具调用等高级能力暂不保证完整兼容。OpenAI-compatible 会保留作为切换选项。</p>
  </section>

  <section class="card">
    <h2>3. 请求诊断</h2>
    <p class="help warn">诊断 JSON 会原样记录网关实际发给上游的完整请求体，包括 system / messages / tools / thinking 等参数；只隐藏 Authorization、x-api-key、Cookie。默认关闭；只在排查问题时开启。</p>
    <div class="row" style="margin-top: 12px;">
      <button id="captureOn" class="primary">开启诊断</button>
      <button id="refreshCaptures">刷新诊断列表</button>
      <button id="captureOff">关闭诊断</button>
      <button id="clear" class="danger">清空诊断</button>
    </div>
  </section>

  <section class="card">
    <h2>4. 强制 Prefix 锁定</h2>
    <p class="help warn">开启后，第一次带 cache_control 的最终上游请求会被学习为锁定 prefix；后续请求会丢弃本轮缓存点前内容，改用锁定 prefix + 本轮 suffix。换角色、世界书、预设、聊天后请清空锁定。</p>
    <div class="grid" style="margin-top: 12px;">
      <div class="stat"><div class="label">锁定开关</div><div id="prefixLockEnabledText" class="value">加载中</div></div>
      <div class="stat"><div class="label">锁定状态</div><div id="prefixLockStatusText" class="value">加载中</div></div>
      <div class="stat"><div class="label">锁定 Prefix</div><div id="prefixLockHashText" class="value">加载中</div></div>
    </div>
    <div class="row" style="margin-top: 12px;">
      <button id="prefixLockOn" class="primary">开启强制锁定</button>
      <button id="prefixLockOff">关闭强制锁定</button>
      <button id="prefixLockClear" class="danger">清空锁定 / 下次重学</button>
    </div>
    <p id="prefixLockDetail" class="muted">加载中...</p>
  </section>

  <section class="card">
    <h2>5. OpenRouter / 上游额外 JSON 参数</h2>
    <p class="help warn">这里会把 JSON 对象深度合并到最终上游请求体里，额外参数优先。它只在 OpenAI-compatible 上游格式生效；测试 OpenRouter 时请使用 UPSTREAM_BASE_URL=https://openrouter.ai/api/v1，并把上游格式切到 OpenAI-compatible。</p>
    <div class="grid" style="margin-top: 12px;">
      <div class="stat"><div class="label">额外参数</div><div id="extraJsonEnabledText" class="value">加载中</div></div>
      <div class="stat"><div class="label">键</div><div id="extraJsonKeysText" class="value">加载中</div></div>
      <div class="stat"><div class="label">当前上游</div><div id="extraJsonModeText" class="value">加载中</div></div>
    </div>
    <div style="margin-top: 12px;">
      <textarea id="upstreamExtraJson" spellcheck="false">{}</textarea>
    </div>
    <div class="row" style="margin-top: 12px;">
      <button id="extraJsonOff">关闭额外参数</button>
      <button id="extraJsonFormat">格式化 JSON</button>
      <button id="extraJsonApply" class="primary">应用</button>
    </div>
  </section>

  <section class="split">
    <div class="card">
      <h2>6. 最近请求</h2>
      <div id="requests" class="muted">加载中...</div>
    </div>
    <div class="card">
      <h2>7. 选中的 JSON</h2>
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
  return value === '1h' ? '1h（默认推荐）' : 'provider-default / 不发送 ttl';
}
function upstreamModeLabel(value) {
  return value === 'anthropic' ? 'Anthropic native（默认推荐）' : 'OpenAI-compatible（兼容模式）';
}
function inboundModeLabel(value) {
  return value === 'anthropic' ? 'Claude 入站' : 'OpenAI 入站';
}
function cacheResultLabel(value) {
  if (value === 'hit') return '命中';
  if (value === 'creation') return '写入';
  if (value === 'none') return '无读写';
  return '未知';
}
function tokenLabel(value) {
  return value === null || value === undefined ? '-' : value;
}
function providerLabel(value, source) {
  return value ? String(value) + ' (' + source + ')' : '未知 / 未返回';
}
function setStatus(text) {
  document.getElementById('selectedHint').textContent = text;
}
async function loadState() {
  const state = await api('/console/state');
  document.getElementById('cacheTtlText').textContent = ttlLabel(state.cacheTtl);
  document.getElementById('upstreamModeText').textContent = upstreamModeLabel(state.upstreamMode);
  document.getElementById('captureText').textContent = (state.captureRequests ? '已开启' : '已关闭') + ' / ' + state.capturedRequests;
  document.getElementById('prefixLockEnabledText').textContent = state.prefixLockEnabled ? '已开启' : '已关闭';
  document.getElementById('prefixLockStatusText').textContent = state.prefixLockActive ? '已锁定' : (state.prefixLockEnabled ? '等待下次学习' : '未锁定');
  document.getElementById('prefixLockHashText').textContent = state.prefixLockHash || '-';
  document.getElementById('prefixLockDetail').textContent = '路径 ' + (state.prefixLockFirstCacheControlPath || '-') + ' · 替换 ' + state.prefixLockReplacements + ' · 最近动作 ' + (state.prefixLockLastAction || '-') + ' · 原因 ' + (state.prefixLockLastSkipReason || '-');
  document.getElementById('extraJsonEnabledText').textContent = state.upstreamExtraJsonEnabled ? '已开启' : '已关闭';
  document.getElementById('extraJsonKeysText').textContent = state.upstreamExtraJsonKeys.length ? state.upstreamExtraJsonKeys.join(', ') : '-';
  document.getElementById('extraJsonModeText').textContent = state.upstreamMode === 'openai' ? '会应用' : '不会应用';
  document.getElementById('upstreamExtraJson').value = state.upstreamExtraJsonText || '{}';
  document.getElementById('cacheControl').textContent = JSON.stringify({ upstreamMode: state.upstreamMode, cacheControl: state.cacheControl, anthropicInboundEnabled: state.anthropicInboundEnabled, prefixLock: { enabled: state.prefixLockEnabled, active: state.prefixLockActive, hash: state.prefixLockHash }, upstreamExtraJson: state.upstreamExtraJson }, null, 2);
  document.getElementById('ttl').value = state.cacheTtl === 'provider-default' ? '' : state.cacheTtl;
  document.getElementById('upstreamMode').value = state.upstreamMode;
}
async function loadRequests() {
  const data = await api('/console/requests');
  const root = document.getElementById('requests');
  if (!data.requests.length) {
    root.innerHTML = '<p class="muted">还没有诊断请求。先点“开启诊断”，再从酒馆发一条消息。</p>';
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
    meta.textContent = item.capturedAt
      + ' · ' + inboundModeLabel(item.inboundMode) + ' → ' + upstreamModeLabel(item.upstreamMode)
      + ' · 状态 ' + (item.responseStatus || '-') + ' · ' + cacheResultLabel(item.cacheResult)
      + ' · 写入 ' + tokenLabel(item.cacheWriteTokens) + ' · 读取 ' + tokenLabel(item.cacheReadTokens)
      + ' · 缓存点 ' + item.cacheControlCount + ' · Prefix ' + (item.prefixHash || '-') + ' / ' + item.prefixLength
      + ' · 锁定 ' + item.prefixLockAction + (item.prefixLockReason ? '(' + item.prefixLockReason + ')' : '')
      + ' · 额外JSON ' + (item.upstreamExtraJsonApplied ? item.upstreamExtraJsonKeys.join(',') : (item.upstreamExtraJsonEnabled ? '跳过' : '关闭'))
      + ' · 供应商 ' + providerLabel(item.upstreamProvider, item.upstreamProviderSource)
      + ' · 消息 ' + item.messages + ' · TTL ' + ttlLabel(item.cacheTtl)
      + ' · 注入 ' + item.injected + ' · 转译 ' + item.removed;
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
document.getElementById('captureOn').onclick = async () => { await api('/console/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }); await refreshAll(); setStatus('请求诊断已开启，并已刷新列表'); };
document.getElementById('refreshCaptures').onclick = async () => { await refreshAll(); setStatus('诊断列表已刷新'); };
document.getElementById('captureOff').onclick = async () => { await api('/console/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }); await refreshAll(); setStatus('请求诊断已关闭'); };
document.getElementById('clear').onclick = async () => { await api('/console/clear', { method: 'POST' }); selected = null; document.getElementById('details').textContent = '暂无选择。'; document.getElementById('download').disabled = true; await refreshAll(); setStatus('已清空诊断'); };
document.getElementById('prefixLockOn').onclick = async () => { await api('/console/prefix-lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) }); await refreshAll(); setStatus('强制 Prefix 锁定已开启，下一次带缓存点请求会学习或替换'); };
document.getElementById('prefixLockOff').onclick = async () => { await api('/console/prefix-lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }); await refreshAll(); setStatus('强制 Prefix 锁定已关闭'); };
document.getElementById('prefixLockClear').onclick = async () => { await api('/console/prefix-lock/clear', { method: 'POST' }); await refreshAll(); setStatus('已清空锁定 prefix，开启状态下下一次请求会重新学习'); };
document.getElementById('extraJsonOff').onclick = async () => { await api('/console/upstream-extra-json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: {} }) }); await refreshAll(); setStatus('上游额外 JSON 已关闭'); };
document.getElementById('extraJsonFormat').onclick = () => { document.getElementById('upstreamExtraJson').value = JSON.stringify(JSON.parse(document.getElementById('upstreamExtraJson').value || '{}'), null, 2); setStatus('额外 JSON 已格式化'); };
document.getElementById('extraJsonApply').onclick = async () => { await api('/console/upstream-extra-json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: document.getElementById('upstreamExtraJson').value }) }); await refreshAll(); setStatus('上游额外 JSON 已应用'); };
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
            return consoleResponse();
        }

        if (request.method === 'GET' && url.pathname === '/console.css') {
            return staticTextResponse('./public/console.css', 'text/css; charset=utf-8');
        }

        if (request.method === 'GET' && url.pathname === '/console.js') {
            return staticTextResponse('./public/console.js', 'application/javascript; charset=utf-8');
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

        if (request.method === 'POST' && url.pathname === '/v1/messages') {
            return anthropicInboundDisabledResponse(url.pathname);
        }

        if (request.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
            return anthropicInboundDisabledResponse(url.pathname);
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
