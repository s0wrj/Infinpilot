/**
 * Infinpilot - Chat Core Logic
 */
import { generateUniqueId } from './utils.js';
import { tr as _ } from './utils/i18n.js';
import { augmentQuery } from './ragManager.js';
import { researchMainAgentPrompt } from './automation/researchPrompts.js';
import { runtimeFetch } from './utils/runtimeFetch.js';
import projectService from './projectService.js';
import CollectiveResearchEngine from './automation/collectiveResearchEngine.js';
import { getDefaultCollectiveRoles } from './automation/agentRoleLibrary.js';

// Let's assume historyManager is available on the window object
const historyManager = window.historyManager;

// 使用 utils/i18n.js 提供的 tr 作为翻译函数

console.log('[Chat] chat.js loaded successfully');

async function getCurrentProjectPromptContext() {
    try {
        return await projectService.buildPromptContext();
    } catch (error) {
        console.warn('[Chat] Failed to build project prompt context:', error);
        return '';
    }
}

function shortenHistoryTitle(text, maxLength = 48) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '';
    }
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function buildModeHistoryTitle(mode, topic = '') {
    const labels = {
        automation: '浏览器自动化',
        'deep-research': '深度研究',
        'collective-research': '群体研究'
    };
    const prefix = labels[mode] || '对话记录';
    const suffix = shortenHistoryTitle(topic, 44);
    return suffix ? `${prefix}：${suffix}` : prefix;
}

async function getCurrentTabUrlsSnapshot() {
    try {
        const tabs = await browser.tabs.query({});
        return tabs.map((tab) => tab.url).filter(Boolean);
    } catch (error) {
        console.warn('[Chat] Failed to snapshot tab URLs for history:', error);
        return [];
    }
}

function buildAutomationToolResultsForHistory(trace = null) {
    if (!Array.isArray(trace?.toolCalls)) {
        return [];
    }
    return trace.toolCalls.map((call) => ({
        tool_call: {
            name: call.toolName || 'unknown_tool',
            args: call.toolInput || {}
        },
        result: call.toolResult?.error ? null : (call.toolResult ?? null),
        error: call.toolResult?.error || null
    }));
}

async function saveAutomationHistorySession({
    userMessage = '',
    finalText = '',
    trace = null,
    mode = 'automation',
    status = 'success'
} = {}) {
    if (!historyManager) {
        return null;
    }

    const normalizedText = String(finalText || '').trim()
        || (status === 'failed' ? '自动化执行失败' : status === 'stopped' ? '自动化任务已停止' : '自动化任务已完成');
    const session = {
        type: mode,
        title: buildModeHistoryTitle(mode, userMessage),
        tabUrls: await getCurrentTabUrlsSnapshot(),
        messages: [
            {
                id: generateUniqueId(),
                role: 'user',
                parts: [{ text: userMessage }],
                originalUserText: userMessage
            },
            {
                id: generateUniqueId(),
                role: 'model',
                parts: [{ text: normalizedText }],
                tool_results: buildAutomationToolResultsForHistory(trace)
            }
        ],
        data: mode === 'deep-research'
            ? {
                id: `deep-research-${Date.now()}`,
                topic: userMessage,
                plan: null,
                steps: Array.isArray(trace?.toolCalls)
                    ? trace.toolCalls.map((call, index) => ({
                        title: call.toolName || `步骤 ${index + 1}`,
                        description: shortenHistoryTitle(JSON.stringify(call.toolInput || {}), 120) || '执行研究步骤',
                        execution_res: typeof call.toolResult === 'string'
                            ? call.toolResult
                            : JSON.stringify(call.toolResult || {}, null, 2)
                    }))
                    : [],
                report: normalizedText,
                status: status === 'success' ? 'done' : (status === 'failed' ? 'error' : 'stopped')
            }
            : {
                status,
                trace
            }
    };

    return historyManager.upsertSession(session);
}

async function saveCollectiveHistorySession({
    topic = '',
    result = null
} = {}) {
    if (!historyManager || !result?.snapshot) {
        return null;
    }

    const session = {
        type: 'collective-research',
        title: buildModeHistoryTitle('collective-research', topic || result.topic),
        tabUrls: await getCurrentTabUrlsSnapshot(),
        messages: [],
        data: {
            topic: topic || result.topic || '群体研究',
            snapshot: result.snapshot,
            finalReport: result.finalReport || '',
            roundsCompleted: result.roundsCompleted || result.snapshot?.currentRound || 0,
            status: result.snapshot?.status || 'stopped'
        }
    };

    return historyManager.upsertSession(session);
}

function ensureCollectiveProjectCaptureKeys() {
    window.CollectiveResearch = window.CollectiveResearch || {};
    if (!(window.CollectiveResearch.projectCaptureKeys instanceof Set)) {
        window.CollectiveResearch.projectCaptureKeys = new Set();
    }
    return window.CollectiveResearch.projectCaptureKeys;
}

function stringifyProjectContentForCapture(value) {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (value == null) {
        return '';
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch (_error) {
        return String(value);
    }
}

function buildCollectiveProjectCaptureItems(toolName, result, agentName = '', agentIndex = null) {
    if (!toolName || !result || result.error) {
        return [];
    }

    const topic = window.CollectiveResearch?.engine?.getSnapshot?.().topic
        || window.CollectiveResearch?.lastResult?.topic
        || '';
    const baseMeta = {
        capturedBy: 'collective_research',
        agentName: agentName || '',
        agentIndex: Number.isFinite(agentIndex) ? agentIndex : null,
        toolName,
        topic,
        capturedAt: new Date().toISOString()
    };
    const url = result.url || result.finalUrl || result.sourceUrl || '';
    const title = result.title || result.name || url || `${agentName || '研究员'} 资料`;

    if (toolName === 'scraping_extract_structured') {
        const data = result.data ?? result.result ?? result.content;
        if (data == null) {
            return [];
        }
        return [{
            type: 'page_extract',
            title: `${result.pattern || 'structured'}：${title}`,
            sourceUrl: url,
            content: data,
            meta: {
                ...baseMeta,
                pattern: result.pattern || ''
            }
        }];
    }

    if (toolName === 'scraping_get_links') {
        const links = Array.isArray(result.links) ? result.links : (Array.isArray(result.items) ? result.items : []);
        if (links.length === 0) {
            return [];
        }
        return [{
            type: 'page_extract',
            title: `链接集：${title}`,
            sourceUrl: url,
            content: links,
            meta: {
                ...baseMeta,
                pattern: 'links',
                count: links.length
            }
        }];
    }

    if (toolName === 'scraping_get_images') {
        const images = Array.isArray(result.images) ? result.images : (Array.isArray(result.items) ? result.items : []);
        if (images.length === 0) {
            return [];
        }
        return [{
            type: 'page_extract',
            title: `图片集：${title}`,
            sourceUrl: url,
            content: images,
            meta: {
                ...baseMeta,
                pattern: 'images',
                count: images.length
            }
        }];
    }

    if (['scraping_get', 'scraping_current_page', 'jina_ai_get_content', 'browser_get_visible_text'].includes(toolName)) {
        const content = stringifyProjectContentForCapture(
            result.content || result.markdown || result.text || result.data || result.result
        );
        if (!content) {
            return [];
        }
        return [{
            type: 'page_snapshot',
            title,
            sourceUrl: url,
            content,
            meta: {
                ...baseMeta,
                contentLength: content.length
            }
        }];
    }

    return [];
}

async function persistCollectiveToolResultToProject(toolName, result, agentName = '', agentIndex = null) {
    if (!toolName || !result || result.error || toolName === 'browser_project') {
        return;
    }

    const projectId = await projectService.getCurrentProjectId();
    if (!projectId) {
        return;
    }

    const items = buildCollectiveProjectCaptureItems(toolName, result, agentName, agentIndex);
    if (items.length === 0) {
        return;
    }

    const captureKeys = ensureCollectiveProjectCaptureKeys();
    let didPersist = false;
    for (const item of items) {
        const dedupeKey = [
            projectId,
            item.type,
            item.title,
            item.sourceUrl || '',
            item.meta?.agentName || '',
            item.meta?.toolName || ''
        ].join('::');
        if (captureKeys.has(dedupeKey)) {
            continue;
        }
        captureKeys.add(dedupeKey);
        await projectService.addProjectItem({
            projectId,
            ...item
        });
        didPersist = true;
    }

    if (didPersist) {
        document.dispatchEvent(new CustomEvent('infinpilot:projects-updated'));
    }
}

/**
 * 格式化工具结果，提取关键信息
 */
function formatToolResult(toolName, result) {
    if (!result) return '';

    // 如果只是简单的成功消息，直接显示
    if (result.success && result.message) {
        return result.message;
    }

    // 如果是错误
    if (result.error) {
        return `错误: ${result.error}`;
    }

    // 根据工具类型提取关键信息
    switch (toolName) {
        case 'browser_navigate':
        case 'browser_open_url':
            return result.tabId ? `已打开新标签页 (ID: ${result.tabId})` : '已打开新标签页';

        case 'browser_get_current_tab':
            return result.url ? `当前页面: ${result.title || result.url}` : '获取当前标签页失败';

        case 'browser_list_tabs':
            if (result.tabs && result.count !== undefined) {
                return `共 ${result.count} 个标签页`;
            }
            break;

        case 'browser_switch_tab':
            return result.message || '已切换标签页';

        case 'browser_close_tab':
            return result.message || '已关闭标签页';

        case 'browser_reload_tab':
            return result.message || '已刷新标签页';

        case 'browser_bookmarks':
            if (Array.isArray(result.items) && result.count !== undefined) {
                return `返回 ${result.count} 个书签项`;
            }
            if (Array.isArray(result.tabIds)) {
                return `已打开 ${result.tabIds.length} 个书签链接`;
            }
            return result.message || '已处理书签操作';

        case 'browser_history':
            if (Array.isArray(result.items) && result.count !== undefined) {
                return `返回 ${result.count} 条历史记录`;
            }
            return result.message || '已处理历史记录操作';

        case 'browser_windows':
            if (Array.isArray(result.windows) && result.count !== undefined) {
                return `返回 ${result.count} 个窗口`;
            }
            return result.message || '已处理窗口操作';

        case 'browser_downloads':
            if (Array.isArray(result.items) && result.count !== undefined) {
                return `返回 ${result.count} 条下载记录`;
            }
            return result.message || '已处理下载操作';

        case 'browser_project':
            return result.message || '已处理项目操作';

        case 'browser_mcp':
            if (Array.isArray(result.items) && result.count !== undefined) {
                return `返回 ${result.count} 条 MCP 数据`;
            }
            if (Array.isArray(result.tools) && result.count !== undefined) {
                return `返回 ${result.count} 个 MCP 工具`;
            }
            return result.message || '已处理 MCP 操作';

        case 'browser_get_visible_text':
            if (result.text) {
                const preview = result.text.substring(0, 200);
                return result.text.length > 200 ? `${preview}...` : preview;
            }
            break;

        case 'browser_get_dom':
            if (result.content) {
                const preview = result.content.substring(0, 200);
                return result.content.length > 200 ? `${preview}...` : preview;
            }
            break;

        case 'browser_click':
            return result.message || (result.success ? '已点击元素' : '点击失败');

        case 'browser_fill_input':
            return result.message || (result.success ? '已填写输入框' : '填写失败');

        case 'browser_scroll':
            return result.message || '已滚动页面';

        case 'browser_screenshot':
            return result.success ? '截图成功' : '截图失败';
    }

    // 默认：如果是对象，转换为简短字符串
    return JSON.stringify(result).substring(0, 100);
}

/**
 * 工具调用 UI 展示函数
 */
function createToolCallUI(toolName, toolInput, result, container) {
    const toolCallDiv = document.createElement('div');
    toolCallDiv.className = 'tool-call-container';

    // 单行显示：工具名 + 结果 + 展开按钮
    const lineDiv = document.createElement('div');
    lineDiv.className = 'tool-call-line';

    // 工具名称
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tool-call-name';
    nameSpan.textContent = toolName;
    lineDiv.appendChild(nameSpan);

    // 结果摘要
    if (result) {
        const resultSpan = document.createElement('span');
        resultSpan.className = 'tool-call-result';

        if (result.success) {
            resultSpan.textContent = '✓ ' + formatToolResult(toolName, result);
        } else if (result.error) {
            resultSpan.textContent = '✕ ' + result.error;
        } else {
            resultSpan.textContent = '...';
        }
        lineDiv.appendChild(resultSpan);
    }

    // 展开/收起按钮
    const expandBtn = document.createElement('button');
    expandBtn.className = 'tool-expand-btn';
    expandBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>';
    expandBtn.title = '展开详情';

    // 详情区域（默认隐藏）
    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'tool-call-details';
    detailsDiv.style.display = 'none';
    detailsDiv.innerHTML = '<pre>' + escapeHtml(JSON.stringify({ input: toolInput, result: result }, null, 2)) + '</pre>';

    // 点击展开/收起
    let isExpanded = false;
    expandBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        isExpanded = !isExpanded;
        detailsDiv.style.display = isExpanded ? 'block' : 'none';
        expandBtn.innerHTML = isExpanded
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>';
        expandBtn.title = isExpanded ? '收起详情' : '展开详情';
    });

    // 点击整行也可以展开
    lineDiv.style.cursor = 'pointer';
    lineDiv.addEventListener('click', function(e) {
        expandBtn.click();
    });

    lineDiv.appendChild(expandBtn);
    toolCallDiv.appendChild(lineDiv);
    toolCallDiv.appendChild(detailsDiv);

    container.appendChild(toolCallDiv);
    return toolCallDiv;
}

/**
 * 显示当前任务目标 UI
 * @param {HTMLElement} container - 容器元素
 * @param {Array} todoList - 目标列表 [{id, text, status: 'pending'|'completed'|'current'|'failed'}]
 * @param {string} currentToolStatus - 当前工具执行状态
 */
function showTodoList(container, todoList, currentToolStatus) {
    // 清除旧的进度显示
    const existingProgress = container.querySelector('.task-todo-list');
    if (existingProgress) {
        existingProgress.remove();
    }

    const todoDiv = document.createElement('div');
    todoDiv.className = 'task-todo-list';

    // 找到当前正在进行的任务
    const currentTodo = todoList.find(t => t.status === 'current');
    if (!currentTodo) return;

    // 显示当前目标
    const itemDiv = document.createElement('div');
    itemDiv.className = 'todo-item current';

    // 目标文本
    const textSpan = document.createElement('span');
    textSpan.className = 'todo-purpose';
    textSpan.textContent = currentTodo.text;

    itemDiv.appendChild(textSpan);

    // 显示当前工具调用
    if (currentToolStatus) {
        const toolStatusSpan = document.createElement('span');
        toolStatusSpan.className = 'todo-tool-status';
        toolStatusSpan.textContent = `→ ${currentToolStatus}`;
        itemDiv.appendChild(toolStatusSpan);
    }

    todoDiv.appendChild(itemDiv);

    // 添加停止和挂起按钮
    if (taskStatus === 'running') {
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'todo-buttons';

        // 暂停按钮
        const suspendBtn = document.createElement('button');
        suspendBtn.className = 'todo-btn suspend';
        suspendBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> 暂停';
        suspendBtn.onclick = function() {
            if (window.__suspendAutomationTask) {
                window.__suspendAutomationTask();
            }
        };

        // 停止按钮
        const stopBtn = document.createElement('button');
        stopBtn.className = 'todo-btn stop';
        stopBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12"></rect></svg> 停止';
        stopBtn.onclick = function() {
            if (window.__stopAutomationTask) {
                window.__stopAutomationTask();
            }
        };

        buttonContainer.appendChild(suspendBtn);
        buttonContainer.appendChild(stopBtn);
        todoDiv.appendChild(buttonContainer);
    }

    container.appendChild(todoDiv);
    return todoDiv;
}

// 鍏ㄥ眬鍙橀噺瀛樺偍褰撳墠鐩殑鍒楄〃
let globalTodoList = [];
let globalCurrentPurposeIndex = 0;

// 任务状态全局变量
let taskStatus = 'idle'; // idle, running, suspended, stopped, completed
let suspendedUserMessage = ''; // 挂起时用户输入的消息
let currentTaskId = null; // 当前运行的任务 ID，用于防止双任务同时执行
let activeAutomationTrace = null;
let lastSuccessfulAutomationTrace = null;

function cloneTraceValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function beginAutomationTrace(userMessage, meta = {}) {
    activeAutomationTrace = {
        id: generateUniqueId(),
        userMessage: typeof userMessage === 'string' ? userMessage : '',
        startedAt: Date.now(),
        completedAt: null,
        status: 'running',
        meta: cloneTraceValue(meta),
        toolCalls: []
    };
    window.InfinPilotActiveAutomationTrace = cloneTraceValue(activeAutomationTrace);
}

function recordAutomationTraceStep(toolName, toolInput, toolResult, executionContext = null) {
    if (!activeAutomationTrace) {
        return;
    }

    const success = Boolean(toolResult && !toolResult.error && toolResult.success !== false);
    activeAutomationTrace.toolCalls.push({
        id: generateUniqueId(),
        toolName,
        toolInput: cloneTraceValue(toolInput || {}),
        toolResult: cloneTraceValue(toolResult || {}),
        success,
        executionContext: executionContext ? cloneTraceValue({
            executionId: executionContext.executionId || '',
            agentName: executionContext.agentName || '',
            currentTabId: executionContext.currentTabId || null
        }) : null,
        timestamp: Date.now()
    });
    window.InfinPilotActiveAutomationTrace = cloneTraceValue(activeAutomationTrace);
}

function finalizeAutomationTrace(status, meta = {}) {
    if (!activeAutomationTrace) {
        return null;
    }

    activeAutomationTrace.status = status;
    activeAutomationTrace.completedAt = Date.now();
    activeAutomationTrace.meta = {
        ...(activeAutomationTrace.meta || {}),
        ...cloneTraceValue(meta)
    };

    const snapshot = cloneTraceValue(activeAutomationTrace);
    if (status === 'success') {
        lastSuccessfulAutomationTrace = snapshot;
        window.InfinPilotLastSuccessfulAutomationTrace = snapshot;
    }

    window.InfinPilotActiveAutomationTrace = null;
    activeAutomationTrace = null;
    return snapshot;
}

/**
 * Tool definitions for browser automation - 浼樺寲鐗堟湰
 */
const browserTools = [
    {
        name: "browser_navigate",
        description: "导航到指定 URL",
        input_schema: {
            type: "object",
            properties: {
                url: { type: "string", description: "目标 URL" }
            },
            required: ["url"]
        }
    },
    {
        name: "browser_get_current_tab",
        description: "获取当前活动标签页信息",
        input_schema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "browser_list_tabs",
        description: "列出所有浏览器标签页",
        input_schema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "browser_switch_tab",
        description: "切换到指定标签页",
        input_schema: {
            type: "object",
            properties: {
                tabId: { type: "number", description: "目标标签页 ID" }
            },
            required: ["tabId"]
        }
    },
    {
        name: "browser_open_url",
        description: "在新标签页打开 URL",
        input_schema: {
            type: "object",
            properties: {
                url: { type: "string", description: "要打开的 URL" },
                active: { type: "boolean", description: "是否激活新标签页", default: true }
            },
            required: ["url"]
        }
    },
    {
        name: "browser_close_tab",
        description: "关闭指定标签页或当前标签页",
        input_schema: {
            type: "object",
            properties: {
                tabId: { type: "number", description: "要关闭的标签页 ID，不填则关闭当前标签页" }
            }
        }
    },
    {
        name: "browser_reload_tab",
        description: "刷新指定标签页或当前标签页",
        input_schema: {
            type: "object",
            properties: {
                tabId: { type: "number", description: "要刷新的标签页 ID，可选" },
                bypassCache: { type: "boolean", description: "是否绕过缓存", default: false }
            }
        }
    },
    {
        name: "browser_bookmarks",
        description: "操作浏览器书签/收藏夹，可列出根目录、查看收藏夹内容、搜索书签，以及打开单个书签或整个收藏夹中的链接。",
        input_schema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description: "操作类型，例如 list_roots、list_children、search、get_path、open_bookmark、open_folder"
                },
                folderId: { type: "string", description: "收藏夹 ID，list_children 或 open_folder 时优先使用" },
                bookmarkId: { type: "string", description: "书签 ID，get_path 或 open_bookmark 时优先使用" },
                parentId: { type: "string", description: "限定父收藏夹 ID，用于 search 或 open_bookmark 缩小范围" },
                title: { type: "string", description: "按标题匹配书签或收藏夹，可配合 path / parentId 使用" },
                query: { type: "string", description: "按标题、URL 或路径模糊搜索书签或收藏夹" },
                path: { type: "string", description: "书签路径，例如 书签工具栏/工作/文档" },
                recursive: { type: "boolean", description: "list_children 或 open_folder 时是否递归遍历子收藏夹", default: false },
                includeFolders: { type: "boolean", description: "search 时是否包含收藏夹结果", default: true },
                limit: { type: "number", description: "返回或打开的最大条数，默认 20" },
                active: { type: "boolean", description: "打开书签时是否激活前台标签页，默认 true", default: true }
            },
            required: ["action"]
        }
    },
    {
        name: "browser_history",
        description: "操作浏览器历史记录，可搜索、列出最近访问、打开历史记录里的链接，以及删除指定历史 URL。",
        input_schema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description: "操作类型，例如 search、list_recent、open_entry、delete_url"
                },
                query: { type: "string", description: "搜索关键字，可匹配标题和 URL" },
                url: { type: "string", description: "精确 URL，用于 open_entry 或 delete_url" },
                title: { type: "string", description: "按标题匹配历史记录，可配合 open_entry 使用" },
                startTime: { type: "number", description: "搜索起始时间戳（毫秒）" },
                endTime: { type: "number", description: "搜索结束时间戳（毫秒）" },
                maxResults: { type: "number", description: "返回条数，默认 10" },
                active: { type: "boolean", description: "打开历史链接时是否切到前台，默认 true", default: true }
            },
            required: ["action"]
        }
    },
    {
        name: "browser_windows",
        description: "操作浏览器窗口，可列出窗口、聚焦窗口、新建窗口、关闭窗口以及移动标签页到其他窗口。",
        input_schema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description: "操作类型，例如 list、focus_window、open_window、close_window、move_tab_to_window"
                },
                windowId: { type: "number", description: "目标窗口 ID" },
                tabId: { type: "number", description: "目标标签页 ID，可用于 move_tab_to_window 或 open_window" },
                url: { type: "string", description: "新窗口要打开的 URL" },
                urls: { type: "array", description: "新窗口要打开的多个 URL", items: { type: "string" } },
                focused: { type: "boolean", description: "是否聚焦目标窗口，默认 true", default: true },
                state: { type: "string", description: "窗口状态，例如 normal、maximized、minimized、fullscreen" }
            },
            required: ["action"]
        }
    },
    {
        name: "browser_downloads",
        description: "操作浏览器下载列表，可发起下载、查询下载项、打开文件、在文件夹中显示以及删除下载记录。",
        input_schema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description: "操作类型，例如 download_url、list、search、open、show、erase"
                },
                downloadId: { type: "number", description: "下载项 ID" },
                url: { type: "string", description: "要下载或删除记录的 URL" },
                query: { type: "string", description: "按文件名或 URL 模糊搜索下载记录" },
                filename: { type: "string", description: "下载保存文件名，可选" },
                state: { type: "string", description: "下载状态过滤，例如 in_progress、complete、interrupted" },
                limit: { type: "number", description: "返回条数，默认 10" },
                saveAs: { type: "boolean", description: "是否弹出另存为对话框，默认 false", default: false }
            },
            required: ["action"]
        }
    },
    {
        name: "browser_get_dom",
        description: "获取当前页面的 DOM 内容，支持选择器",
        input_schema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS 选择器，可选；不填则获取整个页面" },
                text: { type: "string", description: "按可见文本或可访问名称匹配元素，可选" },
                labelText: { type: "string", description: "按 label 文本匹配输入控件，可选" },
                placeholder: { type: "string", description: "按 placeholder 匹配元素，可选" },
                ariaLabel: { type: "string", description: "按 aria-label 匹配元素，可选" },
                role: { type: "string", description: "按 ARIA role 匹配元素，可选" },
                name: { type: "string", description: "按 name 属性匹配元素，可选" },
                tagName: { type: "string", description: "限定标签名，可选" },
                index: { type: "number", description: "匹配多个元素时选择第几个，从 0 开始", default: 0 },
                exactText: { type: "boolean", description: "文本匹配是否要求完全相等", default: false },
                partialText: { type: "boolean", description: "文本匹配是否允许包含匹配", default: true },
                visibleOnly: { type: "boolean", description: "是否只匹配可见元素", default: true },
                timeoutMs: { type: "number", description: "等待元素出现的超时时间（毫秒）", default: 1500 },
                frameId: { type: "number", description: "目标 frameId，默认 0（主文档）" },
                outerHTML: { type: "boolean", description: "是否返回 outerHTML，默认返回 innerHTML", default: false },
                maxLength: { type: "number", description: "返回内容最大长度", default: 5000 }
            }
        }
    },
    {
        name: "browser_get_visible_text",
        description: "获取页面可见文本",
        input_schema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS 选择器，可选" },
                text: { type: "string", description: "按可见文本或可访问名称匹配元素，可选" },
                labelText: { type: "string", description: "按 label 文本匹配元素，可选" },
                placeholder: { type: "string", description: "按 placeholder 匹配元素，可选" },
                ariaLabel: { type: "string", description: "按 aria-label 匹配元素，可选" },
                role: { type: "string", description: "按 ARIA role 匹配元素，可选" },
                name: { type: "string", description: "按 name 属性匹配元素，可选" },
                tagName: { type: "string", description: "限定标签名，可选" },
                index: { type: "number", description: "匹配多个元素时选择第几个，从 0 开始", default: 0 },
                exactText: { type: "boolean", description: "文本匹配是否要求完全相等", default: false },
                partialText: { type: "boolean", description: "文本匹配是否允许包含匹配", default: true },
                visibleOnly: { type: "boolean", description: "是否只匹配可见元素", default: true },
                timeoutMs: { type: "number", description: "等待元素出现的超时时间（毫秒）", default: 1500 },
                frameId: { type: "number", description: "目标 frameId，默认 0（主文档）" }
            }
        }
    },
    {
        name: "browser_click",
        description: "点击页面元素，支持 CSS 选择器以及文本、aria-label、placeholder、label 文本等多种定位方式",
        input_schema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS 选择器，可选" },
                text: { type: "string", description: "按可见文本或可访问名称匹配元素，可选" },
                labelText: { type: "string", description: "按 label 文本匹配元素，可选" },
                placeholder: { type: "string", description: "按 placeholder 匹配元素，可选" },
                ariaLabel: { type: "string", description: "按 aria-label 匹配元素，可选" },
                role: { type: "string", description: "按 ARIA role 匹配元素，可选" },
                name: { type: "string", description: "按 name 属性匹配元素，可选" },
                tagName: { type: "string", description: "限定标签名，可选" },
                index: { type: "number", description: "匹配多个元素时选择第几个，从 0 开始", default: 0 },
                exactText: { type: "boolean", description: "文本匹配是否要求完全相等", default: false },
                partialText: { type: "boolean", description: "文本匹配是否允许包含匹配", default: true },
                visibleOnly: { type: "boolean", description: "是否只匹配可见元素", default: true },
                timeoutMs: { type: "number", description: "等待元素出现的超时时间（毫秒）", default: 2000 },
                frameId: { type: "number", description: "目标 frameId，默认 0（主文档）" }
            },
            required: []
        }
    },
    {
        name: "browser_fill_input",
        description: "填写输入框、文本域或可编辑区域，支持 CSS 选择器、label、placeholder 等定位方式",
        input_schema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "输入框的 CSS 选择器，可选" },
                text: { type: "string", description: "按可见文本或可访问名称匹配元素，可选" },
                labelText: { type: "string", description: "按 label 文本匹配输入控件，可选" },
                placeholder: { type: "string", description: "按 placeholder 匹配元素，可选" },
                ariaLabel: { type: "string", description: "按 aria-label 匹配元素，可选" },
                role: { type: "string", description: "按 ARIA role 匹配元素，可选" },
                name: { type: "string", description: "按 name 属性匹配元素，可选" },
                tagName: { type: "string", description: "限定标签名，可选" },
                value: { type: "string", description: "要填写的文本内容" },
                index: { type: "number", description: "匹配多个元素时选择第几个，从 0 开始", default: 0 },
                exactText: { type: "boolean", description: "文本匹配是否要求完全相等", default: false },
                partialText: { type: "boolean", description: "文本匹配是否允许包含匹配", default: true },
                visibleOnly: { type: "boolean", description: "是否只匹配可见元素", default: true },
                timeoutMs: { type: "number", description: "等待元素出现的超时时间（毫秒）", default: 2500 },
                frameId: { type: "number", description: "目标 frameId，默认 0（主文档）" },
                clearFirst: { type: "boolean", description: "填写前是否清空", default: true }
            },
            required: ["value"]
        }
    },
    {
        name: "browser_press_key",
        description: "在焦点元素上模拟按键",
        input_schema: {
            type: "object",
            properties: {
                key: { type: "string", description: "按键名，例如 Enter、Escape、Tab、a、1" },
                code: { type: "string", description: "键盘事件 code，可选" },
                selector: { type: "string", description: "目标元素 CSS 选择器，可选；不填则作用于当前焦点元素" },
                text: { type: "string", description: "按可见文本或可访问名称匹配元素，可选" },
                labelText: { type: "string", description: "按 label 文本匹配元素，可选" },
                placeholder: { type: "string", description: "按 placeholder 匹配元素，可选" },
                ariaLabel: { type: "string", description: "按 aria-label 匹配元素，可选" },
                role: { type: "string", description: "按 ARIA role 匹配元素，可选" },
                name: { type: "string", description: "按 name 属性匹配元素，可选" },
                tagName: { type: "string", description: "限定标签名，可选" },
                index: { type: "number", description: "匹配多个元素时选择第几个，从 0 开始", default: 0 },
                exactText: { type: "boolean", description: "文本匹配是否要求完全相等", default: false },
                partialText: { type: "boolean", description: "文本匹配是否允许包含匹配", default: true },
                visibleOnly: { type: "boolean", description: "是否只匹配可见元素", default: true },
                timeoutMs: { type: "number", description: "等待元素出现的超时时间（毫秒）", default: 1500 },
                frameId: { type: "number", description: "目标 frameId，默认 0（主文档）" }
            },
            required: ["key"]
        }
    },
    {
        name: "browser_wait",
        description: "等待指定时间（毫秒）",
        input_schema: {
            type: "object",
            properties: {
                milliseconds: { type: "number", description: "等待时间（毫秒）", default: 1000 }
            }
        }
    },
    {
        name: "browser_scroll",
        description: "滚动页面",
        input_schema: {
            type: "object",
            properties: {
                direction: { type: "string", description: "滚动方向：up、down、top、bottom", default: "down" },
                amount: { type: "number", description: "滚动距离（像素）", default: 500 },
                selector: { type: "string", description: "要滚动的元素 CSS 选择器，可选；不填则滚动窗口" },
                timeoutMs: { type: "number", description: "等待滚动容器出现的超时时间（毫秒）", default: 800 },
                frameId: { type: "number", description: "目标 frameId，默认 0（主文档）" }
            }
        }
    },
    {
        name: "browser_screenshot",
        description: "对当前页面截图",
        input_schema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "browser_editor",
        description: "编辑器操作工具，可读取、写入、插入内容到 Infinpilot 编辑器，并管理多文件、网址与截图。",
        input_schema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description: "操作类型，例如 get_content、set_content、insert、replace_selection、get_selection、wrap_selection、append、insert_current_url、insert_all_tabs、capture_screenshot、list_files、list_folders、get_current_file、create_file、create_folder、switch_file、delete_file、rename_file、get_file_content、set_file_content、export_all_files、get_docx_files、is_docx_mode、import_docx、export_docx、get_current_docx_content、switch_docx_file、create_docx_file、insert_docx_content、set_docx_content"
                },
                content: { type: "string", description: "要写入或插入的内容" },
                prefix: { type: "string", description: "包裹选区的前缀，例如 ** 表示粗体" },
                suffix: { type: "string", description: "包裹选区的后缀，例如 ** 表示粗体" },
                fileId: { type: "string", description: "鏂囦欢ID" },
                fileName: { type: "string", description: "新文件名或文件夹名" },
                parentId: { type: "string", description: "父文件夹 ID，创建子文件或子文件夹时使用" },
                append: { type: "boolean", description: "是否使用追加模式，适合流式写入大文件" }
            },
            required: ["action"]
        }
    },
    {
        name: "browser_sheet",
        description: "表格编辑器工具，用于操作 Infinpilot 内置的 XLSX 表格编辑器，支持创建、读取、写入表格与图表。",
        input_schema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description: "操作类型，例如 list_sheets、is_sheet_mode、create_sheet、switch_sheet、get_sheet_data、export_sheet、import_sheet、insert_sheet_data、get_cell、set_cell、insert_chart、get_charts、delete_chart"
                },
                fileId: { type: "string", description: "鏂囦欢ID" },
                fileName: { type: "string", description: "文件名" },
                data: { type: "array", description: "二维数组数据，用于 insert_sheet_data" },
                row: { type: "number", description: "行号，从 0 开始" },
                col: { type: "number", description: "列号，从 0 开始" },
                value: { type: "string", description: "单元格值" },
                sheetIndex: { type: "number", description: "Sheet 索引，从 0 开始，默认 0" },
                base64Data: { type: "string", description: "Base64 编码的 xlsx 文件数据，用于导入" },
                chartType: { type: "string", description: "图表类型：bar、line、pie、area、radar" },
                chartTitle: { type: "string", description: "图表标题" },
                dataRange: { type: "string", description: "数据范围，例如 A1:D5" },
                labelsRange: { type: "string", description: "标签范围，例如 A1:A5" },
                chartId: { type: "string", description: "图表 ID，用于删除图表" }
            },
            required: ["action"]
        }
    },
    {
        name: "browser_svg",
        description: "SVG 编辑器工具，用于操作 Infinpilot 内置 SVG 编辑器，可创建、切换、读取、写入、导入和导出 SVG 文件。",
        input_schema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description: "操作类型，例如 list_svgs、is_svg_mode、create_svg、switch_svg、get_svg_content、set_svg_content、import_svg、export_svg"
                },
                fileId: { type: "string", description: "SVG 文件 ID" },
                fileName: { type: "string", description: "SVG 文件名" },
                content: { type: "string", description: "SVG 源码文本，用于 set_svg_content 或 import_svg" },
                parentId: { type: "string", description: "父文件夹 ID，创建或导入 SVG 文件时使用" }
            },
            required: ["action"]
        }
    },
    {
        name: "browser_project",
        description: "项目工具，可操作当前项目、保存当前页面/结构化提取到项目、管理模板与运行记录，并可把最近一次成功任务提炼为模板。",
        input_schema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description: "操作类型，例如 get_current_project、capture_page、extract_pattern、list_templates、get_template、run_template、resume_run、list_runs、save_last_task_as_template"
                },
                projectId: { type: "string", description: "项目 ID，部分操作可显式指定目标项目" },
                templateId: { type: "string", description: "模板 ID，get_template 或 run_template 时使用" },
                templateName: { type: "string", description: "模板名称，run_template 时可按名称匹配模板" },
                runId: { type: "string", description: "运行记录 ID，resume_run 时使用" },
                pattern: { type: "string", description: "提取模式，例如 article、table、faq、product、timeline" },
                title: { type: "string", description: "保存为模板时的模板名称，或资源操作时的标题" },
                description: { type: "string", description: "模板描述" },
                input: { type: "object", description: "模板执行或继续执行时需要的输入参数对象，例如 {\"query\":\"OpenAI\",\"upload_done\":true}" },
                limit: { type: "number", description: "list_runs 返回条数，默认 8" }
            },
            required: ["action"]
        }
    },
    {
        name: "browser_mcp",
        description: "MCP 管理工具，可列出已连接的 MCP 服务、工具、资源与提示词，并读取远程资源或提示词内容，也可将 MCP 资源或提示词直接加入当前聊天/深度研究上下文。",
        input_schema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    description: "操作类型，例如 get_state、list_servers、list_tools、list_resources、read_resource、save_resource_to_project、add_resource_to_context、list_prompts、get_prompt、save_prompt_to_project、add_prompt_to_context"
                },
                serverId: { type: "string", description: "MCP 服务 ID，按单个服务查询时使用" },
                refresh: { type: "boolean", description: "是否强制刷新服务目录", default: false },
                uri: { type: "string", description: "资源 URI，read_resource 时使用" },
                name: { type: "string", description: "提示词名称，get_prompt 时使用" },
                arguments: { type: "object", description: "提示词参数对象，get_prompt 时使用" },
                projectId: { type: "string", description: "保存到项目时的目标项目 ID，可选，默认当前项目" },
                title: { type: "string", description: "保存到项目时的自定义标题，可选" }
            },
            required: ["action"]
        }
    },
    // ========== Scraping Tools ==========
    {
        name: "scraping_get",
        description: "[网页抓取] 使用 HTTP 请求抓取任意网页内容，支持 CSS 选择器和 XPath 精确提取。",
        input_schema: {
            type: "object",
            properties: {
                url: { type: "string", description: "目标 URL" },
                extraction_type: {
                    type: "string",
                    enum: ["markdown", "html", "text"],
                    default: "markdown",
                    description: "提取格式：markdown（可读文本）、html（原始 HTML）、text（纯文本）"
                },
                css_selector: {
                    type: "string",
                    description: "CSS 选择器，例如 .product-title、#price、article h2"
                },
                xpath_selector: {
                    type: "string",
                    description: "XPath 选择器，例如 //div[@class=\"product\"]、//h1/text()，优先级高于 css_selector"
                },
                fingerprint: {
                    type: "string",
                    enum: ["chrome", "firefox", "safari", "edge"],
                    default: "chrome",
                    description: "浏览器指纹类型"
                },
                timeout: {
                    type: "number",
                    default: 30000,
                    description: "请求超时时间（毫秒）"
                },
                retries: {
                    type: "number",
                    default: 1,
                    description: "瞬时网络失败时的重试次数"
                },
                main_content_only: {
                    type: "boolean",
                    default: true,
                    description: "是否只提取主要内容"
                }
            },
            required: ["url"]
        }
    },
    {
        name: "scraping_extract_structured",
        description: "[网页抓取] 从页面提取结构化数据，例如商品列表、文章列表、表格等",
        input_schema: {
            type: "object",
            properties: {
                url: { type: "string", description: "目标 URL" },
                pattern: {
                    type: "string",
                    enum: ["product-list", "article-list", "table"],
                    description: "提取模式：product-list、article-list、table"
                },
                retries: { type: "number", default: 1, description: "瞬时网络失败时的重试次数" }
            },
            required: ["url", "pattern"]
        }
    },
    {
        name: "scraping_bulk_get",
        description: "[网页抓取] 批量抓取多个 URL，适合同时获取多个页面内容",
        input_schema: {
            type: "object",
            properties: {
                urls: { type: "array", items: { type: "string" }, description: "URL 列表" },
                extraction_type: { type: "string", enum: ["markdown", "html", "text"], default: "markdown" },
                fingerprint: { type: "string", enum: ["chrome", "firefox", "safari", "edge"], default: "chrome" },
                timeout: { type: "number", default: 30000 },
                retries: { type: "number", default: 1, description: "瞬时网络失败时的重试次数" }
            },
            required: ["urls"]
        }
    },
    {
        name: "scraping_get_links",
        description: "[网页抓取] 获取页面中的所有链接",
        input_schema: {
            type: "object",
            properties: {
                url: { type: "string", description: "目标 URL" },
                limit: { type: "number", default: 50, description: "返回链接数量上限" },
                retries: { type: "number", default: 1, description: "瞬时网络失败时的重试次数" }
            },
            required: ["url"]
        }
    },
    {
        name: "scraping_get_images",
        description: "[网页抓取] 获取页面中的所有图片",
        input_schema: {
            type: "object",
            properties: {
                url: { type: "string", description: "目标 URL" },
                limit: { type: "number", default: 30, description: "返回图片数量上限" },
                retries: { type: "number", default: 1, description: "瞬时网络失败时的重试次数" }
            },
            required: ["url"]
        }
    },
    {
        name: "scraping_current_page",
        description: "[网页抓取] 获取当前活动标签页的内容，无需 URL 参数",
        input_schema: {
            type: "object",
            properties: {
                extraction_type: {
                    type: "string",
                    enum: ["markdown", "html", "text", "links", "images"],
                    default: "markdown"
                },
                css_selector: { type: "string", description: "CSS 选择器" },
                visible_only: { type: "boolean", description: "是否只匹配可见元素", default: true },
                timeout_ms: { type: "number", description: "等待选择器出现的超时时间（毫秒）", default: 1500 }
            }
        }
    },
    // ========== 智能搜索工具 ==========
    {
        name: "dom_find_similar",
        description: "[智能搜索] 查找与指定元素相似的元素，基于 DOM 层级、标签名和属性相似度等特征",
        input_schema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "参考元素的 CSS 选择器" },
                index: { type: "number", description: "如果选择器匹配多个元素，指定第几个，从 0 开始", default: 0 },
                similarity_threshold: { type: "number", description: "相似度阈值 0-1，越高越严格", default: 0.2 },
                match_text: { type: "boolean", description: "是否匹配文本内容", default: false },
                limit: { type: "number", description: "返回结果数量上限", default: 20 }
            },
            required: ["selector"]
        }
    },
    {
        name: "dom_find_by_text",
        description: "[智能搜索] 通过文本内容查找元素，支持精确和模糊匹配",
        input_schema: {
            type: "object",
            properties: {
                text: { type: "string", description: "要搜索的文本" },
                partial: { type: "boolean", description: "是否部分匹配", default: true },
                case_sensitive: { type: "boolean", description: "是否区分大小写", default: false },
                tag_name: { type: "string", description: "限定标签名，例如 div、a、button" },
                limit: { type: "number", description: "返回结果数量上限", default: 20 }
            },
            required: ["text"]
        }
    },
    {
        name: "dom_find_by_regex",
        description: "[智能搜索] 通过正则表达式查找元素",
        input_schema: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "正则表达式模式" },
                flags: { type: "string", description: "正则标志，例如 g、i、gi", default: "" },
                target: { type: "string", enum: ["text", "html", "href", "src"], default: "text", description: "匹配目标" },
                tag_name: { type: "string", description: "限定标签名" },
                limit: { type: "number", description: "返回结果数量上限", default: 20 }
            },
            required: ["pattern"]
        }
    },
    {
        name: "dom_find_by_filter",
        description: "[智能搜索] 通过过滤条件查找元素",
        input_schema: {
            type: "object",
            properties: {
                selector: { type: "string", description: "基础 CSS 选择器", default: "*" },
                filter_type: { type: "string", enum: ["text-contains", "has-class", "has-attribute", "visible", "enabled", "checked"], description: "过滤类型" },
                filter_value: { type: "string", description: "过滤值，has-attribute 格式为 attrName=attrValue" },
                limit: { type: "number", description: "返回结果数量上限", default: 20 }
            },
            required: ["filter_type"]
        }
    },
    // ========== Jina AI 网页内容获取工具 ==========
    {
        name: "jina_ai_get_content",
        description: "[网页内容获取] 使用 Jina AI 服务获取任意网页的 Markdown 内容。需要网页正文时优先使用此工具。",
        input_schema: {
            type: "object",
            properties: {
                url: { type: "string", description: "目标 URL，例如 https://x.com/user/status/123456789" },
                max_length: { type: "number", description: "返回内容最大字符数", default: 8000 }
            },
            required: ["url"]
        }
    },
    // ========== Sub Agent 调用工具 ==========
    {
        name: "invoke_sub_agent",
        description: "[研究专用] 调用一个子 Agent 串行执行任务。适用于任务存在依赖关系、必须按顺序执行的场景。",
        input_schema: {
            type: "object",
            properties: {
                agent_name: { type: "string", description: "子 Agent 名称，例如 web_scraper、data_analyst" },
                task: { type: "string", description: "子 Agent 需要完成的具体任务描述" },
                visible_tools: {
                    type: "array",
                    items: { type: "string" },
                    description: "允许子 Agent 使用的工具名列表，例如 ['jina_ai_get_content', 'scraping_get']"
                },
                context: { type: "string", description: "额外上下文信息，帮助子 Agent 更好理解任务，可选" }
            },
            required: ["agent_name", "task", "visible_tools"]
        }
    },
    {
        name: "invoke_sub_agents",
        description: "[研究专用] 并行调用多个子 Agent 执行任务。用户确认研究计划后，使用此工具执行。",
        input_schema: {
            type: "object",
            properties: {
                agents: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            agent_name: { type: "string", description: "子 Agent 名称" },
                            task: { type: "string", description: "任务描述" },
                            visible_tools: { type: "array", items: { type: "string" }, description: "允许使用的工具列表" },
                            context: { type: "string", description: "上下文信息，可选" }
                        },
                        required: ["agent_name", "task", "visible_tools"]
                    },
                    description: "子 Agent 列表，将并行执行"
                },
                sub_agents: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            agent_id: { type: "string", description: "子 Agent ID" },
                            task_description: { type: "string", description: "任务描述" },
                            task_type: { type: "string", description: "任务类型" },
                            visible_tools: { type: "array", items: { type: "string" }, description: "允许使用的工具列表" }
                        },
                        required: ["agent_id", "task_description"]
                    },
                    description: "子 Agent 列表（兼容 agent_id、task_description 结构）"
                }
            }
        }
    }
];

