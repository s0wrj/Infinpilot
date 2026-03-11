import { providers } from './providerManager.js';
import { formatApiUrl } from './utils/apiUrl.js';
import { makeApiRequest } from './utils/proxyRequest.js';
import { getHealthCheckEndpoints, getHealthCheckEndpointsAsync } from './utils/proxyHealth.js';
import mcpManager from './mcp/mcpManager.js';

const CONTENT_STYLE_FILES = [
    'css/content-panel.css',
    'css/text-selection-helper.css',
    'css/github.min.css',
    'css/github-dark-dimmed.min.css',
    'css/katex.min.css'
];

const CONTENT_SCRIPT_FILES = [
    'js/lib/browser-polyfill.js',
    'js/lib/Readability.js',
    'js/lib/markdown-it.min.js',
    'js/lib/highlight.min.js',
    'js/lib/python.min.js',
    'js/lib/r.min.js',
    'js/lib/sql.min.js',
    'js/lib/json.min.js',
    'js/lib/katex.min.js',
    'js/lib/auto-render.min.js',
    'js/lib/mhchem.min.js',
    'js/lib/mermaid.min.js',
    'js/lib/panzoom.min.js',
    'js/lib/lucide.js',
    'js/translations.js',
    'js/markdown-renderer.js',
    'js/text-selection-helper.js',
    'js/automation/content-automation.js',
    'js/automation/content-recorder.js',
    'js/content.js'
];

const DOM_AUTOMATION_TOOLS = new Set([
    'get_page_text',
    'get_interactive_elements',
    'click',
    'fill',
    'clear',
    'get_value',
    'scroll_into_view',
    'highlight',
    'search_page_text',
    'get_page_links',
    'get_page_images',
    'find_element',
    'submit',
    'hover',
    'screenshot',
    'go_back',
    'go_forward',
    'select_option',
    'wait_for_selector',
    'wait_for_network_idle',
    'sleep'
]);

const recorderState = {
    isRecording: false,
    tabId: null,
    activeTabId: null,
    startedAt: null,
    steps: [],
    lastEventAt: null,
    lastRecording: null,
    url: '',
    title: '',
    trackedTabIds: [],
    tabUrls: {},
    tabTitles: {}
};

let screenshotSendResponse = null;
const OFFSCREEN_DOCUMENT_PATH = 'html/offscreen.html';
const PROXY_HEALTH_ALARM = 'proxy-health-check';
const MAX_CONSECUTIVE_FAILURES = 2;
const HEALTH_CHECK_INTERVAL_MINUTES = 1;
const HEALTH_CHECK_TIMEOUT = 5000;

chrome.runtime.onInstalled.addListener(async () => {
    try {
        await chrome.contextMenus.removeAll();
    } catch (_) {
        // Ignore context menu cleanup failures.
    }

    chrome.contextMenus.create({
        id: 'openInfinpilot',
        title: '打开 InfinPilot 面板',
        contexts: ['page', 'selection']
    });

    await configureSidePanelBehavior();
    await updateProxySettings();
    await startProxyHealthCheck();
    await broadcastExtensionReload();
});

chrome.runtime.onStartup.addListener(() => {
    void configureSidePanelBehavior();
    void updateProxySettings();
    void startProxyHealthCheck();
    void broadcastExtensionReload();
});

chrome.action.onClicked.addListener((tab) => {
    if (hasChromeSidePanel()) {
        return;
    }

    if (tab?.id) {
        void toggleInfinpilotPanel(tab.id);
    }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'openInfinpilot' && tab?.id) {
        if (hasChromeSidePanel()) {
            void chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
                console.warn('[background-sw] Failed to open side panel:', error);
            });
            return;
        }

        void toggleInfinpilotPanel(tab.id);
    }
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.proxyAddress) {
        void updateProxySettings();
    }
    void broadcastStorageChanges(changes, namespace);
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PROXY_HEALTH_ALARM) {
        void checkProxyHealth();
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target === 'offscreen') {
        return false;
    }
    void handleRuntimeMessage(message, sender, sendResponse);
    return true;
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    void handleRecorderTabActivated(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void handleRecorderTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onCreated.addListener((tab) => {
    void handleRecorderTabCreated(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    handleRecorderTabRemoved(tabId);
});

async function handleRuntimeMessage(message, sender, sendResponse) {
    try {
        switch (message?.action) {
            case 'pageContentExtracted':
                await chrome.storage.local.set({
                    recentPageContent: message.content,
                    recentExtractionTime: Date.now()
                });
                sendResponse({ success: true });
                return;
            case 'extractTabContent':
                sendResponse(await extractTabContent(message.tabId));
                return;
            case 'generateContent':
                sendResponse({
                    success: false,
                    error: 'This API endpoint has been deprecated. Please use the unified API interface.'
                });
                return;
            case 'deepResearch.crawl':
                sendResponse(await deepResearchCrawl(message.url));
                return;
            case 'deepResearch.webSearch':
                sendResponse(await deepResearchWebSearch(message));
                return;
            case 'scrapling.get':
            case 'scrapling.bulkGet':
            case 'scrapling.getLinks':
            case 'scrapling.getImages':
            case 'scrapling.extractStructured':
                sendResponse(await sendOffscreenMessage(message.action, message));
                return;
            case 'project.capturePage':
                sendResponse(await capturePageForProject());
                return;
            case 'project.extractElements':
                sendResponse(await extractProjectElements(message.pattern));
                return;
            case 'mcp.listServers':
                sendResponse({ success: true, data: await mcpManager.listServers() });
                return;
            case 'mcp.upsertServer':
                sendResponse({ success: true, data: await mcpManager.upsertServer(message.server || {}) });
                return;
            case 'mcp.removeServer':
                sendResponse({ success: true, data: await mcpManager.removeServer(message.serverId) });
                return;
            case 'mcp.testServer':
                sendResponse({ success: true, data: await mcpManager.testServer(message.server || message.serverId) });
                return;
            case 'mcp.listTools':
                sendResponse({ success: true, data: await mcpManager.getToolCatalog({ refresh: message.refresh === true }) });
                return;
            case 'mcp.listResources':
                sendResponse({ success: true, data: await mcpManager.listResources({ serverId: message.serverId || null, refresh: message.refresh === true }) });
                return;
            case 'mcp.readResource':
                sendResponse({ success: true, data: await mcpManager.readResource(message.serverId, message.uri) });
                return;
            case 'mcp.listPrompts':
                sendResponse({ success: true, data: await mcpManager.listPrompts({ serverId: message.serverId || null, refresh: message.refresh === true }) });
                return;
            case 'mcp.getPrompt':
                sendResponse({ success: true, data: await mcpManager.getPrompt(message.serverId, message.name, message.arguments || {}) });
                return;
            case 'mcp.callTool':
                sendResponse({ success: true, data: await mcpManager.callTool(message.toolName, message.args || {}) });
                return;
            case 'mcp.getState':
                sendResponse({ success: true, data: await mcpManager.getState() });
                return;
            case 'recorder.start':
                sendResponse(await startAutomationRecording());
                return;
            case 'recorder.stop':
                sendResponse(await stopAutomationRecording());
                return;
            case 'recorder.getStatus':
                sendResponse(getAutomationRecorderStatus());
                return;
            case 'recorder.replay':
                sendResponse(await replayAutomationRecording(message.steps || []));
                return;
            case 'recorder.event':
                sendResponse(handleAutomationRecorderEvent(message.step, sender));
                return;
            case 'getActiveTabInfo':
                sendResponse(await getActiveTabInfo());
                return;
            case 'activateForegroundTab':
                sendResponse(await activateForegroundTab(message.tabId));
                return;
            case 'getAllOpenTabs':
                sendResponse(await getAllOpenTabs());
                return;
            case 'getAvailableModels':
                sendResponse(await getAvailableModels());
                return;
            case 'getModelConfig':
                sendResponse(await getModelConfig(message.model));
                return;
            case 'broadcastModelsUpdated':
                await broadcastModelsUpdated();
                sendResponse({ success: true });
                return;
            case 'captureScreenshot':
                await captureScreenshot(sendResponse);
                return;
            case 'captureScreenshotForEditor':
            case 'captureScreenshotDirect':
                sendResponse(await captureVisibleTab());
                return;
            case 'captureArea':
                await captureArea(message, sendResponse);
                return;
            case 'captureCancel':
                if (screenshotSendResponse) {
                    screenshotSendResponse({ success: false, error: 'Screenshot cancelled by user.' });
                    screenshotSendResponse = null;
                }
                sendResponse({ success: true });
                return;
            case 'automation.call':
                sendResponse(await handleAutomationCall(message.tool, message.args || {}));
                return;
            case 'callUnifiedAPI':
                sendResponse(await handleUnifiedAPICall(message, sender));
                return;
            case 'fetchWithProxy':
                sendResponse(await handleFetchWithProxy(message));
                return;
            case 'testProxy':
                sendResponse(await handleProxyTestRequest(message.proxyAddress));
                return;
            case 'openSettings':
                if (hasChromeSidePanel()) {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    await chrome.sidePanel.setOptions({
                        path: 'html/sidepanel.html#settings',
                        enabled: true
                    });
                    await chrome.sidePanel.open({ windowId: tab?.windowId || chrome.windows.WINDOW_ID_CURRENT });
                    await chrome.sidePanel.setOptions({
                        path: 'html/sidepanel.html',
                        enabled: true
                    });
                } else {
                    await chrome.tabs.create({ url: chrome.runtime.getURL('html/sidepanel.html#settings') });
                }
                sendResponse({ success: true });
                return;
            case 'runHtml':
                sendResponse(await runHtml(message));
                return;
            default:
                if (typeof message?.action === 'string' && message.action.startsWith('dom.')) {
                    sendResponse(await relayDomAction(message.action, message.args));
                    return;
                }
                sendResponse({
                    success: false,
                    error: `Unhandled action: ${message?.action || 'unknown'}`
                });
                return;
        }
    } catch (error) {
        console.error('[background-sw] Message handling failed:', error);
        sendResponse({
            success: false,
            error: error?.message || String(error)
        });
    }
}

async function toggleInfinpilotPanel(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!isSupportedTabUrl(tab?.url)) {
        return;
    }

    try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'togglePanel' });
        if (response?.success === false && response?.missing) {
            await reinjectScriptsToTab(tabId);
            await sleep(300);
            await chrome.tabs.sendMessage(tabId, { action: 'togglePanel' });
        }
    } catch (_) {
        await reinjectScriptsToTab(tabId);
        await sleep(300);
        await chrome.tabs.sendMessage(tabId, { action: 'togglePanel' });
    }
}

