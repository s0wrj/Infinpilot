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

function buildHeaders(serverConfig, extraHeaders = {}) {
    const headers = {
        Accept: 'text/event-stream',
        ...(serverConfig.headers || {}),
        ...extraHeaders
    };

    if (serverConfig.authType === 'bearer' && serverConfig.authToken) {
        headers.Authorization = `Bearer ${serverConfig.authToken}`;
    } else if (serverConfig.authType === 'api-key' && serverConfig.authToken) {
        headers[serverConfig.authHeaderName || 'X-API-Key'] = serverConfig.authToken;
    } else if (serverConfig.authType === 'custom-header' && serverConfig.authToken) {
        headers[serverConfig.authHeaderName || 'Authorization'] = serverConfig.authToken;
    }

    return headers;
}

function consumeSseBuffer(buffer, onPayload) {
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
            onPayload(JSON.parse(dataText));
        } catch (_) {
            // Ignore malformed SSE data.
        }
    }
    return remainder;
}

export class LegacySseClient {
    constructor(serverConfig, options = {}) {
        this.serverConfig = serverConfig;
        this.clientInfo = options.clientInfo || {};
        this.streamController = null;
        this.streamTask = null;
        this.pendingRequests = new Map();
        this.connected = false;
        this.lastError = null;
    }

    async connect() {
        if (this.connected && this.streamTask) {
            return;
        }
        if (!this.serverConfig.url) {
            throw new Error('MCP SSE URL is missing');
        }
        this.streamController = new AbortController();
        this.streamTask = this.consumeStream(this.streamController.signal);
        await sleep(50);
    }

    async consumeStream(signal) {
        try {
            const response = await fetch(this.serverConfig.url, {
                method: 'GET',
                headers: buildHeaders(this.serverConfig),
                signal
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            this.connected = true;
            if (!response.body) {
                throw new Error('SSE response body is empty');
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                buffer = consumeSseBuffer(buffer, (payload) => this.handlePayload(payload));
            }
        } catch (error) {
            this.lastError = error;
            this.rejectAllPending(error);
        } finally {
            this.connected = false;
            this.streamTask = null;
        }
    }

    handlePayload(payload) {
        if (!payload || payload.id == null) {
            return;
        }
        const pending = this.pendingRequests.get(payload.id);
        if (!pending) {
            return;
        }
        this.pendingRequests.delete(payload.id);
        const error = extractErrorEnvelope(payload);
        if (error) {
            pending.reject(new Error(error.message || 'MCP request failed'));
            return;
        }
        pending.resolve(payload);
    }

    rejectAllPending(error) {
        for (const pending of this.pendingRequests.values()) {
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }

    async request(payload) {
        await this.connect();
        if (!this.serverConfig.messageUrl) {
            throw new Error('Legacy SSE transport requires messageUrl');
        }

        const resultPromise = new Promise((resolve, reject) => {
            this.pendingRequests.set(payload.id, { resolve, reject });
        });

        const response = await fetch(this.serverConfig.messageUrl, {
            method: 'POST',
            headers: {
                ...buildHeaders(this.serverConfig, { 'Content-Type': 'application/json' }),
                Accept: 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            this.pendingRequests.delete(payload.id);
            const errorText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
        }

        return resultPromise;
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
        if (this.streamController) {
            this.streamController.abort();
        }
        this.rejectAllPending(new Error('MCP SSE transport closed'));
        await sleep(0);
    }
}