const MCP_TOOL_NAME_PREFIX = 'mcp__';
const MCP_TOOL_CACHE_TTL_MS = 15000;
const MCP_AGENT_PREFERENCES_KEY = 'infinpilot-mcp-agent-preferences';
let cachedDynamicMcpTools = [];
let cachedDynamicMcpToolsAt = 0;

function isMcpToolName(toolName) {
    return typeof toolName === 'string' && toolName.startsWith(MCP_TOOL_NAME_PREFIX);
}

function invalidateMcpToolCache() {
    cachedDynamicMcpTools = [];
    cachedDynamicMcpToolsAt = 0;
}

async function getMcpAgentPreferences() {
    try {
        const result = await browser.storage.local.get(MCP_AGENT_PREFERENCES_KEY);
        const prefs = result?.[MCP_AGENT_PREFERENCES_KEY] || {};
        return {
            enabled: prefs.enabled !== false,
            allowAllServers: prefs.allowAllServers !== false,
            allowedServerIds: Array.isArray(prefs.allowedServerIds)
                ? prefs.allowedServerIds.map((id) => String(id || '').trim()).filter(Boolean)
                : []
        };
    } catch (error) {
        console.warn('[Chat] Failed to read MCP agent preferences:', error);
        return {
            enabled: true,
            allowAllServers: true,
            allowedServerIds: []
        };
    }
}

async function getDynamicMcpTools(refresh = false) {
    if (refresh) {
        invalidateMcpToolCache();
    }
    const now = Date.now();
    if (!refresh && cachedDynamicMcpTools.length > 0 && (now - cachedDynamicMcpToolsAt) < MCP_TOOL_CACHE_TTL_MS) {
        return cachedDynamicMcpTools;
    }

    try {
        const response = await browser.runtime.sendMessage({
            action: 'mcp.listTools',
            refresh
        });
        if (response?.success && Array.isArray(response.data)) {
            cachedDynamicMcpTools = response.data;
            cachedDynamicMcpToolsAt = now;
            return cachedDynamicMcpTools;
        }
    } catch (error) {
        console.warn('[Chat] Failed to load MCP tools:', error);
    }

    if (refresh) {
        cachedDynamicMcpTools = [];
        cachedDynamicMcpToolsAt = now;
    }
    return cachedDynamicMcpTools;
}

async function getAllAgentTools(refresh = false) {
    const dynamicTools = await getDynamicMcpTools(refresh);
    const prefs = await getMcpAgentPreferences();
    const staticTools = !prefs.enabled
        ? browserTools.filter((tool) => tool.name !== 'browser_mcp')
        : browserTools;
    const filteredDynamicTools = !prefs.enabled
        ? []
        : dynamicTools.filter((tool) => {
            if (prefs.allowAllServers !== false) {
                return true;
            }
            return prefs.allowedServerIds.includes(tool?.meta?.serverId);
        });
    const allTools = [...staticTools, ...filteredDynamicTools];
    if (window.DeepResearch?.subAgentEngine) {
        window.DeepResearch.subAgentEngine.availableTools = allTools;
    }
    return allTools;
}

window.InfinPilotMcp = {
    invalidateToolCache: invalidateMcpToolCache,
    refreshTools: () => getAllAgentTools(true),
    getDynamicTools: () => getDynamicMcpTools(false)
};

window.addEventListener('infinpilot:mcp-changed', () => {
    void getAllAgentTools(true);
});

window.addEventListener('infinpilot:mcp-preferences-changed', () => {
    void getAllAgentTools(false);
});

/**
 * Execute a browser tool
 * @param {string} toolName - 工具名称
 * @param {object} toolInput - 工具输入参数
 * @param {object} executionContext - 执行上下文（可能包含 isolatedTabId）
 */
