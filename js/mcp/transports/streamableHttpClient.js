import {
    buildInitializeRequest,
    buildPromptsGetRequest,
    buildPromptsListRequest,
    buildResourcesListRequest,
    buildResourcesReadRequest,
    buildToolsCallRequest,
    buildToolsListRequest,
    extractErrorEnvelope,
    extractResultEnvelope
} from '../mcpProtocol.js';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSseChunk(buffer, onEvent) {
    const events = buffer.split('\n\n');
    const remainder = events.pop() || '';
    for (const eventText of events) {
        const dataLines = eventText
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) {
            continue;
        }
        const dataText = dataLines.join('\n');
        if (dataText === '[DONE]') {
            continue;
        }
        try {
            onEvent(JSON.parse(dataText));
        } catch (_) {
            // Ignore malformed SSE event payloads.
        }
    }
    return remainder;
}

export class StreamableHttpClient {
    constructor(serverConfig, options = {}) {
        this.serverConfig = serverConfig;
        this.clientInfo = options.clientInfo || {};
        this.sessionId = '';
    }

    buildHeaders(extraHeaders = {}) {
        const headers = {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            ...(this.serverConfig.headers || {}),
            ...extraHeaders
        };

        if (this.serverConfig.authType === 'bearer' && this.serverConfig.authToken) {
            headers.Authorization = `Bearer ${this.serverConfig.authToken}`;
        } else if (this.serverConfig.authType === 'api-key' && this.serverConfig.authToken) {
            headers[this.serverConfig.authHeaderName || 'X-API-Key'] = this.serverConfig.authToken;
        } else if (this.serverConfig.authType === 'custom-header' && this.serverConfig.authToken) {
            headers[this.serverConfig.authHeaderName || 'Authorization'] = this.serverConfig.authToken;
        }

        if (this.sessionId) {
            headers['Mcp-Session-Id'] = this.sessionId;
        }

        return headers;
    }

    updateSessionFromResponse(response) {
        const sessionId = response.headers.get('mcp-session-id') || response.headers.get('Mcp-Session-Id');
        if (sessionId) {
            this.sessionId = sessionId;
        }
    }

    async parseResponse(response, expectedId) {
        this.updateSessionFromResponse(response);
        const contentType = (response.headers.get('content-type') || '').toLowerCase();

        if (contentType.includes('application/json')) {
            const payload = await response.json();
            return this.extractMatchingPayload(payload, expectedId);
        }

        if (contentType.includes('text/event-stream')) {
            return this.parseSseResponse(response, expectedId);
        }

        const rawText = await response.text();
        try {
            return this.extractMatchingPayload(JSON.parse(rawText), expectedId);
        } catch (_) {
            throw new Error(`Unsupported MCP response content type: ${contentType || 'unknown'}`);
        }
    }

    extractMatchingPayload(payload, expectedId) {
        const candidates = Array.isArray(payload) ? payload : [payload];
        for (const candidate of candidates) {
            if (candidate?.id === expectedId || (candidate?.result !== undefined && expectedId == null)) {
                const error = extractErrorEnvelope(candidate);
                if (error) {
                    throw new Error(error.message || 'MCP request failed');
                }
                return candidate;
            }
        }
        const firstError = candidates.map(extractErrorEnvelope).find(Boolean);
        if (firstError) {
            throw new Error(firstError.message || 'MCP request failed');
        }
        return candidates[0] || null;
    }

    async parseSseResponse(response, expectedId) {
        if (!response.body) {
            throw new Error('SSE response body is empty');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let matched = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            buffer = parseSseChunk(buffer, (payload) => {
                if (!matched && (payload?.id === expectedId || (payload?.result !== undefined && expectedId == null))) {
                    matched = payload;
                }
            });
            if (matched) {
                break;
            }
        }

        if (!matched) {
            throw new Error('No matching MCP SSE response received');
        }
        const error = extractErrorEnvelope(matched);
        if (error) {
            throw new Error(error.message || 'MCP request failed');
        }
        return matched;
    }

    async request(payload) {
        if (!this.serverConfig.url) {
            throw new Error('MCP server URL is missing');
        }

        const response = await fetch(this.serverConfig.url, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
        }

        return this.parseResponse(response, payload.id);
    }

    async initialize() {
        const envelope = await this.request(buildInitializeRequest(this.clientInfo));
        return extractResultEnvelope(envelope) || {};
    }

    async listTools() {
        const envelope = await this.request(buildToolsListRequest());
        return extractResultEnvelope(envelope) || {};
    }

    async listResources(cursor = undefined) {
        const envelope = await this.request(buildResourcesListRequest(cursor));
        return extractResultEnvelope(envelope) || {};
    }

    async readResource(uri) {
        const envelope = await this.request(buildResourcesReadRequest(uri));
        return extractResultEnvelope(envelope) || {};
    }

    async listPrompts(cursor = undefined) {
        const envelope = await this.request(buildPromptsListRequest(cursor));
        return extractResultEnvelope(envelope) || {};
    }

    async getPrompt(name, argumentsPayload = {}) {
        const envelope = await this.request(buildPromptsGetRequest(name, argumentsPayload));
        return extractResultEnvelope(envelope) || {};
    }

    async callTool(name, argumentsPayload = {}) {
        const envelope = await this.request(buildToolsCallRequest(name, argumentsPayload));
        return extractResultEnvelope(envelope) || {};
    }

    async close() {
        await sleep(0);
    }
}
