import { listServers, getServer, normalizeServerConfig, upsertServer as saveServer, removeServer as deleteServer } from './mcpRegistryStore.js';
import { StreamableHttpClient } from './transports/streamableHttpClient.js';
import { LegacySseClient } from './transports/sseClient.js';
import { encodeMcpToolName, toAnthropicTool } from './mcpToolAdapter.js';

const runtimeApi = globalThis.browser || globalThis.chrome;
const MAX_CURSOR_PAGES = 20;

function getNextCursor(result) {
    return result?.nextCursor || result?.cursor || null;
}

class McpManager {
    constructor() {
        this.clients = new Map();
        this.serverState = new Map();
        this.toolIndex = new Map();
        this.serverCatalog = new Map();
        this.toolCatalogCache = [];
    }

    getClientInfo() {
        const manifest = typeof runtimeApi.runtime?.getManifest === 'function' ? runtimeApi.runtime.getManifest() : {};
        return {
            name: 'InfinPilot',
            version: manifest.version || '0.0.0'
        };
    }

    getServerState(serverId) {
        return this.serverState.get(serverId) || {
            connected: false,
            lastError: '',
            toolCount: 0,
            resourceCount: 0,
            promptCount: 0,
            lastSyncedAt: null
        };
    }

    setServerState(serverId, partialState) {
        this.serverState.set(serverId, {
            ...this.getServerState(serverId),
            ...partialState
        });
    }

    clearServerIndexes(serverId) {
        for (const [toolName, metadata] of this.toolIndex.entries()) {
            if (metadata.serverId === serverId) {
                this.toolIndex.delete(toolName);
            }
        }
    }

    async disconnectServer(serverId) {
        const client = this.clients.get(serverId);
        if (client && typeof client.close === 'function') {
            try {
                await client.close();
            } catch (_) {
                // Ignore close failures.
            }
        }
        this.clients.delete(serverId);
        this.clearServerIndexes(serverId);
        this.serverCatalog.delete(serverId);
        this.toolCatalogCache = this.toolCatalogCache.filter((tool) => tool?.meta?.serverId !== serverId);
    }

    createClient(serverConfig) {
        const clientInfo = this.getClientInfo();
        if (serverConfig.transport === 'sse') {
            return new LegacySseClient(serverConfig, { clientInfo });
        }
        return new StreamableHttpClient(serverConfig, { clientInfo });
    }

    async getOrCreateClient(serverConfig) {
        const existing = this.clients.get(serverConfig.id);
        if (existing) {
            return existing;
        }
        const client = this.createClient(serverConfig);
        this.clients.set(serverConfig.id, client);
        return client;
    }

    async collectCursorPages(fetchPage, itemKey) {
        const items = [];
        let cursor = undefined;
        let pageCount = 0;
        do {
            const result = await fetchPage(cursor);
            if (Array.isArray(result?.[itemKey])) {
                items.push(...result[itemKey]);
            }
            cursor = getNextCursor(result) || undefined;
            pageCount += 1;
        } while (cursor && pageCount < MAX_CURSOR_PAGES);
        return items;
    }

    indexServerTools(serverConfig, tools) {
        this.clearServerIndexes(serverConfig.id);
        for (const tool of tools) {
            const encodedName = encodeMcpToolName(serverConfig, tool);
            this.toolIndex.set(encodedName, {
                serverId: serverConfig.id,
                serverName: serverConfig.name,
                transport: serverConfig.transport,
                originalToolName: tool.name
            });
        }
    }

    decorateResource(serverConfig, resource) {
        return {
            ...resource,
            serverId: serverConfig.id,
            serverName: serverConfig.name,
            transport: serverConfig.transport
        };
    }

    decoratePrompt(serverConfig, prompt) {
        return {
            ...prompt,
            serverId: serverConfig.id,
            serverName: serverConfig.name,
            transport: serverConfig.transport
        };
    }