async function executeBrowserToolLegacy(toolName, toolInput, executionContext) {
    const startTime = Date.now();
    console.log(`[Automation][T+${startTime % 10000}] Executing tool:`, toolName, 'with context:', executionContext?.executionId);

    // 检查是否存在隔离执行上下文
    const isolatedTabId = executionContext?.isolatedTabId;

    // 辅助函数：获取目标标签页 ID
    const getTargetTabId = async (fallbackToActive = true) => {
        if (isolatedTabId) {
            return isolatedTabId;
        }
        if (fallbackToActive) {
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            return tab?.id;
        }
        return null;
    };

    try {
        switch (toolName) {
            case 'browser_navigate':
            case 'browser_open_url': {
                const url = toolInput.url;
                if (!url) return { error: "缺少 URL 参数" };
                const tab = await browser.tabs.create({ url, active: toolInput.active !== false });

                // 如果处于 subAgent 执行上下文中，跟踪新打开的标签页
                if (window.__currentExecutionContext || window.DeepResearch?.isDeepResearchMode) {
                    const engine = window.DeepResearch?.subAgentEngine;
                    if (engine && typeof engine.trackSubAgentTab === 'function') {
                        engine.trackSubAgentTab(tab.id);
                    }
                }

                return { success: true, message: `已打开 ${url}`, tabId: tab.id };
            }
            case 'browser_get_current_tab': {
                const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
                if (!tab) return { error: "没有活动标签页" };
                return { id: tab.id, title: tab.title, url: tab.url, active: tab.active };
            }
            case 'browser_list_tabs': {
                const tabs = await browser.tabs.query({});
                return { tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active })), count: tabs.length };
            }
            case 'browser_switch_tab': {
                if (!toolInput.tabId) return { error: "缺少 tabId 参数" };
                await browser.tabs.update(toolInput.tabId, { active: true });
                const tab = await browser.tabs.get(toolInput.tabId);
                return { success: true, message: `已切换到: ${tab.title}`, tabId: tab.id };
            }
            case 'browser_close_tab': {
                if (toolInput.tabId) {
                    await browser.tabs.remove(toolInput.tabId);
                    return { success: true, message: `已关闭标签页 ${toolInput.tabId}` };
                } else {
                    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
                    if (tab?.id) await browser.tabs.remove(tab.id);
                    return { success: true, message: "已关闭当前标签页" };
                }
            }
            case 'browser_reload_tab': {
                const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
                const targetTabId = toolInput.tabId || currentTab?.id;
                if (targetTabId) {
                    await browser.tabs.reload(targetTabId, { bypassCache: toolInput.bypassCache || false });
                    return { success: true, message: `已刷新标签页 ${targetTabId}` };
                }
                return { error: "没有可刷新的标签页" };
            }
            case 'browser_get_dom': {
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                let tab;
                try {
                    tab = await browser.tabs.get(tabId);
                } catch (e) {
                    return { error: "无法获取标签页: " + e.message };
                }

                // 检查是否为受限页面
                if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://') || tab.url.startsWith('moz-extension://'))) {
                    return { error: `无法访问受限页面: ${tab.url}` };
                }

                try {
                    // 先尝试直接发送消息
                    const result = await browser.tabs.sendMessage(tabId, {
                        action: 'getPageDOM',
                        selector: toolInput.selector,
                        maxLength: toolInput.maxLength || 5000
                    });
                    return result;
                } catch (err) {
                    // 如果没有 content script，则尝试注入
                    if (err.message.includes('Receiving end does not exist')) {
                        try {
                            await browser.scripting.executeScript({
                                target: { tabId: tabId },
                                files: ['js/content.js']
                            });
                            // 等待一小段时间让脚本初始化
                            await new Promise(resolve => setTimeout(resolve, 200));
                            // 重试发送消息
                            const result = await browser.tabs.sendMessage(tabId, {
                                action: 'getPageDOM',
                                selector: toolInput.selector,
                                maxLength: toolInput.maxLength || 5000
                            });
                            return result;
                        } catch (err2) {
                            return { error: '无法获取页面 DOM: ' + err2.message };
                        }
                    }
                    return { error: '获取页面 DOM 失败: ' + err.message };
                }
            }
            case 'browser_get_visible_text': {
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                let tab;
                try {
                    tab = await browser.tabs.get(tabId);
                } catch (e) {
                    return { error: "无法获取标签页: " + e.message };
                }

                if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://') || tab.url.startsWith('moz-extension://'))) {
                    return { error: `无法访问受限页面: ${tab.url}` };
                }

                try {
                    const result = await browser.tabs.sendMessage(tabId, {
                        action: 'getVisibleText',
                        selector: toolInput.selector
                    });
                    return result;
                } catch (err) {
                    if (err.message.includes('Receiving end does not exist')) {
                        try {
                            await browser.scripting.executeScript({
                                target: { tabId: tabId },
                                files: ['js/content.js']
                            });
                            await new Promise(resolve => setTimeout(resolve, 200));
                            const result = await browser.tabs.sendMessage(tabId, {
                                action: 'getVisibleText',
                                selector: toolInput.selector
                            });
                            return result;
                        } catch (err2) {
                            return { error: '无法获取页面文本: ' + err2.message };
                        }
                    }
                    return { error: '获取页面文本失败: ' + err.message };
                }
            }
            case 'browser_click': {
                if (!toolInput.selector) return { error: "缺少 selector 参数" };
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                let tab;
                try {
                    tab = await browser.tabs.get(tabId);
                } catch (e) {
                    return { error: "无法获取标签页: " + e.message };
                }

                if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://') || tab.url.startsWith('moz-extension://'))) {
                    return { error: `无法访问受限页面: ${tab.url}` };
                }

                try {
                    const result = await browser.tabs.sendMessage(tabId, {
                        action: 'clickElement',
                        selector: toolInput.selector
                    });
                    return result;
                } catch (err) {
                    if (err.message.includes('Receiving end does not exist')) {
                        try {
                            await browser.scripting.executeScript({
                                target: { tabId: tabId },
                                files: ['js/content.js']
                            });
                            await new Promise(resolve => setTimeout(resolve, 200));
                            const result = await browser.tabs.sendMessage(tabId, {
                                action: 'clickElement',
                                selector: toolInput.selector
                            });
                            return result;
                        } catch (err2) {
                            return { error: '无法点击元素: ' + err2.message };
                        }
                    }
                    return { error: '点击元素失败: ' + err.message };
                }
            }
            case 'browser_fill_input': {
                if (!toolInput.selector || toolInput.value === undefined) return { error: "缺少必要参数" };
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                let tab;
                try {
                    tab = await browser.tabs.get(tabId);
                } catch (e) {
                    return { error: "无法获取标签页: " + e.message };
                }

                if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://') || tab.url.startsWith('moz-extension://'))) {
                    return { error: `无法访问受限页面: ${tab.url}` };
                }

                try {
                    const result = await browser.tabs.sendMessage(tabId, {
                        action: 'fillInput',
                        selector: toolInput.selector,
                        value: toolInput.value,
                        clearFirst: toolInput.clearFirst !== false
                    });
                    return result;
                } catch (err) {
                    if (err.message.includes('Receiving end does not exist')) {
                        try {
                            await browser.scripting.executeScript({
                                target: { tabId: tabId },
                                files: ['js/content.js']
                            });
                            await new Promise(resolve => setTimeout(resolve, 200));
                            const result = await browser.tabs.sendMessage(tabId, {
                                action: 'fillInput',
                                selector: toolInput.selector,
                                value: toolInput.value,
                                clearFirst: toolInput.clearFirst !== false
                            });
                            return result;
                        } catch (err2) {
                            return { error: '无法填写输入框: ' + err2.message };
                        }
                    }
                    return { error: '填写输入框失败: ' + err.message };
                }
            }
            case 'browser_press_key': {
                if (!toolInput.key) return { error: "缺少 key 参数" };
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                let tab;
                try {
                    tab = await browser.tabs.get(tabId);
                } catch (e) {
                    return { error: "无法获取标签页: " + e.message };
                }

                if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://') || tab.url.startsWith('moz-extension://'))) {
                    return { error: `无法访问受限页面: ${tab.url}` };
                }

                try {
                    const result = await browser.tabs.sendMessage(tabId, {
                        action: 'pressKey',
                        key: toolInput.key,
                        selector: toolInput.selector
                    });
                    return result;
                } catch (err) {
                    if (err.message.includes('Receiving end does not exist')) {
                        try {
                            await browser.scripting.executeScript({
                                target: { tabId: tabId },
                                files: ['js/content.js']
                            });
                            await new Promise(resolve => setTimeout(resolve, 200));
                            const result = await browser.tabs.sendMessage(tabId, {
                                action: 'pressKey',
                                key: toolInput.key,
                                selector: toolInput.selector
                            });
                            return result;
                        } catch (err2) {
                            return { error: '无法按键: ' + err2.message };
                        }
                    }
                    return { error: '按键失败: ' + err.message };
                }
            }
            case 'browser_wait': {
                const ms = toolInput.milliseconds || 1000;
                await new Promise(resolve => setTimeout(resolve, ms));
                return { success: true, message: `已等待 ${ms}ms` };
            }
            case 'browser_scroll': {
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                let tab;
                try {
                    tab = await browser.tabs.get(tabId);
                } catch (e) {
                    return { error: "无法获取标签页: " + e.message };
                }

                if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://') || tab.url.startsWith('moz-extension://'))) {
                    return { error: `无法访问受限页面: ${tab.url}` };
                }

                try {
                    const result = await browser.tabs.sendMessage(tabId, {
                        action: 'scrollPage',
                        direction: toolInput.direction || 'down',
                        amount: toolInput.amount || 500
                    });
                    return result;
                } catch (err) {
                    if (err.message.includes('Receiving end does not exist')) {
                        try {
                            await browser.scripting.executeScript({
                                target: { tabId: tabId },
                                files: ['js/content.js']
                            });
                            await new Promise(resolve => setTimeout(resolve, 200));
                            const result = await browser.tabs.sendMessage(tabId, {
                                action: 'scrollPage',
                                direction: toolInput.direction || 'down',
                                amount: toolInput.amount || 500
                            });
                            return result;
                        } catch (err2) {
                            return { error: '无法滚动页面: ' + err2.message };
                        }
                    }
                    return { error: '滚动页面失败: ' + err.message };
                }
            }
            case 'browser_screenshot': {
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                let tab;
                try {
                    tab = await browser.tabs.get(tabId);
                } catch (e) {
                    return { error: "无法获取标签页: " + e.message };
                }

                // 鎴浘闇€瑕佷娇鐢╟hrome.debugger鎴朿aptureVisibleTab
                try {
                    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                    return { success: true, message: "截图已保存", dataUrl: dataUrl };
                } catch (e) {
                    return { error: "截图失败: " + e.message };
                }
            }
            case 'browser_editor': {
                const { action, content, prefix, suffix, fileId, fileName } = toolInput;

                // 检查编辑器是否可用
                if (!window.InfinPilotEditor) {
                    return { error: "编辑器未初始化，请刷新页面后重试" };
                }

                try {
                    switch (action) {
                        case 'get_content': {
                            const editorContent = window.InfinPilotEditor.getContent();
                            return { success: true, content: editorContent, message: "已获取编辑器内容" };
                        }
                        case 'set_content': {
                            if (!content) return { error: "缺少 content 参数" };
                            // 检测当前是否处于 DOCX 模式
                            if (window.InfinPilotEditor.isDocxMode()) {
                                // 在 DOCX 模式下，设置内容前需要先把 Markdown 转成 DOCX。
                                // 由于 SuperDoc 不直接支持从 Markdown 设置内容，这里采用折中策略：
                                // 1. 将内容保存到当前文件对象的 markdownSource 字段
                                // 2. 用户后续通过 export_docx 导出为 DOCX
                                // 3. 必要时再考虑重新加载 SuperDoc 实例
                                const currentFileId = window.InfinPilotEditor.getCurrentFileId();
                                const allFiles = window.InfinPilotEditor.getAllFiles();
                                const currentFile = allFiles.find(f => f.id === currentFileId && f.type === 'docx');
                                if (currentFile) {
                                    // 保存 Markdown 源内容到文件对象
                                    const files = window.InfinPilotEditor.getAllFiles ? window.InfinPilotEditor.getAllFiles() : [];
                                    const fileObj = files.find(f => f.id === currentFileId);
                                    if (fileObj) {
                                        // 保存 Markdown 源内容，用于后续转换
                                        fileObj.markdownSource = content;
                                    }
                                    return { success: true, message: "已在 DOCX 模式下设置内容（保存为 Markdown 源）。如需转换为 DOCX，请调用 export_docx 导出。" };
                                }
                            }
                            window.InfinPilotEditor.setContent(content);
                            return { success: true, message: "已设置编辑器内容" };
                        }
                        case 'insert': {
                            if (!content) return { error: "缺少 content 参数" };
                            window.InfinPilotEditor.insertAtCursor(content);
                            return { success: true, message: "已插入内容到光标位置" };
                        }
                        case 'replace_selection': {
                            if (!content) return { error: "缺少 content 参数" };
                            window.InfinPilotEditor.replaceSelection(content);
                            return { success: true, message: "已替换选区内容" };
                        }
                        case 'get_selection': {
                            const selection = window.InfinPilotEditor.getSelectionText();
                            return { success: true, content: selection, message: "已获取选区内容" };
                        }
                        case 'wrap_selection': {
                            if (!prefix) return { error: "缺少 prefix 参数" };
                            window.InfinPilotEditor.wrapSelection(prefix, suffix);
                            return { success: true, message: "已包裹选区" };
                        }
                        case 'append': {
                            if (!content) return { error: "缺少 content 参数" };
                            const currentContent = window.InfinPilotEditor.getContent();
                            window.InfinPilotEditor.setContent(currentContent + '\n' + content);
                            return { success: true, message: "已追加内容到编辑器末尾" };
                        }
                        case 'insert_current_url': {
                            const result = await window.InfinPilotEditor.insertCurrentUrl();
                            return result;
                        }
                        case 'insert_all_tabs': {
                            const result = await window.InfinPilotEditor.insertAllTabs();
                            return result;
                        }
                        case 'capture_screenshot': {
                            const result = await window.InfinPilotEditor.captureAndInsertScreenshot();
                            return result;
                        }
                        // 文件管理操作
                        case 'list_files': {
                            const files = window.InfinPilotEditor.getAllFiles();
                            return { success: true, files: files };
                        }
                        case 'list_folders': {
                            const folders = window.InfinPilotEditor.getFolders();
                            return { success: true, folders: folders };
                        }
                        case 'get_current_file': {
                            const currentId = window.InfinPilotEditor.getCurrentFileId();
                            const files = window.InfinPilotEditor.getAllFiles();
                            const currentFile = files.find(f => f.id === currentId);
                            return { success: true, currentFile: currentFile };
                        }
                        case 'create_file': {
                            const { parentId } = toolInput;
                            const result = window.InfinPilotEditor.createFile(fileName, parentId);
                            return result;
                        }
                        case 'switch_file': {
                            if (!fileId) return { error: "缺少 fileId 参数" };
                            const result = window.InfinPilotEditor.switchFile(fileId);
                            return result;
                        }
                        case 'delete_file': {
                            if (!fileId) return { error: "缺少 fileId 参数" };
                            const result = window.InfinPilotEditor.deleteFile(fileId);
                            return result;
                        }
                        case 'rename_file': {
                            if (!fileId || !fileName) return { error: "缺少 fileId 或 fileName 参数" };
                            const result = window.InfinPilotEditor.renameFile(fileId, fileName);
                            return result;
                        }
                        case 'get_file_content': {
                            if (!fileId) return { error: "缺少 fileId 参数" };
                            const result = window.InfinPilotEditor.getFileContent(fileId);
                            return result;
                        }
                        case 'set_file_content': {
                            if (!fileId || content === undefined) return { error: "缺少 fileId 或 content 参数" };
                            // 支持 append 参数用于流式写入
                            const append = toolInput.append === true;
                            const result = window.InfinPilotEditor.setFileContent(fileId, content, append);
                            return result;
                        }
                        case 'create_folder': {
                            const { parentId } = toolInput;
                            const result = window.InfinPilotEditor.createNewFolder(fileName, parentId);
                            return result;
                        }
                        case 'export_all_files': {
                            const result = window.InfinPilotEditor.exportAllFiles();
                            return result;
                        }
                        // ========== DOCX 编辑器操作 ==========
                        case 'get_docx_files': {
                            const files = window.InfinPilotEditor.getDocxFiles();
                            return { success: true, files: files };
                        }
                        case 'is_docx_mode': {
                            const isDocx = window.InfinPilotEditor.isDocxMode();
                            return { success: true, isDocxMode: isDocx };
                        }
                        case 'import_docx': {
                            const { data, name } = toolInput;
                            if (!data) return { error: "缺少 data 参数（Base64 编码的 DOCX 数据）" };
                            const fileName = name || toolInput.fileName || 'document.docx';
                            const result = await window.InfinPilotEditor.importDocx(data, fileName);
                            return result;
                        }
                        case 'export_docx': {
                            const result = await window.InfinPilotEditor.exportDocx();
                            return result;
                        }
                        case 'get_current_docx_content': {
                            const result = await window.InfinPilotEditor.getCurrentDocxContent();
                            return result;
                        }
                        case 'switch_docx_file': {
                            if (!fileId) return { error: "缺少 fileId 参数" };
                            const result = await window.InfinPilotEditor.switchToDocxFile(fileId);
                            return result;
                        }
                        case 'create_docx_file': {
                            const docxFileName = fileName || '新文档.docx';
                            // 创建一个空 DOCX 文件
                            const result = await window.InfinPilotEditor.importDocx('', docxFileName);
                            return result;
                        }
                        case 'insert_docx_content': {
                            // 在当前 DOCX 编辑器中插入文本
                            if (!content) return { error: "缺少 content 参数" };
                            const result = window.InfinPilotEditor.insertTextToDocx(content);
                            return result;
                        }
                        case 'set_docx_content': {
                            // 设置 DOCX 编辑器内容（替换全部内容）
                            if (!content) return { error: "缺少 content 参数" };
                            const result = window.InfinPilotEditor.setDocxContent(content);
                            return result;
                        }
                    }
                } catch (e) {
                    return { error: "编辑器操作失败: " + e.message };
                }
            }
            // ========== Sheet/XLSX 编辑器操作 ==========
            case 'browser_sheet': {
                const sheetAction = toolInput.action;
                const { fileId, fileName, data, row, col, value, sheetIndex, base64Data, chartType, chartTitle, dataRange, labelsRange, chartId } = toolInput;
                
                if (!window.InfinPilotEditor) {
                    return { error: "编辑器未初始化，请刷新页面后重试" };
                }
                
                try {
                    switch (sheetAction) {
                        case 'list_sheets': {
                            const files = window.InfinPilotEditor.getSheetFiles();
                            return { success: true, files: files };
                        }
                        case 'is_sheet_mode': {
                            const isSheet = window.InfinPilotEditor.isSheetMode();
                            return { success: true, isSheetMode: isSheet };
                        }
                        case 'create_sheet': {
                            const result = await window.InfinPilotEditor.createSheet(fileName);
                            return result;
                        }
                        case 'switch_sheet': {
                            if (!fileId) return { error: "缺少 fileId 参数" };
                            const result = await window.InfinPilotEditor.switchToSheetFile(fileId);
                            return result;
                        }
                        case 'get_sheet_data': {
                            const result = window.InfinPilotEditor.getSheetData();
                            return result;
                        }
                        case 'export_sheet': {
                            const result = await window.InfinPilotEditor.exportSheet();
                            return result;
                        }
                        case 'import_sheet': {
                            const result = await window.InfinPilotEditor.importSheet(base64Data, fileName);
                            return result;
                        }
                        case 'insert_sheet_data': {
                            if (!data) return { error: "缺少 data 参数，应为二维数组" };
                            const result = window.InfinPilotEditor.insertSheetData(data, sheetIndex || 0);
                            return result;
                        }
                        case 'get_cell': {
                            if (row === undefined || col === undefined) return { error: "缺少 row 或 col 参数" };
                            const result = window.InfinPilotEditor.getCellValue(row, col, sheetIndex || 0);
                            return result;
                        }
                        case 'set_cell': {
                            if (row === undefined || col === undefined || value === undefined) return { error: "缺少 row、col 或 value 参数" };
                            const result = window.InfinPilotEditor.setCellValue(row, col, value, sheetIndex || 0);
                            return result;
                        }
                        case 'insert_chart': {
                            const result = window.InfinPilotEditor.insertChart(chartType, chartTitle, dataRange, labelsRange, sheetIndex || 0);
                            return result;
                        }
                        case 'get_charts': {
                            const result = window.InfinPilotEditor.getCharts(sheetIndex || 0);
                            return result;
                        }
                        case 'delete_chart': {
                            if (!chartId) return { error: "缺少 chartId 参数" };
                            const result = window.InfinPilotEditor.deleteChart(chartId, sheetIndex || 0);
                            return result;
                        }
                        default:
                            return { error: `未知的 Sheet 操作: ${sheetAction}` };
                    }
                } catch (e) {
                    return { error: "Sheet 操作失败: " + e.message };
                }
            }
            case 'browser_svg': {
                const svgAction = toolInput.action;
                const { fileId, fileName, content, parentId } = toolInput;

                if (!window.InfinPilotEditor) {
                    return { error: "编辑器未初始化，请刷新页面后重试" };
                }

                try {
                    switch (svgAction) {
                        case 'list_svgs': {
                            const files = (window.InfinPilotEditor.getAllFiles?.() || []).filter(f => f.type === 'svg');
                            return { success: true, files: files };
                        }
                        case 'is_svg_mode': {
                            const isSvg = window.InfinPilotEditor.isSvgMode
                                ? window.InfinPilotEditor.isSvgMode()
                                : false;
                            return { success: true, isSvgMode: isSvg };
                        }
                        case 'create_svg': {
                            const result = await window.InfinPilotEditor.createSvg(fileName, parentId);
                            return result;
                        }
                        case 'switch_svg': {
                            if (!fileId) return { error: "缺少 fileId 参数" };
                            const result = await window.InfinPilotEditor.switchToSvgFile(fileId);
                            return result;
                        }
                        case 'get_svg_content': {
                            const result = await window.InfinPilotEditor.getSvgContent(fileId || null);
                            return result;
                        }
                        case 'set_svg_content': {
                            const targetFileId = fileId || window.InfinPilotEditor.getCurrentFileId?.();
                            if (!targetFileId || content === undefined) {
                                return { error: "缺少 fileId 或 content 参数" };
                            }
                            const result = await window.InfinPilotEditor.setSvgContent(targetFileId, content);
                            return result;
                        }
                        case 'import_svg': {
                            if (content === undefined) return { error: "缺少 content 参数" };
                            const result = await window.InfinPilotEditor.importSvg(content, fileName, parentId);
                            return result;
                        }
                        case 'export_svg': {
                            const result = await window.InfinPilotEditor.exportSvg(fileId || null);
                            return result;
                        }
                        default:
                            return { error: `未知的 SVG 操作: ${svgAction}` };
                    }
                } catch (e) {
                    return { error: "SVG 操作失败: " + e.message };
                }
            }
            case 'browser_project': {
                const projectAction = toolInput.action;
                const { templateId, templateName, runId, projectId } = toolInput;
                const templateTitle = typeof toolInput.title === 'string' ? toolInput.title.trim() : '';
                const templateDescription = typeof toolInput.description === 'string' ? toolInput.description.trim() : '';
                const inputPayload = toolInput.input && typeof toolInput.input === 'object' ? toolInput.input : {};
                const normalizeExtractPattern = (value) => {
                    const raw = String(value || '').trim().toLowerCase();
                    const aliasMap = {
                        extract_article: 'article',
                        extract_table: 'table',
                        extract_faq: 'faq',
                        extract_product: 'product',
                        extract_timeline: 'timeline'
                    };
                    return aliasMap[raw] || raw;
                };
                const buildProjectExtractTitle = (pattern, response) => {
                    const labelMap = {
                        article: '文章提取',
                        table: '表格提取',
                        faq: 'FAQ 提取',
                        product: '商品提取',
                        timeline: '时间线提取'
                    };
                    return response?.title || `${labelMap[pattern] || '页面提取'} ${new Date().toLocaleString()}`;
                };
                const resolveTargetProjectId = async () => projectId || await projectService.getCurrentProjectId();

                try {
                    switch (projectAction) {
                        case 'get_current_project': {
                            const project = await projectService.getCurrentProject();
                            if (!project) {
                                return { error: "当前没有可用项目" };
                            }
                            return {
                                success: true,
                                project,
                                message: `当前项目: ${project.name}`
                            };
                        }
                        case 'list_projects': {
                            const projects = await projectService.listProjects();
                            return {
                                success: true,
                                projects,
                                message: `共有 ${projects.length} 个项目`
                            };
                        }
                        case 'switch_project': {
                            if (!projectId) {
                                return { error: "缺少 projectId 参数" };
                            }
                            const result = await projectService.switchProject(projectId);
                            if (!result?.success) {
                                return { error: result?.error || "切换项目失败" };
                            }
                            return {
                                success: true,
                                project: result.project,
                                message: `已切换到项目: ${result.project?.name || projectId}`
                            };
                        }
                        case 'list_items': {
                            const items = await projectService.listProjectItems(projectId || null);
                            return {
                                success: true,
                                items,
                                message: `项目中共有 ${items.length} 条资源`
                            };
                        }
                        case 'capture_page': {
                            const targetProjectId = await resolveTargetProjectId();
                            if (!targetProjectId) {
                                return { error: "当前没有可用项目" };
                            }
                            const response = await browser.runtime.sendMessage({ action: 'project.capturePage' });
                            const item = await projectService.addProjectItem({
                                projectId: targetProjectId,
                                type: 'page_snapshot',
                                title: response.title || '未命名页面',
                                sourceUrl: response.url || '',
                                sourceTabId: response.tabId ?? null,
                                content: response.content || '',
                                meta: {
                                    capturedAt: response.capturedAt || new Date().toISOString(),
                                    contentLength: (response.content || '').length
                                }
                            });
                            return {
                                success: true,
                                item,
                                message: `已保存页面到项目：${item.title}`
                            };
                        }
                        case 'extract_pattern':
                        case 'extract_article':
                        case 'extract_table':
                        case 'extract_faq':
                        case 'extract_product':
                        case 'extract_timeline': {
                            const targetProjectId = await resolveTargetProjectId();
                            if (!targetProjectId) {
                                return { error: "当前没有可用项目" };
                            }
                            const pattern = normalizeExtractPattern(toolInput.pattern || projectAction);
                            if (!pattern) {
                                return { error: "缺少 pattern 参数" };
                            }
                            const response = await browser.runtime.sendMessage({
                                action: 'project.extractElements',
                                pattern
                            });
                            const item = await projectService.addProjectItem({
                                projectId: targetProjectId,
                                type: 'page_extract',
                                title: buildProjectExtractTitle(pattern, response),
                                sourceUrl: response.url || '',
                                sourceTabId: response.tabId ?? null,
                                content: response.data,
                                meta: {
                                    pattern,
                                    extractedAt: response.extractedAt || new Date().toISOString(),
                                    count: response.count ?? 0
                                }
                            });
                            return {
                                success: true,
                                item,
                                pattern,
                                message: `已提取 ${pattern} 到项目`
                            };
                        }
                        case 'list_templates': {
                            const templates = await projectService.listProjectTemplates();
                            return {
                                success: true,
                                templates: templates.map(template => ({
                                    id: template.id,
                                    name: template.name,
                                    description: template.description || '',
                                    executionMode: template.executionMode || 'foreground',
                                    stepCount: Array.isArray(template.steps) ? template.steps.length : 0,
                                    updatedAt: template.updatedAt
                                })),
                                message: `当前项目共有 ${templates.length} 个模板`
                            };
                        }
                        case 'get_template': {
                            if (!templateId) return { error: "缺少 templateId 参数" };
                            const template = await projectService.getProjectTemplate(templateId);
                            if (!template) {
                                return { error: "模板不存在" };
                            }
                            return {
                                success: true,
                                template,
                                executionMode: template.executionMode || 'foreground',
                                message: `已读取模板 ${template.name}`
                            };
                        }
                        case 'run_template': {
                            let targetTemplateId = templateId || '';
                            if (!targetTemplateId && templateName) {
                                const templates = await projectService.listProjectTemplates();
                                const normalizedName = String(templateName).trim().toLowerCase();
                                const matched = templates.find(template => template.name?.trim().toLowerCase() === normalizedName)
                                    || templates.find(template => template.name?.toLowerCase().includes(normalizedName));
                                if (matched) {
                                    targetTemplateId = matched.id;
                                }
                            }
                            if (!targetTemplateId) {
                                return { error: "缺少 templateId，且无法通过 templateName 匹配模板" };
                            }
                            const result = await projectService.executeProjectTemplate(targetTemplateId, inputPayload);
                            const needsInput = result?.run?.status === 'needs_input';
                            const projectMessage = result?.run?.status === 'success'
                                ? `模板已执行: ${result.run.templateName || targetTemplateId}`
                                : needsInput
                                    ? `模板等待运行时输入: ${result.run.templateName || targetTemplateId}`
                                    : `模板执行失败: ${result?.error || targetTemplateId}`;
                            return {
                                success: result?.run?.status === 'success',
                                run: result?.run || null,
                                item: result?.item || null,
                                requiredInputs: result?.requiredInputs || [],
                                needsInput,
                                executionMode: result?.run?.executionMode || '',
                                error: result?.error || '',
                                message: result?.run?.status === 'success'
                                    ? `模板已执行: ${result.run.templateName || targetTemplateId}`
                                    : `模板执行失败: ${result?.error || targetTemplateId}`
                            };
                        }
                        case 'save_last_task_as_template': {
                            const trace = window.InfinPilotLastSuccessfulAutomationTrace || null;
                            if (!trace || !Array.isArray(trace.toolCalls) || trace.toolCalls.length === 0) {
                                return { error: "当前没有可保存为模板的成功任务" };
                            }
                            const result = await projectService.createTemplateFromExecutionTrace(trace, {
                                projectId: await resolveTargetProjectId(),
                                name: templateTitle,
                                description: templateDescription
                            });
                            if (!result?.success) {
                                return { error: result?.error || "保存模板失败" };
                            }
                            return {
                                success: true,
                                template: result.template,
                                sourceTrace: {
                                    id: trace.id,
                                    userMessage: trace.userMessage || '',
                                    toolCount: trace.toolCalls.length,
                                    completedAt: trace.completedAt || null
                                },
                                message: `已将最近成功任务保存为模板：${result.template?.name || ''}`
                            };
                        }
                        case 'resume_run': {
                            if (!runId) {
                                return { error: "缺少 runId 参数" };
                            }
                            const result = await projectService.resumeProjectRun(runId, inputPayload);
                            const needsInput = result?.run?.status === 'needs_input';
                            const projectMessage = result?.run?.status === 'success'
                                ? `已继续运行: ${result.run.templateName || runId}`
                                : needsInput
                                    ? `运行仍在等待输入: ${result.run.templateName || runId}`
                                    : `继续运行失败: ${result?.error || runId}`;
                            return {
                                success: result?.run?.status === 'success',
                                run: result?.run || null,
                                item: result?.item || null,
                                requiredInputs: result?.requiredInputs || [],
                                needsInput,
                                executionMode: result?.run?.executionMode || '',
                                error: result?.error || '',
                                message: projectMessage
                            };
                        }
                        case 'list_runs': {
                            const runs = await projectService.listProjectRuns(null, toolInput.limit || 8);
                            const templates = await projectService.listProjectTemplates();
                            return {
                                success: true,
                                runs: runs.map(run => ({
                                    id: run.id,
                                    templateId: run.templateId,
                                    templateName: templates.find(template => template.id === run.templateId)?.name || '',
                                    status: run.status,
                                    executionMode: run.outputs?.executionMode || '',
                                    requiredInputs: run.outputs?.requiredInputs || [],
                                    startedAt: run.startedAt,
                                    endedAt: run.endedAt,
                                    error: run.error || ''
                                })),
                                message: `最近运行 ${runs.length} 条`
                            };
                        }
                        default:
                            return { error: `未知的项目操作: ${projectAction}` };
                    }
                } catch (e) {
                    return { error: "项目模板操作失败: " + e.message };
                }
            }
            case 'browser_mcp': {
                const mcpAction = String(toolInput.action || '').trim();
                const refresh = toolInput.refresh === true;
                const serverId = typeof toolInput.serverId === 'string' ? toolInput.serverId.trim() : '';
                const promptName = typeof toolInput.name === 'string' ? toolInput.name.trim() : '';
                const promptArgs = toolInput.arguments && typeof toolInput.arguments === 'object' ? toolInput.arguments : {};
                const uri = typeof toolInput.uri === 'string' ? toolInput.uri.trim() : '';
                const targetProjectId = typeof toolInput.projectId === 'string' ? toolInput.projectId.trim() : '';
                const customTitle = typeof toolInput.title === 'string' ? toolInput.title.trim() : '';

                if (!mcpAction) {
                    return { error: '缺少 action 参数' };
                }

                try {
                    const mcpPrefs = await getMcpAgentPreferences();
                    if (!mcpPrefs.enabled) {
                        return { error: '当前已禁止 Agent 使用 MCP' };
                    }

                    const addRecordToContext = (record) => {
                        const projectTools = window.InfinPilotProjectTools;
                        if (!projectTools || typeof projectTools.addRecordToContext !== 'function') {
                            return { error: '当前界面不支持将 MCP 内容加入上下文' };
                        }
                        const ok = projectTools.addRecordToContext(record);
                        if (!ok) {
                            return { error: '加入上下文失败' };
                        }
                        return {
                            success: true,
                            record,
                            message: `已加入上下文：${record.title || record.meta?.promptName || record.meta?.uri || 'MCP 内容'}`
                        };
                    };

                    const assertServerAllowed = (value) => {
                        if (!value) {
                            return null;
                        }
                        if (mcpPrefs.allowAllServers !== false) {
                            return null;
                        }
                        if (!mcpPrefs.allowedServerIds.includes(value)) {
                            return `当前不允许使用 MCP 服务 ${value}`;
                        }
                        return null;
                    };

                    const filterAllowedServers = (items) => {
                        if (mcpPrefs.allowAllServers !== false) {
                            return items;
                        }
                        return items.filter((item) => mcpPrefs.allowedServerIds.includes(item.id));
                    };

                    const filterAllowedMcpItems = (items) => {
                        if (mcpPrefs.allowAllServers !== false) {
                            return items;
                        }
                        return items.filter((item) => mcpPrefs.allowedServerIds.includes(item.serverId));
                    };

                    switch (mcpAction) {
                        case 'get_state': {
                            const response = await browser.runtime.sendMessage({ action: 'mcp.getState' });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 状态失败' };
                            }
                            const data = response.data || {};
                            const servers = filterAllowedServers(Array.isArray(data.servers) ? data.servers : []);
                            return {
                                success: true,
                                servers,
                                toolCount: servers.reduce((sum, item) => sum + (item.toolCount || 0), 0),
                                resourceCount: servers.reduce((sum, item) => sum + (item.resourceCount || 0), 0),
                                promptCount: servers.reduce((sum, item) => sum + (item.promptCount || 0), 0),
                                message: `已连接 ${servers.length} 个 MCP 服务`
                            };
                        }
                        case 'list_servers': {
                            const response = await browser.runtime.sendMessage({ action: 'mcp.listServers' });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 服务失败' };
                            }
                            const items = filterAllowedServers(Array.isArray(response.data) ? response.data : []);
                            return {
                                success: true,
                                count: items.length,
                                items,
                                message: `共有 ${items.length} 个 MCP 服务`
                            };
                        }
                        case 'list_tools': {
                            const response = await browser.runtime.sendMessage({ action: 'mcp.listTools', refresh });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 工具失败' };
                            }
                            const tools = (Array.isArray(response.data) ? response.data : []).filter((tool) => {
                                if (tool?.meta?.serverId && assertServerAllowed(tool.meta.serverId)) {
                                    return false;
                                }
                                return !serverId || tool?.meta?.serverId === serverId;
                            });
                            return {
                                success: true,
                                count: tools.length,
                                tools,
                                message: `共有 ${tools.length} 个 MCP 工具`
                            };
                        }
                        case 'list_resources': {
                            const denied = assertServerAllowed(serverId);
                            if (denied) {
                                return { error: denied };
                            }
                            const response = await browser.runtime.sendMessage({
                                action: 'mcp.listResources',
                                serverId: serverId || null,
                                refresh
                            });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 资源失败' };
                            }
                            const items = filterAllowedMcpItems(Array.isArray(response.data) ? response.data : []);
                            return {
                                success: true,
                                count: items.length,
                                items,
                                message: `共有 ${items.length} 条 MCP 资源`
                            };
                        }
                        case 'read_resource': {
                            const denied = assertServerAllowed(serverId);
                            if (denied) {
                                return { error: denied };
                            }
                            if (!serverId || !uri) {
                                return { error: 'read_resource 需要 serverId 和 uri' };
                            }
                            const response = await browser.runtime.sendMessage({
                                action: 'mcp.readResource',
                                serverId,
                                uri
                            });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 资源内容失败' };
                            }
                            return {
                                success: true,
                                ...response.data,
                                message: `已读取资源 ${uri}`
                            };
                        }
                        case 'save_resource_to_project': {
                            const denied = assertServerAllowed(serverId);
                            if (denied) {
                                return { error: denied };
                            }
                            if (!serverId || !uri) {
                                return { error: 'save_resource_to_project 需要 serverId 和 uri' };
                            }
                            const response = await browser.runtime.sendMessage({
                                action: 'mcp.readResource',
                                serverId,
                                uri
                            });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 资源内容失败' };
                            }
                            const targetId = targetProjectId || await projectService.getCurrentProjectId();
                            if (!targetId) {
                                return { error: '当前没有可用项目' };
                            }
                            const resourceTitle = customTitle || response.data?.result?.title || response.data?.result?.name || uri;
                            const item = await projectService.addProjectItem({
                                projectId: targetId,
                                type: 'mcp_resource',
                                title: resourceTitle,
                                sourceUrl: '',
                                content: response.data?.result || {},
                                meta: {
                                    serverId,
                                    serverName: response.data?.serverName || '',
                                    uri
                                }
                            });
                            return {
                                success: true,
                                item,
                                message: `已保存 MCP 资源到项目：${item.title}`
                            };
                        }
                        case 'add_resource_to_context': {
                            const denied = assertServerAllowed(serverId);
                            if (denied) {
                                return { error: denied };
                            }
                            if (!serverId || !uri) {
                                return { error: 'add_resource_to_context 需要 serverId 和 uri' };
                            }
                            const response = await browser.runtime.sendMessage({
                                action: 'mcp.readResource',
                                serverId,
                                uri
                            });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 资源内容失败' };
                            }
                            const record = {
                                id: `mcp-resource-${serverId}-${uri}`,
                                type: 'mcp_resource',
                                title: customTitle || response.data?.result?.title || response.data?.result?.name || uri,
                                sourceUrl: '',
                                content: response.data?.result || {},
                                meta: {
                                    serverId,
                                    serverName: response.data?.serverName || '',
                                    uri
                                }
                            };
                            return addRecordToContext(record);
                        }
                        case 'list_prompts': {
                            const denied = assertServerAllowed(serverId);
                            if (denied) {
                                return { error: denied };
                            }
                            const response = await browser.runtime.sendMessage({
                                action: 'mcp.listPrompts',
                                serverId: serverId || null,
                                refresh
                            });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 提示词失败' };
                            }
                            const items = filterAllowedMcpItems(Array.isArray(response.data) ? response.data : []);
                            return {
                                success: true,
                                count: items.length,
                                items,
                                message: `共有 ${items.length} 个 MCP 提示词`
                            };
                        }
                        case 'get_prompt': {
                            const denied = assertServerAllowed(serverId);
                            if (denied) {
                                return { error: denied };
                            }
                            if (!serverId || !promptName) {
                                return { error: 'get_prompt 需要 serverId 和 name' };
                            }
                            const response = await browser.runtime.sendMessage({
                                action: 'mcp.getPrompt',
                                serverId,
                                name: promptName,
                                arguments: promptArgs
                            });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 提示词内容失败' };
                            }
                            return {
                                success: true,
                                ...response.data,
                                message: `已读取提示词 ${promptName}`
                            };
                        }
                        case 'save_prompt_to_project': {
                            const denied = assertServerAllowed(serverId);
                            if (denied) {
                                return { error: denied };
                            }
                            if (!serverId || !promptName) {
                                return { error: 'save_prompt_to_project 需要 serverId 和 name' };
                            }
                            const response = await browser.runtime.sendMessage({
                                action: 'mcp.getPrompt',
                                serverId,
                                name: promptName,
                                arguments: promptArgs
                            });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 提示词内容失败' };
                            }
                            const targetId = targetProjectId || await projectService.getCurrentProjectId();
                            if (!targetId) {
                                return { error: '当前没有可用项目' };
                            }
                            const item = await projectService.addProjectItem({
                                projectId: targetId,
                                type: 'mcp_prompt',
                                title: customTitle || promptName,
                                sourceUrl: '',
                                content: response.data?.result || {},
                                meta: {
                                    serverId,
                                    serverName: response.data?.serverName || '',
                                    promptName
                                }
                            });
                            return {
                                success: true,
                                item,
                                message: `已保存 MCP 提示词到项目：${item.title}`
                            };
                        }
                        case 'add_prompt_to_context': {
                            const denied = assertServerAllowed(serverId);
                            if (denied) {
                                return { error: denied };
                            }
                            if (!serverId || !promptName) {
                                return { error: 'add_prompt_to_context 需要 serverId 和 name' };
                            }
                            const response = await browser.runtime.sendMessage({
                                action: 'mcp.getPrompt',
                                serverId,
                                name: promptName,
                                arguments: promptArgs
                            });
                            if (!response?.success) {
                                return { error: response?.error || '读取 MCP 提示词内容失败' };
                            }
                            const record = {
                                id: `mcp-prompt-${serverId}-${promptName}`,
                                type: 'mcp_prompt',
                                title: customTitle || promptName,
                                sourceUrl: '',
                                content: response.data?.result || {},
                                meta: {
                                    serverId,
                                    serverName: response.data?.serverName || '',
                                    promptName
                                }
                            };
                            return addRecordToContext(record);
                        }
                        default:
                            return { error: `未知的 MCP 操作: ${mcpAction}` };
                    }
                } catch (e) {
                    return { error: 'MCP 操作失败: ' + e.message };
                }
            }
            // ========== Scraping Tools ==========
            case 'scraping_get': {
                const { url, extraction_type, css_selector, xpath_selector, fingerprint, timeout, main_content_only, retries } = toolInput;
                if (!url) return { error: "缺少 url 参数" };

                try {
                    const result = await browser.runtime.sendMessage({
                        action: 'scrapling.get',
                        options: {
                            url,
                            extractionType: extraction_type || 'markdown',
                            cssSelector: css_selector,
                            xpathSelector: xpath_selector,
                            fingerprint: fingerprint || 'chrome',
                            timeout: timeout || 30000,
                            retries: Number.isFinite(retries) ? retries : 1,
                            mainContentOnly: main_content_only !== false
                        }
                    });
                    return result;
                } catch (e) {
                    return { error: "网页抓取失败: " + e.message };
                }
            }
            case 'scraping_extract_structured': {
                const { url, pattern, retries } = toolInput;
                if (!url) return { error: "缺少 url 参数" };
                if (!pattern) return { error: "缺少 pattern 参数" };

                try {
                    const result = await browser.runtime.sendMessage({
                        action: 'scrapling.extractStructured',
                        options: {
                            url,
                            pattern,
                            retries: Number.isFinite(retries) ? retries : 1
                        }
                    });
                    return result;
                } catch (e) {
                    return { error: "结构化提取失败: " + e.message };
                }
            }
            case 'scraping_bulk_get': {
                const { urls, extraction_type, fingerprint, timeout, retries } = toolInput;
                if (!urls || !Array.isArray(urls)) return { error: "缺少 urls 参数或格式不正确" };

                try {
                    const result = await browser.runtime.sendMessage({
                        action: 'scrapling.bulkGet',
                        urls,
                        options: {
                            extractionType: extraction_type || 'markdown',
                            fingerprint: fingerprint || 'chrome',
                            timeout: timeout || 30000,
                            retries: Number.isFinite(retries) ? retries : 1
                        }
                    });
                    return result;
                } catch (e) {
                    return { error: "批量抓取失败: " + e.message };
                }
            }
            case 'scraping_get_links': {
                const { url, limit, retries } = toolInput;
                if (!url) return { error: "缺少 url 参数" };

                try {
                    const result = await browser.runtime.sendMessage({
                        action: 'scrapling.getLinks',
                        options: { url, limit: limit || 50, retries: Number.isFinite(retries) ? retries : 1 }
                    });
                    return result;
                } catch (e) {
                    return { error: "获取链接失败: " + e.message };
                }
            }
            case 'scraping_get_images': {
                const { url, limit, retries } = toolInput;
                if (!url) return { error: "缺少 url 参数" };

                try {
                    const result = await browser.runtime.sendMessage({
                        action: 'scrapling.getImages',
                        options: { url, limit: limit || 30, retries: Number.isFinite(retries) ? retries : 1 }
                    });
                    return result;
                } catch (e) {
                    return { error: "获取图片失败: " + e.message };
                }
            }
            case 'scraping_current_page': {
                const { extraction_type, css_selector, visible_only, timeout_ms } = toolInput;

                // 获取当前标签页
                const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
                if (!tab?.id) return { error: "没有活动标签页" };

                // 检查是否为受限页面
                if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://') || tab.url.startsWith('moz-extension://'))) {
                    return { error: `无法访问受限页面: ${tab.url}` };
                }

                try {
                    const result = await browser.tabs.sendMessage(tab.id, {
                        action: 'extractPageContent',
                        options: {
                            extractionType: extraction_type || 'markdown',
                            cssSelector: css_selector,
                            visibleOnly: visible_only !== false,
                            timeoutMs: Number.isFinite(timeout_ms) ? timeout_ms : 1500
                        }
                    });
                    return { ...result, url: tab.url, title: tab.title };
                } catch (e) {
                    return { error: "获取页面内容失败: " + e.message };
                }
            }
            // ========== Jina AI 网页内容获取工具 ==========
            case 'jina_ai_get_content': {
                const { url, max_length } = toolInput;
                if (!url) return { error: "缺少 url 参数" };

                try {
                    // 拼接 Jina AI URL
                    const jinaUrl = `https://r.jina.ai/${url}`;
                    const response = await runtimeFetch(jinaUrl, {
                        method: 'GET',
                        headers: {
                            'Accept': 'text/plain'
                        }
                    });

                    if (!response.ok) {
                        return { error: `请求失败: ${response.status} ${response.statusText}` };
                    }

                    let content = await response.text();

                    // 如果超过 max_length，则截断内容
                    if (max_length && content.length > max_length) {
                        content = content.substring(0, max_length) + '\n\n[内容已截断，超出最大长度限制]';
                    }

                    return {
                        success: true,
                        url: url,
                        content: content,
                        content_length: content.length
                    };
                } catch (e) {
                    return { error: "获取网页内容失败: " + e.message };
                }
            }
            // ========== Sub Agent 调用工具 ==========
            case 'invoke_sub_agent': {
                // 支持多种参数命名格式和 JSON 字符串
                let agent_name = toolInput.agent_name || toolInput.agent_id || '';
                let task = toolInput.task || toolInput.task_description || toolInput.research_goal || '';
                let visible_tools = toolInput.visible_tools || toolInput.tools || [];
                let context = toolInput.context || '';

                // 如果是字符串，则尝试解析为 JSON
                if (typeof visible_tools === 'string') {
                    try {
                        visible_tools = JSON.parse(visible_tools);
                    } catch (e) {
                        // 如果解析失败，可能是单个工具名
                        visible_tools = [visible_tools];
                    }
                }

                if (!agent_name || !task || !visible_tools || !Array.isArray(visible_tools) || visible_tools.length === 0) {
                    return { error: "缺少必要参数: agent_name, task, visible_tools" };
                }

                // 检查 SubAgentEngine 是否已初始化
                if (!window.DeepResearch || !window.DeepResearch.subAgentEngine) {
                    return { error: "Sub Agent 引擎未初始化，请在 Deep Research 模式下使用" };
                }

                try {
                    const engine = window.DeepResearch.subAgentEngine;
                    // 获取主 Agent 的消息历史
                    const mainAgentMessages = window.DeepResearch.mainAgentMessages || [];

                    const result = await engine.executeSubAgent({
                        agent_name,
                        task,
                        visible_tools,
                        context
                    }, mainAgentMessages);

                    // 格式化返回结果
                    return {
                        sub_agent_result: result
                    };
                } catch (e) {
                    return { error: "Sub Agent 执行失败: " + e.message };
                }
            }
            case 'invoke_sub_agents': {
                // 支持 agents 和 sub_agents 两种参数名
                let agents = toolInput.agents || toolInput.sub_agents || toolInput.agent_descriptions;

                // 如果是字符串，则尝试解析为 JSON
                if (typeof agents === 'string') {
                    try {
                        agents = JSON.parse(agents);
                    } catch (e) {
                        return { error: "agents 参数格式不正确，无法解析 JSON: " + e.message };
                    }
                }

                if (!agents || !Array.isArray(agents) || agents.length === 0) {
                    return { error: "缺少 agents 参数或格式不正确" };
                }

                // 统一参数格式，映射各种可能的字段名
                agents = agents.map((agent, index) => ({
                    agent_name: agent.agent_id || agent.AGENT_ID || agent.agent_name || agent.AGENT_NAME || '',
                    task: agent.task_description || agent.TASK || agent.task || '',
                    visible_tools: agent.visible_tools || agent.tools || [],
                    context: agent.context || agent.topic || '',
                    // 支持依赖关系，例如 [0, 1] 表示依赖前两个任务
                    depends_on: agent.depends_on || agent.dependencies || agent.DEPENDS_ON || []
                }));

                // 检查 SubAgentEngine 是否已初始化
                if (!window.DeepResearch || !window.DeepResearch.subAgentEngine) {
                    return { error: "Sub Agent 引擎未初始化，请在 Deep Research 模式下使用" };
                }

                // 检查是否已有待执行的计划，用户确认后模型会再次调用本工具
                const pendingPlan = window.DeepResearch.pendingResearchPlan;
                const isPlanPhase = window.DeepResearch.isPlanPhase;

                console.log('[DeepResearch] invoke_sub_agents called:', {
                    hasPendingPlan: !!pendingPlan,
                    isPlanPhase,
                    pendingPlanAgents: pendingPlan?.agents?.length,
                    hasEngine: !!(window.DeepResearch?.subAgentEngine)
                });

                // 如果已有待执行计划，或当前不在计划阶段，则直接执行
                if (pendingPlan || !isPlanPhase) {
                    // 如果已有待执行计划，或不处于计划阶段，则直接执行
                    console.log('[DeepResearch] Executing plan (not in plan phase)...', {
                        hasPendingPlan: !!pendingPlan,
                        isPlanPhase,
                        agentsCount: agents?.length
                    });

                    // 优先使用 pendingPlan 中的 agents，否则使用当前传入的 agents
                    const agentsToExecute = pendingPlan ? pendingPlan.agents : agents;
                    const mainAgentMessages = pendingPlan ? pendingPlan.mainAgentMessages : (window.DeepResearch.mainAgentMessages || []);

                    console.log('[DeepResearch] agentsToExecute:', JSON.stringify(agentsToExecute, null, 2));

                    try {
                        const engine = window.DeepResearch.subAgentEngine;
                        if (!engine) {
                            console.error('[DeepResearch] ERROR: subAgentEngine is null!');
                            return { error: "Sub Agent 寮曟搸鏈垵濮嬪寲" };
                        }
                        const results = await engine.executeSubAgentsParallel(agentsToExecute, mainAgentMessages);

                        // 清理计划阶段状态
                        window.DeepResearch.pendingResearchPlan = null;
                        window.DeepResearch.isPlanPhase = false;

                        return {
                            sub_agents_results: results
                        };
                    } catch (e) {
                        return { error: "执行计划失败: " + e.message };
                    }
                }

                // 计划阶段：保存计划，等待用户确认
                console.log('[DeepResearch] Plan phase - saving plan for later execution');

                window.DeepResearch.pendingResearchPlan = {
                    agents: agents,
                    mainAgentMessages: window.DeepResearch.mainAgentMessages || []
                };

                // 返回计划详情，提示用户确认
                return {
                    __type: 'PLAN_CREATED',
                    __instruction: '【重要】你已经完成研究计划制定。现在请：1. 将上面的计划整理并展示给用户；2. 直接结束本轮回复，不要继续执行；3. 等用户确认后，再次调用本工具执行计划。',
                    message: '【研究计划已制定】请确认以下计划：',
                    agents: agents.map((a, i) => ({
                        index: i + 1,
                        agent_name: a.agent_name,
                        task: a.task,
                        visible_tools: a.visible_tools
                    })),
                    confirm_prompt: '请回复“确认”或“开始执行”来执行计划。'
                };
            }

            // ========== 智能搜索工具 ==========
            case 'dom_find_similar': {
                const { selector, index, similarity_threshold, match_text, limit } = toolInput;
                if (!selector) return { error: "缺少 selector 参数" };

                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                try {
                    const result = await browser.tabs.sendMessage(tabId, {
                        action: 'dom.find_similar',
                        args: {
                            selector,
                            index: index || 0,
                            similarityThreshold: similarity_threshold || 0.2,
                            matchText: match_text || false,
                            limit: limit || 20
                        }
                    });
                    return result;
                } catch (e) {
                    return { error: "查找相似元素失败: " + e.message };
                }
            }
            case 'dom_find_by_text': {
                const { text, partial, case_sensitive, tag_name, limit } = toolInput;
                if (!text) return { error: "缺少 text 参数" };

                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                try {
                    const result = await browser.tabs.sendMessage(tabId, {
                        action: 'dom.find_by_text',
                        args: {
                            text,
                            partial: partial !== false,
                            caseSensitive: case_sensitive || false,
                            tagName: tag_name,
                            limit: limit || 20
                        }
                    });
                    return result;
                } catch (e) {
                    return { error: "文本搜索失败: " + e.message };
                }
            }
            case 'dom_find_by_regex': {
                const { pattern, flags, target, tag_name, limit } = toolInput;
                if (!pattern) return { error: "缺少 pattern 参数" };

                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                try {
                    const result = await browser.tabs.sendMessage(tabId, {
                        action: 'dom.find_by_regex',
                        args: {
                            pattern,
                            flags: flags || '',
                            target: target || 'text',
                            tagName: tag_name,
                            limit: limit || 20
                        }
                    });
                    return result;
                } catch (e) {
                    return { error: "正则搜索失败: " + e.message };
                }
            }
            case 'dom_find_by_filter': {
                const { selector, filter_type, filter_value, limit } = toolInput;
                if (!filter_type) return { error: "缺少 filter_type 参数" };

                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的标签页" };

                try {

                    const result = await browser.tabs.sendMessage(tabId, {
                        action: 'dom.find_by_filter',
                        args: {
                            selector: selector || '*',
                            filterType: filter_type,
                            filterValue: filter_value,
                            limit: limit || 20
                        }
                    });
                    return result;
                } catch (e) {
                    return { error: "过滤搜索失败: " + e.message };
                }
            }
            default:
                return { error: `未知工具: ${toolName}` };
        }
    } catch (error) {
        console.error('[Automation] Tool execution error:', error);
        return { error: error.message };
    }
}

// 导出 executeBrowserTool 到全局，供 SubAgentEngine 调用
const FOREGROUND_BROWSER_TOOLS = new Set([
    'browser_navigate',
    'browser_open_url',
    'browser_switch_tab',
    'browser_click',
    'browser_fill_input',
    'browser_press_key',
    'browser_scroll',
    'browser_screenshot',
    'browser_reload_tab'
]);

function initializeBrowserExecutionContext(executionContext) {
    if (!executionContext || typeof executionContext !== 'object') {
        return null;
    }
    executionContext.currentTabId = executionContext.currentTabId || null;
    executionContext.tabStates = executionContext.tabStates || {};
    executionContext.createdTabIds = Array.isArray(executionContext.createdTabIds) ? executionContext.createdTabIds : [];
    executionContext.adoptedTabIds = Array.isArray(executionContext.adoptedTabIds) ? executionContext.adoptedTabIds : [];
    executionContext.preserveTabIds = Array.isArray(executionContext.preserveTabIds) ? executionContext.preserveTabIds : [];
    executionContext.lastInteractedTabId = executionContext.lastInteractedTabId || null;
    executionContext.hasInteractiveBrowserActions = executionContext.hasInteractiveBrowserActions === true;
    executionContext.shouldPreserveCurrentTab = executionContext.shouldPreserveCurrentTab === true;
    executionContext.forceForeground = executionContext.forceForeground === true;
    executionContext.browserActionCount = Number.isFinite(executionContext.browserActionCount) ? executionContext.browserActionCount : 0;
    return executionContext;
}

function shouldScheduleForegroundBrowserTool(toolName, executionContext) {
    if (!executionContext?.executionId) {
        return false;
    }
    if (executionContext.forceForeground === true) {
        return FOREGROUND_BROWSER_TOOLS.has(toolName);
    }
    return ['browser_click', 'browser_fill_input', 'browser_press_key', 'browser_scroll', 'browser_screenshot'].includes(toolName);
}

function formatForegroundBrowserTaskLabel(task) {
    const agentLabel = task?.agentName || task?.executionId || '子 Agent';
    if (task?.templateName || task?.templateId) {
        return `${agentLabel} · ${task.templateName || task.templateId}`;
    }
    if (task?.toolName) {
        return `${agentLabel} · ${task.toolName}`;
    }
    return task?.label || agentLabel;
}