async function configureSidePanelBehavior() {
    if (!hasChromeSidePanel()) {
        return;
    }

    try {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch (error) {
        console.warn('[background-sw] Failed to configure side panel behavior:', error);
    }
}

function hasChromeSidePanel() {
    return !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior && chrome.sidePanel.open);
}

async function reinjectScriptsToTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!isSupportedTabUrl(tab?.url)) {
        return;
    }

    try {
        await chrome.scripting.insertCSS({
            target: { tabId },
            files: CONTENT_STYLE_FILES
        });
    } catch (error) {
        console.warn('[background-sw] Failed to insert CSS:', error?.message || error);
    }

    for (const file of CONTENT_SCRIPT_FILES) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: [file]
            });
        } catch (error) {
            console.warn(`[background-sw] Failed to inject ${file}:`, error?.message || error);
        }
    }

    try {
        await chrome.tabs.sendMessage(tabId, { action: 'extensionReloaded' });
    } catch (_) {
        // Ignore post-injection ping failures.
    }
}

async function captureScreenshot(sendResponse) {
    if (screenshotSendResponse) {
        sendResponse({ success: false, error: 'A screenshot request is already in progress.' });
        return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        sendResponse({ success: false, error: 'No active tab' });
        return;
    }

    if (!isSupportedTabUrl(tab.url)) {
        sendResponse({ success: false, error: 'Screenshots are not supported on this page.' });
        return;
    }

    screenshotSendResponse = sendResponse;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['js/cropper.js']
        });
    } catch (error) {
        screenshotSendResponse = null;
        sendResponse({ success: false, error: error?.message || String(error) });
    }
}

async function captureArea(message, sendResponse) {
    const pendingResponse = screenshotSendResponse;
    screenshotSendResponse = null;

    if (!pendingResponse) {
        sendResponse({ success: false, error: 'No pending screenshot request.' });
        return;
    }

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            pendingResponse({ success: false, error: 'No active tab' });
            sendResponse({ success: true });
            return;
        }

        const { area } = message;
        const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
        const blob = dataUrlToBlob(dataUrl);
        const image = await createImageBitmap(blob);

        const canvas = new OffscreenCanvas(area.width, area.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);

        const outputBlob = await canvas.convertToBlob({ type: 'image/png' });
        const outputDataUrl = await blobToDataUrl(outputBlob);

        pendingResponse({
            success: true,
            dataUrl: outputDataUrl,
            url: tab.url || '',
            title: tab.title || '',
            capturedAt: new Date().toISOString()
        });

        sendResponse({ success: true });
    } catch (error) {
        pendingResponse({ success: false, error: error?.message || String(error) });
        sendResponse({ success: true });
    }
}

async function captureVisibleTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
        return { success: false, error: 'No active tab' };
    }

    if (!isSupportedTabUrl(tab.url)) {
        return { success: false, error: 'Screenshots are not supported on this page.' };
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
    return {
        success: true,
        dataUrl,
        url: tab.url || '',
        title: tab.title || ''
    };
}

async function handleAutomationCall(tool, args) {
    if (DOM_AUTOMATION_TOOLS.has(tool)) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
            return { success: false, message: 'No active tab found' };
        }

        const frameId = typeof args.frameId === 'number' ? args.frameId : 0;
        const { frameId: _, ...restArgs } = args;
        const data = await chrome.tabs.sendMessage(
            tab.id,
            { action: `dom.${tool}`, args: restArgs },
            { frameId }
        );
        return { success: true, data };
    }

    switch (tool) {
        case 'get_all_tabs':
            return { success: true, data: await chrome.tabs.query({}) };
        case 'get_current_tab': {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            return { success: true, data: tab || null };
        }
        case 'get_page_frames': {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) {
                return { success: false, message: 'No active tab found' };
            }
            const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
            return {
                success: true,
                data: frames.map((frame) => ({
                    frameId: frame.frameId,
                    parentFrameId: frame.parentFrameId,
                    url: frame.url,
                    errorOccurred: frame.errorOccurred
                }))
            };
        }
        case 'switch_to_tab':
            await chrome.tabs.update(args.tabId, { active: true });
            return { success: true, data: { switched: true, tabId: args.tabId } };
        case 'open_url':
            return { success: true, data: await chrome.tabs.create({ url: args.url }) };
        case 'close_tab':
            await chrome.tabs.remove(args.tabId);
            return { success: true, data: { closed: true, tabId: args.tabId } };
        case 'reload_tab': {
            const targetTabId = typeof args.tabId === 'number'
                ? args.tabId
                : (await getActiveTab())?.id;
            if (!targetTabId) {
                return { success: false, message: 'No tab to reload' };
            }
            await chrome.tabs.reload(targetTabId);
            return { success: true, data: { reloaded: true, tabId: targetTabId } };
        }
        case 'navigate': {
            const targetTabId = typeof args.tabId === 'number'
                ? args.tabId
                : (await getActiveTab())?.id;
            if (!targetTabId || !args.url) {
                return { success: false, message: 'tabId/url is required' };
            }
            await chrome.tabs.update(targetTabId, { url: args.url });
            return { success: true, data: { navigated: true, tabId: targetTabId, url: args.url } };
        }
        case 'wait_for_navigation':
            return { success: true, data: await waitForNavigation(args) };
        default:
            return {
                success: false,
                message: `Automation tool "${tool}" is not implemented in the Chrome worker yet.`
            };
    }
}

