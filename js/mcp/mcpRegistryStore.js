const STORAGE_KEY = 'infinpilot-mcp-servers';
const extensionApi = globalThis.browser || globalThis.chrome;

function sanitizeHeaders(headers) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        return {};
    }
    const sanitized = {};
    for (const [key, value] of Object.entries(headers)) {
        const normalizedKey = String(key || '').trim();
        const normalizedValue = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
        if (!normalizedKey || !normalizedValue) {
            continue;
        }
        sanitized[normalizedKey] = normalizedValue;
    }
    return sanitized;
}

function generateServerId() {
    return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeServerConfig(serverConfig = {}) {
    const now = Date.now();
    const transport = String(serverConfig.transport || 'streamable-http').trim().toLowerCase();
    return {
        id: typeof serverConfig.id === 'string' && serverConfig.id.trim() ? serverConfig.id.trim() : generateServerId(),
        name: typeof serverConfig.name === 'string' && serverConfig.name.trim() ? serverConfig.name.trim() : 'MCP Server',
        transport: transport === 'sse' ? 'sse' : 'streamable-http',
        url: typeof serverConfig.url === 'string' ? serverConfig.url.trim() : '',
        messageUrl: typeof serverConfig.messageUrl === 'string' ? serverConfig.messageUrl.trim() : '',
        headers: sanitizeHeaders(serverConfig.headers),
        authType: typeof serverConfig.authType === 'string' ? serverConfig.authType.trim() : 'none',
        authHeaderName: typeof serverConfig.authHeaderName === 'string' && serverConfig.authHeaderName.trim()
            ? serverConfig.authHeaderName.trim()
            : 'Authorization',
        authToken: typeof serverConfig.authToken === 'string' ? serverConfig.authToken : '',
        enabled: serverConfig.enabled !== false,
        createdAt: Number.isFinite(serverConfig.createdAt) ? serverConfig.createdAt : now,
        updatedAt: Number.isFinite(serverConfig.updatedAt) ? serverConfig.updatedAt : now
    };
}

export async function listServers() {
    const result = await extensionApi.storage.local.get(STORAGE_KEY);
    const servers = Array.isArray(result?.[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
    return servers.map((server) => normalizeServerConfig(server)).sort((left, right) => {
        return (left.createdAt || 0) - (right.createdAt || 0);
    });
}

export async function getServer(serverId) {
    const servers = await listServers();
    return servers.find((server) => server.id === serverId) || null;
}

export async function upsertServer(serverConfig) {
    const normalized = normalizeServerConfig(serverConfig);
    const servers = await listServers();
    const index = servers.findIndex((server) => server.id === normalized.id);
    if (index >= 0) {
        normalized.createdAt = servers[index].createdAt || normalized.createdAt;
        servers[index] = normalized;
    } else {
        servers.push(normalized);
    }
    await extensionApi.storage.local.set({ [STORAGE_KEY]: servers });
    return normalized;
}

export async function removeServer(serverId) {
    const servers = await listServers();
    const nextServers = servers.filter((server) => server.id !== serverId);
    await extensionApi.storage.local.set({ [STORAGE_KEY]: nextServers });
    return { success: true, removed: nextServers.length !== servers.length };
}

export { STORAGE_KEY as MCP_SERVER_STORAGE_KEY };