async function executeBrowserTool(toolName, toolInput, executionContext) {
    if (isMcpToolName(toolName)) {
        try {
            const response = await browser.runtime.sendMessage({
                action: 'mcp.callTool',
                toolName,
                args: toolInput || {}
            });
            if (!response?.success) {
                return { error: response?.error || 'MCP tool call failed' };
            }
            return response.data;
        } catch (error) {
            return { error: error.message || String(error) };
        }
    }

    const pageTools = new Set([
        'browser_navigate',
        'browser_open_url',
        'browser_get_current_tab',
        'browser_list_tabs',
        'browser_switch_tab',
        'browser_close_tab',
        'browser_reload_tab',
        'browser_bookmarks',
        'browser_history',
        'browser_windows',
        'browser_downloads',
        'browser_get_dom',
        'browser_get_visible_text',
        'browser_click',
        'browser_fill_input',
        'browser_press_key',
        'browser_wait',
        'browser_scroll',
        'browser_screenshot'
    ]);

    if (!pageTools.has(toolName)) {
        return executeBrowserToolLegacy(toolName, toolInput, executionContext);
    }

    const startTime = Date.now();
    console.log(`[Automation][T+${startTime % 10000}] Executing tool:`, toolName, 'with context:', executionContext?.executionId);
    const context = initializeBrowserExecutionContext(executionContext);
    const engine = window.DeepResearch?.subAgentEngine;

    const trackTab = (tabId, metadata = {}) => {
        if (!tabId || !context) {
            return;
        }
        if (typeof engine?.trackSubAgentTab === 'function') {
            engine.trackSubAgentTab(tabId, context, metadata);
            return;
        }
        const currentState = context.tabStates[tabId] || { tabId };
        context.tabStates[tabId] = { ...currentState, ...metadata, tabId };
        if (metadata.createdBySubAgent === true && !context.createdTabIds.includes(tabId)) {
            context.createdTabIds.push(tabId);
        }
        if (metadata.adopted === true && !context.adoptedTabIds.includes(tabId)) {
            context.adoptedTabIds.push(tabId);
        }
        if (metadata.keepOpen === true && !context.preserveTabIds.includes(tabId)) {
            context.preserveTabIds.push(tabId);
        }
        if (metadata.setCurrent === true || !context.currentTabId) {
            context.currentTabId = tabId;
        }
        if (metadata.interacted === true) {
            context.lastInteractedTabId = tabId;
            context.hasInteractiveBrowserActions = true;
        }
        context.browserActionCount += 1;
    };

    const removeTrackedTab = (tabId) => {
        if (!tabId || !context) {
            return;
        }
        delete context.tabStates[tabId];
        context.createdTabIds = context.createdTabIds.filter((id) => id !== tabId);
        context.adoptedTabIds = context.adoptedTabIds.filter((id) => id !== tabId);
        context.preserveTabIds = context.preserveTabIds.filter((id) => id !== tabId);
        if (context.currentTabId === tabId) {
            context.currentTabId = null;
        }
        if (context.lastInteractedTabId === tabId) {
            context.lastInteractedTabId = null;
        }
    };

    const getTargetTabId = async (fallbackToActive = true) => {
        if (context?.currentTabId) {
            return context.currentTabId;
        }
        if (fallbackToActive) {
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (tab?.id && context) {
                trackTab(tab.id, { adopted: true, setCurrent: true });
            }
            return tab?.id || null;
        }
        return null;
    };

    const ensurePageTab = async (tabId) => {
        let tab;
        try {
            tab = await browser.tabs.get(tabId);
        } catch (error) {
            throw new Error(`无法获取标签页: ${error.message}`);
        }
        if (tab?.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://') || tab.url.startsWith('moz-extension://'))) {
            throw new Error(`无法访问受限页面: ${tab.url}`);
        }
        return tab;
    };

    const ensureContentScript = async (tabId, frameId = null) => {
        const target = frameId != null
            ? { tabId, frameIds: [frameId] }
            : { tabId };
        await browser.scripting.executeScript({
            target,
            files: ['js/content.js']
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
    };

    const sendMessageWithInjection = async (tabId, payload, failurePrefix, messageOptions = undefined) => {
        try {
            return await browser.tabs.sendMessage(tabId, payload, messageOptions);
        } catch (error) {
            if (error.message.includes('Receiving end does not exist')) {
                try {
                    await ensureContentScript(tabId, messageOptions?.frameId ?? null);
                    return await browser.tabs.sendMessage(tabId, payload, messageOptions);
                } catch (retryError) {
                    return { error: `${failurePrefix}: ${retryError.message}` };
                }
            }
            return { error: `${failurePrefix}: ${error.message}` };
        }
    };

    const buildElementPayload = (action) => ({
        action,
        selector: toolInput.selector,
        text: toolInput.text,
        labelText: toolInput.labelText,
        placeholder: toolInput.placeholder,
        ariaLabel: toolInput.ariaLabel,
        role: toolInput.role,
        name: toolInput.name,
        tagName: toolInput.tagName,
        index: Number.isFinite(toolInput.index) ? toolInput.index : 0,
        exactText: toolInput.exactText === true,
        partialText: toolInput.partialText !== false,
        visibleOnly: toolInput.visibleOnly !== false,
        timeoutMs: Number.isFinite(toolInput.timeoutMs) ? toolInput.timeoutMs : undefined,
        maxLength: Number.isFinite(toolInput.maxLength) ? toolInput.maxLength : undefined,
        outerHTML: toolInput.outerHTML === true,
        value: toolInput.value,
        clearFirst: toolInput.clearFirst !== false,
        key: toolInput.key,
        code: toolInput.code,
        direction: toolInput.direction,
        amount: toolInput.amount
    });

    const buildMessageOptions = () => (
        Number.isFinite(toolInput.frameId)
            ? { frameId: toolInput.frameId }
            : undefined
    );

    const waitForTabSettled = async (tabId, options = {}) => {
        const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 12000;
        const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 250;
        const startTime = Date.now();
        let lastTab = null;

        while ((Date.now() - startTime) < timeoutMs) {
            try {
                lastTab = await browser.tabs.get(tabId);
            } catch (error) {
                throw new Error(`等待标签页加载失败: ${error.message}`);
            }

            if (!lastTab || lastTab.status === 'complete') {
                if (settleMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, settleMs));
                }
                return lastTab;
            }

            await new Promise((resolve) => setTimeout(resolve, 150));
        }

        if (settleMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, settleMs));
        }
        return lastTab;
    };

    const normalizeBookmarkToken = (value) => String(value || '').trim().toLowerCase();
    const normalizeBookmarkPath = (value) => String(value || '')
        .split(/[\\/]+/)
        .map((part) => normalizeBookmarkToken(part))
        .filter(Boolean)
        .join('/');
    const getBookmarkDisplayTitle = (node) => {
        if (typeof node?.title === 'string' && node.title.trim()) {
            return node.title.trim();
        }
        if (node?.url) {
            return node.url;
        }
        return '未命名收藏夹';
    };
    const bookmarkNodeToItem = (node, parentParts = []) => {
        const title = getBookmarkDisplayTitle(node);
        const path = [...parentParts, title].join(' / ');
        return {
            id: String(node.id),
            parentId: node.parentId != null ? String(node.parentId) : null,
            title,
            url: node.url || '',
            path,
            type: node.url ? 'bookmark' : 'folder',
            index: typeof node.index === 'number' ? node.index : null,
            dateAdded: typeof node.dateAdded === 'number' ? node.dateAdded : null
        };
    };
    const flattenBookmarkNodes = (nodes, parentParts = []) => {
        const items = [];
        for (const node of Array.isArray(nodes) ? nodes : []) {
            const isRootNode = node?.parentId == null && !node?.url && !String(node?.title || '').trim();
            const title = getBookmarkDisplayTitle(node);
            const nextParts = isRootNode ? parentParts : [...parentParts, title];
            const path = nextParts.join(' / ');
            if (!isRootNode) {
                items.push({
                    ...bookmarkNodeToItem(node, parentParts),
                    path
                });
            }
            if (Array.isArray(node.children) && node.children.length > 0) {
                items.push(...flattenBookmarkNodes(node.children, nextParts));
            }
        }
        return items;
    };
    const getBookmarkSnapshot = async () => {
        if (!browser.bookmarks || typeof browser.bookmarks.getTree !== 'function') {
            throw new Error('当前浏览器环境不支持书签 API 或缺少书签权限');
        }
        const tree = await browser.bookmarks.getTree();
        const root = Array.isArray(tree) ? tree[0] || null : null;
        const flat = flattenBookmarkNodes(tree);
        const byId = new Map(flat.map((item) => [item.id, item]));
        return { tree, root, flat, byId };
    };
    const filterBookmarkItems = (items, options = {}) => {
        const {
            type = '',
            title = '',
            query = '',
            path = '',
            parentId = '',
            includeFolders = true
        } = options;
        const normalizedTitle = normalizeBookmarkToken(title);
        const normalizedQuery = normalizeBookmarkToken(query);
        const normalizedPath = normalizeBookmarkPath(path);
        const normalizedParentId = parentId != null && parentId !== '' ? String(parentId) : '';

        return (Array.isArray(items) ? items : [])
            .filter((item) => {
                if (type && item.type !== type) {
                    return false;
                }
                if (includeFolders === false && item.type === 'folder') {
                    return false;
                }
                if (normalizedParentId && item.parentId !== normalizedParentId) {
                    return false;
                }
                if (normalizedPath) {
                    const itemPath = normalizeBookmarkPath(item.path);
                    if (itemPath !== normalizedPath && !itemPath.endsWith(`/${normalizedPath}`)) {
                        return false;
                    }
                }
                if (normalizedTitle) {
                    const itemTitle = normalizeBookmarkToken(item.title);
                    if (itemTitle !== normalizedTitle && !itemTitle.includes(normalizedTitle)) {
                        return false;
                    }
                }
                if (normalizedQuery) {
                    const haystacks = [item.title, item.url, item.path];
                    if (!haystacks.some((candidate) => normalizeBookmarkToken(candidate).includes(normalizedQuery))) {
                        return false;
                    }
                }
                return true;
            })
            .sort((left, right) => {
                const leftPath = normalizeBookmarkPath(left.path);
                const rightPath = normalizeBookmarkPath(right.path);
                if (normalizedPath) {
                    const leftExact = leftPath === normalizedPath ? 0 : 1;
                    const rightExact = rightPath === normalizedPath ? 0 : 1;
                    if (leftExact !== rightExact) {
                        return leftExact - rightExact;
                    }
                }
                if (normalizedTitle) {
                    const leftTitle = normalizeBookmarkToken(left.title);
                    const rightTitle = normalizeBookmarkToken(right.title);
                    const leftExact = leftTitle === normalizedTitle ? 0 : 1;
                    const rightExact = rightTitle === normalizedTitle ? 0 : 1;
                    if (leftExact !== rightExact) {
                        return leftExact - rightExact;
                    }
                }
                return left.path.localeCompare(right.path, 'zh-Hans-CN');
            });
    };
    const normalizeHistoryItem = (item) => ({
        id: item?.id != null ? String(item.id) : '',
        url: item?.url || '',
        title: item?.title || item?.url || '',
        lastVisitTime: typeof item?.lastVisitTime === 'number' ? item.lastVisitTime : null,
        visitCount: typeof item?.visitCount === 'number' ? item.visitCount : 0,
        typedCount: typeof item?.typedCount === 'number' ? item.typedCount : 0
    });
    const normalizeWindowItem = (win) => ({
        id: typeof win?.id === 'number' ? win.id : null,
        focused: win?.focused === true,
        incognito: win?.incognito === true,
        state: win?.state || 'normal',
        type: win?.type || 'normal',
        tabCount: Array.isArray(win?.tabs) ? win.tabs.length : 0,
        tabs: Array.isArray(win?.tabs)
            ? win.tabs.map((tab) => ({
                id: tab.id,
                title: tab.title || '',
                url: tab.url || '',
                active: tab.active === true,
                pinned: tab.pinned === true
            }))
            : []
    });
    const normalizeDownloadItem = (item) => ({
        id: typeof item?.id === 'number' ? item.id : null,
        url: item?.url || '',
        filename: item?.filename || '',
        state: item?.state || '',
        exists: item?.exists === true,
        totalBytes: typeof item?.totalBytes === 'number' ? item.totalBytes : null,
        bytesReceived: typeof item?.bytesReceived === 'number' ? item.bytesReceived : null,
        mime: item?.mime || '',
        startTime: item?.startTime || '',
        endTime: item?.endTime || '',
        estimatedEndTime: item?.estimatedEndTime || ''
    });
    const findCurrentWindowId = async () => {
        if (context?.currentTabId) {
            try {
                const tab = await browser.tabs.get(context.currentTabId);
                if (typeof tab?.windowId === 'number') {
                    return tab.windowId;
                }
            } catch (_) {
                // Ignore and fall back.
            }
        }
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        return typeof activeTab?.windowId === 'number' ? activeTab.windowId : undefined;
    };
    const resolveHistoryCandidates = (items, { url = '', title = '', query = '' } = {}) => {
        const normalizedUrl = String(url || '').trim();
        const normalizedTitle = String(title || '').trim().toLowerCase();
        const normalizedQuery = String(query || '').trim().toLowerCase();
        return (Array.isArray(items) ? items : []).filter((item) => {
            if (normalizedUrl && item.url !== normalizedUrl) {
                return false;
            }
            if (normalizedTitle && !String(item.title || '').toLowerCase().includes(normalizedTitle)) {
                return false;
            }
            if (normalizedQuery) {
                const haystacks = [item.title, item.url];
                if (!haystacks.some((candidate) => String(candidate || '').toLowerCase().includes(normalizedQuery))) {
                    return false;
                }
            }
            return true;
        }).sort((left, right) => (right.lastVisitTime || 0) - (left.lastVisitTime || 0));
    };

    const activateTabForForeground = async (tabId) => {
        if (!tabId) {
            return;
        }
        try {
            const response = await browser.runtime.sendMessage({
                action: 'activateForegroundTab',
                tabId
            });
            if (response?.success) {
                await new Promise((resolve) => setTimeout(resolve, 120));
                return;
            }
        } catch (_) {
            // Fall through to direct activation as a local fallback.
        }

        try {
            const tab = await browser.tabs.get(tabId);
            await browser.tabs.update(tabId, { active: true });
            if (tab?.windowId !== undefined && browser.windows?.update) {
                await browser.windows.update(tab.windowId, { focused: true });
            }
            await new Promise((resolve) => setTimeout(resolve, 120));
        } catch (error) {
            console.warn('[Automation] Failed to activate tab for foreground work:', tabId, error);
        }
    };

    const runWithForegroundScheduler = async (tabId, runner) => {
        if (!shouldScheduleForegroundBrowserTool(toolName, context)) {
            return runner();
        }
        const scheduler = window.InfinPilotExecutionScheduler;
        if (!scheduler || typeof scheduler.runForeground !== 'function') {
            return runner();
        }
        return scheduler.runForeground({
            source: 'browser_tool',
            toolName,
            agentName: context?.agentName || '',
            executionId: context?.executionId || '',
            label: formatForegroundBrowserTaskLabel({
                toolName,
                agentName: context?.agentName,
                executionId: context?.executionId
            })
        }, async () => {
            await activateTabForForeground(tabId);
            return runner();
        });
    };

    try {
        switch (toolName) {
            case 'browser_navigate': {
                const url = toolInput.url;
                if (!url) return { error: "缺少 URL 参数" };
                if (context) {
                    const shouldActivate = toolInput.active !== false;
                    const navigateInContext = async () => {
                        let tab;
                        if (context.currentTabId) {
                            tab = await browser.tabs.update(context.currentTabId, { url, active: false });
                            trackTab(tab.id, {
                                adopted: !context.createdTabIds.includes(tab.id),
                                setCurrent: true,
                                keepOpen: shouldActivate
                            });
                        } else {
                            tab = await browser.tabs.create({ url, active: false });
                            trackTab(tab.id, {
                                createdBySubAgent: true,
                                setCurrent: true,
                                keepOpen: shouldActivate
                            });
                        }
                        if (shouldActivate) {
                            context.shouldPreserveCurrentTab = true;
                        }
                        await waitForTabSettled(tab.id);
                        return { success: true, message: `已导航到 ${url}`, tabId: tab.id, active: shouldActivate };
                    };

                    if (shouldActivate && context.currentTabId) {
                        return runWithForegroundScheduler(context.currentTabId, navigateInContext);
                    }

                    const result = await navigateInContext();
                    if (shouldActivate && result?.tabId) {
                        return runWithForegroundScheduler(result.tabId, async () => result);
                    }
                    return result;
                }
                return executeBrowserToolLegacy(toolName, toolInput, executionContext);
            }
            case 'browser_open_url': {
                const url = toolInput.url;
                if (!url) return { error: "缺少 URL 参数" };
                if (!context) {
                    const tab = await browser.tabs.create({ url, active: toolInput.active !== false });
                    await waitForTabSettled(tab.id);
                    return { success: true, message: `已打开 ${url}`, tabId: tab.id, active: tab.active === true };
                }
                const shouldActivate = toolInput.active !== false;
                const tab = await browser.tabs.create({ url, active: false });
                trackTab(tab.id, {
                    createdBySubAgent: true,
                    setCurrent: true,
                    keepOpen: shouldActivate
                });
                if (shouldActivate) {
                    context.shouldPreserveCurrentTab = true;
                    return runWithForegroundScheduler(tab.id, async () => {
                        await waitForTabSettled(tab.id);
                        return {
                            success: true,
                            message: `已打开 ${url}`,
                            tabId: tab.id,
                            active: true
                        };
                    });
                }
                await waitForTabSettled(tab.id);
                return { success: true, message: `已打开 ${url}`, tabId: tab.id, active: false };
            }
            case 'browser_get_current_tab': {
                if (!context) {
                    return executeBrowserToolLegacy(toolName, toolInput, executionContext);
                }
                const targetTabId = context.currentTabId || null;
                const tab = targetTabId
                    ? await browser.tabs.get(targetTabId)
                    : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
                if (!tab) return { error: "没有可用的目标标签页" };
                trackTab(tab.id, { adopted: !context.createdTabIds.includes(tab.id), setCurrent: true });
                return { id: tab.id, title: tab.title, url: tab.url, active: tab.active };
            }
            case 'browser_list_tabs':
                return executeBrowserToolLegacy(toolName, toolInput, executionContext);
            case 'browser_switch_tab': {
                if (!toolInput.tabId) return { error: "缺少 tabId 参数" };
                if (!context) {
                    return executeBrowserToolLegacy(toolName, toolInput, executionContext);
                }
                return runWithForegroundScheduler(toolInput.tabId, async () => {
                    const tab = await browser.tabs.get(toolInput.tabId);
                    trackTab(tab.id, {
                        adopted: !context.createdTabIds.includes(tab.id),
                        setCurrent: true,
                        keepOpen: true
                    });
                    context.shouldPreserveCurrentTab = true;
                    return {
                        success: true,
                        message: `已切换目标标签页: ${tab.title}`,
                        tabId: tab.id,
                        active: true
                    };
                });
            }
            case 'browser_close_tab': {
                const targetTabId = toolInput.tabId || await getTargetTabId(true);
                if (!targetTabId) {
                    return { error: "没有可关闭的目标标签页" };
                }
                await browser.tabs.remove(targetTabId);
                removeTrackedTab(targetTabId);
                return { success: true, message: `已关闭目标标签页 ${targetTabId}`, tabId: targetTabId };
            }
            case 'browser_reload_tab': {
                const targetTabId = toolInput.tabId || await getTargetTabId(true);
                if (!targetTabId) {
                    return { error: "没有可刷新的目标标签页" };
                }
                return runWithForegroundScheduler(targetTabId, async () => {
                    await browser.tabs.reload(targetTabId, { bypassCache: toolInput.bypassCache || false });
                    await waitForTabSettled(targetTabId);
                    if (context) {
                        trackTab(targetTabId, {
                            setCurrent: true,
                            interacted: true,
                            adopted: !context.createdTabIds.includes(targetTabId)
                        });
                    }
                    return { success: true, message: `已刷新目标标签页 ${targetTabId}`, tabId: targetTabId };
                });
            }
            case 'browser_bookmarks': {
                const bookmarkAction = String(toolInput.action || '').trim();
                if (!bookmarkAction) {
                    return { error: "缺少 action 参数" };
                }

                const limit = Math.max(1, Math.min(Number.isFinite(toolInput.limit) ? toolInput.limit : 20, 50));
                const shouldActivate = toolInput.active !== false;

                if (bookmarkAction === 'list_roots') {
                    const snapshot = await getBookmarkSnapshot();
                    const items = Array.isArray(snapshot.root?.children)
                        ? snapshot.root.children.map((node) => bookmarkNodeToItem(node)).filter((item) => item.type === 'folder')
                        : [];
                    return {
                        success: true,
                        action: bookmarkAction,
                        count: items.length,
                        items
                    };
                }

                const snapshot = await getBookmarkSnapshot();
                const resolveSingleBookmarkItem = (expectedType) => {
                    if (expectedType === 'bookmark' && toolInput.bookmarkId) {
                        const item = snapshot.byId.get(String(toolInput.bookmarkId));
                        if (!item || item.type !== 'bookmark') {
                            return { error: '未找到指定书签 ID' };
                        }
                        return { item };
                    }
                    if (expectedType === 'folder' && toolInput.folderId) {
                        const item = snapshot.byId.get(String(toolInput.folderId));
                        if (!item || item.type !== 'folder') {
                            return { error: '未找到指定收藏夹 ID' };
                        }
                        return { item };
                    }

                    const candidates = filterBookmarkItems(snapshot.flat, {
                        type: expectedType,
                        title: toolInput.title,
                        query: toolInput.query,
                        path: toolInput.path,
                        parentId: toolInput.parentId,
                        includeFolders: toolInput.includeFolders !== false
                    });

                    if (candidates.length === 0) {
                        return { error: expectedType === 'folder' ? '未找到匹配的收藏夹' : '未找到匹配的书签' };
                    }
                    if (candidates.length > 1) {
                        return {
                            error: `找到多个匹配的${expectedType === 'folder' ? '收藏夹' : '书签'}，请改用 ID 精确指定`,
                            count: candidates.length,
                            items: candidates.slice(0, Math.min(limit, 10))
                        };
                    }
                    return { item: candidates[0] };
                };

                switch (bookmarkAction) {
                    case 'list_children': {
                        const resolved = resolveSingleBookmarkItem('folder');
                        if (resolved.error) {
                            return resolved;
                        }
                        const subtree = await browser.bookmarks.getSubTree(resolved.item.id);
                        const folderNode = subtree?.[0];
                        if (!folderNode) {
                            return { error: '无法读取指定收藏夹内容' };
                        }

                        const items = toolInput.recursive === true
                            ? flattenBookmarkNodes(folderNode.children || [], [resolved.item.title]).slice(0, limit)
                            : (folderNode.children || []).map((node) => bookmarkNodeToItem(node, [resolved.item.title])).slice(0, limit);

                        return {
                            success: true,
                            action: bookmarkAction,
                            folder: resolved.item,
                            count: items.length,
                            items
                        };
                    }
                    case 'search': {
                        const filtered = filterBookmarkItems(snapshot.flat, {
                            title: toolInput.title,
                            query: toolInput.query,
                            path: toolInput.path,
                            parentId: toolInput.parentId,
                            includeFolders: toolInput.includeFolders !== false
                        }).slice(0, limit);

                        return {
                            success: true,
                            action: bookmarkAction,
                            count: filtered.length,
                            items: filtered
                        };
                    }
                    case 'get_path': {
                        const resolved = toolInput.bookmarkId
                            ? resolveSingleBookmarkItem('bookmark')
                            : toolInput.folderId
                                ? resolveSingleBookmarkItem('folder')
                                : resolveSingleBookmarkItem(toolInput.includeFolders === true ? '' : 'bookmark');
                        if (resolved.error) {
                            return resolved;
                        }
                        return {
                            success: true,
                            action: bookmarkAction,
                            item: resolved.item,
                            path: resolved.item.path
                        };
                    }
                    case 'open_bookmark': {
                        const resolved = resolveSingleBookmarkItem('bookmark');
                        if (resolved.error) {
                            return resolved;
                        }

                        let tab;
                        if (!context) {
                            tab = await browser.tabs.create({ url: resolved.item.url, active: shouldActivate });
                            await waitForTabSettled(tab.id);
                            return {
                                success: true,
                                action: bookmarkAction,
                                message: `已打开书签：${resolved.item.title}`,
                                tabId: tab.id,
                                item: resolved.item,
                                active: shouldActivate
                            };
                        }

                        tab = await browser.tabs.create({ url: resolved.item.url, active: false });
                        trackTab(tab.id, {
                            createdBySubAgent: true,
                            setCurrent: true,
                            keepOpen: true
                        });
                        if (shouldActivate) {
                            context.shouldPreserveCurrentTab = true;
                            return runWithForegroundScheduler(tab.id, async () => {
                                await waitForTabSettled(tab.id);
                                return {
                                    success: true,
                                    action: bookmarkAction,
                                    message: `已打开书签：${resolved.item.title}`,
                                    tabId: tab.id,
                                    item: resolved.item,
                                    active: true
                                };
                            });
                        }

                        await waitForTabSettled(tab.id);
                        return {
                            success: true,
                            action: bookmarkAction,
                            message: `已在后台打开书签：${resolved.item.title}`,
                            tabId: tab.id,
                            item: resolved.item,
                            active: false
                        };
                    }
                    case 'open_folder': {
                        const resolved = resolveSingleBookmarkItem('folder');
                        if (resolved.error) {
                            return resolved;
                        }
                        const subtree = await browser.bookmarks.getSubTree(resolved.item.id);
                        const folderNode = subtree?.[0];
                        if (!folderNode) {
                            return { error: '无法读取指定收藏夹内容' };
                        }

                        const descendants = toolInput.recursive === true
                            ? flattenBookmarkNodes(folderNode.children || [], [resolved.item.title])
                            : (folderNode.children || []).map((node) => bookmarkNodeToItem(node, [resolved.item.title]));
                        const targets = descendants.filter((item) => item.type === 'bookmark' && item.url).slice(0, limit);
                        if (targets.length === 0) {
                            return { error: '目标收藏夹中没有可打开的书签链接' };
                        }

                        const openedTabs = [];
                        if (!context) {
                            for (let index = 0; index < targets.length; index += 1) {
                                const tab = await browser.tabs.create({
                                    url: targets[index].url,
                                    active: shouldActivate && index === 0
                                });
                                openedTabs.push(tab.id);
                            }
                            await waitForTabSettled(openedTabs[0]);
                            return {
                                success: true,
                                action: bookmarkAction,
                                message: `已打开收藏夹“${resolved.item.title}”中的 ${openedTabs.length} 个链接`,
                                folder: resolved.item,
                                tabIds: openedTabs,
                                count: openedTabs.length,
                                items: targets
                            };
                        }

                        for (let index = 0; index < targets.length; index += 1) {
                            const tab = await browser.tabs.create({ url: targets[index].url, active: false });
                            openedTabs.push(tab.id);
                            trackTab(tab.id, {
                                createdBySubAgent: true,
                                setCurrent: index === 0,
                                keepOpen: true
                            });
                        }

                        if (shouldActivate && openedTabs[0]) {
                            context.shouldPreserveCurrentTab = true;
                            return runWithForegroundScheduler(openedTabs[0], async () => {
                                await waitForTabSettled(openedTabs[0]);
                                return {
                                    success: true,
                                    action: bookmarkAction,
                                    message: `已打开收藏夹“${resolved.item.title}”中的 ${openedTabs.length} 个链接`,
                                    folder: resolved.item,
                                    tabIds: openedTabs,
                                    count: openedTabs.length,
                                    items: targets
                                };
                            });
                        }

                        await waitForTabSettled(openedTabs[0]);
                        return {
                            success: true,
                            action: bookmarkAction,
                            message: `已在后台打开收藏夹“${resolved.item.title}”中的 ${openedTabs.length} 个链接`,
                            folder: resolved.item,
                            tabIds: openedTabs,
                            count: openedTabs.length,
                            items: targets
                        };
                    }
                    default:
                        return { error: `不支持的书签操作: ${bookmarkAction}` };
                }
            }
            case 'browser_history': {
                if (!browser.history || typeof browser.history.search !== 'function') {
                    return { error: "当前浏览器环境不支持历史记录 API 或缺少历史权限" };
                }
                const historyAction = String(toolInput.action || '').trim();
                if (!historyAction) {
                    return { error: "缺少 action 参数" };
                }
                const maxResults = Math.max(1, Math.min(Number.isFinite(toolInput.maxResults) ? toolInput.maxResults : 10, 50));
                const shouldActivate = toolInput.active !== false;

                if (historyAction === 'search' || historyAction === 'list_recent') {
                    const items = await browser.history.search({
                        text: historyAction === 'list_recent' ? '' : String(toolInput.query || ''),
                        startTime: Number.isFinite(toolInput.startTime) ? toolInput.startTime : 0,
                        endTime: Number.isFinite(toolInput.endTime) ? toolInput.endTime : Date.now(),
                        maxResults
                    });
                    const normalizedItems = items.map(normalizeHistoryItem);
                    const filtered = historyAction === 'list_recent'
                        ? normalizedItems
                        : resolveHistoryCandidates(normalizedItems, {
                            url: toolInput.url,
                            title: toolInput.title,
                            query: toolInput.query
                        }).slice(0, maxResults);
                    return {
                        success: true,
                        action: historyAction,
                        count: filtered.length,
                        items: filtered
                    };
                }

                if (historyAction === 'delete_url') {
                    const url = String(toolInput.url || '').trim();
                    if (!url) {
                        return { error: "delete_url 需要提供 url" };
                    }
                    await browser.history.deleteUrl({ url });
                    return { success: true, action: historyAction, message: `已删除历史记录：${url}`, url };
                }

                if (historyAction === 'open_entry') {
                    const searchSeed = String(toolInput.query || toolInput.title || toolInput.url || '').trim();
                    const items = await browser.history.search({
                        text: searchSeed,
                        startTime: Number.isFinite(toolInput.startTime) ? toolInput.startTime : 0,
                        endTime: Number.isFinite(toolInput.endTime) ? toolInput.endTime : Date.now(),
                        maxResults: Math.max(maxResults, 20)
                    });
                    const candidates = resolveHistoryCandidates(items.map(normalizeHistoryItem), {
                        url: toolInput.url,
                        title: toolInput.title,
                        query: toolInput.query
                    });
                    if (candidates.length === 0) {
                        return { error: "未找到匹配的历史记录" };
                    }
                    if (candidates.length > 1 && !toolInput.url) {
                        return {
                            error: "找到多条匹配的历史记录，请改用更精确的 query 或 url",
                            count: candidates.length,
                            items: candidates.slice(0, Math.min(maxResults, 10))
                        };
                    }
                    const target = candidates[0];
                    if (!context) {
                        const tab = await browser.tabs.create({ url: target.url, active: shouldActivate });
                        await waitForTabSettled(tab.id);
                        return {
                            success: true,
                            action: historyAction,
                            message: `已打开历史记录：${target.title}`,
                            item: target,
                            tabId: tab.id,
                            active: shouldActivate
                        };
                    }
                    const tab = await browser.tabs.create({ url: target.url, active: false });
                    trackTab(tab.id, {
                        createdBySubAgent: true,
                        setCurrent: true,
                        keepOpen: true
                    });
                    if (shouldActivate) {
                        context.shouldPreserveCurrentTab = true;
                        return runWithForegroundScheduler(tab.id, async () => {
                            await waitForTabSettled(tab.id);
                            return {
                                success: true,
                                action: historyAction,
                                message: `已打开历史记录：${target.title}`,
                                item: target,
                                tabId: tab.id,
                                active: true
                            };
                        });
                    }
                    await waitForTabSettled(tab.id);
                    return {
                        success: true,
                        action: historyAction,
                        message: `已在后台打开历史记录：${target.title}`,
                        item: target,
                        tabId: tab.id,
                        active: false
                    };
                }

                return { error: `不支持的历史记录操作: ${historyAction}` };
            }
            case 'browser_windows': {
                if (!browser.windows || typeof browser.windows.getAll !== 'function') {
                    return { error: "当前浏览器环境不支持窗口 API" };
                }
                const windowAction = String(toolInput.action || '').trim();
                if (!windowAction) {
                    return { error: "缺少 action 参数" };
                }
                const shouldFocus = toolInput.focused !== false;

                switch (windowAction) {
                    case 'list': {
                        const windows = await browser.windows.getAll({ populate: true });
                        const normalized = windows.map(normalizeWindowItem);
                        return {
                            success: true,
                            action: windowAction,
                            count: normalized.length,
                            windows: normalized
                        };
                    }
                    case 'focus_window': {
                        if (!Number.isFinite(toolInput.windowId)) {
                            return { error: "focus_window 需要提供 windowId" };
                        }
                        const runner = async () => {
                            await browser.windows.update(toolInput.windowId, { focused: true });
                            return {
                                success: true,
                                action: windowAction,
                                message: `已聚焦窗口 ${toolInput.windowId}`,
                                windowId: toolInput.windowId
                            };
                        };
                        const activeTabId = context?.currentTabId || await getTargetTabId(true);
                        return activeTabId ? runWithForegroundScheduler(activeTabId, runner) : runner();
                    }
                    case 'open_window': {
                        const createData = {};
                        if (typeof toolInput.url === 'string' && toolInput.url.trim()) {
                            createData.url = toolInput.url.trim();
                        } else if (Array.isArray(toolInput.urls) && toolInput.urls.length > 0) {
                            createData.url = toolInput.urls.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
                        } else if (Number.isFinite(toolInput.tabId)) {
                            createData.tabId = toolInput.tabId;
                        }
                        if (typeof toolInput.state === 'string' && toolInput.state.trim()) {
                            createData.state = toolInput.state.trim();
                        }
                        createData.focused = shouldFocus;

                        const createdWindow = await browser.windows.create(createData);
                        const normalized = normalizeWindowItem(createdWindow);
                        if (context && Array.isArray(createdWindow?.tabs)) {
                            for (const tab of createdWindow.tabs) {
                                if (!tab?.id) {
                                    continue;
                                }
                                trackTab(tab.id, {
                                    createdBySubAgent: !Number.isFinite(toolInput.tabId),
                                    adopted: Number.isFinite(toolInput.tabId),
                                    setCurrent: tab.active === true,
                                    keepOpen: shouldFocus
                                });
                            }
                            if (shouldFocus) {
                                context.shouldPreserveCurrentTab = true;
                            }
                        }
                        if (shouldFocus && normalized.tabs[0]?.id && context) {
                            return runWithForegroundScheduler(normalized.tabs[0].id, async () => ({
                                success: true,
                                action: windowAction,
                                message: `已打开窗口 ${normalized.id}`,
                                window: normalized
                            }));
                        }
                        return {
                            success: true,
                            action: windowAction,
                            message: `已打开窗口 ${normalized.id}`,
                            window: normalized
                        };
                    }
                    case 'close_window': {
                        const targetWindowId = Number.isFinite(toolInput.windowId)
                            ? toolInput.windowId
                            : await findCurrentWindowId();
                        if (!Number.isFinite(targetWindowId)) {
                            return { error: "没有可关闭的目标窗口" };
                        }
                        await browser.windows.remove(targetWindowId);
                        return {
                            success: true,
                            action: windowAction,
                            message: `已关闭窗口 ${targetWindowId}`,
                            windowId: targetWindowId
                        };
                    }
                    case 'move_tab_to_window': {
                        if (!Number.isFinite(toolInput.tabId)) {
                            return { error: "move_tab_to_window 需要提供 tabId" };
                        }
                        let targetWindowId = Number.isFinite(toolInput.windowId) ? toolInput.windowId : null;
                        if (!targetWindowId) {
                            const createdWindow = await browser.windows.create({ tabId: toolInput.tabId, focused: shouldFocus });
                            const normalized = normalizeWindowItem(createdWindow);
                            if (context && Array.isArray(createdWindow?.tabs)) {
                                for (const tab of createdWindow.tabs) {
                                    if (!tab?.id) {
                                        continue;
                                    }
                                    trackTab(tab.id, {
                                        adopted: true,
                                        setCurrent: true,
                                        keepOpen: shouldFocus
                                    });
                                }
                            }
                            return {
                                success: true,
                                action: windowAction,
                                message: `已将标签页 ${toolInput.tabId} 移动到新窗口 ${normalized.id}`,
                                window: normalized
                            };
                        }
                        await browser.tabs.move(toolInput.tabId, { windowId: targetWindowId, index: -1 });
                        const runner = async () => {
                            if (shouldFocus) {
                                await browser.windows.update(targetWindowId, { focused: true });
                            }
                            if (context) {
                                trackTab(toolInput.tabId, {
                                    adopted: !context.createdTabIds.includes(toolInput.tabId),
                                    setCurrent: true,
                                    keepOpen: shouldFocus
                                });
                                if (shouldFocus) {
                                    context.shouldPreserveCurrentTab = true;
                                }
                            }
                            return {
                                success: true,
                                action: windowAction,
                                message: `已将标签页 ${toolInput.tabId} 移动到窗口 ${targetWindowId}`,
                                windowId: targetWindowId,
                                tabId: toolInput.tabId
                            };
                        };
                        return shouldFocus ? runWithForegroundScheduler(toolInput.tabId, runner) : runner();
                    }
                    default:
                        return { error: `不支持的窗口操作: ${windowAction}` };
                }
            }
            case 'browser_downloads': {
                if (!browser.downloads || typeof browser.downloads.search !== 'function') {
                    return { error: "当前浏览器环境不支持下载 API 或缺少下载权限" };
                }
                const downloadAction = String(toolInput.action || '').trim();
                if (!downloadAction) {
                    return { error: "缺少 action 参数" };
                }
                const limit = Math.max(1, Math.min(Number.isFinite(toolInput.limit) ? toolInput.limit : 10, 50));

                switch (downloadAction) {
                    case 'download_url': {
                        const url = String(toolInput.url || '').trim();
                        if (!url) {
                            return { error: "download_url 需要提供 url" };
                        }
                        const downloadId = await browser.downloads.download({
                            url,
                            filename: typeof toolInput.filename === 'string' && toolInput.filename.trim() ? toolInput.filename.trim() : undefined,
                            saveAs: toolInput.saveAs === true
                        });
                        return {
                            success: true,
                            action: downloadAction,
                            message: `已开始下载 ${url}`,
                            downloadId
                        };
                    }
                    case 'list':
                    case 'search': {
                        const query = {
                            limit
                        };
                        if (typeof toolInput.query === 'string' && toolInput.query.trim()) {
                            query.query = [toolInput.query.trim()];
                        }
                        if (typeof toolInput.state === 'string' && toolInput.state.trim()) {
                            query.state = toolInput.state.trim();
                        }
                        if (typeof toolInput.url === 'string' && toolInput.url.trim()) {
                            query.urlRegex = toolInput.url.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        }
                        const items = await browser.downloads.search(query);
                        const normalized = items.slice(0, limit).map(normalizeDownloadItem);
                        return {
                            success: true,
                            action: downloadAction,
                            count: normalized.length,
                            items: normalized
                        };
                    }
                    case 'open': {
                        if (!Number.isFinite(toolInput.downloadId)) {
                            return { error: "open 需要提供 downloadId" };
                        }
                        await browser.downloads.open(toolInput.downloadId);
                        return {
                            success: true,
                            action: downloadAction,
                            message: `已打开下载文件 ${toolInput.downloadId}`,
                            downloadId: toolInput.downloadId
                        };
                    }
                    case 'show': {
                        if (!Number.isFinite(toolInput.downloadId)) {
                            return { error: "show 需要提供 downloadId" };
                        }
                        await browser.downloads.show(toolInput.downloadId);
                        return {
                            success: true,
                            action: downloadAction,
                            message: `已在文件夹中显示下载文件 ${toolInput.downloadId}`,
                            downloadId: toolInput.downloadId
                        };
                    }
                    case 'erase': {
                        const query = {};
                        if (Number.isFinite(toolInput.downloadId)) {
                            query.id = toolInput.downloadId;
                        }
                        if (typeof toolInput.url === 'string' && toolInput.url.trim()) {
                            query.url = toolInput.url.trim();
                        }
                        if (typeof toolInput.query === 'string' && toolInput.query.trim()) {
                            query.query = [toolInput.query.trim()];
                        }
                        const erasedIds = await browser.downloads.erase(query);
                        return {
                            success: true,
                            action: downloadAction,
                            message: `已删除 ${erasedIds.length} 条下载记录`,
                            erasedIds
                        };
                    }
                    default:
                        return { error: `不支持的下载操作: ${downloadAction}` };
                }
            }
            case 'browser_get_dom': {
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的目标标签页" };
                return runWithForegroundScheduler(tabId, async () => {
                    try {
                        await ensurePageTab(tabId);
                    } catch (error) {
                        return { error: error.message };
                    }
                    const result = await sendMessageWithInjection(tabId, {
                        ...buildElementPayload('getPageDOM'),
                        maxLength: toolInput.maxLength || 5000
                    }, '无法获取页面 DOM', buildMessageOptions());
                    if (!result?.error && context) {
                        trackTab(tabId, { setCurrent: true, interacted: true, adopted: !context.createdTabIds.includes(tabId) });
                    }
                    return result;
                });
            }
            case 'browser_get_visible_text': {
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的目标标签页" };
                return runWithForegroundScheduler(tabId, async () => {
                    try {
                        await ensurePageTab(tabId);
                    } catch (error) {
                        return { error: error.message };
                    }
                    const result = await sendMessageWithInjection(tabId, {
                        ...buildElementPayload('getVisibleText')
                    }, '无法获取页面可见文本', buildMessageOptions());
                    if (!result?.error && context) {
                        trackTab(tabId, { setCurrent: true, interacted: true, adopted: !context.createdTabIds.includes(tabId) });
                    }
                    return result;
                });
            }
            case 'browser_click': {
                if (!(toolInput.selector || toolInput.text || toolInput.labelText || toolInput.placeholder || toolInput.ariaLabel || toolInput.role || toolInput.name || toolInput.tagName)) {
                    return { error: "缺少元素定位参数" };
                }
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的目标标签页" };
                return runWithForegroundScheduler(tabId, async () => {
                    try {
                        await ensurePageTab(tabId);
                    } catch (error) {
                        return { error: error.message };
                    }
                    const result = await sendMessageWithInjection(tabId, {
                        ...buildElementPayload('clickElement')
                    }, '无法点击页面元素', buildMessageOptions());
                    if (!result?.error && context) {
                        trackTab(tabId, { setCurrent: true, interacted: true, adopted: !context.createdTabIds.includes(tabId) });
                    }
                    return result;
                });
            }
            case 'browser_fill_input': {
                if (toolInput.value === undefined) return { error: "缺少 value 参数" };
                if (!(toolInput.selector || toolInput.text || toolInput.labelText || toolInput.placeholder || toolInput.ariaLabel || toolInput.role || toolInput.name || toolInput.tagName)) {
                    return { error: "缺少输入元素定位参数" };
                }
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的目标标签页" };
                return runWithForegroundScheduler(tabId, async () => {
                    try {
                        await ensurePageTab(tabId);
                    } catch (error) {
                        return { error: error.message };
                    }
                    const result = await sendMessageWithInjection(tabId, {
                        ...buildElementPayload('fillInput')
                    }, '无法填写输入框', buildMessageOptions());
                    if (!result?.error && context) {
                        trackTab(tabId, { setCurrent: true, interacted: true, adopted: !context.createdTabIds.includes(tabId) });
                    }
                    return result;
                });
            }
            case 'browser_press_key': {
                if (!toolInput.key) return { error: "缺少 key 参数" };
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的目标标签页" };
                return runWithForegroundScheduler(tabId, async () => {
                    try {
                        await ensurePageTab(tabId);
                    } catch (error) {
                        return { error: error.message };
                    }
                    const result = await sendMessageWithInjection(tabId, {
                        ...buildElementPayload('pressKey')
                    }, '无法按下按键', buildMessageOptions());
                    if (!result?.error && context) {
                        trackTab(tabId, { setCurrent: true, interacted: true, adopted: !context.createdTabIds.includes(tabId) });
                    }
                    return result;
                });
            }
            case 'browser_wait':
                return executeBrowserToolLegacy(toolName, toolInput, executionContext);
            case 'browser_scroll': {
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的目标标签页" };
                return runWithForegroundScheduler(tabId, async () => {
                    try {
                        await ensurePageTab(tabId);
                    } catch (error) {
                        return { error: error.message };
                    }
                    const result = await sendMessageWithInjection(tabId, {
                        ...buildElementPayload('scrollPage'),
                        direction: toolInput.direction || 'down',
                        amount: toolInput.amount || 500
                    }, '无法滚动页面', buildMessageOptions());
                    if (!result?.error && context) {
                        trackTab(tabId, { setCurrent: true, interacted: true, adopted: !context.createdTabIds.includes(tabId) });
                    }
                    return result;
                });
            }
            case 'browser_screenshot': {
                const tabId = await getTargetTabId(false);
                if (!tabId) return { error: "没有可用的目标标签页" };
                return runWithForegroundScheduler(tabId, async () => {
                    let tab;
                    try {
                        tab = await browser.tabs.get(tabId);
                    } catch (error) {
                        return { error: `无法获取标签页: ${error.message}` };
                    }
                    try {
                        const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
                        if (context) {
                            trackTab(tabId, { setCurrent: true, interacted: true, adopted: !context.createdTabIds.includes(tabId) });
                        }
                        return { success: true, message: '截图已保存', dataUrl };
                    } catch (error) {
                        return { error: "截图失败: " + error.message };
                    }
                });
            }
            default:
                return executeBrowserToolLegacy(toolName, toolInput, executionContext);
        }
    } catch (error) {
        console.error('[Automation] Tool execution error:', error);
        return { error: error.message };
    }
}