async function waitForNavigation(args) {
    const timeoutMs = typeof args?.timeoutMs === 'number' ? args.timeoutMs : 10000;
    const targetTabId = typeof args?.tabId === 'number'
        ? args.tabId
        : (await getActiveTab())?.id;

    if (!targetTabId) {
        throw new Error('No target tab to wait on');
    }

    return await new Promise((resolve) => {
        let done = false;
        const timeout = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            cleanup();
            resolve({ completed: false, timeout: true, tabId: targetTabId });
        }, timeoutMs);

        const listener = (tabId, changeInfo, tab) => {
            if (tabId === targetTabId && changeInfo.status === 'complete') {
                if (done) {
                    return;
                }
                done = true;
                cleanup();
                resolve({ completed: true, tabId: targetTabId, url: tab?.url || '' });
            }
        };

        function cleanup() {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
        }

        chrome.tabs.onUpdated.addListener(listener);
    });
}

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
}

async function getActiveTabInfo() {
    const tab = await getActiveTab();
    if (!tab) {
        return { success: false, error: 'No active tab' };
    }
    return {
        success: true,
        url: tab.url || '',
        title: tab.title || ''
    };
}

async function activateForegroundTab(tabId) {
    if (typeof tabId !== 'number') {
        return { success: false, error: 'tabId is required' };
    }

    try {
        const tab = await chrome.tabs.get(tabId);
        await chrome.tabs.update(tabId, { active: true });
        if (typeof tab.windowId === 'number') {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
        return {
            success: true,
            tabId,
            windowId: tab.windowId
        };
    } catch (error) {
        return { success: false, error: error?.message || String(error) };
    }
}

async function sendMessageToTabWithRetry(tabId, message, options = {}) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, message, options);
        if (response) {
            return response;
        }
    } catch (_) {
        // Retry after reinjection.
    }

    await reinjectScriptsToTab(tabId);
    await sleep(800);
    const retryResponse = await chrome.tabs.sendMessage(tabId, message, options);
    return retryResponse || { success: false, error: 'No response after reinject' };
}

function appendRecordedStep(step) {
    if (!step) {
        return;
    }

    const normalizedTabId = typeof step.tabId === 'number' ? step.tabId : null;
    const normalizedUrl = step.url || '';
    const normalizedFrameId = typeof step.frameId === 'number' ? step.frameId : 0;
    const lastStep = recorderState.steps[recorderState.steps.length - 1];
    if (
        step.type === 'navigate' &&
        lastStep?.type === 'navigate' &&
        lastStep.tabId === normalizedTabId &&
        lastStep.frameId === normalizedFrameId &&
        lastStep.url === normalizedUrl
    ) {
        recorderState.lastEventAt = step.timestamp || Date.now();
        if (step.title) {
            lastStep.title = step.title;
        }
        return;
    }

    if (recorderState.lastEventAt && step.timestamp) {
        const delay = step.timestamp - recorderState.lastEventAt;
        if (delay >= 900) {
            recorderState.steps.push({
                type: 'wait',
                durationMs: Math.min(delay, 10000)
            });
        }
    }

    recorderState.lastEventAt = step.timestamp || Date.now();
    recorderState.steps.push({
        type: step.type,
        tabId: normalizedTabId,
        frameId: normalizedFrameId,
        selector: step.selector || '',
        value: step.value,
        key: step.key,
        code: step.code,
        x: step.x,
        y: step.y,
        text: step.text || '',
        url: step.url || '',
        title: step.title || '',
        openerTabId: typeof step.openerTabId === 'number' ? step.openerTabId : null,
        active: step.active === true,
        durationMs: typeof step.durationMs === 'number' ? step.durationMs : undefined
    });
}

function trackRecorderTab(tabId, { url = '', title = '' } = {}) {
    if (typeof tabId !== 'number') {
        return;
    }
    if (!recorderState.trackedTabIds.includes(tabId)) {
        recorderState.trackedTabIds.push(tabId);
    }
    if (url) {
        recorderState.tabUrls[tabId] = url;
    }
    if (title) {
        recorderState.tabTitles[tabId] = title;
    }
}

function untrackRecorderTab(tabId) {
    recorderState.trackedTabIds = recorderState.trackedTabIds.filter((id) => id !== tabId);
    delete recorderState.tabUrls[tabId];
    delete recorderState.tabTitles[tabId];
}

function recordBackgroundRecorderStep(step) {
    if (!recorderState.isRecording || !step?.type) {
        return;
    }
    appendRecordedStep({
        ...step,
        timestamp: Date.now()
    });
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
    return await new Promise((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            chrome.tabs.onUpdated.removeListener(handleUpdated);
            resolve(false);
        }, timeoutMs);

        const handleUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
                return;
            }
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(handleUpdated);
            resolve(true);
        };

        chrome.tabs.onUpdated.addListener(handleUpdated);
    });
}

async function getRecorderFrameIds(tabId) {
    try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        const frameIds = frames
            .map((frame) => frame.frameId)
            .filter((frameId) => typeof frameId === 'number');
        return frameIds.length > 0 ? frameIds : [0];
    } catch (_) {
        return [0];
    }
}

async function sendRecorderCommandToAllFrames(tabId, message) {
    const frameIds = await getRecorderFrameIds(tabId);
    const responses = await Promise.all(frameIds.map(async (frameId) => {
        try {
            return await sendMessageToTabWithRetry(tabId, message, { frameId });
        } catch (_) {
            return null;
        }
    }));
    return responses.filter(Boolean);
}

async function startRecorderInTab(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id || !isSupportedTabUrl(tab.url)) {
        return false;
    }

    trackRecorderTab(tab.id, { url: tab.url || '', title: tab.title || '' });
    await ensureRecorderInjected(tab.id);
    const responses = await sendRecorderCommandToAllFrames(tab.id, { action: 'automationRecorderStart' }).catch(() => []);
    return responses.some((response) => response?.success);
}

async function replayDomRecorderStep(tabId, step) {
    await ensureRecorderInjected(tabId);
    const response = await sendMessageToTabWithRetry(tabId, {
        action: 'automationRecorderReplay',
        steps: [step]
    }, typeof step?.frameId === 'number' ? { frameId: step.frameId } : {});
    if (!response?.success) {
        throw new Error(response?.error || `Failed to replay step ${step.type}`);
    }
}

async function handleRecorderTabActivated(tabId) {
    if (!recorderState.isRecording || typeof tabId !== 'number') {
        return;
    }
    if (recorderState.activeTabId === tabId) {
        return;
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
        return;
    }

    recorderState.activeTabId = tabId;
    recorderState.tabId = tabId;
    trackRecorderTab(tabId, { url: tab.url || '', title: tab.title || '' });
    recordBackgroundRecorderStep({
        type: 'switch_tab',
        tabId,
        url: tab.url || '',
        title: tab.title || ''
    });

    if (isSupportedTabUrl(tab.url)) {
        await startRecorderInTab(tabId);
    }
}

async function handleRecorderTabUpdated(tabId, changeInfo, tab) {
    if (!recorderState.isRecording || typeof tabId !== 'number') {
        return;
    }

    const relevant = recorderState.trackedTabIds.includes(tabId) || tab?.active || recorderState.activeTabId === tabId;
    if (!relevant) {
        return;
    }

    const previousUrl = recorderState.tabUrls[tabId] || '';
    const nextUrl = tab?.url || changeInfo.url || previousUrl || '';
    const nextTitle = tab?.title || recorderState.tabTitles[tabId] || '';

    trackRecorderTab(tabId, { url: nextUrl, title: nextTitle });

    if (changeInfo.status === 'complete') {
        if (nextUrl && previousUrl !== nextUrl) {
            recordBackgroundRecorderStep({
                type: 'navigate',
                tabId,
                url: nextUrl,
                title: nextTitle
            });
        }
        if (isSupportedTabUrl(nextUrl)) {
            await startRecorderInTab(tabId);
        }
    }
}