    async syncServerCatalog(serverConfig, options = {}) {
        const refresh = options.refresh === true;
        const cached = this.serverCatalog.get(serverConfig.id);
        if (!refresh && cached) {
            this.indexServerTools(serverConfig, cached.rawTools || []);
            return cached;
        }

        const client = await this.getOrCreateClient(serverConfig);
        try {
            await client.initialize();
            const rawTools = await this.collectCursorPages((cursor) => client.listTools(cursor), 'tools');
            const rawResources = typeof client.listResources === 'function'
                ? await this.collectCursorPages((cursor) => client.listResources(cursor), 'resources')
                : [];
            const rawPrompts = typeof client.listPrompts === 'function'
                ? await this.collectCursorPages((cursor) => client.listPrompts(cursor), 'prompts')
                : [];

            const tools = rawTools.map((tool) => toAnthropicTool(serverConfig, tool));
            const resources = rawResources.map((resource) => this.decorateResource(serverConfig, resource));
            const prompts = rawPrompts.map((prompt) => this.decoratePrompt(serverConfig, prompt));

            this.indexServerTools(serverConfig, rawTools);
            const catalogEntry = {
                tools,
                resources,
                prompts,
                rawTools,
                lastSyncedAt: Date.now()
            };
            this.serverCatalog.set(serverConfig.id, catalogEntry);
            this.setServerState(serverConfig.id, {
                connected: true,
                lastError: '',
                toolCount: tools.length,
                resourceCount: resources.length,
                promptCount: prompts.length,
                lastSyncedAt: catalogEntry.lastSyncedAt
            });
            return catalogEntry;
        } catch (error) {
            this.setServerState(serverConfig.id, {
                connected: false,
                lastError: error.message || String(error),
                toolCount: 0,
                resourceCount: 0,
                promptCount: 0,
                lastSyncedAt: Date.now()
            });
            await this.disconnectServer(serverConfig.id);
            return {
                tools: [],
                resources: [],
                prompts: [],
                rawTools: [],
                lastSyncedAt: Date.now()
            };
        }
    }

    async testServer(configOrId) {
        const serverConfig = typeof configOrId === 'string'
            ? await getServer(configOrId)
            : normalizeServerConfig(configOrId || {});
        if (!serverConfig) {
            throw new Error('MCP server not found');
        }
        const client = this.createClient(serverConfig);
        try {
            await client.initialize();
            const tools = await this.collectCursorPages((cursor) => client.listTools(cursor), 'tools');
            const resources = typeof client.listResources === 'function'
                ? await this.collectCursorPages((cursor) => client.listResources(cursor), 'resources')
                : [];
            const prompts = typeof client.listPrompts === 'function'
                ? await this.collectCursorPages((cursor) => client.listPrompts(cursor), 'prompts')
                : [];
            return {
                success: true,
                serverId: serverConfig.id,
                transport: serverConfig.transport,
                toolCount: tools.length,
                resourceCount: resources.length,
                promptCount: prompts.length
            };
        } finally {
            if (typeof client.close === 'function') {
                await client.close();
            }
        }
    }

    async listServers() {
        const servers = await listServers();
        return servers.map((server) => {
            const state = this.getServerState(server.id);
            return {
                ...server,
                connected: state.connected === true,
                lastError: state.lastError || '',
                toolCount: Number.isFinite(state.toolCount) ? state.toolCount : 0,
                resourceCount: Number.isFinite(state.resourceCount) ? state.resourceCount : 0,
                promptCount: Number.isFinite(state.promptCount) ? state.promptCount : 0,
                lastSyncedAt: state.lastSyncedAt || null
            };
        });
    }

    async upsertServer(serverConfig) {
        const saved = await saveServer(serverConfig);
        await this.disconnectServer(saved.id);
        this.toolCatalogCache = [];
        return saved;
    }

    async removeServer(serverId) {
        await this.disconnectServer(serverId);
        this.serverState.delete(serverId);
        this.toolCatalogCache = [];
        return deleteServer(serverId);
    }

    async getEnabledServers(serverId = null) {
        if (serverId) {
            const server = await getServer(serverId);
            return server && server.enabled !== false && server.url ? [server] : [];
        }
        return (await listServers()).filter((server) => server.enabled !== false && server.url);
    }

    async getToolCatalog(options = {}) {
        const refresh = options.refresh === true;
        const servers = await this.getEnabledServers();
        if (servers.length === 0) {
            this.toolCatalogCache = [];
            this.toolIndex.clear();
            return [];
        }
        if (!refresh && this.toolCatalogCache.length > 0) {
            return this.toolCatalogCache;
        }

        this.toolIndex.clear();
        const toolCatalog = [];
        for (const server of servers) {
            const catalog = await this.syncServerCatalog(server, { refresh });
            toolCatalog.push(...catalog.tools);
        }
        this.toolCatalogCache = toolCatalog;
        return toolCatalog;
    }