window.executeBrowserTool = async function executeBrowserToolWithTracking(toolName, toolInput, executionContext) {
    const result = await executeBrowserTool(toolName, toolInput, executionContext);
    recordAutomationTraceStep(toolName, toolInput, result, executionContext);
    return result;
};

let collectiveResearchRuntime = null;
let collectiveResearchStopRequested = false;

function initializeCollectiveResearchUI(topic = '') {
    teardownCollectiveResearchUI();

    const container = document.createElement('div');
    container.id = 'collective-research-container';
    container.className = 'collective-research-container';
    container.innerHTML = `
        <div class="collective-research-header">
            <div class="collective-research-title-wrap">
                <div class="collective-research-title">群体研究</div>
                <div class="collective-research-topic">${escapeHtml(topic)}</div>
            </div>
            <div class="collective-research-header-actions">
                <div class="collective-research-status" id="collective-research-status">初始化中</div>
                <button type="button" class="collective-inline-btn" id="collective-stop-btn">停止</button>
            </div>
        </div>
        <div class="collective-research-meta">
            <div class="collective-meta-pill" id="collective-round-pill">第 0 轮</div>
            <div class="collective-meta-pill" id="collective-role-pill">0 个角色</div>
        </div>
        <div class="collective-role-grid" id="collective-role-grid"></div>
        <div class="collective-research-highlights">
            <div class="collective-highlight-block">
                <div class="collective-highlight-title">决策</div>
                <div class="collective-highlight-body" id="collective-decisions"></div>
            </div>
            <div class="collective-highlight-block">
                <div class="collective-highlight-title">争议</div>
                <div class="collective-highlight-body" id="collective-challenges"></div>
            </div>
            <div class="collective-highlight-block">
                <div class="collective-highlight-title">待办</div>
                <div class="collective-highlight-body" id="collective-todos"></div>
            </div>
        </div>
        <div class="collective-research-board" id="collective-blackboard-feed"></div>
        <div class="collective-research-report" id="collective-final-report"></div>
    `;

    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
        chatMessages.appendChild(container);
    }

    collectiveResearchRuntime = {
        container,
        status: container.querySelector('#collective-research-status'),
        stopBtn: container.querySelector('#collective-stop-btn'),
        round: container.querySelector('#collective-round-pill'),
        roles: container.querySelector('#collective-role-pill'),
        roleGrid: container.querySelector('#collective-role-grid'),
        decisions: container.querySelector('#collective-decisions'),
        challenges: container.querySelector('#collective-challenges'),
        todos: container.querySelector('#collective-todos'),
        board: container.querySelector('#collective-blackboard-feed'),
        report: container.querySelector('#collective-final-report')
    };

    collectiveResearchRuntime.stopBtn?.addEventListener('click', () => {
        collectiveResearchStopRequested = true;
        window.CollectiveResearch?.engine?.stopSession?.();
        if (collectiveResearchRuntime?.status) {
            collectiveResearchRuntime.status.textContent = '停止中';
        }
    });
}

function renderCollectiveSchedulerStatus(snapshot = null) {
    if (!collectiveResearchRuntime?.status || !snapshot) {
        return;
    }
    const activeTask = snapshot.scheduler?.activeTask;
    const queuedCount = snapshot.scheduler?.queuedCount || 0;
    const statusText = activeTask
        ? `执行中：${activeTask.roleName}`
        : (snapshot.status === 'completed' ? '已完成' : snapshot.status === 'stopped' ? '已停止' : '等待下一轮');
    collectiveResearchRuntime.status.textContent = queuedCount > 0
        ? `${statusText} · 队列 ${queuedCount}`
        : statusText;
    if (collectiveResearchRuntime.stopBtn) {
        collectiveResearchRuntime.stopBtn.disabled = snapshot.status === 'completed' || snapshot.status === 'stopped';
        collectiveResearchRuntime.stopBtn.textContent = snapshot.status === 'stopped' ? '已停止' : (snapshot.status === 'completed' ? '已完成' : '停止');
    }
    if (collectiveResearchRuntime.round) {
        collectiveResearchRuntime.round.textContent = `第 ${snapshot.currentRound} / ${snapshot.maxRounds} 轮`;
    }
    if (collectiveResearchRuntime.roles) {
        collectiveResearchRuntime.roles.textContent = `${snapshot.roles?.length || 0} 个角色`;
    }
}

function renderBlackboardFeed(snapshot = null) {
    if (!collectiveResearchRuntime?.board || !snapshot?.blackboard) {
        return;
    }

    const entries = snapshot.blackboard.entries || [];
    if (entries.length === 0) {
        collectiveResearchRuntime.board.innerHTML = '<div class="collective-board-empty">黑板还没有内容</div>';
        return;
    }

    collectiveResearchRuntime.board.innerHTML = entries.slice(-12).map((entry) => `
        <article class="collective-board-entry">
            <div class="collective-board-entry-meta">
                <span class="collective-board-role">${escapeHtml(entry.role || '未知角色')}</span>
                <span class="collective-board-type">${escapeHtml(entry.entryType || 'note')}</span>
            </div>
            <div class="collective-board-content">${escapeHtml(entry.content || '')}</div>
        </article>
    `).join('');
}

function renderCollectiveRoleCards(snapshot = null) {
    if (!collectiveResearchRuntime?.roleGrid || !snapshot) {
        return;
    }

    const roles = Array.isArray(snapshot.roles) ? snapshot.roles : [];
    const tasks = Array.isArray(snapshot.scheduler?.queue) ? snapshot.scheduler.queue : [];
    const entries = Array.isArray(snapshot.blackboard?.entries) ? snapshot.blackboard.entries : [];

    if (roles.length === 0) {
        collectiveResearchRuntime.roleGrid.innerHTML = '';
        return;
    }

    collectiveResearchRuntime.roleGrid.innerHTML = roles.map((role) => {
        const latestTask = [...tasks].reverse().find((task) => task.roleId === role.id && task.phase !== 'chat-review');
        const latestEntry = [...entries].reverse().find((entry) => entry.role === role.name);
        const status = latestTask?.status || 'idle';
        const statusLabelMap = {
            queued: '排队中',
            running: '执行中',
            done: '已完成',
            failed: '失败',
            paused_waiting_input: '等待输入',
            idle: '待命'
        };
        const statusLabel = statusLabelMap[status] || status;
        const latestText = latestEntry?.content || latestTask?.mission || role.description || '';
        return `
            <article class="collective-role-card collective-role-card--${escapeHtml(status)}">
                <div class="collective-role-card-header">
                    <div class="collective-role-card-title">${escapeHtml(role.name)}</div>
                    <div class="collective-role-card-status">${escapeHtml(statusLabel)}</div>
                </div>
                <div class="collective-role-card-body">${escapeHtml(latestText)}</div>
            </article>
        `;
    }).join('');
}

function renderCollectiveHighlights(snapshot = null) {
    if (!collectiveResearchRuntime || !snapshot?.blackboard) {
        return;
    }

    const entries = Array.isArray(snapshot.blackboard.entries) ? snapshot.blackboard.entries : [];
    const decisions = Array.isArray(snapshot.blackboard.decisions) ? snapshot.blackboard.decisions : [];
    const challenges = entries.filter((entry) => entry.entryType === 'challenge').slice(-4);
    const todos = entries.filter((entry) => entry.entryType === 'todo').slice(-4);

    const renderList = (items, pickText) => {
        if (!items || items.length === 0) {
            return '<div class="collective-highlight-empty">暂无</div>';
        }
        return items.map((item) => `<div class="collective-highlight-item">${escapeHtml(pickText(item))}</div>`).join('');
    };

    if (collectiveResearchRuntime.decisions) {
        collectiveResearchRuntime.decisions.innerHTML = renderList(decisions.slice(-4), (item) => item.content || '');
    }
    if (collectiveResearchRuntime.challenges) {
        collectiveResearchRuntime.challenges.innerHTML = renderList(challenges, (item) => item.content || '');
    }
    if (collectiveResearchRuntime.todos) {
        collectiveResearchRuntime.todos.innerHTML = renderList(todos, (item) => item.content || '');
    }
}

function renderCollectiveResearchDock(snapshot = null, result = null) {
    if (!collectiveResearchRuntime) {
        return;
    }
    renderCollectiveSchedulerStatus(snapshot);
    renderCollectiveRoleCards(snapshot);
    renderCollectiveHighlights(snapshot);
    renderBlackboardFeed(snapshot);

    if (collectiveResearchRuntime.report) {
        const reportContent = result?.finalReport || snapshot?.blackboard?.draft?.content || '';
        if (reportContent) {
            collectiveResearchRuntime.report.innerHTML = `
                <div class="collective-report-title">当前报告</div>
                <div class="collective-report-body">${escapeHtml(reportContent)}</div>
                <div class="collective-report-actions">
                    <button type="button" class="collective-inline-btn" id="collective-save-editor-btn">写入编辑器</button>
                </div>
            `;
            const saveBtn = collectiveResearchRuntime.report.querySelector('#collective-save-editor-btn');
            saveBtn?.addEventListener('click', async () => {
                await saveCollectiveReportToEditor(result?.finalReport || snapshot?.blackboard?.draft?.content || '', snapshot?.topic || '群体研究报告');
            });
        } else {
            collectiveResearchRuntime.report.innerHTML = '';
        }
    }
}

function teardownCollectiveResearchUI() {
    if (collectiveResearchRuntime?.container) {
        collectiveResearchRuntime.container.remove();
    }
    collectiveResearchRuntime = null;
}

window.teardownCollectiveResearchUI = teardownCollectiveResearchUI;

async function saveCollectiveReportToEditor(reportContent, topic) {
    const editorApi = window.InfinPilotEditor || window.InfinpilotEditor;
    if (!editorApi || typeof editorApi.createFile !== 'function' || typeof editorApi.setFileContent !== 'function') {
        return;
    }

    try {
        const snapshot = collectiveResearchRuntime?.lastSnapshot || window.CollectiveResearch?.lastResult?.snapshot || null;
        const result = collectiveResearchRuntime?.lastResult || window.CollectiveResearch?.lastResult || null;
        const packageResult = await saveCollectiveResearchPackageToEditor({
            topic: topic || '群体研究报告',
            snapshot,
            result,
            editorApi
        });
        return packageResult;
    } catch (error) {
        console.warn('[CollectiveResearch] Failed to save report to editor:', error);
        return null;
    }
}

async function saveCollectiveResearchResultToProject(result) {
    if (!result?.snapshot) {
        return null;
    }

    try {
        const saved = await projectService.saveCollectiveSession(null, {
            ...result.snapshot,
            topic: result.topic,
            roundsCompleted: result.roundsCompleted,
            finalReport: result.finalReport
        });
        await projectService.addProjectItem({
            type: 'collective_research_result',
            title: result.topic || '群体研究结果',
            content: {
                topic: result.topic,
                finalReport: result.finalReport,
                roundsCompleted: result.roundsCompleted,
                snapshot: result.snapshot
            }
        });
        return saved;
    } catch (error) {
        console.warn('[CollectiveResearch] Failed to save result to project:', error);
        return null;
    }
}

async function startCollectiveResearch(userMessage, state, elements, currentTranslations, addMessageToChatCallback, addThinkingAnimationCallback, restoreSendButtonAndInputCallback, showToastCallback) {
    console.log('[CollectiveResearch] Starting collective research mode');
    window.CollectiveResearch = window.CollectiveResearch || {};
    collectiveResearchStopRequested = false;
    if (!userMessage) {
        showToastCallback?.('请输入群体研究任务', 'warning');
        return;
    }

    const config = await browser.storage.sync.get([
        'agentSdkEndpoint',
        'agentSdkApiKey',
        'agentSdkModel'
    ]);

    const endpoint = config.agentSdkEndpoint || 'https://api.anthropic.com';
    const apiKey = config.agentSdkApiKey;
    const model = config.agentSdkModel || 'claude-sonnet-4-5';

    if (!apiKey) {
        showToastCallback?.(_('agentSdkApiKeyMissing', {}, currentTranslations) || '请先配置 Claude Agent SDK 的 API Key', 'error');
        return;
    }

    const SubAgentEngine = window.DeepResearch?.SubAgentEngine;
    if (!SubAgentEngine) {
        showToastCallback?.('群体研究执行器未加载，请刷新页面后重试', 'error');
        return;
    }
    state.isStreaming = true;
    try {
    const userMessageId = generateUniqueId();
    addMessageToChatCallback?.(userMessage, 'user', { id: userMessageId, forceScroll: true });
    if (state.chatHistory) {
        state.chatHistory.push({
            id: userMessageId,
            role: 'user',
            parts: [{ text: userMessage }],
            originalUserText: userMessage
        });
    }
    if (elements?.userInput) {
        elements.userInput.value = '';
    }

    initializeCollectiveResearchUI(userMessage);

    const initialTools = await getAllAgentTools(true);
    const subAgentEngine = new SubAgentEngine(initialTools, {
        endpoint,
        apiKey,
        model
    }, {
        onSubAgentStart: (agentName, task, agentIndex) => {
            console.log('[CollectiveResearch] Role started:', agentName, task, agentIndex);
        },
        onSubAgentComplete: (agentName, result, agentIndex) => {
            console.log('[CollectiveResearch] Role completed:', agentName, agentIndex, result?.summary);
        },
        onToolCall: (toolName, toolInput, toolId, agentIndex) => {
            console.log('[CollectiveResearch] Tool call:', toolName, toolId, agentIndex, toolInput);
        },
        onToolResult: (toolId, result, agentIndex) => {
            console.log('[CollectiveResearch] Tool result:', toolId, agentIndex, result);
        }
    });

    const contextSections = [];
    const projectPromptContext = await getCurrentProjectPromptContext();
    if (projectPromptContext) {
        contextSections.push(projectPromptContext);
    }
    if (Array.isArray(state.selectedContextTabs)) {
        for (const item of state.selectedContextTabs.filter((entry) => entry.content && !entry.isLoading)) {
            contextSections.push(`${item.title || item.url || '上下文'}\n${item.content}`);
        }
    }

    const collectiveEngine = new CollectiveResearchEngine({
        tools: initialTools,
        apiConfig: { endpoint, apiKey, model },
        subAgentEngine,
        callbacks: {
            onSessionStart: (snapshot) => renderCollectiveResearchDock(snapshot),
            onRoundStart: (roundNumber, snapshot) => {
                renderCollectiveResearchDock(snapshot);
                console.log('[CollectiveResearch] Round started:', roundNumber);
            },
            onRoleStart: (_role, _task, snapshot) => renderCollectiveResearchDock(snapshot),
            onBlackboardUpdate: (_entry, snapshot) => renderCollectiveResearchDock(snapshot),
            onRoleComplete: (_role, _action, _result, snapshot) => renderCollectiveResearchDock(snapshot),
            onSessionComplete: (result, snapshot) => renderCollectiveResearchDock(snapshot, result)
        }
    });

        window.CollectiveResearch.engine = collectiveEngine;
        await collectiveEngine.startSession({
            topic: userMessage,
            roles: getDefaultCollectiveRoles(),
            context: contextSections.join('\n\n')
        });
        const result = await collectiveEngine.runUntilSettled();
        window.CollectiveResearch.lastResult = result;
        await saveCollectiveResearchResultToProject(result);

        addMessageToChatCallback?.(result.finalReport || '群体研究已完成，但没有生成最终报告。', 'assistant', {
            forceScroll: true
        });
        if (state.chatHistory) {
            state.chatHistory.push({
                id: generateUniqueId(),
                role: 'assistant',
                parts: [{ text: result.finalReport || '群体研究已完成。' }]
            });
        }
        showToastCallback?.(collectiveResearchStopRequested ? '群体研究已停止并保存当前结果' : '群体研究已完成', 'success');
    } catch (error) {
        console.error('[CollectiveResearch] Failed:', error);
        addMessageToChatCallback?.(`群体研究执行失败：${error.message}`, 'assistant', {
            forceScroll: true
        });
        showToastCallback?.(error.message || '群体研究执行失败', 'error');
} finally {
        state.isStreaming = false;
        window.CollectiveResearch.engine = null;
        collectiveResearchStopRequested = false;
        restoreSendButtonAndInputCallback?.(state, elements, currentTranslations);
    }
}

const COLLECTIVE_ENTRY_LABELS = {
    question: '问题',
    claim: '观点',
    evidence: '证据',
    challenge: '争议',
    todo: '待办',
    draft: '草稿',
    decision: '决策',
    team_plan: '组队',
    reflection: '复盘',
    note: '笔记'
};

function getCollectiveTopicFromRecord(record) {
    return record?.content?.topic || record?.content?.snapshot?.topic || record?.title || '群体研究';
}

function getCollectiveReportFromRecord(record) {
    return record?.content?.finalReport || record?.content?.snapshot?.finalReport || '';
}

function getCollectiveSnapshotFromRecord(record) {
    if (!record) {
        return null;
    }
    if (record.type === 'collective_session') {
        return record.content || null;
    }
    if (record.type === 'collective_research_result') {
        return record.content?.snapshot || null;
    }
    return null;
}

function getCollectiveTemplateSourceRecord(record = null) {
    if (record) {
        return record;
    }
    const lastResult = window.CollectiveResearch?.lastResult;
    if (!lastResult?.snapshot) {
        return null;
    }
    return {
        type: 'collective_research_result',
        title: lastResult.topic || '群体研究结果',
        content: {
            topic: lastResult.topic,
            finalReport: lastResult.finalReport,
            roundsCompleted: lastResult.roundsCompleted,
            snapshot: lastResult.snapshot
        }
    };
}

function getCollectiveEntries(snapshot = null) {
    return Array.isArray(snapshot?.workBoard?.entries)
        ? snapshot.workBoard.entries
        : (Array.isArray(snapshot?.blackboard?.entries) ? snapshot.blackboard.entries : []);
}

function getCollectiveChatEntries(snapshot = null) {
    return Array.isArray(snapshot?.chatBoard?.entries) ? snapshot.chatBoard.entries : [];
}

function getCollectiveUniqueRounds(snapshot = null) {
    return Array.from(new Set(
        getCollectiveEntries(snapshot)
            .map((entry) => entry.round)
            .filter((round) => Number.isFinite(round))
    )).sort((left, right) => left - right);
}

function syncCollectiveFilterOptions(snapshot = null) {
    if (!collectiveResearchRuntime) {
        return;
    }

    const roleNames = Array.from(new Set([
        ...((snapshot?.decisionCommittee || []).map((role) => role.name)),
        ...((snapshot?.roles || []).map((role) => role.name)),
        ...(getCollectiveEntries(snapshot).map((entry) => entry.role))
    ].filter(Boolean)));
    const rounds = getCollectiveUniqueRounds(snapshot);

    if (collectiveResearchRuntime.typeFilter && !collectiveResearchRuntime.typeFilter.dataset.initialized) {
        collectiveResearchRuntime.typeFilter.innerHTML = [
            '<option value="all">全部类型</option>',
            ...Object.entries(COLLECTIVE_ENTRY_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`)
        ].join('');
        collectiveResearchRuntime.typeFilter.dataset.initialized = 'true';
    }

    if (collectiveResearchRuntime.roleFilter) {
        const currentRole = collectiveResearchRuntime.filters.role;
        collectiveResearchRuntime.roleFilter.innerHTML = [
            '<option value="all">全部角色</option>',
            ...roleNames.map((roleName) => `<option value="${escapeHtml(roleName)}">${escapeHtml(roleName)}</option>`)
        ].join('');
        collectiveResearchRuntime.roleFilter.value = roleNames.includes(currentRole) ? currentRole : 'all';
        collectiveResearchRuntime.filters.role = collectiveResearchRuntime.roleFilter.value;
    }

    if (collectiveResearchRuntime.roundFilter) {
        const currentRound = collectiveResearchRuntime.filters.round;
        collectiveResearchRuntime.roundFilter.innerHTML = [
            '<option value="all">全部轮次</option>',
            ...rounds.map((round) => `<option value="${round}">第 ${round} 轮</option>`)
        ].join('');
        collectiveResearchRuntime.roundFilter.value = rounds.some((round) => String(round) === String(currentRound)) ? String(currentRound) : 'all';
        collectiveResearchRuntime.filters.round = collectiveResearchRuntime.roundFilter.value;
    }
}

function getFilteredCollectiveEntries(snapshot = null) {
    if (!collectiveResearchRuntime) {
        return getCollectiveEntries(snapshot);
    }
    return getCollectiveEntries(snapshot).filter((entry) => {
        if (collectiveResearchRuntime.filters.type !== 'all' && entry.entryType !== collectiveResearchRuntime.filters.type) {
            return false;
        }
        if (collectiveResearchRuntime.filters.role !== 'all' && entry.role !== collectiveResearchRuntime.filters.role) {
            return false;
        }
        if (collectiveResearchRuntime.filters.round !== 'all' && String(entry.round) !== String(collectiveResearchRuntime.filters.round)) {
            return false;
        }
        return true;
    });
}

function buildCollectiveRuntimeReportContent(snapshot = null, result = null) {
    return buildCollectiveExpandedReport(snapshot, result);
}

function escapeSvgText(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function normalizeCollectivePackageName(topic = '') {
    return String(topic || '群体研究')
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .trim() || '群体研究';
}

function buildCollectiveEvidenceRows(snapshot = null) {
    const entries = getCollectiveEntries(snapshot);
    return entries
        .filter((entry) => ['evidence', 'claim', 'challenge', 'todo', 'decision', 'draft'].includes(entry.entryType))
        .map((entry) => [
            Number.isFinite(entry.round) ? String(entry.round) : '',
            entry.role || '',
            entry.entryType || '',
            String(entry.content || '').replace(/\s+/g, ' ').trim(),
            Array.isArray(entry.references) ? entry.references.join(' | ') : '',
            entry.metadata?.phase || '',
            entry.metadata?.replyToRoleId || ''
        ]);
}

function buildCollectiveMermaidDiagram(snapshot = null, result = null) {
    const topic = normalizeCollectivePackageName(snapshot?.topic || result?.topic || '群体研究');
    const decisions = (snapshot?.workBoard?.decisions || []).slice(-3);
    const evidence = getCollectiveEntries(snapshot).filter((entry) => entry.entryType === 'evidence').slice(-4);
    const challenges = getCollectiveEntries(snapshot).filter((entry) => entry.entryType === 'challenge').slice(-3);
    const todos = getCollectiveEntries(snapshot).filter((entry) => entry.entryType === 'todo').slice(-3);
    const sanitize = (value, fallback) => {
        const text = shortenCollectiveText(String(value || '').replace(/["<>]/g, ''), 34);
        return text || fallback;
    };

    const lines = [
        'flowchart TD',
        `  root["${sanitize(topic, '群体研究')}"]`
    ];

    decisions.forEach((entry, index) => {
        const id = `d${index + 1}`;
        lines.push(`  root --> ${id}["决策: ${sanitize(entry.content, `决策 ${index + 1}`)}"]`);
    });
    evidence.forEach((entry, index) => {
        const id = `e${index + 1}`;
        lines.push(`  root --> ${id}["证据: ${sanitize(entry.content, `证据 ${index + 1}`)}"]`);
    });
    challenges.forEach((entry, index) => {
        const id = `c${index + 1}`;
        lines.push(`  root --> ${id}["质疑: ${sanitize(entry.content, `质疑 ${index + 1}`)}"]`);
    });
    todos.forEach((entry, index) => {
        const id = `t${index + 1}`;
        lines.push(`  root --> ${id}["待办: ${sanitize(entry.content, `待办 ${index + 1}`)}"]`);
    });

    if (lines.length === 2) {
        lines.push('  root --> summary["暂无足够结构化研究结果"]');
    }
    return lines.join('\n');
}

function buildCollectiveExpandedReport(snapshot = null, result = null) {
    const topic = snapshot?.topic || result?.topic || '群体研究';
    const finalReport = result?.finalReport || snapshot?.workBoard?.draft?.content || snapshot?.blackboard?.draft?.content || '';
    const teamPlan = snapshot?.teamPlan?.members || [];
    const decisions = (snapshot?.workBoard?.decisions || snapshot?.blackboard?.decisions || []).slice(-8);
    const entries = getCollectiveEntries(snapshot);
    const evidence = entries.filter((entry) => entry.entryType === 'evidence');
    const claims = entries.filter((entry) => entry.entryType === 'claim');
    const challenges = entries.filter((entry) => entry.entryType === 'challenge');
    const todos = entries.filter((entry) => entry.entryType === 'todo');
    const drafts = entries.filter((entry) => entry.entryType === 'draft');
    const chatEntries = getCollectiveChatEntries(snapshot).filter((entry) => entry.role !== 'system').slice(-20);
    const mermaid = buildCollectiveMermaidDiagram(snapshot, result);

    const renderList = (items, mapper, emptyText = '暂无') => {
        if (!items || items.length === 0) {
            return `- ${emptyText}`;
        }
        return items.map((item, index) => `- ${mapper(item, index)}`).join('\n');
    };

    const evidenceTableRows = evidence.slice(-12).map((entry) => {
        const refs = Array.isArray(entry.references) && entry.references.length > 0 ? entry.references.join(' / ') : '无';
        return `| ${entry.role || '未知'} | ${Number.isFinite(entry.round) ? entry.round : '-'} | ${String(entry.content || '').replace(/\|/g, '\\|')} | ${refs.replace(/\|/g, '\\|')} |`;
    }).join('\n');

    return [
        `# ${topic} 研究总报告`,
        '',
        '## 一、执行摘要',
        finalReport || '研究组尚未形成足够完整的最终结论，以下内容根据现有黑板与聊天室记录自动汇总。',
        '',
        '## 二、研究组结构',
        renderList(teamPlan, (member) => `${member.name}：${member.description || member.missionHint || member.mission || '未说明职责'}`, '决策组自动组建，未记录显式研究员方案'),
        '',
        `## 三、协作拓扑图`,
        '```mermaid',
        mermaid,
        '```',
        '',
        '## 四、核心决策',
        renderList(decisions, (item) => item.content || '空决策'),
        '',
        '## 五、关键结论与证据链',
        '### 5.1 主要结论',
        renderList(claims.slice(-10), (item) => `${item.role || '未知成员'}：${item.content || ''}`),
        '',
        '### 5.2 关键证据矩阵',
        '| 研究员 | 轮次 | 证据内容 | 引用 |',
        '| --- | --- | --- | --- |',
        evidenceTableRows || '| 暂无 | - | - | - |',
        '',
        '## 六、争议、质疑与待办',
        '### 6.1 审查与争议',
        renderList(challenges.slice(-10), (item) => `${item.role || '未知成员'}：${item.content || ''}`),
        '',
        '### 6.2 尚未闭合的待办',
        renderList(todos.slice(-10), (item) => `${item.role || '未知成员'}：${item.content || ''}`),
        '',
        '## 七、研究过程与协作记录',
        renderList(entries.slice(-18), (item) => `[${item.entryType || 'note'}] ${item.role || '未知成员'}：${item.content || ''}`),
        '',
        '## 八、聊天室中的关键协作反馈',
        renderList(chatEntries, (item) => `${item.role || '未知成员'}：${item.content || ''}`, '最近没有关键聊天室反馈'),
        '',
        '## 九、草稿与阶段性总结',
        renderList(drafts.slice(-6), (item) => `${item.role || '未知成员'}：${item.content || ''}`, '暂无阶段性草稿'),
        '',
        '## 十、后续建议',
        renderList([
            '将关键结论转成项目模板或自动化模板，复用于后续相似研究任务。',
            '把证据矩阵中的高价值来源沉淀到项目资源，以便后续复核与引用。',
            '如仍有高风险争议点，可继续群体研究并要求特定研究员补证。'
        ], (item) => item),
        '',
        '## 附录：完整最终报告原文',
        finalReport || '暂无单独最终报告原文。'
    ].join('\n');
}

function buildCollectiveSvgSummary(snapshot = null, result = null) {
    const topic = normalizeCollectivePackageName(snapshot?.topic || result?.topic || '群体研究');
    const sections = [
        {
            title: '执行摘要',
            lines: [shortenCollectiveText(result?.finalReport || snapshot?.workBoard?.draft?.content || '暂无最终总结', 180)]
        },
        {
            title: '关键决策',
            lines: (snapshot?.workBoard?.decisions || []).slice(-4).map((entry) => shortenCollectiveText(entry.content, 80))
        },
        {
            title: '关键证据',
            lines: getCollectiveEntries(snapshot).filter((entry) => entry.entryType === 'evidence').slice(-4).map((entry) => shortenCollectiveText(`${entry.role}: ${entry.content}`, 80))
        },
        {
            title: '争议与待办',
            lines: [
                ...getCollectiveEntries(snapshot).filter((entry) => entry.entryType === 'challenge').slice(-2).map((entry) => shortenCollectiveText(`质疑: ${entry.content}`, 80)),
                ...getCollectiveEntries(snapshot).filter((entry) => entry.entryType === 'todo').slice(-2).map((entry) => shortenCollectiveText(`待办: ${entry.content}`, 80))
            ]
        }
    ];

    const width = 1120;
    const sectionWidth = 500;
    const sectionGap = 24;
    const titleHeight = 42;
    const lineHeight = 22;
    const sectionHeights = sections.map((section) => Math.max(120, 56 + Math.max(1, section.lines.length) * lineHeight));
    const totalHeight = 120 + sectionHeights.reduce((max, value, index) => {
        if (index < 2) {
            return Math.max(max, value);
        }
        return max;
    }, 0) + sectionHeights.slice(2).reduce((max, value) => Math.max(max, value), 0) + 110;

    const renderSection = (section, x, y, height) => {
        const tspans = (section.lines.length > 0 ? section.lines : ['暂无'])
            .map((line, index) => `<tspan x="${x + 20}" dy="${index === 0 ? 0 : lineHeight}">${escapeSvgText(line)}</tspan>`)
            .join('');
        return `
            <rect x="${x}" y="${y}" width="${sectionWidth}" height="${height}" rx="18" fill="#ffffff" stroke="#d6dce5" />
            <text x="${x + 20}" y="${y + 32}" font-size="18" font-weight="700" fill="#1f2937">${escapeSvgText(section.title)}</text>
            <text x="${x + 20}" y="${y + 66}" font-size="14" fill="#475569">${tspans}</text>
        `;
    };

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
  <rect width="${width}" height="${totalHeight}" fill="#f5f7fb"/>
  <rect x="24" y="24" width="${width - 48}" height="${totalHeight - 48}" rx="26" fill="#eef3f8" stroke="#d7e0eb"/>
  <text x="56" y="78" font-size="30" font-weight="700" fill="#111827">${escapeSvgText(topic)} 研究包摘要</text>
  <text x="56" y="106" font-size="15" fill="#4b5563">自动生成的群体研究视觉摘要，可继续在 SVG 编辑器中补充与调整。</text>
  ${renderSection(sections[0], 56, 138, sectionHeights[0])}
  ${renderSection(sections[1], 56 + sectionWidth + sectionGap, 138, sectionHeights[1])}
  ${renderSection(sections[2], 56, 138 + Math.max(sectionHeights[0], sectionHeights[1]) + 24, sectionHeights[2])}
  ${renderSection(sections[3], 56 + sectionWidth + sectionGap, 138 + Math.max(sectionHeights[0], sectionHeights[1]) + 24, sectionHeights[3])}
</svg>`.trim();
}

async function createCollectiveDocxArtifact(editorApi, folderId, topic, markdownContent) {
    if (
        !editorApi
        || typeof editorApi.importDocx !== 'function'
        || typeof editorApi.getDocxFiles !== 'function'
        || typeof editorApi.switchToDocxFile !== 'function'
        || typeof editorApi.setDocxContent !== 'function'
    ) {
        return null;
    }

    const beforeIds = new Set((editorApi.getDocxFiles() || []).map((item) => item.id));
    const fileName = `${topic} - 正式报告.docx`;
    const imported = await editorApi.importDocx('', fileName);
    if (!imported?.success) {
        return null;
    }

    const created = (editorApi.getDocxFiles() || []).find((item) => !beforeIds.has(item.id));
    if (!created?.id) {
        return null;
    }

    if (folderId && typeof editorApi.moveTreeItem === 'function') {
        editorApi.moveTreeItem(created.id, folderId);
    }
    await editorApi.switchToDocxFile(created.id);
    editorApi.setDocxContent(markdownContent);
    return { success: true, id: created.id, name: fileName };
}

async function createCollectiveSheetArtifact(editorApi, folderId, topic, snapshot) {
    if (
        !editorApi
        || typeof editorApi.createSheet !== 'function'
        || typeof editorApi.insertSheetData !== 'function'
    ) {
        return null;
    }

    const rows = [
        ['轮次', '研究员', '类型', '内容', '引用', '阶段', '回复对象'],
        ...buildCollectiveEvidenceRows(snapshot)
    ];
    const created = await editorApi.createSheet(`${topic} - 证据矩阵.xlsx`);
    if (!created?.success || !created.id) {
        return null;
    }
    if (folderId && typeof editorApi.moveTreeItem === 'function') {
        editorApi.moveTreeItem(created.id, folderId);
    }
    editorApi.insertSheetData(rows);
    return created;
}

async function saveCollectiveResearchPackageToEditor({ topic, snapshot = null, result = null, editorApi = null } = {}) {
    const api = editorApi || window.InfinPilotEditor || window.InfinpilotEditor;
    if (!api || typeof api.createFile !== 'function' || typeof api.setFileContent !== 'function') {
        return null;
    }

    const normalizedTopic = normalizeCollectivePackageName(topic || snapshot?.topic || result?.topic || '群体研究');
    const markdownReport = buildCollectiveExpandedReport(snapshot, result);
    const mermaidDiagram = buildCollectiveMermaidDiagram(snapshot, result);
    const svgSummary = buildCollectiveSvgSummary(snapshot, result);
    const selectedItem = typeof api.getSelectedTreeItem === 'function' ? api.getSelectedTreeItem() : null;
    const baseParentId = selectedItem?.type === 'folder' ? selectedItem.id : (selectedItem?.parentId || null);
    const packageFolder = typeof api.createNewFolder === 'function'
        ? await api.createNewFolder(`${normalizedTopic} 研究包`, baseParentId)
        : null;
    const folderId = packageFolder?.id || baseParentId || null;
    const artifacts = [];

    const mdFile = await api.createFile(`${normalizedTopic} - 总报告.md`, folderId);
    if (mdFile?.success && mdFile.id) {
        const markdownWithMermaid = `${markdownReport}\n\n## 附录：协作结构图\n\`\`\`mermaid\n${mermaidDiagram}\n\`\`\`\n`;
        await api.setFileContent(mdFile.id, markdownWithMermaid, false);
        artifacts.push({ type: 'md', id: mdFile.id, name: mdFile.name });
    }

    if (typeof api.createSvg === 'function' && typeof api.setSvgContent === 'function') {
        const svgFile = await api.createSvg(`${normalizedTopic} - 摘要.svg`, folderId);
        if (svgFile?.success && svgFile.id) {
            await api.setSvgContent(svgFile.id, svgSummary);
            artifacts.push({ type: 'svg', id: svgFile.id, name: svgFile.name });
        }
    }

    const sheetArtifact = await createCollectiveSheetArtifact(api, folderId, normalizedTopic, snapshot);
    if (sheetArtifact?.success) {
        artifacts.push({ type: 'sheet', id: sheetArtifact.id, name: sheetArtifact.name });
    }

    const docxArtifact = await createCollectiveDocxArtifact(api, folderId, normalizedTopic, markdownReport);
    if (docxArtifact?.success) {
        artifacts.push({ type: 'docx', id: docxArtifact.id, name: docxArtifact.name });
    }

    return {
        success: artifacts.length > 0,
        folderId,
        folderName: packageFolder?.name || '',
        artifacts,
        markdownReport
    };
}

function ensureCollectiveActivityStore() {
    if (!collectiveResearchRuntime) {
        return null;
    }
    if (!collectiveResearchRuntime.agentActivity) {
        collectiveResearchRuntime.agentActivity = {
            byIndex: {},
            byName: {}
        };
    }
    return collectiveResearchRuntime.agentActivity;
}

function shortenCollectiveText(text, maxLength = 120) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '';
    }
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function previewCollectiveToolInput(input) {
    if (!input || typeof input !== 'object') {
        return '';
    }
    const preview = Object.entries(input)
        .filter(([, value]) => value != null && value !== '')
        .slice(0, 3)
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join(' · ');
    return shortenCollectiveText(preview, 80);
}

