function sanitizeNamePart(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24) || 'server';
}

export function encodeMcpToolName(serverConfig, tool) {
    const serverPart = sanitizeNamePart(serverConfig?.name || serverConfig?.id || 'server');
    const serverIdPart = sanitizeNamePart(String(serverConfig?.id || '').slice(-8) || 'server');
    const toolPart = sanitizeNamePart(tool?.name || 'tool');
    return `mcp__${serverPart}_${serverIdPart}__${toolPart}`;
}

export function toAnthropicTool(serverConfig, tool) {
    const encodedName = encodeMcpToolName(serverConfig, tool);
    return {
        name: encodedName,
        description: tool.description || `${serverConfig.name} · ${tool.name}`,
        input_schema: tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} },
        meta: {
            source: 'mcp',
            serverId: serverConfig.id,
            serverName: serverConfig.name,
            transport: serverConfig.transport,
            originalToolName: tool.name
        }
    };
}