async function handleRecorderTabCreated(tab) {
    if (!recorderState.isRecording || !tab?.id) {
        return;
    }

    const openerTracked = typeof tab.openerTabId === 'number' && recorderState.trackedTabIds.includes(tab.openerTabId);
    if (!openerTracked && !tab.active) {
        return;
    }

    trackRecorderTab(tab.id, { url: tab.url || '', title: tab.title || '' });
    recordBackgroundRecorderStep({
        type: 'open_tab',
        tabId: tab.id,
        openerTabId: typeof tab.openerTabId === 'number' ? tab.openerTabId : null,
        url: tab.url || '',
        title: tab.title || '',
        active: tab.active === true
    });

    if (tab.active) {
        recorderState.activeTabId = tab.id;
        recorderState.tabId = tab.id;
    }

    if (isSupportedTabUrl(tab.url)) {
        await startRecorderInTab(tab.id);
    }
}

function handleRecorderTabRemoved(tabId) {
    if (!recorderState.isRecording || typeof tabId !== 'number') {
        return;
    }
    if (!recorderState.trackedTabIds.includes(tabId)) {
        return;
    }

    recordBackgroundRecorderStep({
        type: 'close_tab',
        tabId
    });
    untrackRecorderTab(tabId);

    if (recorderState.activeTabId === tabId) {
        recorderState.activeTabId = null;
    }
    if (recorderState.tabId === tabId) {
        recorderState.tabId = recorderState.activeTabId;
    }
}

async function ensureRecorderInjected(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ['js/lib/browser-polyfill.js']
        });
    } catch (_) {
        // Ignore duplicate polyfill injection failures.
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ['js/automation/content-recorder.js']
        });
    } catch (error) {
        console.warn('[background-sw] Failed to inject recorder script directly, trying full reinject:', error?.message || error);
        await reinjectScriptsToTab(tabId);
    }
}

async function startAutomationRecordingLegacy() {
    const tab = await getActiveTab();
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }
    if (!isSupportedTabUrl(tab.url)) {
        return { success: false, error: '当前页面不支持录制' };
    }

    await ensureRecorderInjected(tab.id);
    const response = await sendMessageToTabWithRetry(tab.id, { action: 'automationRecorderStart' });
    if (!response?.success) {
        return { success: false, error: response?.error || '录制启动失败' };
    }

    recorderState.isRecording = true;
    recorderState.tabId = tab.id;
    recorderState.startedAt = Date.now();
    recorderState.steps = [];
    recorderState.lastEventAt = null;
    recorderState.url = tab.url || '';
    recorderState.title = tab.title || '';
    return { success: true, tabId: tab.id };
}

async function stopAutomationRecordingLegacy() {
    if (!recorderState.isRecording || !recorderState.tabId) {
        return { success: false, error: '当前没有正在进行的录制' };
    }

    const tabId = recorderState.tabId;
    const response = await sendMessageToTabWithRetry(tabId, { action: 'automationRecorderStop' });
    if (!response?.success) {
        return { success: false, error: response?.error || '停止录制失败' };
    }

    recorderState.isRecording = false;
    recorderState.tabId = null;
    recorderState.lastEventAt = null;
    recorderState.lastRecording = {
        title: recorderState.title || '页面录制',
        url: recorderState.url || '',
        startedAt: recorderState.startedAt,
        endedAt: Date.now(),
        steps: [...recorderState.steps]
    };
    return { success: true, recording: recorderState.lastRecording };
}

function getAutomationRecorderStatusLegacy() {
    return {
        success: true,
        isRecording: recorderState.isRecording,
        tabId: recorderState.tabId,
        stepCount: recorderState.steps.length,
        lastRecording: recorderState.lastRecording
    };
}

async function replayAutomationRecordingLegacy(steps) {
    const tab = await getActiveTab();
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }
    if (!steps?.length) {
        return { success: false, error: '没有可回放的录制步骤' };
    }

    await ensureRecorderInjected(tab.id);
    const response = await sendMessageToTabWithRetry(tab.id, {
        action: 'automationRecorderReplay',
        steps
    });
    if (!response?.success) {
        return { success: false, error: response?.error || '回放失败' };
    }
    return { success: true, stepCount: steps.length };
}

function handleAutomationRecorderEventLegacy(step, sender) {
    if (!recorderState.isRecording || sender?.tab?.id !== recorderState.tabId) {
        return { success: false, error: 'No active recorder session' };
    }
    appendRecordedStep(step);
    if (step?.url) {
        recorderState.url = step.url;
    }
    if (step?.title) {
        recorderState.title = step.title;
    }
    return { success: true, stepCount: recorderState.steps.length };
}

async function startAutomationRecording() {
    const tab = await getActiveTab();
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }
    if (!isSupportedTabUrl(tab.url)) {
        return { success: false, error: '褰撳墠椤甸潰涓嶆敮鎸佸綍鍒?' };
    }

    recorderState.isRecording = true;
    recorderState.tabId = tab.id;
    recorderState.activeTabId = tab.id;
    recorderState.startedAt = Date.now();
    recorderState.steps = [];
    recorderState.lastEventAt = null;
    recorderState.url = tab.url || '';
    recorderState.title = tab.title || '';
    recorderState.trackedTabIds = [tab.id];
    recorderState.tabUrls = { [tab.id]: tab.url || '' };
    recorderState.tabTitles = { [tab.id]: tab.title || '' };

    const started = await startRecorderInTab(tab.id);
    if (!started) {
        recorderState.isRecording = false;
        recorderState.tabId = null;
        recorderState.activeTabId = null;
        recorderState.startedAt = null;
        recorderState.steps = [];
        recorderState.lastEventAt = null;
        recorderState.url = '';
        recorderState.title = '';
        recorderState.trackedTabIds = [];
        recorderState.tabUrls = {};
        recorderState.tabTitles = {};
        return { success: false, error: 'Failed to start the recorder on the active tab.' };
    }

    return { success: true, tabId: tab.id };
}

async function stopAutomationRecording() {
    if (!recorderState.isRecording || !recorderState.tabId) {
        return { success: false, error: '褰撳墠娌℃湁姝ｅ湪杩涜鐨勫綍鍒?' };
    }

    const trackedTabIds = [...recorderState.trackedTabIds];
    await Promise.all(trackedTabIds.map(async (tabId) => {
        try {
            await sendRecorderCommandToAllFrames(tabId, { action: 'automationRecorderStop' });
        } catch (_) {
            // Ignore tabs that are no longer reachable.
        }
    }));

    recorderState.isRecording = false;
    recorderState.tabId = null;
    recorderState.activeTabId = null;
    recorderState.lastEventAt = null;
    recorderState.lastRecording = {
        title: recorderState.title || '椤甸潰褰曞埗',
        url: recorderState.url || '',
        startedAt: recorderState.startedAt,
        endedAt: Date.now(),
        steps: [...recorderState.steps]
    };
    recorderState.trackedTabIds = [];
    recorderState.tabUrls = {};
    recorderState.tabTitles = {};
    return { success: true, recording: recorderState.lastRecording };
}

function getAutomationRecorderStatus() {
    return {
        success: true,
        isRecording: recorderState.isRecording,
        tabId: recorderState.tabId,
        activeTabId: recorderState.activeTabId,
        trackedTabIds: [...recorderState.trackedTabIds],
        stepCount: recorderState.steps.length,
        lastRecording: recorderState.lastRecording
    };
}