function previewCollectiveToolResult(result) {
    if (!result) {
        return '';
    }
    if (typeof result === 'string') {
        return shortenCollectiveText(result, 80);
    }
    if (result.error) {
        return shortenCollectiveText(result.error, 80);
    }
    if (result.message) {
        return shortenCollectiveText(result.message, 80);
    }
    if (result.success === true) {
        return '成功';
    }
    return shortenCollectiveText(JSON.stringify(result), 80);
}

function ensureCollectiveAgentActivity(agentName, agentIndex = null, task = '') {
    const store = ensureCollectiveActivityStore();
    if (!store || !agentName) {
        return null;
    }

    let record = store.byName[agentName];
    if (!record) {
        record = {
            agentName,
            agentIndex,
            task: task || '',
            status: 'idle',
            latestSummary: '',
            latestEntry: '',
            tools: []
        };
        store.byName[agentName] = record;
    }

    if (Number.isFinite(agentIndex)) {
        record.agentIndex = agentIndex;
        store.byIndex[agentIndex] = record;
    }
    if (task) {
        record.task = task;
    }
    return record;
}

function recordCollectiveAgentStart(agentName, task, agentIndex, meta = null) {
    const record = ensureCollectiveAgentActivity(agentName, agentIndex, task);
    if (!record) {
        return;
    }
    record.lastPhase = meta?.phase || '';
    record.status = 'running';
}

function recordCollectiveAgentComplete(agentName, result, agentIndex, meta = null) {
    const record = ensureCollectiveAgentActivity(agentName, agentIndex, '');
    if (!record) {
        return;
    }
    const phase = meta?.phase || result?.__collectivePhase || '';
    record.lastPhase = phase;
    if (phase !== 'chat-review') {
        record.status = result?.status === 'failed' ? 'failed' : 'idle';
        record.latestSummary = shortenCollectiveText(result?.summary || result?.findings || result?.error || '', 140);
    }
    if (collectiveResearchRuntime?.lastSnapshot) {
        renderCollectiveRoleCards(collectiveResearchRuntime.lastSnapshot);
    }
}

function recordCollectiveToolCall(toolName, toolInput, toolId, agentIndex) {
    const store = ensureCollectiveActivityStore();
    if (!store) {
        return;
    }
    const record = store.byIndex[agentIndex];
    if (!record) {
        return;
    }
    record.status = 'running';
    record.tools = Array.isArray(record.tools) ? record.tools : [];
    record.tools.unshift({
        id: toolId,
        name: toolName,
        inputPreview: previewCollectiveToolInput(toolInput),
        resultPreview: '',
        status: 'running',
        startedAt: Date.now()
    });
    record.tools = record.tools.slice(0, 6);
    if (collectiveResearchRuntime?.lastSnapshot) {
        renderCollectiveRoleCards(collectiveResearchRuntime.lastSnapshot);
    }
}

function recordCollectiveToolResult(toolId, result, agentIndex) {
    const store = ensureCollectiveActivityStore();
    if (!store) {
        return;
    }
    const record = store.byIndex[agentIndex];
    if (!record || !Array.isArray(record.tools)) {
        return;
    }
    const tool = record.tools.find((entry) => entry.id === toolId);
    if (!tool) {
        return;
    }
    tool.status = result?.error ? 'failed' : 'done';
    tool.resultPreview = previewCollectiveToolResult(result);
    void persistCollectiveToolResultToProject(tool.name || '', result, record.agentName || '', agentIndex);
    if (collectiveResearchRuntime?.lastSnapshot) {
        renderCollectiveRoleCards(collectiveResearchRuntime.lastSnapshot);
    }
}

initializeCollectiveResearchUI = function initializeCollectiveResearchUIEnhanced(topic = '') {
    teardownCollectiveResearchUI();

    const container = document.createElement('div');
    container.id = 'collective-research-container';
    container.className = 'collective-research-container';
    container.innerHTML = `
        <div class="collective-research-header collective-research-header--compact">
            <div class="collective-research-title-wrap">
                <div class="collective-research-title">群体研究</div>
                <div class="collective-research-topic">${escapeHtml(topic)}</div>
            </div>
            <div class="collective-research-header-actions">
                <div class="collective-research-status" id="collective-research-status">决策组准备中</div>
                <button type="button" class="collective-inline-btn" id="collective-stop-btn">停止</button>
            </div>
        </div>
        <div class="collective-research-meta collective-research-meta--compact">
            <div class="collective-meta-pill" id="collective-round-pill">第 0 次协作</div>
            <div class="collective-meta-pill" id="collective-role-pill">0 名成员</div>
            <div class="collective-meta-pill" id="collective-entry-pill">0 条黑板</div>
        </div>
        <details class="collective-section collective-section--highlights" open>
            <summary class="collective-section-summary">
                <span>研究摘要</span>
                <span class="collective-section-hint">决策 / 争议 / 待办</span>
            </summary>
            <div class="collective-section-body">
                <div class="collective-research-highlights">
                    <div class="collective-highlight-block">
                        <div class="collective-highlight-title">决策</div>
                        <div class="collective-highlight-body" id="collective-decisions"></div>
                    </div>
                    <div class="collective-highlight-block">
                        <div class="collective-highlight-title">争议</div>
                        <div class="collective-highlight-body" id="collective-challenges"></div>
                    </div>
                    <div class="collective-highlight-block">
                        <div class="collective-highlight-title">待办</div>
                        <div class="collective-highlight-body" id="collective-todos"></div>
                    </div>
                </div>
            </div>
        </details>
        <details class="collective-section" open>
            <summary class="collective-section-summary">
                <span>研究成员</span>
                <span class="collective-section-hint">查看成员状态与工具调用</span>
            </summary>
            <div class="collective-section-body">
                <div class="collective-research-members-panel">
                    <div class="collective-role-grid" id="collective-role-grid"></div>
                </div>
            </div>
        </details>
        <details class="collective-section" open>
            <summary class="collective-section-summary">
                <span>聊天室</span>
                <span class="collective-section-hint">广播与自由交流</span>
            </summary>
            <div class="collective-section-body">
                <div class="collective-research-board-panel collective-research-board-panel--chat">
                    <div class="collective-research-board collective-research-board--chat" id="collective-chat-feed"></div>
                </div>
            </div>
        </details>
        <details class="collective-section" open>
            <summary class="collective-section-summary">
                <span>工作黑板</span>
                <span class="collective-section-hint">结构化工作结果</span>
            </summary>
            <div class="collective-section-body">
                <div class="collective-research-board-panel">
                    <div class="collective-board-toolbar">
                        <div class="collective-board-toolbar-title">筛选</div>
                        <div class="collective-board-toolbar-controls">
                            <select id="collective-filter-type" class="collective-filter-select"></select>
                            <select id="collective-filter-role" class="collective-filter-select"></select>
                            <select id="collective-filter-round" class="collective-filter-select"></select>
                            <button type="button" class="collective-inline-btn" id="collective-filter-reset-btn">重置筛选</button>
                        </div>
                    </div>
                    <div class="collective-research-board" id="collective-blackboard-feed"></div>
                </div>
            </div>
        </details>
        <details class="collective-section" open>
            <summary class="collective-section-summary">
                <span>研究报告</span>
                <span class="collective-section-hint">汇总输出与后续动作</span>
            </summary>
            <div class="collective-section-body">
                <div class="collective-research-report" id="collective-final-report"></div>
            </div>
        </details>
    `;

    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
        chatMessages.insertBefore(container, chatMessages.firstChild || null);
    }

    collectiveResearchRuntime = {
        container,
        status: container.querySelector('#collective-research-status'),
        stopBtn: container.querySelector('#collective-stop-btn'),
        round: container.querySelector('#collective-round-pill'),
        roles: container.querySelector('#collective-role-pill'),
        entries: container.querySelector('#collective-entry-pill'),
        roleGrid: container.querySelector('#collective-role-grid'),
        decisions: container.querySelector('#collective-decisions'),
        challenges: container.querySelector('#collective-challenges'),
        todos: container.querySelector('#collective-todos'),
        chatBoard: container.querySelector('#collective-chat-feed'),
        board: container.querySelector('#collective-blackboard-feed'),
        report: container.querySelector('#collective-final-report'),
        typeFilter: container.querySelector('#collective-filter-type'),
        roleFilter: container.querySelector('#collective-filter-role'),
        roundFilter: container.querySelector('#collective-filter-round'),
        resetFilterBtn: container.querySelector('#collective-filter-reset-btn'),
        filters: {
            type: 'all',
            role: 'all',
            round: 'all'
        },
        agentActivity: {
            byIndex: {},
            byName: {}
        },
        lastSnapshot: null,
        lastResult: null
    };

    const reRenderBoard = () => renderBlackboardFeed(collectiveResearchRuntime?.lastSnapshot);
    collectiveResearchRuntime.typeFilter?.addEventListener('change', (event) => {
        collectiveResearchRuntime.filters.type = event.target.value || 'all';
        reRenderBoard();
    });
    collectiveResearchRuntime.roleFilter?.addEventListener('change', (event) => {
        collectiveResearchRuntime.filters.role = event.target.value || 'all';
        reRenderBoard();
    });
    collectiveResearchRuntime.roundFilter?.addEventListener('change', (event) => {
        collectiveResearchRuntime.filters.round = event.target.value || 'all';
        reRenderBoard();
    });
    collectiveResearchRuntime.resetFilterBtn?.addEventListener('click', () => {
        collectiveResearchRuntime.filters = { type: 'all', role: 'all', round: 'all' };
        if (collectiveResearchRuntime.typeFilter) collectiveResearchRuntime.typeFilter.value = 'all';
        if (collectiveResearchRuntime.roleFilter) collectiveResearchRuntime.roleFilter.value = 'all';
        if (collectiveResearchRuntime.roundFilter) collectiveResearchRuntime.roundFilter.value = 'all';
        reRenderBoard();
    });
    collectiveResearchRuntime.stopBtn?.addEventListener('click', () => {
        collectiveResearchStopRequested = true;
        window.CollectiveResearch?.engine?.stopSession?.();
        if (collectiveResearchRuntime?.status) {
            collectiveResearchRuntime.status.textContent = '停止中';
        }
    });
    syncCollectiveFilterOptions();
};

renderCollectiveSchedulerStatus = function renderCollectiveSchedulerStatusEnhanced(snapshot = null) {
    if (!collectiveResearchRuntime?.status || !snapshot) {
        return;
    }
    const activeTask = snapshot.scheduler?.activeTask;
    const queuedCount = snapshot.scheduler?.queuedCount || 0;
    const phaseLabelMap = {
        planning: '决策组讨论中',
        research: '研究组推进中',
        review: '决策组复盘中',
        synthesis: '正在生成报告',
        paused: '等待继续',
        stopped: '已停止'
    };
    const phaseLabel = phaseLabelMap[snapshot.phase] || '研究中';
    const statusText = activeTask
        ? `${phaseLabel} · ${activeTask.roleName}`
        : (snapshot.status === 'stopped' ? '已停止' : phaseLabel);
    collectiveResearchRuntime.status.textContent = queuedCount > 0 ? `${statusText} · 队列 ${queuedCount}` : statusText;
    if (collectiveResearchRuntime.stopBtn) {
        const isEnded = snapshot.status === 'stopped';
        collectiveResearchRuntime.stopBtn.disabled = isEnded;
        collectiveResearchRuntime.stopBtn.textContent = snapshot.status === 'stopped' ? '已停止' : '结束研究';
    }
    if (collectiveResearchRuntime.round) {
        collectiveResearchRuntime.round.textContent = `第 ${snapshot.currentRound || 0} 次协作`;
    }
    if (collectiveResearchRuntime.roles) {
        collectiveResearchRuntime.roles.textContent = `${snapshot.agentRoster?.length || 0} 名在线成员`;
    }
    if (collectiveResearchRuntime.entries) {
        collectiveResearchRuntime.entries.textContent = `${getCollectiveEntries(snapshot).length} 条工作板 / ${getCollectiveChatEntries(snapshot).length} 条聊天`;
    }
};

renderBlackboardFeed = function renderBlackboardFeedEnhanced(snapshot = null) {
    if (!collectiveResearchRuntime?.board || !(snapshot?.workBoard || snapshot?.blackboard)) {
        return;
    }
    collectiveResearchRuntime.lastSnapshot = snapshot;
    syncCollectiveFilterOptions(snapshot);

    const entries = getFilteredCollectiveEntries(snapshot);
    if (entries.length === 0) {
        const hasFilters = Object.values(collectiveResearchRuntime.filters).some((value) => value !== 'all');
        collectiveResearchRuntime.board.innerHTML = `<div class="collective-board-empty">${hasFilters ? '当前筛选条件下没有黑板内容' : '黑板还没有内容'}</div>`;
        return;
    }

    collectiveResearchRuntime.board.innerHTML = entries.slice(-24).map((entry) => {
        const referenceHtml = Array.isArray(entry.references) && entry.references.length > 0
            ? `<div class="collective-board-references">${entry.references.map((ref) => `<span class="collective-board-reference">${escapeHtml(String(ref))}</span>`).join('')}</div>`
            : '';
        const roundText = Number.isFinite(entry.round) ? `第 ${entry.round} 次协作` : '未分协作轮次';
        const phaseText = entry.metadata?.phase ? `<span class="collective-board-round">${escapeHtml(entry.metadata.phase)}</span>` : '';
        return `
            <article class="collective-board-entry">
                <div class="collective-board-entry-meta">
                    <span class="collective-board-role">${escapeHtml(entry.role || '未知角色')}</span>
                    <span class="collective-board-type">${escapeHtml(COLLECTIVE_ENTRY_LABELS[entry.entryType] || entry.entryType || '笔记')}</span>
                    <span class="collective-board-round">${escapeHtml(roundText)}</span>
                    ${phaseText}
                </div>
                <div class="collective-board-content">${escapeHtml(entry.content || '')}</div>
                ${referenceHtml}
            </article>
        `;
    }).join('');
    collectiveResearchRuntime.board.scrollTop = collectiveResearchRuntime.board.scrollHeight;
};

function renderCollectiveChatFeed(snapshot = null) {
    if (!collectiveResearchRuntime?.chatBoard) {
        return;
    }
    const entries = getCollectiveChatEntries(snapshot);
    if (entries.length === 0) {
        collectiveResearchRuntime.chatBoard.innerHTML = '<div class="collective-board-empty">聊天室还没有消息</div>';
        return;
    }

    collectiveResearchRuntime.chatBoard.innerHTML = entries.slice(-24).map((entry) => {
        const roundText = Number.isFinite(entry.round) ? `第 ${entry.round} 次协作` : '系统广播';
        const phaseText = entry.metadata?.phase ? `<span class="collective-board-round">${escapeHtml(entry.metadata.phase)}</span>` : '';
        const audienceNames = Array.isArray(entry.metadata?.audienceRoleNames) ? entry.metadata.audienceRoleNames.filter(Boolean) : [];
        const replyToName = entry.metadata?.replyToRoleId
            ? escapeHtml(
                ([
                    ...(snapshot?.decisionCommittee || []),
                    ...(snapshot?.supportRoles || []),
                    ...(snapshot?.roles || [])
                ].find((role) => role.id === entry.metadata.replyToRoleId)?.name || entry.metadata.replyToRoleId)
              )
            : '';
        const typeLabel = entry.metadata?.isWorkResultNotice
            ? '<span class="collective-chat-badge">黑板提示</span>'
            : (entry.metadata?.isDirected ? '<span class="collective-chat-badge">定向消息</span>' : '');
        const audienceLabel = audienceNames.length > 0
            ? `<span class="collective-chat-audience">定向给：${escapeHtml(audienceNames.join('、'))}</span>`
            : '';
        const replyLabel = replyToName
            ? `<span class="collective-chat-reply">回复：${replyToName}</span>`
            : '';
        return `
            <article class="collective-chat-entry">
                <div class="collective-chat-entry-meta">
                    <span class="collective-board-role">${escapeHtml(entry.role || '未知成员')}</span>
                    <span class="collective-board-round">${escapeHtml(roundText)}</span>
                    ${phaseText}
                    ${typeLabel}
                    ${audienceLabel}
                    ${replyLabel}
                </div>
                <div class="collective-chat-entry-content">${escapeHtml(entry.content || '')}</div>
            </article>
        `;
    }).join('');
    collectiveResearchRuntime.chatBoard.scrollTop = collectiveResearchRuntime.chatBoard.scrollHeight;
}

renderCollectiveRoleCards = function renderCollectiveRoleCardsEnhanced(snapshot = null) {
    if (!collectiveResearchRuntime?.roleGrid || !snapshot) {
        return;
    }

    const roles = [
        ...((snapshot.decisionCommittee || []).map((role) => ({ ...role, roleGroup: '决策组' }))),
        ...((snapshot.supportRoles || []).map((role) => ({ ...role, roleGroup: '支持组' }))),
        ...((snapshot.roles || []).map((role) => ({ ...role, roleGroup: '研究组' })))
    ];
    const tasks = Array.isArray(snapshot.scheduler?.queue) ? snapshot.scheduler.queue : [];
    const entries = getCollectiveEntries(snapshot);
    const activityStore = ensureCollectiveActivityStore();

    if (roles.length === 0) {
        collectiveResearchRuntime.roleGrid.innerHTML = '';
        return;
    }

    collectiveResearchRuntime.roleGrid.innerHTML = roles.map((role) => {
        const latestTask = [...tasks].reverse().find((task) => task.roleId === role.id && task.phase !== 'chat-review');
        const latestEntry = [...entries].reverse().find((entry) => entry.role === role.name);
        const activity = activityStore?.byName?.[role.name] || null;
        const rawStatus = latestTask?.status || activity?.status || 'idle';
        const status = rawStatus === 'done' && snapshot.status !== 'stopped' ? 'idle' : rawStatus;
        const statusLabelMap = {
            queued: '排队中',
            running: '执行中',
            done: snapshot.status === 'stopped' ? '已完成' : '待命中',
            failed: '失败',
            paused_waiting_input: '等待输入',
            idle: snapshot.status === 'stopped' ? '已结束' : '待命中'
        };
        const latestTaskText = latestTask?.mission || activity?.task || role.missionHint || role.description || '';
        const latestEntryText = latestEntry?.content || activity?.latestSummary || '还没有最新贡献';
        const tools = Array.isArray(activity?.tools) ? activity.tools.slice(0, 3) : [];
        const toolHtml = tools.length > 0
            ? `
                <details class="collective-role-tools" ${status === 'running' ? 'open' : ''}>
                    <summary class="collective-role-tools-summary">
                        <span class="collective-role-card-label collective-role-card-label--inline">工具调用</span>
                        <span class="collective-role-tools-count">${tools.length}</span>
                    </summary>
                    <div class="collective-role-tool-list">
                        ${tools.map((tool) => `
                            <div class="collective-role-tool collective-role-tool--${escapeHtml(tool.status || 'done')}">
                                <div class="collective-role-tool-name">${escapeHtml(tool.name || 'tool')}</div>
                                <div class="collective-role-tool-meta">${escapeHtml(tool.inputPreview || tool.resultPreview || '')}</div>
                            </div>
                        `).join('')}
                    </div>
                </details>
            `
            : '';
        return `
            <article class="collective-role-card collective-role-card--${escapeHtml(status)}">
                <div class="collective-role-card-header">
                    <div>
                        <div class="collective-role-card-title">${escapeHtml(role.name)}</div>
                        <div class="collective-role-card-group">${escapeHtml(role.roleGroup || '成员')}</div>
                    </div>
                    <div class="collective-role-card-status">${escapeHtml(statusLabelMap[status] || status)}</div>
                </div>
                <div class="collective-role-card-label">本轮任务</div>
                <div class="collective-role-card-body collective-role-card-body--compact">${escapeHtml(shortenCollectiveText(latestTaskText, 120) || '待分配')}</div>
                <div class="collective-role-card-label">最近动作</div>
                <div class="collective-role-card-body collective-role-card-body--compact">${escapeHtml(shortenCollectiveText(latestEntryText, 120) || '暂无')}</div>
                ${toolHtml}
            </article>
        `;
    }).join('');
};

renderCollectiveHighlights = function renderCollectiveHighlightsEnhanced(snapshot = null) {
    if (!collectiveResearchRuntime || !(snapshot?.workBoard || snapshot?.blackboard)) {
        return;
    }

    const entries = getCollectiveEntries(snapshot);
    const decisions = Array.isArray(snapshot.workBoard?.decisions)
        ? snapshot.workBoard.decisions
        : (Array.isArray(snapshot.blackboard?.decisions) ? snapshot.blackboard.decisions : []);
    const challenges = entries.filter((entry) => entry.entryType === 'challenge').slice(-4);
    const todos = entries.filter((entry) => entry.entryType === 'todo').slice(-4);

    const renderList = (items, pickText) => {
        if (!items || items.length === 0) {
            return '<div class="collective-highlight-empty">暂无</div>';
        }
        return items.map((item) => `<div class="collective-highlight-item">${escapeHtml(pickText(item))}</div>`).join('');
    };

    if (collectiveResearchRuntime.decisions) {
        collectiveResearchRuntime.decisions.innerHTML = renderList(decisions.slice(-4), (item) => item.content || '');
    }
    if (collectiveResearchRuntime.challenges) {
        collectiveResearchRuntime.challenges.innerHTML = renderList(challenges, (item) => item.content || '');
    }
    if (collectiveResearchRuntime.todos) {
        collectiveResearchRuntime.todos.innerHTML = renderList(todos, (item) => item.content || '');
    }
};

async function createCollectiveTemplateFromRecord(record = null) {
    const sourceRecord = getCollectiveTemplateSourceRecord(record);
    if (!sourceRecord) {
        return { success: false, error: '当前没有可保存为模板的群体研究结果' };
    }

    try {
        const result = await projectService.createTemplateFromCollectiveRecord(sourceRecord, {
            name: `${getCollectiveTopicFromRecord(sourceRecord)} 模板`
        });
        if (result?.success) {
            document.dispatchEvent(new CustomEvent('infinpilot:projects-updated'));
        }
        return result;
    } catch (error) {
        return {
            success: false,
            error: error.message || '群体研究模板创建失败'
        };
    }
}

async function buildCollectiveContextSections(runtimeState = {}) {
    const contextSections = [];
    const projectPromptContext = await getCurrentProjectPromptContext();
    if (projectPromptContext) {
        contextSections.push(projectPromptContext);
    }
    if (Array.isArray(runtimeState.selectedContextTabs)) {
        for (const item of runtimeState.selectedContextTabs.filter((entry) => entry.content && !entry.isLoading)) {
            contextSections.push(`${item.title || item.url || '上下文'}\n${item.content}`);
        }
    }
    return contextSections;
}

async function buildCollectiveApiConfigOverride(currentTranslationsOverride = null) {
    const config = await browser.storage.sync.get([
        'agentSdkEndpoint',
        'agentSdkApiKey',
        'agentSdkModel'
    ]);
    const endpoint = config.agentSdkEndpoint || 'https://api.anthropic.com';
    const apiKey = config.agentSdkApiKey;
    const model = config.agentSdkModel || 'claude-sonnet-4-5';
    if (!apiKey) {
        throw new Error(_('agentSdkApiKeyMissing', {}, currentTranslationsOverride || {}) || '请先配置 Claude Agent SDK 的 API Key');
    }
    return { endpoint, apiKey, model };
}

function createCollectiveEngineCallbacks(renderUI) {
    if (!renderUI) {
        return {};
    }
    return {
        onSessionStart: (snapshot) => renderCollectiveResearchDock(snapshot),
        onRoundStart: (_roundNumber, snapshot) => renderCollectiveResearchDock(snapshot),
        onRoleStart: (_role, _task, snapshot) => renderCollectiveResearchDock(snapshot),
        onBlackboardUpdate: (_entry, snapshot) => renderCollectiveResearchDock(snapshot),
        onBroadcast: (_entry, snapshot) => renderCollectiveResearchDock(snapshot),
        onRoleComplete: (_role, _action, _result, snapshot) => renderCollectiveResearchDock(snapshot),
        onSessionComplete: (result, snapshot) => renderCollectiveResearchDock(snapshot, result),
        onSessionStopped: (snapshot) => renderCollectiveResearchDock(snapshot)
    };
}

async function saveCollectiveResearchResultToProjectOverride(result) {
    if (!result?.snapshot) {
        return null;
    }

    try {
        const saved = await projectService.saveCollectiveSession(null, {
            ...result.snapshot,
            topic: result.topic,
            roundsCompleted: result.roundsCompleted,
            finalReport: result.finalReport
        });
        const resultItem = await projectService.addProjectItem({
            type: 'collective_research_result',
            title: result.topic || '群体研究结果',
            content: {
                topic: result.topic,
                finalReport: result.finalReport,
                roundsCompleted: result.roundsCompleted,
                snapshot: result.snapshot
            }
        });
        document.dispatchEvent(new CustomEvent('infinpilot:projects-updated'));
        return { ...saved, resultItem };
    } catch (error) {
        console.warn('[CollectiveResearch] Failed to save result to project:', error);
        return null;
    }
}

async function runCollectiveResearchWorkflowOverride(options = {}) {
    const {
        topic = '',
        roles = [],
        context = '',
        snapshot = null,
        renderUI = document.body.classList.contains('collective-research-mode'),
        persistToProject = true,
        currentTranslations: currentTranslationsOverride = null
    } = options;

    const existingEngine = window.CollectiveResearch?.engine;
    if (existingEngine) {
        const existingStatus = existingEngine.getSnapshot?.().status;
        if (existingStatus === 'stopped') {
            window.CollectiveResearch.engine = null;
        } else {
            return { success: false, error: '当前已有群体研究任务正在执行' };
        }
    }

    const SubAgentEngine = window.DeepResearch?.SubAgentEngine;
    if (!SubAgentEngine) {
        return { success: false, error: '群体研究执行器未加载，请刷新页面后重试' };
    }

    if (renderUI) {
        initializeCollectiveResearchUI(topic || snapshot?.topic || '群体研究');
    }
    ensureCollectiveProjectCaptureKeys().clear();

    try {
        const apiConfig = await buildCollectiveApiConfigOverride(currentTranslationsOverride);
        const initialTools = await getAllAgentTools(true);
        const subAgentEngine = new SubAgentEngine(initialTools, apiConfig, {
        onSubAgentStart: (agentName, task, agentIndex, meta) => {
            recordCollectiveAgentStart(agentName, task, agentIndex, meta);
            console.log('[CollectiveResearch] Role started:', agentName, task, agentIndex);
        },
        onSubAgentComplete: (agentName, result, agentIndex, meta) => {
            recordCollectiveAgentComplete(agentName, result, agentIndex, meta);
            console.log('[CollectiveResearch] Role completed:', agentName, agentIndex, result?.summary);
        },
            onToolCall: (toolName, toolInput, toolId, agentIndex) => {
                recordCollectiveToolCall(toolName, toolInput, toolId, agentIndex);
                console.log('[CollectiveResearch] Tool call:', toolName, toolId, agentIndex, toolInput);
            },
            onToolResult: (toolId, result, agentIndex) => {
                recordCollectiveToolResult(toolId, result, agentIndex);
                console.log('[CollectiveResearch] Tool result:', toolId, agentIndex, result);
            }
        });

        const collectiveEngine = new CollectiveResearchEngine({
            tools: initialTools,
            apiConfig,
            subAgentEngine,
            callbacks: createCollectiveEngineCallbacks(renderUI)
        });

        window.CollectiveResearch = window.CollectiveResearch || {};
        window.CollectiveResearch.engine = collectiveEngine;

        if (snapshot) {
            await collectiveEngine.resumeSession({
                snapshot,
                context
            });
        } else {
            await collectiveEngine.startSession({
                topic,
                roles,
                context
            });
        }

        const result = await collectiveEngine.runUntilSettled();
        const saved = persistToProject ? await saveCollectiveResearchResultToProjectOverride(result) : null;
        window.CollectiveResearch.lastResult = result;
        window.CollectiveResearch.lastSaved = saved;
        await saveCollectiveHistorySession({
            topic: result.topic || topic || snapshot?.topic || '群体研究',
            result
        });
        return {
            success: true,
            ...result,
            saved,
            resultItemId: saved?.resultItem?.id || ''
        };
    } catch (error) {
        console.error('[CollectiveResearch] Workflow failed:', error);
        if (window.CollectiveResearch) {
            window.CollectiveResearch.engine = null;
        }
        return {
            success: false,
            error: error.message || '群体研究执行失败'
        };
    } finally {
        collectiveResearchStopRequested = false;
    }
}

async function continueCollectiveResearchFromRecordOverride(record, options = {}) {
    const snapshot = getCollectiveSnapshotFromRecord(record);
    if (!snapshot) {
        return { success: false, error: '当前素材不包含可继续的研究会话' };
    }
    if (typeof window.updateButtonStates === 'function') {
        window.updateButtonStates(true, false, true);
    }
    const contextSections = options.contextSections || await buildCollectiveContextSections(window.state || {});
    return runCollectiveResearchWorkflowOverride({
        snapshot,
        context: Array.isArray(contextSections) ? contextSections.join('\n\n') : String(contextSections || ''),
        renderUI: true,
        persistToProject: true,
        currentTranslations: options.currentTranslations || currentTranslations
    });
}

async function continueCurrentCollectiveResearch() {
    const liveEngine = window.CollectiveResearch?.engine;
    if (liveEngine && typeof liveEngine.runUntilSettled === 'function' && liveEngine.getSnapshot?.().status !== 'stopped') {
        try {
            const refreshedTools = await getAllAgentTools(true);
            liveEngine.setTools?.(refreshedTools);
            const contextSections = await buildCollectiveContextSections(window.state || {});
            if (typeof liveEngine.sharedContext === 'string') {
                liveEngine.sharedContext = Array.isArray(contextSections) ? contextSections.join('\n\n') : String(contextSections || '');
            }
            collectiveResearchStopRequested = false;
            const result = await liveEngine.runUntilSettled();
            const saved = await saveCollectiveResearchResultToProjectOverride(result);
            window.CollectiveResearch.lastResult = result;
            window.CollectiveResearch.lastSaved = saved;
            return {
                success: true,
                ...result,
                saved,
                resultItemId: saved?.resultItem?.id || ''
            };
        } catch (error) {
            console.error('[CollectiveResearch] Continue failed:', error);
            return {
                success: false,
                error: error.message || '继续群体研究失败'
            };
        }
    }

    const lastResult = window.CollectiveResearch?.lastResult;
    if (!lastResult?.snapshot) {
        return { success: false, error: '当前没有可继续的群体研究结果' };
    }
    return continueCollectiveResearchFromRecordOverride({
        type: 'collective_research_result',
        content: {
            topic: lastResult.topic,
            snapshot: lastResult.snapshot
        }
    });
}

