let requestCounter = 0;
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export function createRpcId(prefix = 'mcp') {
    requestCounter += 1;
    return `${prefix}_${Date.now()}_${requestCounter}`;
}

export function buildJsonRpcRequest(method, params = {}, id = createRpcId()) {
    return {
        jsonrpc: '2.0',
        id,
        method,
        params
    };
}

export function buildInitializeRequest(clientInfo = {}) {
    return buildJsonRpcRequest('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
            tools: {},
            resources: {},
            prompts: {}
        },
        clientInfo: {
            name: clientInfo.name || 'InfinPilot',
            version: clientInfo.version || '0.0.0'
        }
    });
}

export function buildToolsListRequest(cursor = undefined) {
    const params = {};
    if (cursor) {
        params.cursor = cursor;
    }
    return buildJsonRpcRequest('tools/list', params);
}

export function buildResourcesListRequest(cursor = undefined) {
    const params = {};
    if (cursor) {
        params.cursor = cursor;
    }
    return buildJsonRpcRequest('resources/list', params);
}

export function buildResourcesReadRequest(uri) {
    return buildJsonRpcRequest('resources/read', { uri });
}

export function buildPromptsListRequest(cursor = undefined) {
    const params = {};
    if (cursor) {
        params.cursor = cursor;
    }
    return buildJsonRpcRequest('prompts/list', params);
}

export function buildPromptsGetRequest(name, argumentsPayload = {}) {
    return buildJsonRpcRequest('prompts/get', {
        name,
        arguments: argumentsPayload && typeof argumentsPayload === 'object' ? argumentsPayload : {}
    });
}

export function buildToolsCallRequest(name, argumentsPayload = {}) {
    return buildJsonRpcRequest('tools/call', {
        name,
        arguments: argumentsPayload && typeof argumentsPayload === 'object' ? argumentsPayload : {}
    });
}

export function extractResultEnvelope(payload) {
    if (payload && typeof payload === 'object' && payload.result !== undefined) {
        return payload.result;
    }
    return null;
}

export function extractErrorEnvelope(payload) {
    if (payload && typeof payload === 'object' && payload.error) {
        return payload.error;
    }
    return null;
}