async function replayAutomationRecording(steps) {
    const tab = await getActiveTab();
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }
    if (!steps?.length) {
        return { success: false, error: '娌℃湁鍙洖鏀剧殑褰曞埗姝ラ' };
    }

    const firstRecordedTabId = steps.find((step) => typeof step?.tabId === 'number')?.tabId ?? null;
    const tabMap = new Map();
    if (firstRecordedTabId != null) {
        tabMap.set(firstRecordedTabId, tab.id);
    }
    let currentReplayTabId = tab.id;

    try {
        for (const step of steps) {
            if (!step?.type) {
                continue;
            }

            if (step.type === 'wait') {
                await sleep(step.durationMs || 500);
                continue;
            }

            if (step.type === 'open_tab') {
                const createdTab = await chrome.tabs.create({
                    url: isSupportedTabUrl(step.url) ? step.url : 'about:blank',
                    active: step.active !== false
                });
                if (typeof step.tabId === 'number') {
                    tabMap.set(step.tabId, createdTab.id);
                }
                currentReplayTabId = createdTab.id;
                await waitForTabComplete(createdTab.id);
                if (isSupportedTabUrl(createdTab.url)) {
                    await ensureRecorderInjected(createdTab.id);
                }
                continue;
            }

            if (step.type === 'switch_tab') {
                let mappedTabId = typeof step.tabId === 'number' ? tabMap.get(step.tabId) : null;
                if (!mappedTabId) {
                    const createdTab = await chrome.tabs.create({
                        url: isSupportedTabUrl(step.url) ? step.url : undefined,
                        active: true
                    });
                    mappedTabId = createdTab.id;
                    if (typeof step.tabId === 'number') {
                        tabMap.set(step.tabId, mappedTabId);
                    }
                    await waitForTabComplete(mappedTabId);
                } else {
                    await chrome.tabs.update(mappedTabId, { active: true });
                }
                currentReplayTabId = mappedTabId;
                if (step.url && isSupportedTabUrl(step.url)) {
                    await ensureRecorderInjected(mappedTabId);
                }
                continue;
            }

            if (step.type === 'navigate') {
                const recordedTabId = typeof step.tabId === 'number' ? step.tabId : firstRecordedTabId;
                let mappedTabId = recordedTabId != null ? tabMap.get(recordedTabId) : currentReplayTabId;
                if (!mappedTabId) {
                    mappedTabId = currentReplayTabId;
                    if (recordedTabId != null) {
                        tabMap.set(recordedTabId, mappedTabId);
                    }
                }
                const existingTab = await chrome.tabs.get(mappedTabId).catch(() => null);
                if (step.url && existingTab?.url !== step.url) {
                    await chrome.tabs.update(mappedTabId, { url: step.url });
                    await waitForTabComplete(mappedTabId);
                }
                currentReplayTabId = mappedTabId;
                if (step.url && isSupportedTabUrl(step.url)) {
                    await ensureRecorderInjected(mappedTabId);
                }
                continue;
            }

            if (step.type === 'close_tab') {
                const mappedTabId = typeof step.tabId === 'number' ? tabMap.get(step.tabId) : null;
                if (mappedTabId) {
                    await chrome.tabs.remove(mappedTabId).catch(() => {});
                    tabMap.delete(step.tabId);
                }
                continue;
            }

            const recordedTabId = typeof step.tabId === 'number' ? step.tabId : firstRecordedTabId;
            const mappedTabId = recordedTabId != null
                ? (tabMap.get(recordedTabId) || currentReplayTabId)
                : currentReplayTabId;
            if (recordedTabId != null && !tabMap.has(recordedTabId)) {
                tabMap.set(recordedTabId, mappedTabId);
            }
            currentReplayTabId = mappedTabId;
            await replayDomRecorderStep(mappedTabId, step);
        }
    } catch (error) {
        return { success: false, error: error?.message || String(error) };
    }

    return { success: true, stepCount: steps.length };
}

function handleAutomationRecorderEvent(step, sender) {
    if (!recorderState.isRecording || !sender?.tab?.id || !recorderState.trackedTabIds.includes(sender.tab.id)) {
        return { success: false, error: 'No active recorder session' };
    }

    const normalizedStep = {
        ...step,
        tabId: sender.tab.id,
        frameId: typeof sender.frameId === 'number' ? sender.frameId : 0,
        url: step?.url || sender.tab.url || '',
        title: step?.title || sender.tab.title || ''
    };
    trackRecorderTab(sender.tab.id, {
        url: normalizedStep.url,
        title: normalizedStep.title
    });
    appendRecordedStep(normalizedStep);
    if (normalizedStep.url) {
        recorderState.url = normalizedStep.url;
    }
    if (normalizedStep.title) {
        recorderState.title = normalizedStep.title;
    }
    return { success: true, stepCount: recorderState.steps.length };
}

async function capturePageForProject() {
    const tab = await getActiveTab();
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }

    if (!isSupportedTabUrl(tab.url)) {
        return { success: false, error: '当前页面不支持保存到项目' };
    }

    const result = await extractTabContent(tab.id);
    if (result?.error) {
        return { success: false, error: result.error };
    }

    return {
        success: true,
        tabId: tab.id,
        url: tab.url || '',
        title: tab.title || '',
        content: result?.content || '',
        capturedAt: new Date().toISOString()
    };
}

async function extractProjectElements(pattern = 'article') {
    const tab = await getActiveTab();
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }

    if (!isSupportedTabUrl(tab.url)) {
        return { success: false, error: '当前页面不支持提取' };
    }

    const response = await sendMessageToTabWithRetry(tab.id, {
        action: 'projectExtractStructured',
        pattern
    });

    if (!response?.success) {
        return { success: false, error: response?.error || '页面提取失败' };
    }

    return {
        ...response,
        tabId: tab.id,
        url: tab.url || '',
        title: tab.title || '',
        extractedAt: new Date().toISOString()
    };
}

async function getAllOpenTabs() {
    const tabs = await chrome.tabs.query({});
    const extensionOrigin = chrome.runtime.getURL('');
    return {
        success: true,
        tabs: tabs
            .filter((tab) => tab?.url)
            .filter((tab) => !tab.url.startsWith(extensionOrigin))
            .filter((tab) => !tab.url.startsWith('chrome://'))
            .filter((tab) => !tab.url.startsWith('edge://'))
            .filter((tab) => !tab.url.startsWith('about:'))
            .map((tab) => ({
                url: tab.url,
                title: tab.title || 'Untitled Tab',
                favIconUrl: tab.favIconUrl || '../magic.png'
            }))
    };
}

async function extractTabContent(targetTabId) {
    if (!targetTabId) {
        return { error: 'No tabId provided' };
    }

    const tab = await chrome.tabs.get(targetTabId);
    if (!tab?.url) {
        throw new Error('Tab not found or has no URL');
    }

    if (/^(chrome|edge|about):/.test(tab.url) || tab.url.startsWith('moz-extension://')) {
        return { error: `Cannot access restricted URL: ${tab.url}` };
    }

    return await sendMessageToTabWithRetry(targetTabId, { action: 'getFullPageContentRequest' });
}

async function deepResearchCrawl(url) {
    try {
        const response = await makeApiRequest(url, { method: 'GET' });
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }

        const html = await response.text();
        return await sendOffscreenMessage('parseReadableContent', { html });
    } catch (error) {
        return { success: false, error: error?.message || String(error) };
    }
}

async function deepResearchWebSearch(message) {
    try {
        const pageUrl = message.pageUrl || `https://duckduckgo.com/html/?q=${encodeURIComponent(message.query)}`;
        const response = await makeApiRequest(pageUrl, { method: 'GET', forceProxy: true });
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }

        const html = await response.text();
        return await sendOffscreenMessage('parseDuckDuckGoResults', { html });
    } catch (error) {
        return { success: false, error: error?.message || String(error) };
    }
}

async function handleFetchWithProxy(message) {
    const response = await makeApiRequest(message.url, message.options || {});
    if (!response.ok) {
        return {
            success: false,
            error: `HTTP error ${response.status}: ${response.statusText}`
        };
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
        success: true,
        data: arrayBufferToBase64(arrayBuffer),
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries())
    };
}

async function relayDomAction(action, args) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }

    try {
        return await chrome.tabs.sendMessage(tab.id, { action, args });
    } catch (error) {
        return { success: false, error: error?.message || String(error) };
    }
}

async function runHtml(message) {
    if (!message.htmlContent) {
        return { success: false, error: 'No HTML content provided' };
    }

    const tab = await chrome.tabs.create({
        url: 'about:blank',
        active: true
    });

    await sleep(300);
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (html) => {
            const blob = new Blob([html], { type: 'text/html' });
            const blobUrl = URL.createObjectURL(blob);
            const iframe = document.createElement('iframe');
            iframe.src = blobUrl;
            iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;';
            document.documentElement.innerHTML = '';
            document.body.appendChild(iframe);
        },
        args: [message.htmlContent]
    });

    return { success: true, tabId: tab.id };
}