renderCollectiveResearchDock = function renderCollectiveResearchDockEnhanced(snapshot = null, result = null) {
    if (!collectiveResearchRuntime || !snapshot) {
        return;
    }
    collectiveResearchRuntime.lastSnapshot = snapshot;
    if (result) {
        collectiveResearchRuntime.lastResult = result;
    }
    renderCollectiveSchedulerStatus(snapshot);
    renderCollectiveRoleCards(snapshot);
    renderCollectiveHighlights(snapshot);
    renderBlackboardFeed(snapshot);
    renderCollectiveChatFeed(snapshot);

    if (!collectiveResearchRuntime.report) {
        return;
    }
    const reportContent = buildCollectiveRuntimeReportContent(snapshot, result || collectiveResearchRuntime.lastResult);
    const hasLiveEngine = Boolean(window.CollectiveResearch?.engine && snapshot.status !== 'stopped');
    const hasSnapshotSource = Boolean(getCollectiveSnapshotFromRecord(getCollectiveTemplateSourceRecord()));
    const canContinue = (snapshot.status === 'paused' && hasLiveEngine) || ((snapshot.status === 'paused' || snapshot.status === 'stopped') && hasSnapshotSource);
    const canCreateTemplate = Boolean(getCollectiveTemplateSourceRecord());
    const teamSummary = snapshot.teamPlan?.members?.length
        ? snapshot.teamPlan.members.map((member) => member.name).join('、')
        : '决策组将自动决定研究成员';
    collectiveResearchRuntime.report.innerHTML = `
        <div class="collective-report-title">研究报告</div>
        <div class="collective-report-meta">
            <span>${escapeHtml(snapshot.topic || '群体研究')}</span>
            <span>已协作 ${escapeHtml(String(snapshot.currentRound || 0))} 次</span>
            <span>${escapeHtml(teamSummary)}</span>
        </div>
        <div class="collective-report-body">${escapeHtml(reportContent || '研究组仍在线协作，暂未形成最终报告。')}</div>
        <div class="collective-report-actions">
            <button type="button" class="collective-inline-btn" id="collective-save-editor-btn" ${reportContent ? '' : 'disabled'}>生成研究包</button>
            <button type="button" class="collective-inline-btn" id="collective-save-template-btn" ${canCreateTemplate ? '' : 'disabled'}>保存为模板</button>
            <button type="button" class="collective-inline-btn" id="collective-continue-btn" ${canContinue ? '' : 'disabled'}>继续研究</button>
        </div>
    `;

    collectiveResearchRuntime.report.querySelector('#collective-save-editor-btn')?.addEventListener('click', async () => {
        const saved = await saveCollectiveReportToEditor(reportContent, snapshot.topic || '群体研究报告');
        if (saved?.success && window.showToastUI) {
            window.showToastUI(`已生成研究包：${snapshot.topic || '群体研究报告'}`, 'success');
        }
    });
    collectiveResearchRuntime.report.querySelector('#collective-save-template-btn')?.addEventListener('click', async () => {
        const templateResult = await createCollectiveTemplateFromRecord();
        if (window.showToastUI) {
            window.showToastUI(
                templateResult?.success ? `已创建模板：${templateResult.template.name}` : (templateResult?.error || '群体研究模板创建失败'),
                templateResult?.success ? 'success' : 'error'
            );
        }
    });
    collectiveResearchRuntime.report.querySelector('#collective-continue-btn')?.addEventListener('click', async () => {
        const continueResult = await continueCurrentCollectiveResearch();
        if (!continueResult?.success && window.showToastUI) {
            window.showToastUI(continueResult?.error || '继续群体研究失败', 'error');
        }
    });
};

saveCollectiveResearchResultToProject = saveCollectiveResearchResultToProjectOverride;
window.runCollectiveResearchWorkflow = runCollectiveResearchWorkflowOverride;
window.continueCollectiveResearchFromRecord = continueCollectiveResearchFromRecordOverride;
window.createCollectiveTemplateFromRecord = createCollectiveTemplateFromRecord;

startCollectiveResearch = async function startCollectiveResearchEnhanced(userMessage, state, elements, currentTranslations, addMessageToChatCallback, addThinkingAnimationCallback, restoreSendButtonAndInputCallback, showToastCallback) {
    console.log('[CollectiveResearch] Starting collective research mode');
    window.CollectiveResearch = window.CollectiveResearch || {};
    collectiveResearchStopRequested = false;
    if (!userMessage) {
        showToastCallback?.('请输入群体研究任务', 'warning');
        return;
    }

    state.isStreaming = true;
    try {
        if (elements?.userInput) {
            elements.userInput.value = '';
        }

        const contextSections = await buildCollectiveContextSections(state);
        const result = await runCollectiveResearchWorkflowOverride({
            topic: userMessage,
            context: contextSections.join('\n\n'),
            renderUI: true,
            persistToProject: true,
            currentTranslations
        });

        if (!result?.success) {
            throw new Error(result?.error || '群体研究执行失败');
        }
        if (collectiveResearchRuntime?.status) {
            collectiveResearchRuntime.status.textContent = result.snapshot?.status === 'stopped'
                ? '研究已结束'
                : '研究已收束，可继续或导出';
        }
        showToastCallback?.(result.snapshot?.status === 'stopped' ? '群体研究已停止并保存当前结果' : '群体研究已完成', 'success');
    } catch (error) {
        console.error('[CollectiveResearch] Failed:', error);
        if (collectiveResearchRuntime?.status) {
            collectiveResearchRuntime.status.textContent = '执行失败';
        }
        if (collectiveResearchRuntime?.report) {
            collectiveResearchRuntime.report.innerHTML = `
                <div class="collective-report-title">研究状态</div>
                <div class="collective-report-body">群体研究执行失败：${escapeHtml(error.message || '未知错误')}</div>
            `;
        }
        showToastCallback?.(error.message || '群体研究执行失败', 'error');
    } finally {
        state.isStreaming = false;
        collectiveResearchStopRequested = false;
        restoreSendButtonAndInputCallback?.(state, elements, currentTranslations);
    }
};

/**
 * 初始化 SubAgent UI 显示容器
 * 创建层级 UI：subAgent 作为一级菜单，工具调用作为二级菜单
 */
function initializeSubAgentUI() {
    // 清理旧的 UI 容器和事件监听器（如果存在）
    const existingContainer = document.getElementById('subagent-ui-container');
    if (existingContainer) {
        existingContainer.remove();
    }

    // 清理旧的事件监听器
    if (window.DeepResearchUIHandlers) {
        window.removeEventListener('subagent-start', window.DeepResearchUIHandlers.onStart);
        window.removeEventListener('subagent-complete', window.DeepResearchUIHandlers.onComplete);
        window.removeEventListener('subagent-tool-call', window.DeepResearchUIHandlers.onToolCall);
        window.removeEventListener('subagent-tool-result', window.DeepResearchUIHandlers.onToolResult);
        document.removeEventListener('infinpilot:scheduler-updated', window.DeepResearchUIHandlers.onSchedulerUpdate);
    }

    // 保存事件处理器引用，便于后续清理
    window.DeepResearchUIHandlers = {
        onStart: handleSubAgentStart,
        onComplete: handleSubAgentComplete,
        onToolCall: handleSubAgentToolCall,
        onToolResult: handleSubAgentToolResult,
        onSchedulerUpdate: handleSchedulerUpdate
    };

    // 创建 SubAgent UI 容器
    const container = document.createElement('div');
    container.id = 'subagent-ui-container';
    container.className = 'subagent-ui-container';
    container.style.display = 'none'; // 默认隐藏，执行计划时显示

    container.innerHTML = `
        <div class="subagent-ui-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            <span class="subagent-ui-title">深度研究</span>
        </div>
        <div class="subagent-scheduler-status" id="subagent-scheduler-status"></div>
        <div class="subagent-ui-content" id="subagent-cards"></div>
    `;

    // 添加到聊天消息区域之前
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages && chatMessages.parentElement) {
        chatMessages.parentElement.insertBefore(container, chatMessages);
    }

    // 监听 SubAgent 事件并更新 UI
    window.addEventListener('subagent-start', handleSubAgentStart);
    window.addEventListener('subagent-complete', handleSubAgentComplete);
    window.addEventListener('subagent-tool-call', handleSubAgentToolCall);
    window.addEventListener('subagent-tool-result', handleSubAgentToolResult);
    document.addEventListener('infinpilot:scheduler-updated', handleSchedulerUpdate);
    renderSchedulerStatus();

    console.log('[DeepResearch] SubAgent UI initialized');
}

/**
 * 处理 SubAgent 启动事件
 */
function handleSubAgentStart(event) {
    const { agentName, task, agentIndex } = event.detail;
    showSubAgentUI();
    addSubAgentCard(agentName, task, agentIndex);
}

/**
 * 处理 SubAgent 完成事件
 */
function handleSubAgentComplete(event) {
    const { agentName, result, agentIndex } = event.detail;
    updateSubAgentCard(agentName, result, agentIndex);
}

/**
 * 处理 SubAgent 工具调用事件
 */
function handleSubAgentToolCall(event) {
    const { toolName, toolInput, toolId, agentIndex, timestamp } = event.detail;
    addToolCallToSubAgent(toolName, toolInput, toolId, agentIndex, timestamp);
}

/**
 * 处理 SubAgent 工具结果事件
 */
function handleSubAgentToolResult(event) {
    const { toolId, result, agentIndex } = event.detail;
    updateToolCallResult(toolId, result, agentIndex);
}

/**
 * 显示 SubAgent UI 容器
 */
function showSubAgentUI() {
    const container = document.getElementById('subagent-ui-container');
    if (container) {
        container.style.display = 'block';
    }
}

/**
 * 隐藏 SubAgent UI 容器
 */
function hideSubAgentUI() {
    const container = document.getElementById('subagent-ui-container');
    if (container) {
        container.style.display = 'none';
    }
}

/**
 * 渲染前台调度状态条
 */
function renderSchedulerStatus(snapshot = null) {
    const container = document.getElementById('subagent-scheduler-status');
    if (!container) {
        return;
    }

    const schedulerState = snapshot
        || window.InfinPilotExecutionScheduler?.getSnapshot?.()
        || { activeForegroundTask: null, queue: [] };
    const activeTask = schedulerState.activeForegroundTask;
    const queue = Array.isArray(schedulerState.queue) ? schedulerState.queue : [];

    if (!activeTask && queue.length === 0) {
        container.innerHTML = '<div class="scheduler-pill idle">前台队列空闲</div>';
        return;
    }

    const activeLabel = activeTask
        ? formatForegroundBrowserTaskLabel(activeTask)
        : '等待前台任务';
    const queueLabel = queue.length > 0
        ? queue.map((task, index) => `${index + 1}. ${formatForegroundBrowserTaskLabel(task)}`).join(' | ')
        : '无排队任务';

    container.innerHTML = `
        <div class="scheduler-pill busy">前台占用中</div>
        <div class="scheduler-active">执行中：${escapeHtml(activeLabel)}</div>
        ${queue.length > 0 ? `<div class="scheduler-queue">队列：${escapeHtml(queueLabel)}</div>` : '<div class="scheduler-queue">队列：无排队任务</div>'}
    `;
}

function handleSchedulerUpdate(event) {
    renderSchedulerStatus(event.detail || null);
}

function addSubAgentCard(agentName, task, agentIndex) {
    const cardsContainer = document.getElementById('subagent-cards');
    if (!cardsContainer) return;

    const cardId = 'subagent-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const card = document.createElement('div');
    card.className = 'subagent-card';
    card.id = cardId;
    card.dataset.agentName = agentName;
    card.dataset.agentIndex = agentIndex;

    // 使用 agentIndex 作为显示名称后缀，便于区分
    const displayName = agentIndex !== undefined ? `${agentName} [${agentIndex}]` : agentName;

    card.innerHTML = `
        <div class="subagent-card-header">
            <button class="subagent-card-toggle" type="button">
                <svg class="toggle-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <div class="subagent-card-info">
                <span class="subagent-name">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                    ${escapeHtml(displayName)}
                </span>
                <span class="subagent-task">${escapeHtml(task)}</span>
            </div>
            <span class="subagent-status running">
                <svg class="spinner" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="1"></path></svg>
                运行中
            </span>
        </div>
        <div class="subagent-card-body">
            <div class="subagent-tool-calls" id="${cardId}-tools"></div>
        </div>
    `;

    // 绑定折叠事件，默认展开
    card.classList.remove('collapsed');
    const toggleBtn = card.querySelector('.subagent-card-toggle');
    toggleBtn.addEventListener('click', () => {
        card.classList.toggle('collapsed');
    });

    cardsContainer.appendChild(card);

    // 保存 cardId 映射，使用 agentIndex 避免同名 agent 覆盖
    if (!window.DeepResearch.subAgentCardMap) {
        window.DeepResearch.subAgentCardMap = {};
    }
    // 同时保存 agentName 和 agentIndex 两种映射
    window.DeepResearch.subAgentCardMap[agentName] = cardId;
    if (agentIndex !== undefined) {
        window.DeepResearch.subAgentCardMap['__index_' + agentIndex] = cardId;
    }
}

/**
 * 更新 SubAgent 卡片状态
 */
function updateSubAgentCard(agentName, result, agentIndex) {
    // 优先使用 agentIndex 查找
    let cardId = agentIndex !== undefined 
        ? window.DeepResearch?.subAgentCardMap?.['__index_' + agentIndex]
        : window.DeepResearch?.subAgentCardMap?.[agentName];
    
    if (!cardId) return;

    const card = document.getElementById(cardId);
    if (!card) return;

    const statusEl = card.querySelector('.subagent-status');
    if (statusEl) {
        const isError = result?.status === 'failed' || result?.error;
        statusEl.className = 'subagent-status ' + (isError ? 'error' : 'completed');
        statusEl.textContent = isError ? '失败' : '完成';
    }
}

/**
 * 添加工具调用到 SubAgent 卡片
 */
function addToolCallToSubAgent(toolName, toolInput, toolId, agentIndex, timestamp) {
    // 使用 agentIndex 直接找到对应的 SubAgent 卡片
    const cardsContainer = document.getElementById('subagent-cards');
    if (!cardsContainer) return;

    // 优先使用 agentIndex 查找卡片
    let targetCard = null;
    if (agentIndex !== undefined) {
        const cardId = window.DeepResearch?.subAgentCardMap?.['__index_' + agentIndex];
        if (cardId) {
            targetCard = document.getElementById(cardId);
        }
    }

    // 如果没找到，则回退到旧的查找逻辑
    if (!targetCard) {
        const cards = cardsContainer.querySelectorAll('.subagent-card');
        if (cards.length === 0) return;

        // 找到最后一个运行中的 SubAgent
        for (let i = cards.length - 1; i >= 0; i--) {
            const statusEl = cards[i].querySelector('.subagent-status');
            if (statusEl && statusEl.classList.contains('running')) {
                targetCard = cards[i];
                break;
            }
        }

        // 如果没有运行中的，则使用最后一个
        if (!targetCard) {
            targetCard = cards[cards.length - 1];
        }
    }

    if (!targetCard) return;

    const toolsContainer = targetCard.querySelector('.subagent-tool-calls');
    if (!toolsContainer) return;

    const toolIdStr = 'tool-' + toolId;
    const toolCall = document.createElement('div');
    toolCall.className = 'subagent-tool-call pending';
    toolCall.id = toolIdStr;
    toolCall.dataset.toolId = toolId;
    if (agentIndex !== undefined) {
        toolCall.dataset.agentIndex = agentIndex;
    }

    // 简化显示工具参数
    let inputPreview = '';
    if (toolInput) {
        const inputStr = JSON.stringify(toolInput);
        inputPreview = inputStr.length > 100 ? inputStr.substring(0, 100) + '...' : inputStr;
    }

    toolCall.innerHTML = `
        <div class="subagent-tool-call-header">
            <span class="subagent-tool-name">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                ${escapeHtml(toolName)}
            </span>
            <span class="subagent-tool-status pending">等待中</span>
        </div>
        <div class="subagent-tool-call-body">
            <pre>${escapeHtml(inputPreview)}</pre>
        </div>
    `;

    toolsContainer.appendChild(toolCall);
}

/**
 * 更新工具调用结果
 */
function updateToolCallResult(toolId, result) {
    const toolIdStr = 'tool-' + toolId;
    const toolCall = document.getElementById(toolIdStr);
    if (!toolCall) return;

    const statusEl = toolCall.querySelector('.subagent-tool-status');
    const bodyEl = toolCall.querySelector('.subagent-tool-call-body');

    const isError = result?.error || result?.__type === 'error';

    if (statusEl) {
        statusEl.className = 'subagent-tool-status ' + (isError ? 'error' : 'success');
        statusEl.textContent = isError ? '失败' : '成功';
    }

    if (bodyEl) {
        let resultPreview = '';
        if (result) {
            const resultStr = JSON.stringify(result);
            resultPreview = resultStr.length > 200 ? resultStr.substring(0, 200) + '...' : resultStr;
        }
        bodyEl.innerHTML = `<pre>${escapeHtml(resultPreview)}</pre>`;
    }

    toolCall.className = 'subagent-tool-call ' + (isError ? 'error' : 'success');
}

/**
 * Start Deep Research with hierarchical multi-agent system
 * This function is called when deep-research-mode is enabled
 * Deep Research 模式是自动化模式的扩展：
 * 1. 初始化 SubAgentEngine
 * 2. 设置 Deep Research 标志
 * 3. 调用现有的 startAutomation
 */
async function startDeepResearch(userMessage, state, elements, currentTranslations, addMessageToChatCallback, addThinkingAnimationCallback, restoreSendButtonAndInputCallback, showToastCallback) {
    console.log('[DeepResearch] Starting deep research mode (as extension of automation)');

    // 1. 初始化 SubAgentEngine
    const config = await browser.storage.sync.get([
        'agentSdkEndpoint',
        'agentSdkApiKey',
        'agentSdkModel'
    ]);

    const endpoint = config.agentSdkEndpoint || 'https://api.anthropic.com';
    const apiKey = config.agentSdkApiKey;
    const model = config.agentSdkModel || 'claude-sonnet-4-5';

    if (!apiKey) {
        if (showToastCallback) {
            showToastCallback(_('agentSdkApiKeyMissing', {}, currentTranslations) || '请先配置 Claude Agent SDK 的 API Key', 'error');
        }
        return;
    }

    // 检查 SubAgentEngine 是否已加载
    const SubAgentEngine = window.DeepResearch.SubAgentEngine;
    if (!SubAgentEngine) {
        console.error('[DeepResearch] SubAgentEngine not loaded!');
        if (showToastCallback) {
            showToastCallback('Sub Agent 引擎未加载，请刷新页面后重试', 'error');
        }
        return;
    }

    // 初始化 SubAgentEngine
    const initialTools = await getAllAgentTools(true);
    const subAgentEngine = new SubAgentEngine(initialTools, {
        endpoint,
        apiKey,
        model
    }, {
        // 工具调用回调，用于在 UI 上显示子代理的工具调用
        onToolCall: (toolName, toolInput, toolId, agentIndex) => {
            console.log('[DeepResearch] SubAgent tool call:', toolName, toolId, 'agentIndex:', agentIndex);
            // 通过全局事件通知 UI
            window.dispatchEvent(new CustomEvent('subagent-tool-call', {
                detail: { toolName, toolInput, toolId, agentIndex, timestamp: Date.now() }
            }));
        },
        onToolResult: (toolId, result, agentIndex) => {
            console.log('[DeepResearch] SubAgent tool result:', toolId, 'agentIndex:', agentIndex);
            // 通过全局事件通知 UI
            window.dispatchEvent(new CustomEvent('subagent-tool-result', {
                detail: { toolId, result, agentIndex, timestamp: Date.now() }
            }));
        },
        // subAgent 开始回调
        onSubAgentStart: (agentName, task, agentIndex) => {
            console.log('[DeepResearch] SubAgent started:', agentName, 'index:', agentIndex);
            window.dispatchEvent(new CustomEvent('subagent-start', {
                detail: { agentName, task, agentIndex, timestamp: Date.now() }
            }));
        },
        // subAgent 完成回调
        onSubAgentComplete: (agentName, result, agentIndex) => {
            console.log('[DeepResearch] SubAgent completed:', agentName, 'index:', agentIndex);
            window.dispatchEvent(new CustomEvent('subagent-complete', {
                detail: { agentName, result, agentIndex, timestamp: Date.now() }
            }));
        }
    });

    // 设置全局变量，供 executeBrowserTool 中的 sub-agent 调用使用
    window.DeepResearch.subAgentEngine = subAgentEngine;
    window.DeepResearch.isDeepResearchMode = true;
    // 计划阶段：第一次只输出计划，不执行工具
    window.DeepResearch.isPlanPhase = true;
    // 保存用户的研究请求
    window.DeepResearch.userResearchRequest = userMessage;

    console.log('[DeepResearch] SubAgentEngine initialized, entering automation flow (Plan Phase)');

    // 初始化 SubAgent UI 显示容器
    initializeSubAgentUI();

    // 2. 调用现有的 startAutomation
    // 它会处理消息发送、UI 更新等逻辑
    // 这里只需要确保它使用 Deep Research 的 system prompt
    await startAutomation(
        userMessage,
        state,
        elements,
        currentTranslations,
        addMessageToChatCallback,
        addThinkingAnimationCallback,
        restoreSendButtonAndInputCallback,
        showToastCallback,
        false
    );

    // 3. 清理
    window.DeepResearch.subAgentEngine = null;
    window.DeepResearch.isDeepResearchMode = false;
    console.log('[DeepResearch] Deep research mode ended');

    // 清理 SubAgent UI
    const container = document.getElementById('subagent-ui-container');
    if (container) {
        container.remove();
    }
    // 清理事件监听器
    if (window.DeepResearchUIHandlers) {
        window.removeEventListener('subagent-start', window.DeepResearchUIHandlers.onStart);
        window.removeEventListener('subagent-complete', window.DeepResearchUIHandlers.onComplete);
        window.removeEventListener('subagent-tool-call', window.DeepResearchUIHandlers.onToolCall);
        window.removeEventListener('subagent-tool-result', window.DeepResearchUIHandlers.onToolResult);
        window.DeepResearchUIHandlers = null;
    }
}

/**
 * Start automation with Claude Agent SDK
 * This function is called when automation-mode is enabled and user sends a message
 */