    async listResources(options = {}) {
        const refresh = options.refresh === true;
        const servers = await this.getEnabledServers(options.serverId || null);
        const resources = [];
        for (const server of servers) {
            const catalog = await this.syncServerCatalog(server, { refresh });
            resources.push(...catalog.resources);
        }
        return resources;
    }

    async readResource(serverId, uri) {
        if (!serverId) {
            throw new Error('MCP resource read requires serverId');
        }
        if (!uri) {
            throw new Error('MCP resource read requires uri');
        }
        const serverConfig = await getServer(serverId);
        if (!serverConfig) {
            throw new Error(`MCP server not found: ${serverId}`);
        }
        const client = await this.getOrCreateClient(serverConfig);
        try {
            await client.initialize();
            const result = await client.readResource(uri);
            this.setServerState(serverConfig.id, {
                connected: true,
                lastError: '',
                lastSyncedAt: Date.now()
            });
            return {
                success: true,
                serverId: serverConfig.id,
                serverName: serverConfig.name,
                transport: serverConfig.transport,
                uri,
                result
            };
        } catch (error) {
            this.setServerState(serverConfig.id, {
                connected: false,
                lastError: error.message || String(error),
                lastSyncedAt: Date.now()
            });
            throw error;
        }
    }

    async listPrompts(options = {}) {
        const refresh = options.refresh === true;
        const servers = await this.getEnabledServers(options.serverId || null);
        const prompts = [];
        for (const server of servers) {
            const catalog = await this.syncServerCatalog(server, { refresh });
            prompts.push(...catalog.prompts);
        }
        return prompts;
    }

    async getPrompt(serverId, name, argumentsPayload = {}) {
        if (!serverId) {
            throw new Error('MCP prompt lookup requires serverId');
        }
        if (!name) {
            throw new Error('MCP prompt lookup requires name');
        }
        const serverConfig = await getServer(serverId);
        if (!serverConfig) {
            throw new Error(`MCP server not found: ${serverId}`);
        }
        const client = await this.getOrCreateClient(serverConfig);
        try {
            await client.initialize();
            const result = await client.getPrompt(name, argumentsPayload);
            this.setServerState(serverConfig.id, {
                connected: true,
                lastError: '',
                lastSyncedAt: Date.now()
            });
            return {
                success: true,
                serverId: serverConfig.id,
                serverName: serverConfig.name,
                transport: serverConfig.transport,
                name,
                result
            };
        } catch (error) {
            this.setServerState(serverConfig.id, {
                connected: false,
                lastError: error.message || String(error),
                lastSyncedAt: Date.now()
            });
            throw error;
        }
    }

    async callTool(encodedToolName, args = {}) {
        const metadata = this.toolIndex.get(encodedToolName);
        if (!metadata) {
            await this.getToolCatalog({ refresh: true });
        }
        const resolved = this.toolIndex.get(encodedToolName);
        if (!resolved) {
            throw new Error(`Unknown MCP tool: ${encodedToolName}`);
        }
        const serverConfig = await getServer(resolved.serverId);
        if (!serverConfig) {
            throw new Error(`MCP server not found: ${resolved.serverId}`);
        }
        const client = await this.getOrCreateClient(serverConfig);
        try {
            const result = await client.callTool(resolved.originalToolName, args);
            this.setServerState(serverConfig.id, {
                connected: true,
                lastError: '',
                lastSyncedAt: Date.now()
            });
            return {
                success: true,
                serverId: serverConfig.id,
                serverName: serverConfig.name,
                toolName: resolved.originalToolName,
                transport: serverConfig.transport,
                result
            };
        } catch (error) {
            this.setServerState(serverConfig.id, {
                connected: false,
                lastError: error.message || String(error),
                lastSyncedAt: Date.now()
            });
            throw error;
        }
    }

    async getState() {
        const servers = await this.listServers();
        return {
            servers,
            toolCount: servers.reduce((sum, server) => sum + (server.toolCount || 0), 0),
            resourceCount: servers.reduce((sum, server) => sum + (server.resourceCount || 0), 0),
            promptCount: servers.reduce((sum, server) => sum + (server.promptCount || 0), 0)
        };
    }
}

const mcpManager = new McpManager();

export default mcpManager;