async function handleUnifiedAPICall(message, sender) {
    const { model, messages, options, streamId } = message;
    const result = await chrome.storage.sync.get(['managedModels', 'providerSettings']);
    const managedModels = Array.isArray(result.managedModels) ? result.managedModels : [];

    let modelConfig = null;
    if (typeof model === 'string' && model.includes('::')) {
        const [providerId, id] = model.split('::');
        modelConfig = managedModels.find((entry) => entry.id === id && entry.providerId === providerId);
    } else {
        modelConfig = managedModels.find((entry) => entry.id === model);
    }

    if (!modelConfig) {
        return {
            success: false,
            error: `Model not found: ${model}`
        };
    }

    const providerSettings = result.providerSettings?.[modelConfig.providerId];
    if (!providerSettings?.apiKey) {
        return {
            success: false,
            error: `API Key not configured for provider: ${modelConfig.providerId}`
        };
    }

    const streamCallback = async (chunk, isComplete) => {
        if (!sender?.tab?.id) {
            return;
        }

        try {
            await chrome.tabs.sendMessage(sender.tab.id, {
                action: 'streamUpdate',
                streamId,
                chunk,
                isComplete
            });
        } catch (_) {
            // Ignore tab messaging failures during background streaming.
        }
    };

    try {
        const response = await callAPIDirectlyWithStream(
            modelConfig,
            providerSettings,
            messages,
            options || {},
            streamCallback
        );

        return {
            success: true,
            response
        };
    } catch (error) {
        console.error('[background-sw] Unified API call failed:', error);
        return {
            success: false,
            error: error?.message || String(error)
        };
    }
}

async function getAvailableModels() {
    try {
        const result = await chrome.storage.sync.get([
            'managedModels',
            'userActiveModels',
            'customProviders',
            'providerSettings',
            'apiKey'
        ]);

        const managedModels = Array.isArray(result.managedModels) ? result.managedModels : [];
        const userActiveModels = Array.isArray(result.userActiveModels) ? result.userActiveModels : [];

        const providerMap = Object.fromEntries(
            Object.values(providers).map((provider) => [provider.id, provider.name || provider.id])
        );

        if (Array.isArray(result.customProviders)) {
            for (const provider of result.customProviders) {
                providerMap[provider.id] = provider.name || provider.id;
            }
        }

        if (managedModels.length > 0) {
            const sourceList = userActiveModels.length > 0
                ? userActiveModels.map((key) => {
                    if (typeof key === 'string' && key.includes('::')) {
                        const [providerId, modelId] = key.split('::');
                        return managedModels.find((model) => model.id === modelId && model.providerId === providerId);
                    }
                    return managedModels.find((model) => model.id === key);
                })
                : managedModels;

            return {
                success: true,
                models: sourceList
                    .filter(Boolean)
                    .map((model) => ({
                        value: `${model.providerId}::${model.id}`,
                        text: model.displayName,
                        providerId: model.providerId,
                        providerName: providerMap[model.providerId] || model.providerId || 'Unknown'
                    }))
            };
        }

        if (checkGoogleApiKeyConfigured(result.providerSettings, result.apiKey)) {
            return {
                success: true,
                models: defaultGeminiModels()
            };
        }

        return { success: true, models: [] };
    } catch (error) {
        console.error('[background-sw] Failed to get available models:', error);
        return { success: true, models: [] };
    }
}

async function getModelConfig(modelId) {
    try {
        const result = await chrome.storage.sync.get(['managedModels']);
        const managedModels = Array.isArray(result.managedModels) ? result.managedModels : [];

        let modelConfig = null;
        if (typeof modelId === 'string' && modelId.includes('::')) {
            const [providerId, id] = modelId.split('::');
            modelConfig = managedModels.find((model) => model.id === id && model.providerId === providerId);
        } else {
            modelConfig = managedModels.find((model) => model.id === modelId);
        }

        const plainId = typeof modelId === 'string' && modelId.includes('::')
            ? modelId.split('::')[1]
            : modelId;

        if (!modelConfig) {
            return {
                success: true,
                config: {
                    apiModelName: plainId,
                    providerId: 'google',
                    params: getDefaultModelParams(plainId)
                }
            };
        }

        return {
            success: true,
            config: {
                apiModelName: modelConfig.apiModelName,
                providerId: modelConfig.providerId || 'google',
                params: modelConfig.params
            }
        };
    } catch (error) {
        console.error('[background-sw] Failed to get model config:', error);
        return {
            success: true,
            config: {
                apiModelName: modelId,
                providerId: 'google',
                params: getDefaultModelParams(modelId)
            }
        };
    }
}

async function broadcastModelsUpdated() {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (isSupportedTabUrl(tab.url)) {
            try {
                await chrome.tabs.sendMessage(tab.id, { action: 'modelsUpdated' });
            } catch (_) {
                // Ignore tabs without content scripts.
            }
        }
    }
}

async function broadcastStorageChanges(changes, namespace) {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!isSupportedTabUrl(tab.url)) {
            continue;
        }

        try {
            await chrome.tabs.sendMessage(tab.id, {
                action: 'storageChanged',
                changes,
                namespace
            });
        } catch (_) {
            // Ignore tabs without content scripts.
        }

        if (namespace === 'sync' && changes.language) {
            try {
                await chrome.tabs.sendMessage(tab.id, {
                    action: 'languageChanged',
                    newLanguage: changes.language.newValue,
                    oldLanguage: changes.language.oldValue
                });
            } catch (_) {
                // Ignore tabs without content scripts.
            }
        }

        if (namespace === 'local' && changes.textSelectionHelperSettings) {
            try {
                await chrome.tabs.sendMessage(tab.id, {
                    action: 'textSelectionHelperSettingsChanged',
                    newSettings: changes.textSelectionHelperSettings.newValue,
                    oldSettings: changes.textSelectionHelperSettings.oldValue
                });
            } catch (_) {
                // Ignore tabs without content scripts.
            }
        }
    }
}

async function broadcastExtensionReload() {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!isSupportedTabUrl(tab.url)) {
            continue;
        }

        try {
            await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
            await chrome.tabs.sendMessage(tab.id, { action: 'extensionReloaded' });
        } catch (_) {
            await reinjectScriptsToTab(tab.id);
        }
    }
}

function defaultGeminiModels() {
    return [
        { value: 'google::gemini-2.5-flash', text: 'gemini-2.5-flash', providerId: 'google', providerName: 'Google' },
        { value: 'google::gemini-2.5-flash-thinking', text: 'gemini-2.5-flash-thinking', providerId: 'google', providerName: 'Google' },
        { value: 'google::gemini-2.5-flash-lite', text: 'gemini-2.5-flash-lite', providerId: 'google', providerName: 'Google' }
    ];
}

function checkGoogleApiKeyConfigured(providerSettings, legacyApiKey = null) {
    if (providerSettings?.google?.apiKey?.trim()) {
        return true;
    }
    return !!legacyApiKey?.trim();
}

function getDefaultModelParams(modelId) {
    if (modelId === 'gemini-2.5-flash') {
        return { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } };
    }
    return null;
}

async function getProviderConfig(providerId) {
    const builtinProviders = Object.fromEntries(
        Object.values(providers).map((provider) => [
            provider.id,
            { type: provider.type, apiHost: provider.apiHost }
        ])
    );

    if (builtinProviders[providerId]) {
        return builtinProviders[providerId];
    }

    const result = await chrome.storage.sync.get(['customProviders']);
    if (!Array.isArray(result.customProviders)) {
        return null;
    }

    const customProvider = result.customProviders.find((provider) => provider.id === providerId);
    if (!customProvider) {
        return null;
    }

    return {
        type: customProvider.type || 'openai_compatible',
        apiHost: customProvider.apiHost
    };
}

let offscreenReadyPromise = null;

async function sendOffscreenMessage(action, payload = {}) {
    await ensureOffscreenDocument();
    return chrome.runtime.sendMessage({
        target: 'offscreen',
        action,
        ...payload
    });
}