async function startAutomation(userMessage, state, elements, currentTranslations, addMessageToChatCallback, addThinkingAnimationCallback, restoreSendButtonAndInputCallback, showToastCallback, isResume = false) {
    console.log('[Automation] Starting automation with message:', userMessage);
    const isDeepResearchAutomation = Boolean(window.DeepResearch && window.DeepResearch.isDeepResearchMode);
    const automationHistoryMode = isDeepResearchAutomation ? 'deep-research' : 'automation';
    let latestTraceSnapshotForHistory = null;

    // Deep Research 模式：检查用户是否确认计划
    // 如果确认，则将 isPlanPhase 设为 false，让模型下一轮工具调用执行计划
    if (window.DeepResearch && window.DeepResearch.pendingResearchPlan) {
        const confirmKeywords = ['确认', '开始', '执行', '好的', 'yes', 'confirm', 'start', 'execute', 'go'];
        const isConfirmation = confirmKeywords.some(kw => userMessage.toLowerCase().includes(kw.toLowerCase()));

        if (isConfirmation) {
            console.log('[DeepResearch] User confirmed plan, continuing to call model API...');

            // 切换到非计划阶段，模型将调用 invoke_sub_agents 执行计划
            window.DeepResearch.isPlanPhase = false;

            // 不要提前返回，继续与模型 API 交互
            // 这样模型会收到用户确认消息，然后调用 invoke_sub_agents
        }
    }

    // 如果不是恢复任务，且已有正在运行的任务，则停止旧任务
    const thisTaskId = generateUniqueId();
    if (!isResume && taskStatus === 'running' && currentTaskId) {
        console.log('[Automation] Stopping previous task:', currentTaskId);
        taskStatus = 'stopped';
    }
    // 设置当前任务 ID
    currentTaskId = thisTaskId;
    beginAutomationTrace(userMessage, {
        taskId: thisTaskId,
        isResume,
        mode: window.DeepResearch && window.DeepResearch.isDeepResearchMode ? 'deep_research' : 'automation'
    });

    // Add user message to chat UI first
    const userMessageId = generateUniqueId();
    if (addMessageToChatCallback) {
        addMessageToChatCallback(userMessage, 'user', { id: userMessageId, forceScroll: true });
    }

    // Add user message to chat history
    if (state.chatHistory) {
        state.chatHistory.push({
            id: userMessageId,
            role: 'user',
            parts: [{ text: userMessage }],
            originalUserText: userMessage
        });
    }

    // Clear user input
    if (elements && elements.userInput) {
        elements.userInput.value = '';
    }

    // Show thinking animation
    let thinkingElement = null;
    if (addThinkingAnimationCallback) {
        thinkingElement = addThinkingAnimationCallback(null);
    }

    // 任务状态管理
    taskStatus = 'running'; // running, suspended, stopped, completed
    suspendedUserMessage = ''; // 挂起时用户输入的消息

    // 暴露全局函数供按钮调用
    window.__automationTaskStatus = taskStatus;
    window.__suspendAutomationTask = async function() {
        if (taskStatus === 'running') {
            taskStatus = 'suspended';
            window.__automationTaskStatus = 'suspended';
            if (showToastCallback) {
                showToastCallback('任务已挂起，你可以输入新指令继续任务', 'info');
            }
            // 显示恢复按钮
            showResumeButton(elements, addMessageToChatCallback);
        }
    };
    window.__stopAutomationTask = function() {
        if (taskStatus === 'running' || taskStatus === 'suspended') {
            taskStatus = 'stopped';
            window.__automationTaskStatus = 'stopped';
            if (showToastCallback) {
                showToastCallback('任务已停止', 'info');
            }
        }
    };

    // 显示恢复按钮
    function showResumeButton(elements, addMessageToChatCallback) {
        // 查找当前模型消息
        const lastBotMessage = document.querySelector('.message-bubble.bot .message-content:last-child');
        if (lastBotMessage) {
            // 添加操作按钮容器
            let actionContainer = lastBotMessage.querySelector('.automation-actions');
            if (!actionContainer) {
                actionContainer = document.createElement('div');
                actionContainer.className = 'automation-actions';
                actionContainer.style.cssText = 'display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color, #e0e0e0);';
                lastBotMessage.appendChild(actionContainer);
            }

            // 恢复按钮
            const resumeBtn = document.createElement('button');
            resumeBtn.textContent = '继续任务';
            resumeBtn.className = 'resume-task-btn';
            resumeBtn.style.cssText = 'padding: 6px 12px; background: var(--primary-color, #0078d4); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;';
            resumeBtn.onclick = async function() {
                // 隐藏操作按钮
                actionContainer.style.display = 'none';
                // 让用户输入继续任务的指令
                if (elements && elements.userInput) {
                    elements.userInput.focus();
                }
            };

            // 停止按钮
            const stopBtn = document.createElement('button');
            stopBtn.textContent = '停止任务';
            stopBtn.className = 'stop-task-btn';
            stopBtn.style.cssText = 'padding: 6px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;';
            stopBtn.onclick = function() {
                window.__stopAutomationTask();
                actionContainer.style.display = 'none';
            };

            actionContainer.innerHTML = '';
            actionContainer.appendChild(resumeBtn);
            actionContainer.appendChild(stopBtn);
            actionContainer.style.display = 'flex';
        }
    }

    try {
        // Get Agent SDK configuration from storage
        const config = await browser.storage.sync.get([
            'agentSdkEndpoint',
            'agentSdkApiKey',
            'agentSdkModel',
            'agentSdkPermission'
        ]);

        const endpoint = config.agentSdkEndpoint || 'https://api.anthropic.com';
        const apiKey = config.agentSdkApiKey;
        const model = config.agentSdkModel || 'claude-sonnet-4-5';

        if (!apiKey) {
            if (showToastCallback) {
                showToastCallback(_('agentSdkApiKeyMissing', {}, currentTranslations) || '请先配置 Claude Agent SDK 的 API Key', 'error');
            }
            if (restoreSendButtonAndInputCallback) {
                restoreSendButtonAndInputCallback();
            }
            // Remove thinking animation
            if (thinkingElement && thinkingElement.parentNode) {
                thinkingElement.remove();
            }
            return;
        }

        // Build messages array with history
        const messages = state.chatHistory
            .filter(m => m.role === 'user' || m.role === 'model')
            .map(m => {
                // 处理工具结果
                if (m.tool_results) {
                    return {
                        role: 'user',
                        content: typeof m.tool_results === 'string' ? m.tool_results : JSON.stringify(m.tool_results)
                    };
                }
                // 处理普通消息，支持多种格式
                let text = '';
                if (m.parts && m.parts[0] && m.parts[0].text) {
                    text = m.parts[0].text;
                } else if (m.content) {
                    text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                }

                return {
                    role: m.role === 'model' ? 'assistant' : 'user',
                    content: text
                };
            });

        // Add current user message
        messages.push({ role: 'user', content: userMessage });

        // 如果是恢复任务，则追加提示让 AI 重新规划
        if (isResume) {
            messages.push({
                role: 'user',
                content: '请根据以上上下文和我的新指令[' + userMessage + ']，重新规划任务并继续执行。如果需要调整 todo list，请明确说明新的计划。'
            });
        }

        // System prompt - check if deep research mode is enabled
        let systemPrompt;
        if (window.DeepResearch && window.DeepResearch.isDeepResearchMode) {
            // 深度研究模式：使用研究专用的 system prompt
            systemPrompt = researchMainAgentPrompt;
        } else {
            // 普通自动化模式
            systemPrompt = `你是一个浏览器自动化助手。用户要求你操作网页时，使用可用工具逐步完成任务。

## 核心原则
- 始终围绕用户的最终目标行动，而不是机械调用工具。
- 先拆分任务，再执行步骤，必要时动态调整计划。
- 工具失败时先分析原因，再尝试替代方案。
- 不要因为调用次数而提前停止，只在目标完成或明确失败时结束。

## 浏览器工具使用原则
- 导航或打开页面后，再获取 DOM、点击、输入、滚动或截图。
- 需要读取网页正文时，优先使用 jina_ai_get_content。
- 执行点击或输入前，先确认目标标签页和页面上下文正确。
- 涉及浏览器书签、收藏夹、批量打开收藏夹链接时，优先使用 browser_bookmarks。
- 需要查历史记录、管理窗口或操作下载列表时，分别使用 browser_history、browser_windows、browser_downloads。

## 编辑器工具
- browser_editor 用于 Markdown、DOCX、Sheet、SVG 文件与内容操作。
- browser_svg 用于 SVG 文件创建、切换、导入导出和源码读写。
- browser_project 用于项目、模板、运行记录，以及把当前页面或结构化提取结果保存到项目。
- browser_mcp 用于列出 MCP 服务、远程工具、资源和提示词，并读取资源或提示词内容，也可以把 MCP 内容直接加入当前上下文。
- browser_bookmarks 用于列出书签根目录、搜索书签、打开单个书签，以及打开收藏夹中的链接。
- browser_history 用于搜索历史记录并从历史中重新打开页面。
- browser_windows 用于列出窗口、聚焦窗口、创建窗口和移动标签页。
- browser_downloads 用于查询下载、触发下载、打开文件和清理下载记录。
- 名称以 mcp__ 开头的工具来自远程 MCP server，属于远程能力，不要假设它们可以直接控制本地浏览器前台。

## 行为要求
- 每次工具调用都要服务于当前子目标。
- 如果要继续执行现有流程，优先复用已有项目模板。
- 如果用户要求把当前页面、文章、表格、FAQ、商品或时间线保存到项目，优先使用 browser_project。
- 如果用户要求把刚刚成功的任务沉淀为模板，使用 browser_project action=save_last_task_as_template。
- 如果用户要求查看 MCP 服务状态、列出远程资源、读取 MCP 提示词或资源内容，优先使用 browser_mcp。
- 如果用户要求把 MCP 资源或 MCP 提示词沉淀到当前项目，使用 browser_mcp 的 save_resource_to_project 或 save_prompt_to_project。
- 如果用户要求把 MCP 资源或 MCP 提示词直接作为当前聊天/深度研究上下文，使用 browser_mcp 的 add_resource_to_context 或 add_prompt_to_context。
- 对需要用户确认或补充输入的流程，要显式说明并等待继续。`;
        }

        // 使用工具发起 API 调用，直到达成目标
        const maxToolIterations = 1000; // 实际上不限制，只是防呆
        const projectPromptContext = await getCurrentProjectPromptContext();
        if (projectPromptContext) {
            systemPrompt += `\n\n## 当前项目上下文\n${projectPromptContext}`;
        }
        systemPrompt += `\n\n## 项目模板策略
如果用户目标可以通过当前项目中的任务模板完成，优先使用 browser_project。
推荐顺序：
1. browser_project action=list_templates 查找模板
2. 必要时 browser_project action=get_template 理解模板用途
3. browser_project action=run_template 执行模板
4. 如果返回 needsInput=true，收集 requiredInputs 后调用 browser_project action=resume_run
5. browser_project action=list_runs 查看最近运行结果

当用户明确要求“运行模板”“继续工作流”“复用已有流程”或“执行项目里的模板”时，不要直接改用普通网页工具链，先检查项目模板。`;

        systemPrompt += `\n\n## 项目沉淀策略
如果用户要求把当前页面内容沉淀到项目，不要自己总结后停下，直接使用 browser_project：
- action=capture_page 保存当前页面
- action=extract_pattern 并传 pattern=article/table/faq/product/timeline 做结构化提取

如果用户要求“把这次成功任务保存成模板”“总结为模板”“沉淀成模板并存到项目”，优先使用 browser_project action=save_last_task_as_template。`;

        systemPrompt += `\n\n## 前台执行约束
当 browser_project 返回的模板或运行记录带有 executionMode=foreground 时，表示它需要独占浏览器前台交互资源。
多个 foreground 模板会自动排队串行执行，不要假设它们能并发点击、输入、切页或回放录制。`;

        let toolIterations = 0;
        let finalText = '';
        let assistantMessageContent = null;
        let currentMessages = [...messages];

        while (toolIterations < maxToolIterations) {
            // 检查任务 ID 是否匹配，防止双任务执行
            if (currentTaskId !== thisTaskId) {
                console.log('[Automation] Task ID mismatch, stopping old task');
                break;
            }

            // 检查任务状态
            if (taskStatus === 'stopped') {
                finalText += '\n\n[任务已被用户停止]';
                break;
            }

            if (taskStatus === 'suspended') {
                // 挂起时直接停止循环，不再等待
                finalText += '\n\n[任务已挂起，请输入指令继续任务]';
                break;
            }

            // 过滤掉 sub-agent 工具，仅在普通自动化模式下生效
            // 深度研究模式下保留所有工具
            let toolsToUse = await getAllAgentTools();
            if (!(window.DeepResearch && window.DeepResearch.isDeepResearchMode)) {
                toolsToUse = toolsToUse.filter(tool =>
                    tool.name !== 'invoke_sub_agent' && tool.name !== 'invoke_sub_agents'
                );
            }

            const response = await runtimeFetch(`${endpoint}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: model,
                    max_tokens: 8192, // Increased to support longer content output
                    system: systemPrompt,
                    messages: currentMessages,
                    tools: toolsToUse
                })
            });

            if (!response.ok) {
                throw new Error(`API Error: ${response.status} - ${response.statusText}`);
            }

            // Parse the response
            const result = await response.json();

            // Check if there's text content
            if (result.content) {
                const textBlock = result.content.find(c => c.type === 'text');
                const toolUseBlocks = result.content.filter(c => c.type === 'tool_use');

                // 如果有工具调用，仅保留 AI 的简短回复，不显示冗长的工具调用说明
                let displayText = '';
                if (textBlock && textBlock.text) {
                    if (toolUseBlocks.length > 0) {
                        // 有工具调用时，过滤掉冗长的工具调用描述
                        // 提取真正有意义的部分，通常是工具调用前的简短说明
                        displayText = textBlock.text.split('\n\n')[0] || ''; // 只取第一段
                        if (displayText.length > 200) {
                            displayText = displayText.substring(0, 200) + '...';
                        }
                    } else {
                        // 没有工具调用时，正常显示
                        displayText = textBlock.text;
                    }
                }

                // Update UI with current response
                if (toolIterations === 0) {
                    // First iteration - create new message
                    const messageId = generateUniqueId();
                    const messageElement = addMessageToChatCallback(displayText, 'model', {
                        id: messageId,
                        renderedMode: 'automation'
                    });
                    assistantMessageContent = { id: messageId, element: messageElement, text: displayText };
                    finalText = displayText;
                } else {
                    // Subsequent iterations - update existing message
                    finalText = displayText;
                    if (assistantMessageContent) {
                        if (window.updateStreamingMessage) {
                            window.updateStreamingMessage(assistantMessageContent.element, displayText);
                        } else {
                            const contentDiv = assistantMessageContent.element.querySelector('.message-content');
                            if (contentDiv) {
                                contentDiv.textContent = displayText;
                            }
                        }
                    }
                }

                // Check for tool use
                if (toolUseBlocks.length === 0) {
                    // No more tool calls, we're done
                    break;
                }

                // Execute tools and add results to messages
                for (const toolUse of toolUseBlocks) {
                    console.log('[Automation] Tool call:', toolUse.name, toolUse.input);

                    // Execute the tool (for main automation flow, no execution context)
                    const toolResult = await window.executeBrowserTool(toolUse.name, toolUse.input, null);

                    console.log('[Automation] Tool result:', toolResult);

                    // Show tool execution in UI with styled component (now includes result and is collapsible)
                    console.log('[Automation] Creating tool call UI:', toolUse.name, toolUse.input, toolResult);
                    if (assistantMessageContent && assistantMessageContent.element) {
                        const messageContent = assistantMessageContent.element.querySelector('.message-content');
                        console.log('[Automation] messageContent found:', !!messageContent);
                        if (messageContent) {
                            // Create tool call UI element with result (collapsible by default)
                            createToolCallUI(toolUse.name, toolUse.input, toolResult, messageContent);
                            console.log('[Automation] Tool call UI created');

                            // 显示当前工具执行状态
                            const toolStatus = toolResult.success ? `✓ ${toolUse.name}` : (toolResult.error ? `✕ ${toolUse.name}` : `${toolUse.name}`);

                            // 从模型回复中提取目标文本（第一段）
                            let purposeText = displayText || '执行自动化任务';
                            if (purposeText.length > 100) {
                                purposeText = purposeText.substring(0, 100) + '...';
                            }

                            // 显示当前目标
                            showTodoList(messageContent, [
                                { id: 1, text: purposeText, status: 'current' }
                            ], toolStatus);
                        }
                    }

                    // Add tool result to messages for API
                    currentMessages.push({
                        role: 'assistant',
                        content: result.content.filter(c => c.type === 'text' || c.id === toolUse.id).map(c => {
                            if (c.type === 'tool_use') {
                                return {
                                    type: 'tool_use',
                                    id: c.id,
                                    name: c.name,
                                    input: c.input
                                };
                            }
                            return c;
                        })
                    });

                    currentMessages.push({
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: toolUse.id,
                            content: JSON.stringify(toolResult, null, 2)
                        }]
                    });

                    // Add simplified version to finalText for history
                    finalText += `\n\n[工具: ${toolUse.name}]\n结果: ${formatToolResult(toolUse.name, toolResult)}`;

                    // 保存工具调用到 chatHistory，便于恢复任务时读取
                    if (state.chatHistory) {
                        state.chatHistory.push({
                            id: generateUniqueId(),
                            role: 'user',
                            parts: [{ text: '' }],
                            tool_results: JSON.stringify({
                                tool: toolUse.name,
                                input: toolUse.input,
                                result: toolResult
                            }, null, 2)
                        });
                    }
                }

                toolIterations++;
            } else {
                break;
            }
        }

        // Remove thinking animation element
        if (thinkingElement && thinkingElement.parentNode) {
            thinkingElement.remove();
        }

        // Finalize the message - hide buttons in automation mode
        if (assistantMessageContent && assistantMessageContent.element) {
            if (window.finalizeBotMessage) {
                window.finalizeBotMessage(assistantMessageContent.element, finalText);
            } else {
                // Fallback: manually update content
                const contentDiv = assistantMessageContent.element.querySelector('.message-content');
                if (contentDiv) {
                    contentDiv.textContent = finalText;
                }
            }

            // 在 automation 模式下隐藏消息下方按钮
            if (document.body.classList.contains('automation-mode')) {
                const actionButtons = assistantMessageContent.element.querySelector('.message-actions');
                if (actionButtons) {
                    actionButtons.style.display = 'none';
                }
            }

            // 任务完成后重置状态
            taskStatus = 'completed';
            currentTaskId = null;
        }

        const traceStatus = taskStatus === 'stopped'
            ? 'stopped'
            : taskStatus === 'suspended'
                ? 'suspended'
                : 'success';
        latestTraceSnapshotForHistory = cloneTraceValue(activeAutomationTrace);
        finalizeAutomationTrace(traceStatus, {
            finalText,
            toolIterations
        });

        const historyTrace = traceStatus === 'success'
            ? (window.InfinPilotLastSuccessfulAutomationTrace || latestTraceSnapshotForHistory)
            : {
                ...(latestTraceSnapshotForHistory || {}),
                status: traceStatus,
                completedAt: Date.now(),
                meta: {
                    ...((latestTraceSnapshotForHistory && latestTraceSnapshotForHistory.meta) || {}),
                    finalText,
                    toolIterations
                }
            };

        // Save to chat history
        if (state.chatHistory && finalText) {
            state.chatHistory.push({
                id: generateUniqueId(),
                role: 'model',
                parts: [{ text: finalText }]
            });
        }

        await saveAutomationHistorySession({
            userMessage,
            finalText,
            trace: historyTrace,
            mode: automationHistoryMode,
            status: traceStatus
        });

    } catch (error) {
        console.error('[Automation] Error:', error);
        latestTraceSnapshotForHistory = cloneTraceValue(activeAutomationTrace);
        finalizeAutomationTrace('failed', {
            error: error.message || String(error)
        });

        // Remove thinking animation on error
        if (thinkingElement && thinkingElement.parentNode) {
            thinkingElement.remove();
        }

        // Clean up: remove user message from history if API call failed
        if (state.chatHistory && userMessageId) {
            const msgIndex = state.chatHistory.findIndex(m => m.id === userMessageId);
            if (msgIndex !== -1) {
                state.chatHistory.splice(msgIndex, 1);
            }
        }

        if (showToastCallback) {
            showToastCallback(_('agentSdkError', {}, currentTranslations) || `自动化错误: ${error.message}`, 'error');
        }

        await saveAutomationHistorySession({
            userMessage,
            finalText: `自动化执行失败：${error.message || '未知错误'}`,
            trace: {
                ...(latestTraceSnapshotForHistory || {}),
                status: 'failed',
                completedAt: Date.now(),
                meta: {
                    ...((latestTraceSnapshotForHistory && latestTraceSnapshotForHistory.meta) || {}),
                    error: error.message || String(error)
                }
            },
            mode: automationHistoryMode,
            status: 'failed'
        });
    } finally {
        if (restoreSendButtonAndInputCallback) {
            restoreSendButtonAndInputCallback();
        }
    }
}

// Make startAutomation available globally
window.startAutomation = startAutomation;

/**
 * Sends a user message and initiates the AI response process.
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {object} currentTranslations - Translations object
 * @param {function} showConnectionStatusCallback - Callback for model settings status
 * @param {function} addMessageToChatCallback - Callback (this is main.js#addMessageToChatUI)
 * @param {function} addThinkingAnimationCallback - Callback (this is a lambda from main.js calling ui.js#addThinkingAnimation with live isUserNearBottom)
 * @param {function} resizeTextareaCallback - Callback
 * @param {function} clearImagesCallback - Callback
 * @param {function} clearVideosCallback - Callback
 * @param {function} showToastCallback - Callback
 * @param {function} restoreSendButtonAndInputCallback - Callback
 * @param {function} abortStreamingCallback - Callback
 * @param {function} [updateSelectedTabsBarCallback] - Optional callback to update selected tabs bar UI
 */
export async function sendUserMessage(state, elements, currentTranslations, showConnectionStatusCallback, addMessageToChatCallback, addThinkingAnimationCallback, resizeTextareaCallback, clearImagesCallback, clearVideosCallback, showToastCallback, restoreSendButtonAndInputCallback, abortStreamingCallback, updateSelectedTabsBarCallback) {
    const originalUserMessage = elements.userInput.value.trim();
    let userMessage = originalUserMessage; // Use a mutable variable for potential augmentation

    if (document.body.classList.contains('collective-research-mode')) {
        await startCollectiveResearch(userMessage, state, elements, currentTranslations, addMessageToChatCallback, addThinkingAnimationCallback, restoreSendButtonAndInputCallback, showToastCallback);
        elements.userInput.value = '';
        return;
    }

    if (document.body.classList.contains('deep-research-mode')) {
        // 使用新的分层 Agent 系统
        await startDeepResearch(userMessage, state, elements, currentTranslations, addMessageToChatCallback, addThinkingAnimationCallback, restoreSendButtonAndInputCallback, showToastCallback);
        elements.userInput.value = '';
        return;
    }

    // Restore the original automation logic check
    if (document.body.classList.contains('automation-mode')) {
        // 检查是否存在挂起的任务
        if (window.__automationTaskStatus === 'suspended') {
            // 恢复挂起任务，并传递用户的实际消息
            const resumeMessage = userMessage; // 保存用户输入的指令

            window.__automationTaskStatus = 'running';
            taskStatus = 'running';

            // 隐藏恢复按钮，显示加载状态
            const lastBotMessage = document.querySelector('.message-bubble.bot .message-content:last-child');
            if (lastBotMessage) {
                const actionContainer = lastBotMessage.querySelector('.automation-actions');
                if (actionContainer) {
                    actionContainer.innerHTML = '<span style="color: var(--primary-color, #0078d4);">正在继续任务...</span>';
                }
            }

            // 重新调用 startAutomation 继续任务，并传递用户实际消息
            startAutomation(
                resumeMessage,
                state,
                elements,
                currentTranslations,
                addMessageToChatCallback,
                addThinkingAnimationCallback,
                restoreSendButtonAndInputCallback,
                showToastCallback,
                true // 传入 resume 标志，表示这是继续任务
            );
        } else {
            // 正常启动新任务
            startAutomation(
                userMessage,
                state,
                elements,
                currentTranslations,
                addMessageToChatCallback,
                addThinkingAnimationCallback,
                restoreSendButtonAndInputCallback,
                showToastCallback
            );
        }
        elements.userInput.value = '';
        return;
    }

    if (state.isStreaming) {
        console.warn("Cannot send message while streaming.");
        return;
    }

    if (!userMessage && state.images.length === 0 && state.videos.length === 0 && state.selectedContextTabs.filter(t => t.content && !t.isLoading && !t.isContextSent).length === 0) return;

    let hasValidApiKey = false;
    if (window.ModelManager?.instance) {
        try {
            await window.ModelManager.instance.initialize();
            const modelConfig = window.ModelManager.instance.getModelApiConfig(state.model);
            const providerId = modelConfig.providerId;
            hasValidApiKey = window.ModelManager.instance.isProviderConfigured(providerId);
        } catch (error) {
            console.warn('[Chat] Failed to check provider configuration:', error);
        }
    }

    if (!hasValidApiKey) {
        if (showToastCallback) showToastCallback(_('apiKeyMissingError', {}, currentTranslations), 'error');
        return;
    }

    state.isStreaming = true;
    state.userScrolledUpDuringStream = false;
    elements.sendMessage.classList.add('stop-streaming');
    elements.sendMessage.title = _('stopStreamingTitle', {}, currentTranslations);
    elements.sendMessage.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
            <path d="M5 3.5h6A1.5 1.5 0 0 1 12.5 5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 11V5A1.5 1.5 0 0 1 5 3.5z"/>
        </svg>
    `;
    elements.sendMessage.removeEventListener('click', sendUserMessage);
    elements.sendMessage.addEventListener('click', abortStreamingCallback);

    const sessionData = await browser.storage.session.get('selectedDbId');
    const selectedDbId = sessionData.selectedDbId;
    let ragCitations = [];
    if (selectedDbId && selectedDbId !== 'null' && userMessage) {
        const { prompt, citations } = await augmentQuery(userMessage, parseInt(selectedDbId, 10));
        userMessage = prompt;
        ragCitations = citations || [];
    }

    const projectPromptContext = await getCurrentProjectPromptContext();
    if (projectPromptContext) {
        userMessage = userMessage
            ? `${userMessage}\n\n【当前项目上下文】\n${projectPromptContext}`
            : `銆愬綋鍓嶉」鐩笂涓嬫枃銆慭n${projectPromptContext}`;
    }

    const currentImages = [...state.images];
    const currentVideos = [...state.videos];

    const tabsForBubbleDisplay = state.selectedContextTabs
        .filter(tab => tab.content && !tab.isLoading && !tab.isContextSent)
        .map(tab => ({ id: tab.id, title: tab.title, favIconUrl: tab.favIconUrl }));

    const userMessageElement = addMessageToChatCallback(originalUserMessage, 'user', { images: currentImages, videos: currentVideos, forceScroll: true, sentContextTabs: tabsForBubbleDisplay });
    const userMessageId = userMessageElement.dataset.messageId;

    elements.userInput.value = '';
    resizeTextareaCallback();

    let contextTabsForApi = [];
    if (state.selectedContextTabs && state.selectedContextTabs.length > 0) {
        const tabsToSendNow = state.selectedContextTabs.filter(
            tab => tab.content && !tab.isLoading && !tab.isContextSent
        );

        if (tabsToSendNow.length > 0) {
            contextTabsForApi = tabsToSendNow.map(tab => ({ id: tab.id, title: tab.title, content: tab.content }));
            tabsToSendNow.forEach(tabSent => {
                const originalTab = state.selectedContextTabs.find(t => t.id === tabSent.id);
                if (originalTab) originalTab.isContextSent = true;
            });
            state.selectedContextTabs = state.selectedContextTabs.filter(tab => !tab.isContextSent);
            if (updateSelectedTabsBarCallback) updateSelectedTabsBarCallback();
        }
    }

    const currentParts = [];
    if (userMessage) currentParts.push({ text: userMessage });
    currentImages.forEach(image => {
        const base64data = image.dataUrl.split(',')[1];
        currentParts.push({ inlineData: { mimeType: image.mimeType, data: base64data } });
    });
    currentVideos.forEach(video => {
        if (video.type === 'youtube') currentParts.push({ fileData: { fileUri: video.url } });
    });

    const userMessageForHistory = currentParts.length > 0 ? {
        role: 'user',
        parts: currentParts,
        id: userMessageId,
        // Save the original, un-augmented user input for correct history display
        originalUserText: originalUserMessage,
        sentContextTabsInfo: contextTabsForApi.length > 0 ? contextTabsForApi : null
    } : null;

    if (!userMessageForHistory) {
        if (userMessageElement && userMessageElement.parentNode) userMessageElement.remove();
        restoreSendButtonAndInputCallback();
        return;
    }

    if (currentImages.length > 0) clearImagesCallback();
    if (currentVideos.length > 0) clearVideosCallback();

    const thinkingElement = addThinkingAnimationCallback(null);

    

    try {
                // 构建 RAG 引用 HTML（如果有），避免复杂模板字符串嵌套
        

        const apiUiCallbacks = {
            addMessageToChat: addMessageToChatCallback,
            updateStreamingMessage: (el, content) => window.updateStreamingMessage(el, content),
            finalizeBotMessage: (el, content, citations) => window.finalizeBotMessage(el, content, citations),
            showToast: showToastCallback,
            restoreSendButtonAndInput: restoreSendButtonAndInputCallback,
            clearImages: clearImagesCallback,
            clearVideos: clearVideosCallback,
            getCitations: () => ragCitations
        };

        await window.GeminiAPI.callGeminiAPIWithImages(
            userMessage,
            currentImages,
            currentVideos,
            thinkingElement,
            state,
            apiUiCallbacks,
            contextTabsForApi,
            userMessageForHistory,
            ragCitations // Pass citations here
        );

        // --- BEGIN: Chat History Saving Logic ---
        const isNewChat = !state.currentSessionId;

        // Get all current tab URLs
        const tabs = await browser.tabs.query({});
        const tabUrls = tabs.map(tab => tab.url);

        const session = {
            id: state.currentSessionId, // Will be null for new chats
            messages: JSON.parse(JSON.stringify(state.chatHistory)), // Deep copy
            tabUrls: tabUrls, // Save the tab URLs
            // Preserve existing title if it exists
            title: isNewChat ? (_('newChat', {}, currentTranslations) || 'New Chat') : (await historyManager.getSession(state.currentSessionId))?.title
        };

        const savedSession = await historyManager.upsertSession(session);
        state.currentSessionId = savedSession.id; // Ensure ID is set for the current session

        // Generate title for new chats after the first exchange
        if (isNewChat && state.chatHistory.length >= 2) {
            // This is fire-and-forget, no need to await
            window.InfinPilotAPI.generateChatTitle(savedSession.messages, state.model).then(newTitle => {
                if (newTitle && newTitle !== (_('untitledChat', {}, currentTranslations) || 'Untitled Chat')) {
                    savedSession.title = newTitle;
                    historyManager.upsertSession(savedSession);
                }
            });
        }
        // --- END: Chat History Saving Logic ---

    } catch (error) {
        console.error('Error during sendUserMessage API call:', error);
        if (thinkingElement && thinkingElement.parentNode) thinkingElement.remove();

        if (userMessageForHistory) {
            const messageIndex = state.chatHistory.findIndex(msg => msg.id === userMessageForHistory.id);
            if (messageIndex !== -1) {
                state.chatHistory.splice(messageIndex, 1);
                console.log(`Removed failed user message from history`);
            }
        }
        restoreSendButtonAndInputCallback();
    }
}


/**
 * Clears the chat context and history.
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {function} clearImagesCallback - Callback
 * @param {function} clearVideosCallback - Callback
 * @param {function} showToastCallback - Callback
 * @param {object} currentTranslations - Translations object
 * @param {boolean} [showToast=true] - Whether to show the "Cleared" toast
 */
export async function clearContext(state, elements, clearImagesCallback, clearVideosCallback, showToastCallback, currentTranslations, showToast = true) {
    state.chatHistory = [];
    state.currentSessionId = null; // Reset the current session ID
    state.locallyIgnoredTabs = {}; // 清空已忽略标签页的本地状态
    elements.chatMessages.innerHTML = ''; // Clear UI

    // Re-add welcome message with dynamic quick actions
    const welcomeMessage = await createWelcomeMessage(currentTranslations);
    elements.chatMessages.appendChild(welcomeMessage);

    clearImagesCallback(); // Clear images using callback
    clearVideosCallback(); // Clear videos using callback
    if (showToast) {
        showToastCallback(_('contextClearedSuccess', {}, currentTranslations), 'success');
    }
}

/**
 * Deletes a specific message from chat history and UI.
 * @param {string} messageId - The ID of the message to delete.
 * @param {object} state - Global state reference
 */
export async function deleteMessage(messageId, state) {
    const messageContainer = document.querySelector(`.message-container[data-message-id="${messageId}"]`);
    let domRemoved = false;
    if (messageContainer) {
        messageContainer.remove();
        domRemoved = true;
    }

    const messageIndex = state.chatHistory.findIndex(msg => msg.id === messageId);
    let historyRemoved = false;
    if (messageIndex !== -1) {
        state.chatHistory.splice(messageIndex, 1);
        historyRemoved = true;
    }

    // Clean up from locallyIgnoredTabs
    if (state.locallyIgnoredTabs && state.locallyIgnoredTabs[messageId]) {
        delete state.locallyIgnoredTabs[messageId];
        console.log(`Cleaned up ignored tabs for deleted message ${messageId}`);
    }

    if (domRemoved || historyRemoved) {
        console.log(`Message ${messageId} deleted (DOM: ${domRemoved}, History: ${historyRemoved})`);
        // If a message was removed from history, update the session in storage
        if (historyRemoved && state.currentSessionId) {
            try {
                const session = await historyManager.getSession(state.currentSessionId);
                if (session) {
                    session.messages = state.chatHistory;
                    await historyManager.upsertSession(session);
                    console.log(`Session ${state.currentSessionId} updated after message deletion.`);
                }
            } catch (error) {
                console.error(`Failed to update session after deleting message:`, error);
            }
        }
    } else {
        console.warn(`Delete failed: Message ${messageId} not found.`);
    }
}

/**
 * Regenerates the AI response for a specific turn.
 * @param {string} messageId - The ID of the message (user or bot) triggering regeneration.
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {object} currentTranslations - Translations object
 * @param {function} addMessageToChatCallback - Callback (main.js#addMessageToChatUI)
 * @param {function} addThinkingAnimationCallback - Callback (lambda from main.js for ui.js#addThinkingAnimation)
 * @param {function} restoreSendButtonAndInputCallback - Callback
 * @param {function} abortStreamingCallback - Callback
 * @param {function} showToastCallback - Callback to show toast notifications
 * @param {function} [updateSelectedTabsBarCallback] - Optional callback to update selected tabs bar UI
 */
export async function regenerateMessage(messageId, state, elements, currentTranslations, addMessageToChatCallback, addThinkingAnimationCallback, restoreSendButtonAndInputCallback, abortStreamingCallback, showToastCallback, updateSelectedTabsBarCallback) {
    if (state.isStreaming) {
        console.warn("Cannot regenerate while streaming.");
        return;
    }

    const clickedMessageIndex = state.chatHistory.findIndex(msg => msg.id === messageId);
    if (clickedMessageIndex === -1) {
        console.error("Regenerate failed: Message not found in history.");
        if (showToastCallback) showToastCallback(_('regenerateFailedNotFound', {}, currentTranslations), 'error');
        return;
    }

    const clickedMessage = state.chatHistory[clickedMessageIndex];
    let userIndex = -1;
    let aiIndex = -1;
    let userMessageElement = null;

    if (clickedMessage.role === 'user') {
        userIndex = clickedMessageIndex;
        if (userIndex + 1 < state.chatHistory.length && state.chatHistory[userIndex + 1].role === 'model') {
            aiIndex = userIndex + 1;
        }
    } else { // clickedMessage.role === 'model'
        aiIndex = clickedMessageIndex;
        userIndex = aiIndex - 1;
        if (userIndex < 0 || state.chatHistory[userIndex].role !== 'user') {
            console.error("Regenerate failed: Could not find preceding user message.");
            if (showToastCallback) showToastCallback(_('regenerateFailedNoUserMessage', {}, currentTranslations), 'error');
            return;
        }
    }

    userMessageElement = document.querySelector(`.message[data-message-id="${state.chatHistory[userIndex].id}"]`);
    if (!userMessageElement) {
        console.error("Regenerate failed: Could not find user message DOM element.");
        if (showToastCallback) showToastCallback(_('regenerateFailedUIDiscrepancy', {}, currentTranslations), 'error');
        return;
    }

    const userMessageData = state.chatHistory[userIndex];
    const { text: userMessageText, images: userImages, videos: userVideos } = extractPartsFromMessage(userMessageData);
    const previouslySentContextTabsFromHistory = userMessageData.sentContextTabsInfo || [];
    const historyForApi = state.chatHistory.slice(0, userIndex);

    // --- MODIFICATION START ---
    // We will no longer reuse elements to ensure the entire message container is removed.
    let elementToReuse = null;

    // Remove all AI-related messages from history that follow the user message.
    let removedHistoryCount = 0;
    while (state.chatHistory[userIndex + 1]?.role === 'model') {
        state.chatHistory.splice(userIndex + 1, 1);
        removedHistoryCount++;
    }
    if (removedHistoryCount > 0) {
        console.log(`Removed ${removedHistoryCount} old AI message(s) from history.`);
    }

    // Remove all bot message elements from the DOM that follow the user message.
    let nextElem = userMessageElement.parentElement.nextElementSibling;
    while (nextElem) {
        const currentElem = nextElem;
        nextElem = currentElem.nextElementSibling; // Move to next before removing current

        // Check if the element is a bot message container and remove it.
        // This removes the avatar, name, and message card together.
        if (currentElem.querySelector('.message.bot-message')) {
            currentElem.remove();
        }
    }
    // --- MODIFICATION END ---

    const ignoredTabIdsForThisTurn = (state.locallyIgnoredTabs && state.locallyIgnoredTabs[userMessageData.id]) ? state.locallyIgnoredTabs[userMessageData.id] : [];
    let effectivePreviouslySentContext = previouslySentContextTabsFromHistory.filter(
        tab => !ignoredTabIdsForThisTurn.includes(tab.id)
    );
    let contextTabsForApiRegen = [...effectivePreviouslySentContext];

    if (state.selectedContextTabs && state.selectedContextTabs.length > 0) {
        const newlySelectedTabsToSend = state.selectedContextTabs.filter(
            tab => tab.content && !tab.isLoading && !tab.isContextSent
        );
        if (newlySelectedTabsToSend.length > 0) {
            const newTabsForApi = newlySelectedTabsToSend.map(tab => ({ id: tab.id, title: tab.title, content: tab.content }));
            newTabsForApi.forEach(newTab => {
                if (!contextTabsForApiRegen.some(existingTab => existingTab.id === newTab.id)) {
                    contextTabsForApiRegen.push(newTab);
                }
            });
            newlySelectedTabsToSend.forEach(tabSent => {
                const originalTab = state.selectedContextTabs.find(t => t.id === tabSent.id);
                if (originalTab) originalTab.isContextSent = true;
            });
            state.selectedContextTabs = state.selectedContextTabs.filter(tab => !tab.isContextSent);
            if (updateSelectedTabsBarCallback) updateSelectedTabsBarCallback();
        }
    }

    state.isStreaming = true;
    state.userScrolledUpDuringStream = false;
    elements.sendMessage.classList.add('stop-streaming');
    elements.sendMessage.title = _('stopStreamingTitle', {}, currentTranslations);
    elements.sendMessage.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
            <path d="M5 3.5h6A1.5 1.5 0 0 1 12.5 5v6a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 11V5A1.5 1.5 0 0 1 5 3.5z"/>
        </svg>
    `;
    elements.sendMessage.removeEventListener('click', sendUserMessage);
    elements.sendMessage.addEventListener('click', abortStreamingCallback);

    // If we are reusing an element, the thinking animation goes inside it.
    // Otherwise, a new thinking bubble is created.
    const thinkingElement = addThinkingAnimationCallback(null);

    try {
        const apiUiCallbacks = {
            addMessageToChat: addMessageToChatCallback,
            updateStreamingMessage: (el, content) => window.updateStreamingMessage(el, content),
            finalizeBotMessage: (el, content) => window.finalizeBotMessage(el, content),
            clearImages: () => {},
            showToast: showToastCallback
        };

        let regenMessageText = userMessageText;
        let regenRagCitations = [];
        try {
            const sessionData = await browser.storage.session.get('selectedDbId');
            const selectedDbId = sessionData.selectedDbId;
            if (selectedDbId && selectedDbId !== 'null' && regenMessageText) {
                const { prompt, citations } = await augmentQuery(regenMessageText, parseInt(selectedDbId, 10));
                regenMessageText = prompt;
                regenRagCitations = citations || [];
            }
        } catch (e) {
            console.warn('[Regenerate] RAG augmentation failed or skipped:', e);
        }

        const regenUiCallbacks = {
            ...apiUiCallbacks,
            finalizeBotMessage: (el, content, citations) => window.finalizeBotMessage(el, content, citations),
            getCitations: () => regenRagCitations
        };

        await window.GeminiAPI.callApiAndInsertResponse(
            regenMessageText,
            userImages,
            userVideos,
            thinkingElement,
            historyForApi,
            userIndex + 1,
            userMessageElement,
            state,
            regenUiCallbacks,
            contextTabsForApiRegen,
            elementToReuse // --- MODIFICATION: Pass element to reuse
        );

    } catch (error) {
        console.error(`Regenerate failed:`, error);
        if (thinkingElement && thinkingElement.parentNode && thinkingElement !== elementToReuse) {
            thinkingElement.remove();
        }
        addMessageToChatCallback(_('regenerateError', { error: error.message }, currentTranslations), 'bot', { insertAfterElement: userMessageElement });
        restoreSendButtonAndInputCallback();
    }
}

/**
 * Helper to extract text, image and video info from a message object.
 * @param {object} message - A message object from state.chatHistory
 * @returns {{text: string, images: Array<{dataUrl: string, mimeType: string}>, videos: Array<{dataUrl?: string, mimeType?: string, url?: string, type: string}>}}
 */
function extractPartsFromMessage(message) {
    let text = '';
    const images = [];
    const videos = [];
    if (message && message.parts && Array.isArray(message.parts)) {
        message.parts.forEach(part => {
            if (part.text) {
                text += (text ? '\n' : '') + part.text; // Combine text parts
            } else if (part.inlineData && part.inlineData.data && part.inlineData.mimeType) {
                if (part.inlineData.mimeType.startsWith('image/')) {
                    images.push({
                        dataUrl: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
                        mimeType: part.inlineData.mimeType
                    });
                }
                // 忽略本地视频文件处理
            } else if (part.fileData && part.fileData.fileUri) {
                // YouTube URL
                videos.push({
                    url: part.fileData.fileUri,
                    type: 'youtube'
                });
            }
        });
    }
    return { text, images, videos };
}

/**
 * Aborts the current streaming API request.
 * @param {object} state - Global state reference
 * @param {function} restoreSendButtonAndInputCallback - Callback
 * @param {function} showToastCallback - Callback to show toast notifications
 * @param {object} currentTranslations - Translations object
 */
export function abortStreaming(state, restoreSendButtonAndInputCallback, showToastCallback, currentTranslations) {
    let aborted = false;

    // 尝试中断新的统一 API 接口
    if (window.InfinPilotAPI && window.InfinPilotAPI.currentAbortController) {
        console.log("Aborting unified API request...");
        window.InfinPilotAPI.currentAbortController.abort();
        aborted = true;
    }

    // 尝试中断旧的 Gemini API 接口，保持向后兼容
    if (window.GeminiAPI && window.GeminiAPI.currentAbortController) {
        console.log("Aborting legacy Gemini API request...");
        window.GeminiAPI.currentAbortController.abort();
        aborted = true;
    }

    if (!aborted) {
        console.warn("No active AbortController found to abort.");
    }

    // Always attempt to restore UI state after abort attempt
    restoreSendButtonAndInputCallback();
}

/**
 * Handles removing a sent tab from a message's context.
 * This updates the state to ignore the tab for future regenerations.
 * @param {string} messageId - The ID of the user message.
 * @param {string} tabId - The ID of the tab to remove from context.
 * @param {object} state - Global state reference.
 */
export function handleRemoveSentTabContext(messageId, tabId, state) {
    if (!state.locallyIgnoredTabs[messageId]) {
        state.locallyIgnoredTabs[messageId] = [];
    }
    if (!state.locallyIgnoredTabs[messageId].includes(tabId)) {
        state.locallyIgnoredTabs[messageId].push(tabId);
        console.log(`Tab ${tabId} marked as ignored for message ${messageId}. Ignored:`, state.locallyIgnoredTabs);
    } else {
        console.log(`Tab ${tabId} was already marked as ignored for message ${messageId}.`);
    }
}

/**
 * 鍒涘缓娆㈣繋娑堟伅锛屽寘鍚姩鎬佸揩鎹锋搷浣滃拰鎻愮ず
 * @param {object} currentTranslations - 褰撳墠缈昏瘧瀵硅薄
 * @returns {Promise<HTMLElement>} 娆㈣繋娑堟伅鍏冪礌
 */
export async function createWelcomeMessage(currentTranslations) {
    const welcomeMessage = document.createElement('div');
    welcomeMessage.className = 'welcome-message';

    // 获取快捷操作
    let quickActions = [];
    if (window.QuickActionsManager) {
        try {
            // 检查快捷操作管理器是否已经初始化
            if (window.QuickActionsManager.isQuickActionsManagerInitialized &&
                window.QuickActionsManager.isQuickActionsManagerInitialized()) {
                quickActions = window.QuickActionsManager.getAllQuickActions();
                console.log('[createWelcomeMessage] Found', quickActions.length, 'quick actions:', quickActions);
            } else {
                console.warn('[createWelcomeMessage] QuickActionsManager not yet initialized, using empty actions');
                quickActions = [];
            }
        } catch (error) {
            console.warn('[createWelcomeMessage] Error getting quick actions:', error);
            quickActions = [];
        }
    } else {
        console.warn('[createWelcomeMessage] QuickActionsManager not available in global scope');
    }

    // 键盘快捷键提示
    const tipsHtml = `
        <div class="welcome-tips">
            <span class="welcome-tip"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 发送</span>
            <span class="welcome-tip"><kbd>Ctrl</kbd>+<kbd>Shift</kbd> 新对话</span>
            <span class="welcome-tip"><kbd>Ctrl</kbd>+<kbd>K</kbd> 快捷命令</span>
        </div>
    `;

    // 生成快捷操作按钮 HTML
    const quickActionsHtml = quickActions.map(action => {
        return `
            <button class="quick-action-btn" data-action-id="${action.id}" data-prompt="${escapeHtml(action.prompt)}" data-ignore-assistant="${action.ignoreAssistant}">
                ${escapeHtml(action.name)}
            </button>
        `;
    }).join('');

    // 欢迎面板
    welcomeMessage.innerHTML = `
        <h2>${_('welcomeHeading', {}, currentTranslations)}</h2>
        <p>选择下方快捷操作开始对话，或直接输入消息</p>
        ${quickActionsHtml ? `<div class="quick-actions">${quickActionsHtml}</div>` : ''}
        ${tipsHtml}
    `;

    // 为所有快捷操作按钮添加事件监听器
    const actionButtons = welcomeMessage.querySelectorAll('.quick-action-btn');
    actionButtons.forEach(button => {
        button.addEventListener('click', () => {
            const actionId = button.dataset.actionId;
            const prompt = button.dataset.prompt;
            const ignoreAssistant = button.dataset.ignoreAssistant === 'true';

            // 点击快捷操作后先移除欢迎消息，释放空间
            try {
                const parentWelcome = button.closest('.welcome-message');
                if (parentWelcome && parentWelcome.parentNode) {
                    parentWelcome.parentNode.removeChild(parentWelcome);
                }
            } catch (e) {
                console.warn('[createWelcomeMessage] Failed to remove welcome message on quick action click:', e);
            }

            // 触发快捷操作
            if (window.triggerQuickAction) {
                window.triggerQuickAction(actionId, prompt, ignoreAssistant);
            } else {
                console.warn('Quick action trigger function not available');
            }
        });
    });

    return welcomeMessage;
}

// 杈呭姪鍑芥暟锛欻TML杞箟
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Loads a chat session from history into the UI.
 * @param {string} sessionId - The ID of the session to load.
 * @param {object} state - Global state reference.
 * @param {object} elements - DOM elements reference.
 * @param {function} addMessageToChatCallback - Callback to add messages to UI.
 * @param {function} clearContextCallback - Callback to clear the context.
 * @param {object} currentTranslations - Translations object.
 */
export async function loadChatSession(sessionId, state, elements, addMessageToChatCallback, clearContextCallback, currentTranslations) {
    const session = await historyManager.getSession(sessionId);
    if (!session) {
        console.error(`Session ${sessionId} not found.`);
        return;
    }

    // Clear current chat, but don't show a toast
    await clearContextCallback(false);

    if (session.type === 'collective-research') {
        const snapshot = session.data?.snapshot || null;
        if (snapshot) {
            if (elements?.chatMessages) {
                elements.chatMessages.innerHTML = '';
            }
            const result = {
                topic: session.data?.topic || snapshot.topic || session.title || '群体研究',
                finalReport: session.data?.finalReport || snapshot.finalReport || '',
                roundsCompleted: session.data?.roundsCompleted || snapshot.currentRound || 0,
                snapshot
            };
            initializeCollectiveResearchUI(result.topic);
            renderCollectiveResearchDock(snapshot, result);
            window.CollectiveResearch = window.CollectiveResearch || {};
            window.CollectiveResearch.lastResult = result;
            state.currentSessionId = session.id;
            state.chatHistory = [];
            return;
        }
    }

    // Handle Deep Research session loading
    if (session.type === 'deep-research') {
        if (window.DeepResearch && window.DeepResearch.ui && window.DeepResearch.ui.renderResearchDockFromHistory) {
            if (elements?.chatMessages) {
                elements.chatMessages.innerHTML = '';
            }
            state.currentSessionId = session.id;
            state.chatHistory = []; // Deep research has no conventional chat history
            window.DeepResearch.ui.renderResearchDockFromHistory(session.data);
        }
        return; // Stop further execution
    }

    // Ask to open associated tabs
    if (session.tabUrls && session.tabUrls.length > 0) {
        const confirmOpen = confirm(_('confirmOpenTabs', { count: session.tabUrls.length }, currentTranslations));
        if (confirmOpen) {
            session.tabUrls.forEach(url => {
                if (url) browser.tabs.create({ url: url });
            });
        }
    }

    state.currentSessionId = session.id;
    state.chatHistory = JSON.parse(JSON.stringify(session.messages)); // Deep copy

    // Render messages
    for (const message of state.chatHistory) {
        // Prefer the originally typed text if present (avoid augmented RAG prompt)
        const preferText = message.originalUserText && message.role === 'user' ? message.originalUserText : extractPartsFromMessage(message).text;
        const { images, videos } = extractPartsFromMessage(message);
        const sender = message.role === 'model' ? 'bot' : 'user';
        
        const options = {
            id: message.id,
            images: images,
            videos: videos,
            sentContextTabs: message.sentContextTabsInfo || [],
            citations: message.citations || null, // Add this line
            tool_results: message.tool_results || null
        };

        addMessageToChatCallback(preferText, sender, options);
    }
}

/**
 * Deletes a chat session from history.
 * @param {string} sessionId - The ID of the session to delete.
 * @param {object} state - Global state reference.
 */
export async function deleteChatSession(sessionId, state) {
    await historyManager.deleteHistory(sessionId);
    // If the deleted session was the current one, clear the chat
    if (state.currentSessionId === sessionId) {
        state.currentSessionId = null;
        // The UI is not automatically cleared here, as the user is in the history modal.
        // They can start a new chat or load another, which will handle the UI clearing.
    }
}