async function ensureOffscreenDocument() {
    if (!chrome.offscreen?.createDocument) {
        throw new Error('Offscreen document support is unavailable in this browser.');
    }

    if (!offscreenReadyPromise) {
        offscreenReadyPromise = (async () => {
            const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

            if (chrome.runtime.getContexts) {
                const contexts = await chrome.runtime.getContexts({
                    contextTypes: ['OFFSCREEN_DOCUMENT'],
                    documentUrls: [offscreenUrl]
                });

                if (contexts.length > 0) {
                    return;
                }
            }

            await chrome.offscreen.createDocument({
                url: OFFSCREEN_DOCUMENT_PATH,
                reasons: [chrome.offscreen.Reason.DOM_PARSER],
                justification: 'Parse HTML responses and run DOM-based scraping helpers.'
            });
        })().catch((error) => {
            offscreenReadyPromise = null;
            throw error;
        });
    }

    return offscreenReadyPromise;
}

async function getAllApiDomainsAsync() {
    const domains = new Set();

    for (const provider of Object.values(providers)) {
        if (!provider?.apiHost) {
            continue;
        }

        try {
            domains.add(new URL(provider.apiHost).hostname);
        } catch (_) {
            // Ignore invalid provider hosts.
        }
    }

    try {
        const result = await chrome.storage.sync.get(['customProviders']);
        if (Array.isArray(result.customProviders)) {
            for (const provider of result.customProviders) {
                if (!provider?.apiHost) {
                    continue;
                }

                try {
                    domains.add(new URL(provider.apiHost).hostname);
                } catch (_) {
                    // Ignore invalid custom provider hosts.
                }
            }
        }
    } catch (error) {
        console.warn('[background-sw] Failed to read custom providers for proxy domains:', error);
    }

    return Array.from(domains);
}

function generatePacScript(domains, proxyHost, proxyPort, proxyScheme = 'http') {
    const checks = domains.length > 0
        ? domains
            .map((domain) => `host === "${domain}" || dnsDomainIs(host, ".${domain}")`)
            .join(' || ')
        : 'false';

    let pacDirective = `PROXY ${proxyHost}:${proxyPort}`;
    if (proxyScheme === 'https') {
        pacDirective = `HTTPS ${proxyHost}:${proxyPort}`;
    } else if (proxyScheme === 'socks4') {
        pacDirective = `SOCKS4 ${proxyHost}:${proxyPort}`;
    } else if (proxyScheme === 'socks5') {
        pacDirective = `SOCKS5 ${proxyHost}:${proxyPort}`;
    }

    return `function FindProxyForURL(url, host) {
    if (${checks}) {
        return "${pacDirective}";
    }
    return "DIRECT";
}`;
}

async function updateProxySettings() {
    try {
        const result = await chrome.storage.sync.get(['proxyAddress']);
        const proxyAddress = result.proxyAddress?.trim() || '';

        if (!proxyAddress) {
            if (await canUseProxySettings()) {
                await chrome.proxy.settings.clear({ scope: 'regular' });
            }
            await stopProxyHealthCheck();
            await clearNetworkCache();
            return;
        }

        const hasPermission = await canUseProxySettings();
        if (!hasPermission) {
            notifyProxyPermissionRequired();
            return;
        }

        const proxyUrl = new URL(proxyAddress);
        const proxyScheme = proxyUrl.protocol.slice(0, -1);
        const supportedSchemes = new Set(['http', 'https', 'socks4', 'socks5']);
        if (!supportedSchemes.has(proxyScheme)) {
            throw new Error(`Unsupported proxy scheme: ${proxyScheme}`);
        }

        const apiDomains = await getAllApiDomainsAsync();
        const proxyPort = proxyUrl.port || String(getDefaultPort(proxyUrl.protocol));
        const proxyConfig = {
            mode: 'pac_script',
            pacScript: {
                data: generatePacScript(apiDomains, proxyUrl.hostname, proxyPort, proxyScheme)
            }
        };

        await chrome.proxy.settings.set({
            value: proxyConfig,
            scope: 'regular'
        });

        await chrome.storage.local.set({ proxyHealthConsecutiveFailures: 0 });
        await clearNetworkCache();
        await startProxyHealthCheck();
    } catch (error) {
        console.error('[background-sw] Failed to update proxy settings:', error);
    }
}

function getDefaultPort(protocol) {
    switch (protocol) {
        case 'http:':
            return 80;
        case 'https:':
            return 443;
        case 'socks4:':
        case 'socks5:':
            return 1080;
        default:
            return 8080;
    }
}

async function clearNetworkCache() {
    if (!chrome.browsingData?.remove) {
        return;
    }

    try {
        await chrome.browsingData.remove(
            { since: Date.now() - 60_000 },
            {
                cache: true,
                cacheStorage: true
            }
        );
    } catch (error) {
        console.warn('[background-sw] Failed to clear network cache:', error);
    }
}

async function handleProxyTestRequest(proxyAddress) {
    if (!proxyAddress?.trim()) {
        return { success: false, error: 'Proxy address is required.' };
    }

    const hasPermission = await canUseProxySettings();
    if (!hasPermission) {
        return {
            success: false,
            error: 'Proxy API is unavailable. Check extension permissions and Chrome proxy control.'
        };
    }

    let originalProxyConfig = null;

    try {
        const currentSettings = await chrome.proxy.settings.get({ incognito: false });
        originalProxyConfig = currentSettings?.value || null;

        const proxyUrl = new URL(proxyAddress.trim());
        const proxyScheme = proxyUrl.protocol.slice(0, -1);
        const proxyPort = proxyUrl.port || String(getDefaultPort(proxyUrl.protocol));
        const apiDomains = await getAllApiDomainsAsync();

        await chrome.proxy.settings.set({
            value: {
                mode: 'pac_script',
                pacScript: {
                    data: generatePacScript(apiDomains, proxyUrl.hostname, proxyPort, proxyScheme)
                }
            },
            scope: 'regular'
        });

        await sleep(1000);

        const testEndpoints = await getHealthCheckEndpointsAsync(providers);
        let lastError = null;

        for (const testUrl of testEndpoints) {
            try {
                const response = await fetchWithTimeout(testUrl, 8000);
                if (response.ok || response.status === 401 || response.status === 403 || response.status === 404) {
                    return {
                        success: true,
                        message: 'Proxy connection successful.'
                    };
                }

                lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error('All proxy tests failed.');
    } catch (error) {
        console.error('[background-sw] Proxy test failed:', error);
        return {
            success: false,
            error: error?.message || 'Proxy test failed.'
        };
    } finally {
        try {
            if (originalProxyConfig && originalProxyConfig.mode !== 'direct') {
                await chrome.proxy.settings.set({
                    value: originalProxyConfig,
                    scope: 'regular'
                });
            } else {
                await chrome.proxy.settings.clear({ scope: 'regular' });
            }
        } catch (error) {
            console.warn('[background-sw] Failed to restore proxy config after test:', error);
        }
    }
}

async function canUseProxySettings() {
    try {
        if (!chrome.proxy?.settings) {
            return false;
        }

        await chrome.proxy.settings.get({ incognito: false });
        return true;
    } catch (error) {
        console.warn('[background-sw] Proxy settings API is unavailable:', error);
        return false;
    }
}

async function startProxyHealthCheck() {
    const hasPermission = await canUseProxySettings();
    if (!hasPermission) {
        return;
    }

    const result = await chrome.storage.sync.get(['proxyAddress']);
    if (!result.proxyAddress?.trim()) {
        await stopProxyHealthCheck();
        return;
    }

    chrome.alarms.create(PROXY_HEALTH_ALARM, {
        periodInMinutes: HEALTH_CHECK_INTERVAL_MINUTES
    });

    await checkProxyHealth();
}

async function stopProxyHealthCheck() {
    await chrome.alarms.clear(PROXY_HEALTH_ALARM);
    await chrome.storage.local.set({ proxyHealthConsecutiveFailures: 0 });
}

async function checkProxyHealth() {
    const hasPermission = await canUseProxySettings();
    if (!hasPermission) {
        return;
    }

    try {
        const result = await chrome.storage.sync.get(['proxyAddress']);
        const proxyAddress = result.proxyAddress?.trim() || '';
        if (!proxyAddress) {
            await stopProxyHealthCheck();
            return;
        }

        const endpoints = await getHealthCheckEndpointsAsync(providers);
        let passed = false;

        for (const testUrl of endpoints) {
            try {
                const response = await fetchWithTimeout(testUrl, HEALTH_CHECK_TIMEOUT);
                if (response.ok || response.status === 401 || response.status === 403 || response.status === 404) {
                    passed = true;
                    break;
                }
            } catch (_) {
                // Try the next endpoint.
            }
        }

        const localState = await chrome.storage.local.get(['proxyHealthConsecutiveFailures']);
        const previousFailures = Number(localState.proxyHealthConsecutiveFailures) || 0;

        if (passed) {
            if (previousFailures > 0) {
                await chrome.storage.local.set({ proxyHealthConsecutiveFailures: 0 });
            }
            return;
        }

        const nextFailures = previousFailures + 1;
        await chrome.storage.local.set({ proxyHealthConsecutiveFailures: nextFailures });

        if (nextFailures >= MAX_CONSECUTIVE_FAILURES) {
            await clearProxyDueToFailure(proxyAddress);
        }
    } catch (error) {
        console.error('[background-sw] Proxy health check failed:', error);
    }
}

async function clearProxyDueToFailure(failedProxyAddress) {
    const hasPermission = await canUseProxySettings();
    if (!hasPermission) {
        await chrome.storage.sync.remove('proxyAddress');
        notifyProxyPermissionRequired();
        return;
    }

    try {
        await chrome.proxy.settings.clear({ scope: 'regular' });
        await chrome.storage.sync.remove('proxyAddress');
        await stopProxyHealthCheck();
        notifyProxyAutoCleared(failedProxyAddress);
    } catch (error) {
        console.error('[background-sw] Failed to clear proxy after health check failure:', error);
    }
}

function notifyProxyAutoCleared(failedProxyAddress) {
    void chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
            if (!isSupportedTabUrl(tab.url)) {
                continue;
            }

            chrome.tabs.sendMessage(tab.id, {
                action: 'proxyAutoCleared',
                failedProxy: failedProxyAddress
            }).catch(() => {
                // Ignore tabs without content scripts.
            });
        }
    }).catch(() => {
        // Ignore tab query failures.
    });
}

function notifyProxyPermissionRequired() {
    void chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
            if (!isSupportedTabUrl(tab.url)) {
                continue;
            }

            chrome.tabs.sendMessage(tab.id, {
                action: 'proxyAutoCleared',
                failedProxy: 'Proxy settings are unavailable. Check extension permissions and Chrome policy.'
            }).catch(() => {
                // Ignore tabs without content scripts.
            });
        }
    }).catch(() => {
        // Ignore tab query failures.
    });
}

async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            method: 'GET',
            signal: controller.signal,
            cache: 'no-cache'
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function callAPIDirectlyWithStream(modelConfig, providerSettings, messages, options, streamCallback) {
    const { providerId, apiModelName, params } = modelConfig;
    const provider = await getProviderConfig(providerId);
    if (!provider) {
        throw new Error(`Unsupported provider: ${providerId}`);
    }

    const apiHost = providerSettings.apiHost || provider.apiHost;
    const apiKey = providerSettings.apiKey;

    switch (provider.type) {
        case 'gemini':
            return callGeminiAPIInBackgroundStream(apiHost, apiKey, apiModelName, messages, options, params, streamCallback);
        case 'openai_compatible':
            return callOpenAICompatibleAPIInBackgroundStream(apiHost, apiKey, apiModelName, messages, options, providerId, streamCallback);
        case 'anthropic':
            return callAnthropicAPIInBackgroundStream(apiHost, apiKey, apiModelName, messages, options, streamCallback);
        default:
            throw new Error(`Unsupported provider type: ${provider.type}`);
    }
}

async function callOpenAICompatibleAPIInBackgroundStream(apiHost, apiKey, modelName, messages, options, providerId, streamCallback) {
    const requestBody = {
        model: modelName,
        messages,
        stream: true
    };

    if (!isTemperatureUnsupported(providerId, modelName)) {
        requestBody.temperature = options.temperature || 0.7;
    }

    if (options.maxTokens && Number.parseInt(options.maxTokens, 10) > 0) {
        requestBody.max_tokens = Number.parseInt(options.maxTokens, 10);
    }

    const headers = {
        'Content-Type': 'application/json',
        Authorization: providerId === 'chatglm' ? apiKey : `Bearer ${apiKey}`
    };

    if (providerId === 'openrouter') {
        headers['HTTP-Referer'] = 'https://infinpilot.extension';
        headers['X-Title'] = 'InfinPilot Browser Extension';
    }

    const endpoint = formatApiUrl(apiHost, providerId, '/chat/completions');
    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
    }

    return readSseResponse(response, (parsed) => parsed.choices?.[0]?.delta?.content || '', streamCallback);
}

async function callGeminiAPIInBackgroundStream(apiHost, apiKey, modelName, messages, options, params, streamCallback) {
    const geminiMessages = messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
    }));

    const requestBody = {
        contents: geminiMessages,
        generationConfig: {
            temperature: options.temperature || 0.7,
            ...(params?.generationConfig || {})
        }
    };

    if (options.maxTokens && Number.parseInt(options.maxTokens, 10) > 0) {
        requestBody.generationConfig.maxOutputTokens = Number.parseInt(options.maxTokens, 10);
    }

    const endpoint = `${apiHost}/v1beta/models/${modelName}:streamGenerateContent?key=${apiKey}&alt=sse`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
    }

    return readSseResponse(response, (parsed) => parsed.candidates?.[0]?.content?.parts?.[0]?.text || '', streamCallback);
}

async function callAnthropicAPIInBackgroundStream(apiHost, apiKey, modelName, messages, options, streamCallback) {
    const systemMessage = messages.find((message) => message.role === 'system');
    const userMessages = messages.filter((message) => message.role !== 'system');

    const requestBody = {
        model: modelName,
        messages: userMessages,
        temperature: options.temperature || 0.7,
        stream: true
    };

    if (systemMessage) {
        requestBody.system = systemMessage.content;
    }

    if (options.maxTokens && Number.parseInt(options.maxTokens, 10) > 0) {
        requestBody.max_tokens = Number.parseInt(options.maxTokens, 10);
    }

    const response = await fetch(`${apiHost}/v1/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
    }

    return readSseResponse(
        response,
        (parsed) => parsed.type === 'content_block_delta' ? parsed.delta?.text || '' : '',
        streamCallback
    );
}

async function readSseResponse(response, extractChunk, streamCallback) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) {
                    continue;
                }

                const data = line.slice(6);
                if (data === '[DONE]') {
                    streamCallback('', true);
                    return fullResponse;
                }

                try {
                    const parsed = JSON.parse(data);
                    const text = extractChunk(parsed);
                    if (text) {
                        fullResponse += text;
                        streamCallback(text, false);
                    }
                } catch (_) {
                    // Ignore malformed SSE chunks.
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    streamCallback('', true);
    return fullResponse;
}

function isTemperatureUnsupported(providerId, modelName) {
    if (!providerId || !modelName) {
        return false;
    }

    const name = String(modelName).toLowerCase();
    if (providerId === 'openai') {
        return name.startsWith('gpt-5') || /^o\d/.test(name) || name.startsWith('o-');
    }

    if (providerId === 'deepseek') {
        return name.startsWith('deepseek-reasoner');
    }

    return false;
}

function isSupportedTabUrl(url) {
    return typeof url === 'string' && /^(https?|file):/.test(url);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function blobToDataUrl(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    return `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
}

function arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

function dataUrlToBlob(dataUrl) {
    const [header, base64Data] = String(dataUrl || '').split(',', 2);
    if (!header || !base64Data) {
        throw new Error('Invalid screenshot data URL.');
    }

    const mimeMatch = header.match(/^data:(.*?);base64$/);
    const mimeType = mimeMatch?.[1] || 'application/octet-stream';
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    return new Blob([bytes], { type: mimeType });
}
