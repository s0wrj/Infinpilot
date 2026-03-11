// background.js 加载

/**
 * Infinpilot 背景脚本
 * 处理浏览器扩展的后台逻辑
 */

let makeApiRequest, providers, getHealthCheckEndpoints, getHealthCheckEndpointsAsync, formatApiUrl, toolCatalog, ScrapingTools, mcpManager;
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

// 等待模块加载完成的 Promise
let modulesLoaded = false;
const moduleLoadPromise = (async () => {
    try {
        const proxyModule = await import('./utils/proxyRequest.js');
        const providerModule = await import('./providerManager.js');
        const healthModule = await import('./utils/proxyHealth.js');
        const apiUrlModule = await import('./utils/apiUrl.js');
        const automationModule = await import('./automation/toolCatalog.js');
        const scrapingModule = await import('./scraping-tools.js');
        const mcpModule = await import('./mcp/mcpManager.js');

        makeApiRequest = proxyModule.makeApiRequest;
        providers = providerModule.providers;
        getHealthCheckEndpoints = healthModule.getHealthCheckEndpoints;
        getHealthCheckEndpointsAsync = healthModule.getHealthCheckEndpointsAsync;
        formatApiUrl = apiUrlModule.formatApiUrl;
        toolCatalog = automationModule.default;
        ScrapingTools = scrapingModule.default;
        mcpManager = mcpModule.default;

        modulesLoaded = true;
        console.log('[Background] Dynamically imported proxyRequest, providerManager, proxyHealth, apiUrl, automation, scraping and mcp modules');
    } catch (e) {
        console.error('[Background] Failed to dynamically import modules:', e);
    }
})();

// 等待模块加载的工具函数
async function waitForModules() {
    if (modulesLoaded) return;
    await moduleLoadPromise;
}

// 当安装或更新扩展时初始化
browser.runtime.onInstalled.addListener(() => {
    // onInstalled 事件触发

    // 创建右键菜单
    browser.contextMenus.create({
        id: "openInfinpilot",
        title: "打开 Infinpilot 面板",
        contexts: ["page", "selection"]
    });

    // 初始化代理设置
    updateProxySettings();

    // 启动代理健康检查
    startProxyHealthCheck();
});

// 处理右键菜单点击
browser.contextMenus.onClicked.addListener((info, tab) => {
    // onClicked 事件触发 (右键菜单)
    if (info.menuItemId === "openInfinpilot" && tab) {
        toggleInfinpilotPanel(tab.id);
    }
});

// 处理扩展图标点击
// In Firefox, the sidebar_action button automatically toggles the sidebar.
// This listener is kept for cross-browser compatibility but might be disabled for pure Firefox builds.
// browser.action.onClicked.addListener((tab) => {
//     // onClicked 事件触发 (扩展图标)
//     if (tab) {
//         toggleInfinpilotPanel(tab.id);
//     }
// });

// 切换面板状态
browser.tabs.onActivated.addListener((activeInfo) => {
    void handleRecorderTabActivated(activeInfo.tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void handleRecorderTabUpdated(tabId, changeInfo, tab);
});

browser.tabs.onCreated.addListener((tab) => {
    void handleRecorderTabCreated(tab);
});

browser.tabs.onRemoved.addListener((tabId) => {
    handleRecorderTabRemoved(tabId);
});

async function toggleInfinpilotPanel(tabId) {
    try {
        // --- 新增代码 开始 ---
        // 1. 获取标签页信息
        const tab = await browser.tabs.get(tabId);

        // 2. 检查 URL 协议是否受支持
        //    只允许在 http, https (以及可选的 file) 页面执行
        if (!tab || !tab.url || !(
            tab.url.startsWith('http:') ||
            tab.url.startsWith('https:') // ||
            // tab.url.startsWith('file:') // 如果需要支持本地文件，取消此行注释
        )) {
            console.debug(`Infinpilot: 不在受支持的页面 (${tab ? tab.url : 'N/A'}) 上执行操作，跳过。`);
            return; // 直接退出，不执行后续操作
        }
        // --- 新增代码 结束 ---

        // --- 原有代码（稍作调整，仅在受支持页面执行）---
        try {
            // 尝试切换面板
            const response = await browser.tabs.sendMessage(tabId, { action: "togglePanel" });

            // 检查响应，如果库缺失则重新注入
            if (response && !response.success && response.missing) {
                console.log('[Background] Libraries missing, reinjecting scripts:', response.missing);
                await reinjectScriptsToTab(tabId);

                // 再次尝试发送消息
                setTimeout(async () => {
                    try {
                        await browser.tabs.sendMessage(tabId, { action: "togglePanel" });
                    } catch (e) {
                        console.error('[Background] 重试切换面板失败:', e);
                    }
                }, 1000);
            }
        } catch (error) {
            console.log('[Background] Content script not responding, reinjecting all scripts');

            // 如果出错可能是因为content script还未加载或已失效，重新注入所有必要脚本
            try {
                await reinjectScriptsToTab(tabId);

                // 再次尝试发送消息
                setTimeout(async () => {
                    try {
                        await browser.tabs.sendMessage(tabId, { action: "togglePanel" });
                    } catch (e) {
                        console.error('[Background] 重试切换面板失败:', e);
                    }
                }, 1000); // 给更多时间让脚本完全加载
            } catch (e) {
                console.error('[Background] 重新注入脚本失败:', e);
            }
        }
    } catch (outerError) {
        // 捕获获取 tab 信息或其他意外错误
        console.error('toggleInfinpilotPanel 获取 tab 信息或其他意外出错:', outerError);
    }
}

async function sendMessageToTabWithRetry(tabId, message, options = {}) {
    try {
        const response = await browser.tabs.sendMessage(tabId, message, options);
        if (response) {
            return response;
        }
    } catch (_) {
        // Retry after reinjection.
    }

    await reinjectScriptsToTab(tabId);
    await new Promise(resolve => setTimeout(resolve, 800));
    const retryResponse = await browser.tabs.sendMessage(tabId, message, options);
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
            try { browser.tabs.onUpdated.removeListener(handleUpdated); } catch (_) {}
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
            try { browser.tabs.onUpdated.removeListener(handleUpdated); } catch (_) {}
            resolve(true);
        };

        try { browser.tabs.onUpdated.addListener(handleUpdated); } catch (_) {
            clearTimeout(timeout);
            resolve(false);
        }
    });
}

async function getRecorderFrameIds(tabId) {
    try {
        const frames = await browser.webNavigation.getAllFrames({ tabId });
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
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab?.id || !tab.url || !/^(https?|file):/.test(tab.url)) {
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

    const tab = await browser.tabs.get(tabId).catch(() => null);
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

    if (tab.url && /^(https?|file):/.test(tab.url)) {
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
        if (nextUrl && /^(https?|file):/.test(nextUrl)) {
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

    if (tab.url && /^(https?|file):/.test(tab.url)) {
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
        await browser.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ['js/lib/browser-polyfill.js']
        });
    } catch (_) {
        // Ignore duplicate polyfill injection failures.
    }

    try {
        await browser.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ['js/automation/content-recorder.js']
        });
    } catch (error) {
        console.warn('[Background] Failed to inject recorder script directly, trying full reinject:', error?.message || error);
        await reinjectScriptsToTab(tabId);
    }
}

async function startAutomationRecordingLegacy() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }
    if (!tab.url || !/^(https?|file):/.test(tab.url)) {
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

    const response = await sendMessageToTabWithRetry(recorderState.tabId, { action: 'automationRecorderStop' });
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
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
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
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }
    if (!tab.url || !/^(https?|file):/.test(tab.url)) {
        return { success: false, error: 'The current page does not support recording.' };
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
        return { success: false, error: 'There is no active recording session.' };
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
        title: recorderState.title || 'Page recording',
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
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }
    if (!steps?.length) {
        return { success: false, error: 'There are no recorded steps to replay.' };
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
                await new Promise((resolve) => setTimeout(resolve, step.durationMs || 500));
                continue;
            }

            if (step.type === 'open_tab') {
                const createdTab = await browser.tabs.create({
                    url: step.url && /^(https?|file):/.test(step.url) ? step.url : 'about:blank',
                    active: step.active !== false
                });
                if (typeof step.tabId === 'number') {
                    tabMap.set(step.tabId, createdTab.id);
                }
                currentReplayTabId = createdTab.id;
                await waitForTabComplete(createdTab.id);
                if (createdTab.url && /^(https?|file):/.test(createdTab.url)) {
                    await ensureRecorderInjected(createdTab.id);
                }
                continue;
            }

            if (step.type === 'switch_tab') {
                let mappedTabId = typeof step.tabId === 'number' ? tabMap.get(step.tabId) : null;
                if (!mappedTabId) {
                    const createdTab = await browser.tabs.create({
                        url: step.url && /^(https?|file):/.test(step.url) ? step.url : undefined,
                        active: true
                    });
                    mappedTabId = createdTab.id;
                    if (typeof step.tabId === 'number') {
                        tabMap.set(step.tabId, mappedTabId);
                    }
                    await waitForTabComplete(mappedTabId);
                } else {
                    await browser.tabs.update(mappedTabId, { active: true });
                }
                currentReplayTabId = mappedTabId;
                if (step.url && /^(https?|file):/.test(step.url)) {
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
                const existingTab = await browser.tabs.get(mappedTabId).catch(() => null);
                if (step.url && existingTab?.url !== step.url) {
                    await browser.tabs.update(mappedTabId, { url: step.url });
                    await waitForTabComplete(mappedTabId);
                }
                currentReplayTabId = mappedTabId;
                if (step.url && /^(https?|file):/.test(step.url)) {
                    await ensureRecorderInjected(mappedTabId);
                }
                continue;
            }

            if (step.type === 'close_tab') {
                const mappedTabId = typeof step.tabId === 'number' ? tabMap.get(step.tabId) : null;
                if (mappedTabId) {
                    await browser.tabs.remove(mappedTabId).catch(() => {});
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
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }

    if (!tab.url || !/^(https?|file):/.test(tab.url)) {
        return { success: false, error: '当前页面不支持保存到项目' };
    }

    const result = await browser.tabs.sendMessage(tab.id, { action: 'getFullPageContentRequest' }).catch(() => null);
    const normalizedResult = result || await sendMessageToTabWithRetry(tab.id, { action: 'getFullPageContentRequest' });
    if (normalizedResult?.error) {
        return { success: false, error: normalizedResult.error };
    }

    return {
        success: true,
        tabId: tab.id,
        url: tab.url || '',
        title: tab.title || '',
        content: normalizedResult?.content || '',
        capturedAt: new Date().toISOString()
    };
}

async function extractProjectElements(pattern = 'article') {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        return { success: false, error: 'No active tab' };
    }

    if (!tab.url || !/^(https?|file):/.test(tab.url)) {
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

let screenshotSendResponse = null;
// 监听来自内容脚本或面板的消息
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "pageContentExtracted") { // 来自 content.js 通过 iframe -> main.js -> content script -> background (这条路径似乎不直接发生)
        // 通常是 main.js 直接通过 browser.runtime.sendMessage 联系 background
        // ... (此部分逻辑可能需要审视，但不是当前 bug 的核心) ...
        // 实际上 pageContentExtracted 是 content.js 发给 iframe(main.js)的
        // main.js 收到后更新自己的状态，通常不直接发给 background.js
        // 如果有特定场景，保留。
        browser.storage.local.set({
            recentPageContent: message.content,
            recentExtractionTime: Date.now()
        });
        sendResponse({ success: true });
    }
    // 修改：处理从 main.js 发来的提取指定标签页内容的请求
    else if (message.action === "extractTabContent") {
        const targetTabId = message.tabId;
        if (!targetTabId) {
            console.error("Background: No tabId provided for extractTabContent");
            sendResponse({ error: "No tabId provided" });
            return true;
        }

        (async () => {
            try {
                const tab = await browser.tabs.get(targetTabId);

                if (!tab || !tab.url) {
                    throw new Error('Tab not found or has no URL');
                }

                // 受限页面直接报错
                if (tab.url.startsWith('chrome://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://') || tab.url.startsWith('moz-extension://')) {
                    console.warn(`Background: Cannot access restricted URL: ${tab.url}`);
                    sendResponse({ error: `Cannot access restricted URL: ${tab.url}` });
                    return;
                }

                // 优先直接请求 content script
                try {
                    const responseFromContentScript = await browser.tabs.sendMessage(targetTabId, { action: 'getFullPageContentRequest' });
                    if (responseFromContentScript) {
                        sendResponse(responseFromContentScript);
                        return;
                    }
                    throw new Error('No response from content script');
                } catch (err) {
                    console.warn(`[Background] sendMessage failed or no response for tab ${targetTabId}: ${err?.message || err}. Trying to reinject scripts...`);

                    // 尝试重新注入并重试一次
                    await reinjectScriptsToTab(targetTabId);
                    await new Promise(r => setTimeout(r, 800));

                    try {
                        const retryResponse = await browser.tabs.sendMessage(targetTabId, { action: 'getFullPageContentRequest' });
                        if (retryResponse) {
                            sendResponse(retryResponse);
                            return;
                        }
                        throw new Error('No response after reinject');
                    } catch (retryErr) {
                        console.error(`[Background] Retry failed for tab ${targetTabId}:`, retryErr?.message || retryErr);
                        sendResponse({ error: `Failed to communicate with the tab after reinject: ${retryErr?.message || retryErr}` });
                    }
                }
            } catch (e) {
                console.error('[Background] Error in extractTabContent handler:', e);
                sendResponse({ error: e.message || String(e) });
            }
        })();

        return true; // 必须返回 true 以表明 sendResponse 将会异步调用
    }
    // 已废弃：处理来自划词助手的 generateContent 请求
    // 现在划词助手使用统一API接口，不再通过background.js处理
    else if (message.action === "generateContent") {
        sendResponse({
            success: false,
            error: "This API endpoint has been deprecated. Please use the unified API interface."
        });
        return true;
    }
    // 处理来自content script的代理请求

    // DeepResearch: crawl background fetch for arbitrary URLs (with proxy)
    else if (message && message.action === 'deepResearch.crawl' && message.url) {
        (async () => {
            try{
                // Use makeApiRequest to leverage the proxy and bypass CORS
                const resp = await makeApiRequest(message.url, { method:'GET' });
                if (!resp.ok) {
                    throw new Error(`HTTP error ${resp.status}`);
                }
                const html = await resp.text();
                // Best-effort extraction of title + readable content
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const title = doc.querySelector('title')?.textContent?.trim() || '';
                let content = '';
                try{
                    // If Readability is present in this context (unlikely), use it
                    if(typeof Readability !== 'undefined'){
                        const article = new Readability(doc).parse();
                        content = article?.textContent || doc.body?.innerText || '';
                    }else{
                        content = doc.body?.innerText || '';
                    }
                }catch(_){ content = doc.body?.innerText || ''; }
                sendResponse({ success:true, title, content });
            }catch(e){
                console.warn('[DeepResearch][bg][crawl] fetch failed', e);
                sendResponse({ success:false, error:String(e?.message||e) });
            }
        })();
        return true; // async response
    }
    // DeepResearch: webSearch background fetch with pagination
    else if (message && message.action === 'deepResearch.webSearch' && message.query) {
        (async () => {
            try {
                const { query, maxResults, pageUrl } = message;
                const url = pageUrl || `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
                
                const resp = await makeApiRequest(url, { method: 'GET', forceProxy: true });
                if (!resp.ok) {
                    throw new Error(`HTTP error ${resp.status}`);
                }
                const html = await resp.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const results = [];
                const candidates = doc.querySelectorAll('.result, .results_links_deep, .results_links, .web-result');
                for (const node of candidates) {
                    let a = node.querySelector('a.result__a, a[href^="http"]');
                    if (!a) continue;
                    let href = a.getAttribute('href');
                    if (!href) continue;
                    // Normalize DuckDuckGo redirect links to the final destination when possible
                    try {
                        const parsed = new URL(href, 'https://duckduckgo.com');
                        if (parsed.hostname.includes('duckduckgo.com')) {
                            const uddg = parsed.searchParams.get('uddg');
                            if (uddg) {
                                href = decodeURIComponent(uddg);
                            }
                        }
                    } catch (_) {}
                    if (!/^https?:\/\//.test(href)) continue;
                    const title = a.textContent.trim();
                    const snippetNode = node.querySelector('.result__snippet, .result__snippet.js-result-snippet, .snippet');
                    const snippet = (snippetNode?.textContent || '').trim();
                    results.push({ title, url: href, snippet });
                }

                // Find the 'Next' page URL by parsing the form
                let nextPageUrl = null;
                const nextForm = doc.querySelector('form.results-nav, form[name="x"]');
                if (nextForm) {
                    const params = new URLSearchParams();
                    const hiddenInputs = nextForm.querySelectorAll('input[type="hidden"]');
                    hiddenInputs.forEach(input => {
                        if (input.name && input.value) {
                           params.append(input.name, input.value);
                        }
                    });
                    if (params.toString()) {
                        nextPageUrl = `https://duckduckgo.com/html/?${params.toString()}`;
                    }
                }

                sendResponse({ success: true, results, nextPageUrl });
            } catch (e) {
                console.warn('[DeepResearch][bg][webSearch] fetch failed', e);
                sendResponse({ success: false, error: String(e?.message || e) });
            }
        })();
        return true; // async response
    }
    // Scraping Tools - HTTP 网页抓取
    else if (message.action === 'scrapling.get' && message.options) {
        (async () => {
            try {
                await waitForModules(); // 等待模块加载
                if (!ScrapingTools) {
                    throw new Error('ScrapingTools not loaded');
                }
                const result = await ScrapingTools.scraplingGet(message.options);
                sendResponse(result);
            } catch (e) {
                console.error('[Background][scrapling.get] error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    // Scraping Tools - 批量抓取
    else if (message.action === 'scrapling.bulkGet' && message.urls) {
        (async () => {
            try {
                await waitForModules(); // 等待模块加载
                if (!ScrapingTools) {
                    throw new Error('ScrapingTools not loaded');
                }
                const result = await ScrapingTools.scraplingBulkGet(message.urls, message.options);
                sendResponse({ success: true, results: result });
            } catch (e) {
                console.error('[Background][scrapling.bulkGet] error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    // Scraping Tools - 获取链接
    else if (message.action === 'scrapling.getLinks' && message.options) {
        (async () => {
            try {
                await waitForModules(); // 等待模块加载
                if (!ScrapingTools) {
                    throw new Error('ScrapingTools not loaded');
                }
                const result = await ScrapingTools.scraplingGetLinks(message.options);
                sendResponse(result);
            } catch (e) {
                console.error('[Background][scrapling.getLinks] error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    // Scraping Tools - 获取图片
    else if (message.action === 'scrapling.getImages' && message.options) {
        (async () => {
            try {
                await waitForModules(); // 等待模块加载
                if (!ScrapingTools) {
                    throw new Error('ScrapingTools not loaded');
                }
                const result = await ScrapingTools.scraplingGetImages(message.options);
                sendResponse(result);
            } catch (e) {
                console.error('[Background][scrapling.getImages] error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    // Scraping Tools - 提取结构化数据
    else if (message.action === 'scrapling.extractStructured' && message.options) {
        (async () => {
            try {
                await waitForModules(); // 等待模块加载
                if (!ScrapingTools) {
                    throw new Error('ScrapingTools not loaded');
                }
                const result = await ScrapingTools.scraplingExtractStructured(message.options);
                sendResponse(result);
            } catch (e) {
                console.error('[Background][scrapling.extractStructured] error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    // DOM 智能搜索工具 - 转发到 content script
    else if (message.action === 'project.capturePage') {
        (async () => {
            try {
                sendResponse(await capturePageForProject());
            } catch (e) {
                console.error('[Background][project.capturePage] error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'project.extractElements') {
        (async () => {
            try {
                sendResponse(await extractProjectElements(message.pattern));
            } catch (e) {
                console.error('[Background][project.extractElements] error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.listServers') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.listServers() });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.upsertServer') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.upsertServer(message.server || {}) });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.removeServer') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.removeServer(message.serverId) });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.testServer') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.testServer(message.server || message.serverId) });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.listTools') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.getToolCatalog({ refresh: message.refresh === true }) });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.listResources') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.listResources({ serverId: message.serverId || null, refresh: message.refresh === true }) });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.readResource') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.readResource(message.serverId, message.uri) });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.listPrompts') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.listPrompts({ serverId: message.serverId || null, refresh: message.refresh === true }) });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.getPrompt') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.getPrompt(message.serverId, message.name, message.arguments || {}) });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.callTool') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.callTool(message.toolName, message.args || {}) });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'mcp.getState') {
        (async () => {
            try {
                await waitForModules();
                sendResponse({ success: true, data: await mcpManager.getState() });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'recorder.start') {
        (async () => {
            try {
                sendResponse(await startAutomationRecording());
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'recorder.stop') {
        (async () => {
            try {
                sendResponse(await stopAutomationRecording());
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'recorder.getStatus') {
        sendResponse(getAutomationRecorderStatus());
        return false;
    }
    else if (message.action === 'recorder.replay') {
        (async () => {
            try {
                sendResponse(await replayAutomationRecording(message.steps || []));
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'recorder.event') {
        sendResponse(handleAutomationRecorderEvent(message.step, sender));
        return false;
    }
    else if (message.action && message.action.startsWith('dom.')) {
        (async () => {
            try {
                const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
                if (!tab?.id) {
                    sendResponse({ success: false, error: 'No active tab' });
                    return;
                }
                const result = await browser.tabs.sendMessage(tab.id, {
                    action: message.action,
                    args: message.args
                });
                sendResponse(result);
            } catch (e) {
                console.error('[Background][dom.*] error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === "fetchWithProxy") {        handleFetchWithProxyRequest(message.url, message.options, sendResponse);
        return true; // 异步响应
    }
    // 处理代理测试请求
    else if (message.action === "testProxy") {
        handleProxyTestRequest(message.proxyAddress, sendResponse);
        return true; // 异步响应
    }
    // 处理获取可用模型列表的请求
    else if (message.action === "captureScreenshot") {
        (async () => {
            if (screenshotSendResponse) {
                sendResponse({ success: false, error: 'A screenshot request is already in progress.' });
                return;
            }
            try {
                const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
                if (!tab) {
                    sendResponse({ success: false, error: 'No active tab' });
                    return;
                }

                if (!tab.url || !/^(https?|file):/.test(tab.url)) {
                    sendResponse({ success: false, error: 'Screenshots are not supported on this page.' });
                    return;
                }

                screenshotSendResponse = sendResponse;

                await browser.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['js/cropper.js']
                });
            } catch (e) {
                console.error('[Background] captureScreenshot error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
                screenshotSendResponse = null;
            }
        })();
        return true;
    }
    // Agent专用的截图（直接返回dataUrl，不需要用户交互）
    else if (message.action === "captureScreenshotForEditor" || message.action === "captureScreenshotDirect") {
        (async () => {
            try {
                const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
                if (!tab) {
                    sendResponse({ success: false, error: 'No active tab' });
                    return;
                }

                if (!tab.url || !/^(https?|file):/.test(tab.url)) {
                    sendResponse({ success: false, error: 'Screenshots are not supported on this page.' });
                    return;
                }

                const dataUrl = await browser.tabs.captureVisibleTab(tab.id, { format: 'png' });
                sendResponse({
                    success: true,
                    dataUrl: dataUrl,
                    url: tab.url,
                    title: tab.title
                });
            } catch (e) {
                console.error('[Background] captureScreenshotForEditor error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true; // 保持异步响应
    }
    else if (message.action === "captureArea") {
        (async () => {
            if (!screenshotSendResponse) {
                console.error('[Background] Received captureArea without a pending screenshot request.');
                return;
            }

            const sendResponse = screenshotSendResponse;
            screenshotSendResponse = null;

            try {
                const { area } = message;
                const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

                const dataUrl = await browser.tabs.captureVisibleTab(undefined, { format: 'png' });
                
                const image = await createImageBitmap(await (await fetch(dataUrl)).blob());

                const canvas = new OffscreenCanvas(area.width, area.height);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
                
                const blob = await canvas.convertToBlob({ type: 'image/png' });
                
                const reader = new FileReader();
                reader.onload = () => {
                    sendResponse({
                        success: true,
                        dataUrl: reader.result,
                        url: tab.url || '',
                        title: tab.title || '',
                        capturedAt: new Date().toISOString()
                    });
                };
                reader.readAsDataURL(blob);

            } catch (e) {
                console.error('[Background] captureArea error:', e);
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === 'captureCancel') {
        if (screenshotSendResponse) {
            screenshotSendResponse({ success: false, error: 'Screenshot cancelled by user.' });
            screenshotSendResponse = null;
        }
        return false;
    }
    else if (message.action === "getActiveTabInfo") {
        (async () => {
            try {
                const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
                if (!tab) { sendResponse({ success: false, error: 'No active tab' }); return; }
                sendResponse({ success: true, url: tab.url || '', title: tab.title || '' });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === "activateForegroundTab") {
        (async () => {
            try {
                if (typeof message.tabId !== 'number') {
                    sendResponse({ success: false, error: 'tabId is required' });
                    return;
                }
                const tab = await browser.tabs.get(message.tabId);
                await browser.tabs.update(message.tabId, { active: true });
                if (typeof tab.windowId === 'number' && browser.windows?.update) {
                    await browser.windows.update(tab.windowId, { focused: true });
                }
                sendResponse({ success: true, tabId: message.tabId, windowId: tab.windowId });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === "getAllOpenTabs") {
        (async () => {
            try {
                const tabs = await browser.tabs.query({});
                const extId = browser.runtime.id;
                const sanitized = tabs
                    .filter(t => t && t.url)
                    .filter(t => !t.url.startsWith(`chrome-extension://${extId}`))
                    .filter(t => !t.url.startsWith('moz-extension://'))
                    .filter(t => !t.url.startsWith('chrome://'))
                    .filter(t => !t.url.startsWith('edge://'))
                    .filter(t => !t.url.startsWith('about:'))
                    .map(t => ({ url: t.url, title: t.title || 'Untitled Tab', favIconUrl: t.favIconUrl || '../magic.png' }));
                sendResponse({ success: true, tabs: sanitized });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    else if (message.action === "getAvailableModels") {
        handleGetAvailableModelsRequest(sendResponse);
        return true; // 异步响应
    }
    // 处理获取模型配置的请求
    else if (message.action === "getModelConfig") {
        handleGetModelConfigRequest(message.model, sendResponse);
        return true; // 异步响应
    }
    // 处理广播模型更新的请求
    else if (message.action === "broadcastModelsUpdated") {
        handleBroadcastModelsUpdated(sendResponse);
        return true; // 异步响应
    }
    // 处理来自划词助手的API调用请求
    else if (message.action === "callUnifiedAPI") {
        handleUnifiedAPICall(message, sendResponse, sender);
        return true; // 异步响应
    }
    else if (message.action === "openSettings") {
        // 处理打开设置页面的请求
        browser.runtime.openOptionsPage();
        sendResponse({ success: true });
        return false; // 同步响应
    }
    else if (message.action === "automation.call") {
        (async () => {
            const { tool, args } = message;
            try {
                const result = await handleAutomationCall(tool, args);
                sendResponse({ success: true, data: result });
            } catch (error) {
                sendResponse({ success: false, message: error.message });
            }
        })();
        return true;
    }
    // 处理运行 HTML 项目的请求
    else if (message.action === 'runHtml') {
        (async () => {
            try {
                const { htmlContent, projectName } = message;
                if (!htmlContent) {
                    sendResponse({ success: false, error: 'No HTML content provided' });
                    return;
                }

                // 创建 about:blank 标签页
                const tab = await browser.tabs.create({
                    url: 'about:blank',
                    active: true
                });

                // 等待页面加载
                await new Promise(resolve => setTimeout(resolve, 300));

                // 在页面上下文中创建 Blob URL 并加载
                await browser.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: function(html) {
                        // 创建 Blob
                        const blob = new Blob([html], { type: 'text/html' });
                        const blobUrl = URL.createObjectURL(blob);

                        // 创建 iframe 并加载 blob URL
                        const iframe = document.createElement('iframe');
                        iframe.src = blobUrl;
                        iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;';

                        // 替换整个文档
                        document.documentElement.innerHTML = '';
                        document.body.appendChild(iframe);
                    },
                    args: [htmlContent]
                });

                sendResponse({ success: true, tabId: tab.id });
            } catch (error) {
                console.error('[Background] runHtml error:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }
    // 如果有其他同步消息处理，它们可以在这里返回 false 或 undefined
    // 但如果整个 onMessage 可能处理异步操作，最好总是返回 true
    return true;
});

/**
 * 处理获取可用模型列表的请求
 */
async function handleGetAvailableModelsRequest(sendResponse) {
    try {
        // 从存储中获取模型管理器的数据、自定义提供商、供应商设置和旧版本API key
        const result = await browser.storage.sync.get(['managedModels', 'userActiveModels', 'customProviders', 'providerSettings', 'apiKey']);

        const managedModels = Array.isArray(result.managedModels) ? result.managedModels : [];
        const userActiveModels = Array.isArray(result.userActiveModels) ? result.userActiveModels : [];

        // 构建提供商映射（包括内置与自定义）
        const providerMap = Object.fromEntries(
            Object.values(providers).map(p => [p.id, p.name || p.id])
        );
        if (Array.isArray(result.customProviders)) {
            result.customProviders.forEach(provider => {
                providerMap[provider.id] = provider.name || provider.id;
            });
        }

        // 优先返回“用户激活的模型”；如果激活列表为空但管理列表非空，则回退为“全部管理的模型”
        if (managedModels.length > 0) {
            const sourceList = userActiveModels.length > 0
                ? userActiveModels.map(key => {
                    if (typeof key === 'string' && key.includes('::')) {
                        const [providerId, modelId] = key.split('::');
                        return managedModels.find(m => m.id === modelId && m.providerId === providerId);
                    }
                    // 兼容旧格式（纯ID）
                    return managedModels.find(m => m.id === key);
                })
                : managedModels; // 回退：没有激活列表时返回全部管理的模型

            const options = sourceList
                .filter(model => model)
                .map(model => ({
                    value: `${model.providerId}::${model.id}`,
                    text: model.displayName,
                    providerId: model.providerId,
                    providerName: providerMap[model.providerId] || model.providerId || 'Unknown'
                }));

            console.log('[Background] Returning model options:', {
                totalManaged: managedModels.length,
                totalActive: userActiveModels.length,
                returned: options.length,
                mode: userActiveModels.length > 0 ? 'active' : 'managed-fallback'
            });
            sendResponse({ success: true, models: options });
            return;
        }

        // 没有任何存储的模型，则基于是否配置了 Google API Key 返回默认 Gemini 模型，或空列表
        const hasGoogleApiKey = checkGoogleApiKeyConfigured(result.providerSettings, result.apiKey);
        if (hasGoogleApiKey) {
            const defaultModelOptions = [
                { value: 'google::gemini-2.5-flash', text: 'gemini-2.5-flash', providerId: 'google', providerName: 'Google' },
                { value: 'google::gemini-2.5-flash-thinking', text: 'gemini-2.5-flash-thinking', providerId: 'google', providerName: 'Google' },
                { value: 'google::gemini-2.5-flash-lite', text: 'gemini-2.5-flash-lite', providerId: 'google', providerName: 'Google' }
            ];
            console.log('[Background] No stored models but Google API key configured, returning Gemini defaults:', defaultModelOptions);
            sendResponse({ success: true, models: defaultModelOptions });
        } else {
            console.log('[Background] No stored models and no provider configured, returning empty list');
            sendResponse({ success: true, models: [] });
        }
    } catch (error) {
        console.error('[Background] Error getting available models:', error);
        // 返回默认模型选项作为回退，但也要检查API key
        const result = await browser.storage.sync.get(['providerSettings', 'apiKey']).catch(() => ({}));
        const hasGoogleApiKey = checkGoogleApiKeyConfigured(result.providerSettings, result.apiKey);

        if (hasGoogleApiKey) {
            const fallbackModelOptions = [
                { value: 'google::gemini-2.5-flash', text: 'gemini-2.5-flash', providerId: 'google', providerName: 'Google' },
                { value: 'google::gemini-2.5-flash-thinking', text: 'gemini-2.5-flash-thinking', providerId: 'google', providerName: 'Google' },
                { value: 'google::gemini-2.5-flash-lite', text: 'gemini-2.5-flash-lite', providerId: 'google', providerName: 'Google' }
            ];
            sendResponse({ success: true, models: fallbackModelOptions });
        } else {
            sendResponse({ success: true, models: [] });
        }
    }
}

/**
 * 处理获取模型配置的请求（多供应商版本）
 */
async function handleGetModelConfigRequest(modelId, sendResponse) {
    try {
        // 从存储中获取模型管理器的数据
        const result = await browser.storage.sync.get(['managedModels']);

        if (result.managedModels) {
            // 查找指定的模型配置
            const managedModels = result.managedModels;
            let modelConfig = null;
            if (typeof modelId === 'string' && modelId.includes('::')) {
                const [providerId, id] = modelId.split('::');
                modelConfig = managedModels.find(model => model.id === id && model.providerId === providerId);
            } else {
                modelConfig = managedModels.find(model => model.id === modelId);
            }

            if (modelConfig) {
                console.log('[Background] Returning model config for:', modelId, modelConfig);
                sendResponse({
                    success: true,
                    config: {
                        apiModelName: modelConfig.apiModelName,
                        providerId: modelConfig.providerId || 'google',
                        params: modelConfig.params
                    }
                });
            } else {
                // 模型不存在，返回默认配置
                console.warn('[Background] Model not found, using fallback config for:', modelId);
                const plainId = (typeof modelId === 'string' && modelId.includes('::')) ? modelId.split('::')[1] : modelId;
                sendResponse({
                    success: true,
                    config: {
                        apiModelName: plainId,
                        providerId: 'google',
                        params: getDefaultModelParams(plainId)
                    }
                });
            }
        } else {
            // 没有存储数据，返回默认配置
            console.warn('[Background] No stored models, using fallback config for:', modelId);
            const plainId = (typeof modelId === 'string' && modelId.includes('::')) ? modelId.split('::')[1] : modelId;
            sendResponse({
                success: true,
                config: {
                    apiModelName: plainId,
                    providerId: 'google',
                    params: getDefaultModelParams(plainId)
                }
            });
        }
    } catch (error) {
        console.error('[Background] Error getting model config:', error);
        // 返回默认配置作为回退
        const plainId = (typeof modelId === 'string' && modelId.includes('::')) ? modelId.split('::')[1] : modelId;
        sendResponse({
            success: true,
            config: {
                apiModelName: plainId,
                providerId: 'google',
                params: getDefaultModelParams(plainId)
            }
        });
    }
}

/**
 * 检查Google API key是否已配置
 * @param {Object} providerSettings - 供应商设置对象
 * @param {string} legacyApiKey - 旧版本的API key（可选）
 * @returns {boolean} 是否已配置Google API key
 */
function checkGoogleApiKeyConfigured(providerSettings, legacyApiKey = null) {
    // 首先检查新的供应商设置结构
    if (providerSettings && providerSettings.google && providerSettings.google.apiKey) {
        const googleApiKey = providerSettings.google.apiKey;
        if (googleApiKey && googleApiKey.trim()) {
            return true;
        }
    }

    // 如果新结构中没有，检查旧版本的API key
    if (legacyApiKey && legacyApiKey.trim()) {
        return true;
    }

    return false;
}

/**
 * 获取默认模型参数（多供应商版本）
 */
function getDefaultModelParams(modelId) {
    // Google Gemini 模型的默认参数
    if (modelId === 'gemini-2.5-flash') {
        return { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } };
    } else if (modelId === 'gemini-2.5-flash-thinking') {
        return null; // 使用默认思考模式
    } else if (modelId === 'gemini-2.5-pro') {
        return null;
    } else if (modelId === 'gemini-2.5-flash-lite') {
        return null;
    }

    // 其他供应商的模型默认无特殊参数
    return null;
}

/**
 * 处理广播模型更新的请求
 */
async function handleBroadcastModelsUpdated(sendResponse) {
    try {
        // 获取所有标签页
        const tabs = await browser.tabs.query({});

        // 向每个标签页发送模型更新消息
        const promises = tabs.map(tab => {
            return browser.tabs.sendMessage(tab.id, {
                action: 'modelsUpdated'
            }).catch(error => {
                // 忽略发送失败的错误（可能是标签页没有content script）
                console.log(`[Background] Failed to send modelsUpdated to tab ${tab.id}:`, error.message);
            });
        });

        await Promise.all(promises);
        console.log('[Background] Broadcasted models updated to all tabs');

        // 确保在响应之前检查运行时是否仍然有效
        if (browser.runtime.lastError) {
            console.warn('[Background] Runtime error during broadcast:', browser.runtime.lastError.message);
        } else {
            sendResponse({ success: true });
        }
    } catch (error) {
        console.error('[Background] Error broadcasting models updated:', error);
        // 只有在运行时仍然有效时才发送响应
        if (!browser.runtime.lastError) {
            sendResponse({ success: false, error: error.message });
        }
    }
}

/**
 * 处理来自划词助手的统一API调用请求 - 独立处理，不依赖主面板
 */
async function handleUnifiedAPICall(message, sendResponse, sender) {
    try {
        const { model, messages, options, streamId } = message;
        console.log('[Background] Handling independent unified API call for model:', model);

        // 从存储中获取模型配置和供应商设置
        const result = await browser.storage.sync.get(['managedModels', 'providerSettings']);

        if (!result.managedModels) {
            throw new Error('Model configuration not found. Please configure models in the main panel first.');
        }

        // 查找模型配置（支持复合键）
        let modelConfig = null;
        if (typeof model === 'string' && model.includes('::')) {
            const [providerId, id] = model.split('::');
            modelConfig = result.managedModels.find(m => m.id === id && m.providerId === providerId);
        } else {
            modelConfig = result.managedModels.find(m => m.id === model);
        }
        if (!modelConfig) {
            throw new Error(`Model not found: ${model}`);
        }

        const providerId = modelConfig.providerId;
        const providerSettings = result.providerSettings?.[providerId];

        if (!providerSettings || !providerSettings.apiKey) {
            throw new Error(`API Key not configured for provider: ${providerId}`);
        }

        // 流式回调函数
        const streamCallback = (chunk, isComplete) => {
            if (sender.tab) {
                browser.tabs.sendMessage(sender.tab.id, {
                    action: 'streamUpdate',
                    streamId: streamId,
                    chunk: chunk,
                    isComplete: isComplete
                }).catch(() => {
                    // 忽略发送失败
                });
            }
        };

        // 直接在background中调用API（支持流式）
        const response = await callAPIDirectlyWithStream(modelConfig, providerSettings, messages, options, streamCallback);

        sendResponse({ success: true, response: response });

    } catch (error) {
        console.error('[Background] Error handling unified API call:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * 智能格式化 API URL
// Centralized in utils/apiUrl.js (dynamically imported at startup)
// Centralized in utils/apiUrl.js
import { formatApiUrl } from './utils/apiUrl.js';

/**
 * 获取提供商配置（包括自定义提供商）
 */
async function getProviderConfig(providerId) {
    // 内置提供商配置来源于 providerManager
    const builtinProviders = Object.fromEntries(Object.values(providers).map(p => [p.id, { type: p.type, apiHost: p.apiHost }]));

    // 首先检查是否是内置提供商
    if (builtinProviders[providerId]) {
        return builtinProviders[providerId];
    }

    // 如果不是内置提供商，从存储中获取自定义提供商
    try {
        const result = await browser.storage.sync.get(['customProviders']);
        if (result.customProviders && Array.isArray(result.customProviders)) {
            const customProvider = result.customProviders.find(provider => provider.id === providerId);
            if (customProvider) {
                return {
                    type: customProvider.type || 'openai_compatible',
                    apiHost: customProvider.apiHost
                };
            }
        }
    } catch (error) {
        console.error('[Background] Error loading custom providers:', error);
    }

    return null;
}

/**
 * 在background中直接调用API（支持流式）
 */
async function callAPIDirectlyWithStream(modelConfig, providerSettings, messages, options, streamCallback) {
    const { providerId, apiModelName, params } = modelConfig;
    const { apiKey } = providerSettings;

    // 获取供应商配置（包括自定义提供商）
    const provider = await getProviderConfig(providerId);
    if (!provider) {
        throw new Error(`Unsupported provider: ${providerId}`);
    }

    const apiHost = providerSettings.apiHost || provider.apiHost;

    // 根据供应商类型调用相应的API
    switch (provider.type) {
        case 'gemini':
            return await callGeminiAPIInBackgroundStream(apiHost, apiKey, apiModelName, messages, options, params, streamCallback);
        case 'openai_compatible':
            return await callOpenAICompatibleAPIInBackgroundStream(apiHost, apiKey, apiModelName, messages, options, providerId, streamCallback);
        case 'anthropic':
            return await callAnthropicAPIInBackgroundStream(apiHost, apiKey, apiModelName, messages, options, streamCallback);
        default:
            throw new Error(`Unsupported provider type: ${provider.type}`);
    }
}

// 已删除：handleGenerateContentRequest 函数
// 划词助手现在使用统一API接口，不再通过background.js处理API调用

// 移除 getPageContentForExtraction 函数，因为它不再被使用
// function getPageContentForExtraction() { ... } // REMOVED

/**
 * 实时同步机制 - 监听存储变化并广播到所有标签页
 */
browser.storage.onChanged.addListener((changes, namespace) => {
    console.log('[Background] Storage changed:', changes, 'namespace:', namespace);

    // 处理sync存储变化
    if (namespace === 'sync') {
        // 特殊处理代理地址变化
        if (changes.proxyAddress) {
            console.log('[Background] Proxy address changed, updating proxy settings');
            updateProxySettings();
        }

        // 获取所有标签页并广播sync存储变化
        browser.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                // 检查标签页是否支持content script
                if (tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
                    // 广播通用存储变化
                    browser.tabs.sendMessage(tab.id, {
                        action: 'storageChanged',
                        changes: changes,
                        namespace: namespace
                    }).catch(() => {
                        // 忽略没有content script的标签页
                    });

                    // 特殊处理语言变化
                    if (changes.language) {
                        console.log('[Background] Broadcasting language change to tab:', tab.id);
                        browser.tabs.sendMessage(tab.id, {
                            action: 'languageChanged',
                            newLanguage: changes.language.newValue,
                            oldLanguage: changes.language.oldValue
                        }).catch(() => {
                            // 忽略错误
                        });
                    }
                }
            });
        });
    }

    // 处理local存储变化（主要是划词助手设置）
    if (namespace === 'local') {
        // 获取所有标签页并广播local存储变化
        browser.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                // 检查标签页是否支持content script
                if (tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
                    // 特殊处理划词助手设置变化
                    if (changes.textSelectionHelperSettings) {
                        console.log('[Background] Broadcasting text selection helper settings change to tab:', tab.id);
                        browser.tabs.sendMessage(tab.id, {
                            action: 'textSelectionHelperSettingsChanged',
                            newSettings: changes.textSelectionHelperSettings.newValue,
                            oldSettings: changes.textSelectionHelperSettings.oldValue
                        }).catch(() => {
                            // 忽略错误
                        });
                    }
                }
            });
        });
    }
});

/**
 * 处理扩展更新/重载 - 通知所有标签页重新初始化
 */
browser.runtime.onStartup.addListener(() => {
    console.log('[Background] Extension startup - broadcasting to all tabs');
    // 初始化代理设置
    updateProxySettings();
    // 启动代理健康检查
    startProxyHealthCheck();
    setTimeout(broadcastExtensionReload, 1000);
});

// 当扩展重新安装或更新时也广播
browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'update' || details.reason === 'install') {
        console.log('[Background] Extension updated/installed - broadcasting to all tabs');
        setTimeout(broadcastExtensionReload, 1000); // 延迟一秒确保所有服务准备就绪
    }
});

/**
 * 广播扩展重载事件到所有标签页，并重新注入必要的脚本
 */
function broadcastExtensionReload() {
    browser.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
                // 首先尝试发送消息检查content script是否还活跃
                browser.tabs.sendMessage(tab.id, {
                    action: 'ping'
                }).then(() => {
                    // Content script响应了，发送重载通知
                    browser.tabs.sendMessage(tab.id, {
                        action: 'extensionReloaded'
                    });
                }).catch(() => {
                    // Content script没有响应，需要重新注入
                    console.log('[Background] Content script not responding for tab', tab.id, 'reinject scripts');
                    reinjectScriptsToTab(tab.id);
                });
            }
        });
    });
}

/**
 * 重新注入所有必要的脚本到指定标签页
 */
async function reinjectScriptsToTab(tabId) {
    try {
        const tab = await browser.tabs.get(tabId);
        // Check if the tab URL is valid for injection
        if (!tab.url || !/^(https?|file):/.test(tab.url)) {
            console.log(`[Background] Skipping script injection for unsupported URL: ${tab.url}`);
            return;
        }

        console.log('[Background] Reinjecting scripts to tab:', tabId);

        // First, inject CSS files
        try {
            await browser.scripting.insertCSS({
                target: { tabId: tabId },
                files: ['css/content-panel.css', 'css/text-selection-helper.css']
            });
            console.log('[Background] Successfully injected CSS files');
        } catch (error) {
            console.warn(`[Background] Failed to inject CSS files into tab ${tabId}:`, error.message);
        }

        // Sequentially inject all necessary scripts
        const scriptsToInject = [
           'js/lib/browser-polyfill.js',
           'js/lib/Readability.js',
           'js/lib/markdown-it.min.js',
           'js/translations.js',
           'js/markdown-renderer.js',
           'js/text-selection-helper.js',
           'js/automation/content-automation.js',
           'js/automation/content-recorder.js',
           'js/content.js'
       ];

        for (const script of scriptsToInject) {
            try {
                await browser.scripting.executeScript({
                    target: { tabId: tabId },
                    files: [script]
                });
                console.log(`[Background] Successfully injected: ${script}`);
                // Add a small delay between key scripts to ensure dependencies are met
                if (script.includes('translations.js') || script.includes('markdown-renderer.js')) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            } catch (error) {
                console.warn(`[Background] Failed to inject script '${script}' into tab ${tabId}:`, error.message);
                // Continue to the next script even if one fails
            }
        }

        // Wait a bit for scripts to load, then send the reload message
        setTimeout(() => {
            browser.tabs.sendMessage(tabId, {
                action: 'extensionReloaded'
            }).catch((error) => {
                console.warn(`[Background] Failed to send extensionReloaded message to tab ${tabId} after reinject:`, error.message);
            });
        }, 500); // Reduced wait time

    } catch (error) {
        console.error(`[Background] Error reinjecting scripts to tab ${tabId}:`, error.message);
    }
}

/**
 * 获取所有供应商的API域名
 * @returns {Array<string>} 域名列表
 */
function getAllApiDomains() {
    const domains = new Set();

    // 从内置供应商配置中提取域名
    const builtinApiHosts = Object.values(providers).map(p => p.apiHost);

    // 添加内置供应商域名
    builtinApiHosts.forEach(apiHost => {
        try {
            const url = new URL(apiHost);
            domains.add(url.hostname);
        } catch (error) {
            console.warn('[Background] Invalid API host:', apiHost);
        }
    });

    // 从存储中获取自定义供应商域名
    try {
        // 这里我们需要同步获取，但由于browser.storage是异步的，
        // 我们将在调用此函数的地方处理异步逻辑
        if (window.customProviderDomains) {
            window.customProviderDomains.forEach(domain => domains.add(domain));
        }
    } catch (error) {
        console.warn('[Background] Error getting custom provider domains:', error);
    }

    const domainList = Array.from(domains);
    console.log('[Background] Collected API domains for proxy:', domainList);
    return domainList;
}

/**
 * 异步获取所有供应商的API域名（包括自定义供应商）
 * @returns {Promise<Array<string>>} 域名列表
 */
async function getAllApiDomainsAsync() {
    const domains = new Set();

    // 从内置供应商配置中提取域名
    const builtinApiHosts = Object.values(providers).map(p => p.apiHost);

    // 添加内置供应商域名
    builtinApiHosts.forEach(apiHost => {
        try {
            const url = new URL(apiHost);
            domains.add(url.hostname);
        } catch (error) {
            console.warn('[Background] Invalid API host:', apiHost);
        }
    });

    // 从存储中获取自定义供应商域名
    try {
        const result = await browser.storage.sync.get(['customProviders']);
        if (result.customProviders && Array.isArray(result.customProviders)) {
            result.customProviders.forEach(provider => {
                if (provider.apiHost) {
                    try {
                        const url = new URL(provider.apiHost);
                        domains.add(url.hostname);
                    } catch (error) {
                        console.warn('[Background] Invalid custom provider API host:', provider.apiHost);
                    }
                }
            });
        }
    } catch (error) {
        console.warn('[Background] Error getting custom providers from storage:', error);
    }

    const domainList = Array.from(domains);
    console.log('[Background] Collected API domains for proxy (async):', domainList);
    return domainList;
}

/**
 * 生成PAC脚本数据
 * @param {Array<string>} domains - 需要代理的域名列表
 * @param {string} proxyHost - 代理主机
 * @param {string|number} proxyPort - 代理端口
 * @returns {string} PAC脚本内容
 */
function generatePacScript(domains, proxyHost, proxyPort) {
    const domainChecks = domains.map(domain => `host === "${domain}"`).join(' || ');

    return `function FindProxyForURL(url, host) {
    if (${domainChecks}) {
        return "PROXY ${proxyHost}:${proxyPort}";
    }
    return "DIRECT";
}`;
}

/**
 * 更新代理设置 - 使用选择性代理，支持所有AI供应商的API域名
 */
async function updateProxySettings() {
    try {
        // 在 Firefox 中，使用 proxy.settings 需要允许“在隐私浏览窗口中运行”
        const hasPermission = await canUseProxySettings();
        if (!hasPermission) {
            console.warn('[Background] Proxy settings are unavailable (requires private browsing permission). Skipping proxy apply.');
            notifyProxyPermissionRequired();
            return; // 不再继续，避免抛出异常
        }

        // 从存储中获取代理地址
        const result = await browser.storage.sync.get(['proxyAddress']);
        const proxyAddress = result.proxyAddress;

        if (!proxyAddress || proxyAddress.trim() === '') {
            // 清除代理设置
            console.log('[Background] Clearing proxy settings');
            await browser.proxy.settings.clear({});
            console.log('[Background] Proxy settings cleared');
            // 停止健康检查
            stopProxyHealthCheck();

            // 等待代理清除完全生效
            await new Promise(resolve => setTimeout(resolve, 500));

            // 清理网络缓存以避免代理切换导致的缓存问题
            await clearNetworkCache();

            return;
        }

        // 解析代理地址
        let proxyUrl;
        try {
            proxyUrl = new URL(proxyAddress.trim());
        } catch (error) {
            console.error('[Background] Invalid proxy URL format:', proxyAddress, error);
            return;
        }

        // 获取所有需要代理的API域名
        const apiDomains = await getAllApiDomainsAsync();

        // 构建选择性代理配置 - 支持所有AI供应商的API域名
        const proxyPort = proxyUrl.port || getDefaultPort(proxyUrl.protocol);
        const pacScriptData = generatePacScript(apiDomains, proxyUrl.hostname, proxyPort);

        const proxyConfig = {
            mode: "pac_script",
            pacScript: {
                data: pacScriptData
            }
        };

        // 验证协议支持
        const supportedSchemes = ['http', 'https', 'socks4', 'socks5'];
        const proxyScheme = proxyUrl.protocol.slice(0, -1);
        if (!supportedSchemes.includes(proxyScheme)) {
            console.error('[Background] Unsupported proxy scheme:', proxyScheme);
            return;
        }

        // 应用代理设置
        console.log('[Background] Applying selective proxy settings for all AI API domains:', proxyAddress);
        console.log('[Background] Proxy will be applied to domains:', apiDomains);
        await browser.proxy.settings.set({
            value: proxyConfig,
            scope: 'regular'
        });
        console.log('[Background] Selective proxy settings applied successfully');

        // 等待代理设置完全生效
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 清理网络缓存以避免代理切换导致的缓存问题
        await clearNetworkCache();

        // 启动健康检查
        startProxyHealthCheck();

    } catch (error) {
        console.error('[Background] Error updating proxy settings:', error);
    }
}

/**
 * 获取协议的默认端口
 */
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

/**
 * 清理网络缓存以避免代理切换导致的缓存问题
 */
async function clearNetworkCache() {
    const hasPermission = await canUseProxySettings();
    if (!hasPermission) {
        console.warn('[Background] Skipping cache clear due to missing proxy permission.');
        return;
    }
    try {
        console.log('[Background] Clearing network cache to avoid proxy switching issues');

        // 清理浏览器缓存（包括 DNS 缓存）
        if (browser.browsingData) {
            // Construct the data types to remove, excluding properties not supported by Firefox.
            const dataToRemove = {
                "cache": true,
                "indexedDB": false,
                "localStorage": false,
                "cookies": false,
                "downloads": false,
                "formData": false,
                "history": false,
                "passwords": false
            };

            // Dynamically add properties for Chrome/Chromium-based browsers.
            const isFirefox = browser.runtime.getURL("").startsWith("moz-extension://");
            if (!isFirefox) {
                dataToRemove.cacheStorage = true;
                dataToRemove.webSQL = false;
            }

            await browser.browsingData.remove({
                "since": Date.now() - 60000 // 清理最近1分钟的缓存
            }, dataToRemove);
            console.log('[Background] Network cache cleared successfully');
        }
    } catch (error) {
        console.warn('[Background] Failed to clear network cache:', error);
        // 不抛出错误，因为这不是关键功能
    }
}

/**
 * 检查URL是否为AI API请求
 * @param {string} url - 请求URL
 * @returns {boolean} 是否为AI API请求
 */
/*
 * NOTE: HTTP request helpers are centralized in utils/proxyRequest.js.
 * background.js now imports and uses makeApiRequest directly.
 */

/**
 * 处理来自content script的代理请求
 */
async function handleFetchWithProxyRequest(url, options = {}, sendResponse) {
    try {
        console.log('[Background] Handling fetch with proxy request for:', url);

        // 使用统一的代理感知请求
        const response = await makeApiRequest(url, options);

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
        }

        // 将响应转换为base64（用于传输二进制数据）
        const arrayBuffer = await response.arrayBuffer();

        // 使用更高效的方法处理大文件
        let base64Data;
        try {
            // 尝试使用现代的 FileReader API（更高效）
            const blob = new Blob([arrayBuffer]);
            base64Data = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    // FileReader 返回的是 data:mime/type;base64,data 格式，需要提取 base64 部分
                    const result = reader.result;
                    const base64Index = result.indexOf(',') + 1;
                    resolve(result.substring(base64Index));
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (fileReaderError) {
            console.warn('[Background] FileReader failed, falling back to chunked processing:', fileReaderError);

            // 回退到分块处理方法
            const uint8Array = new Uint8Array(arrayBuffer);
            let binaryString = '';
            const chunkSize = 8192; // 8KB chunks
            for (let i = 0; i < uint8Array.length; i += chunkSize) {
                const chunk = uint8Array.subarray(i, i + chunkSize);
                binaryString += String.fromCharCode.apply(null, chunk);
            }
            base64Data = btoa(binaryString);
        }

        sendResponse({
            success: true,
            data: base64Data,
            status: response.status,
            statusText: response.statusText
        });

    } catch (error) {
        console.error('[Background] Error in handleFetchWithProxyRequest:', error);
        sendResponse({
            success: false,
            error: error.message
        });
    }
}

/**
 * 处理代理测试请求
 */
async function handleProxyTestRequest(proxyAddress, sendResponse) {
    const hasPermission = await canUseProxySettings();
    if (!hasPermission) {
        sendResponse({ success: false, error: 'Proxy test requires private browsing permission in Firefox. Please enable "Run in Private Windows" for InfinPilot.' });
        return;
    }
    try {
        console.log('[Background] Testing proxy:', proxyAddress);

        // 临时设置代理进行测试
        let originalProxyConfig = null;

        try {
            // 获取当前代理设置
            const currentSettings = await browser.proxy.settings.get({});
            originalProxyConfig = currentSettings.value;

            // 解析代理地址
            const proxyUrl = new URL(proxyAddress.trim());
            const proxyPort = proxyUrl.port || getDefaultPort(proxyUrl.protocol);

            // 获取所有需要代理的API域名
            const apiDomains = await getAllApiDomainsAsync();

            // 构建测试代理配置 - 支持所有AI供应商的API域名
            const testPacScriptData = generatePacScript(apiDomains, proxyUrl.hostname, proxyPort);

            const testProxyConfig = {
                mode: "pac_script",
                pacScript: {
                    data: testPacScriptData
                }
            };

            // 应用测试代理设置
            await browser.proxy.settings.set({
                value: testProxyConfig,
                scope: 'regular'
            });

            console.log('[Background] Applied test proxy config for domains:', apiDomains);

            // 等待代理设置生效
            await new Promise(resolve => setTimeout(resolve, 1000));

            // 测试多个AI API端点以验证代理连接
            const testEndpoints = await getHealthCheckEndpointsAsync(providers);

            let successCount = 0;
            let lastError = null;

            for (const testUrl of testEndpoints) {
                try {
                    console.log('[Background] Testing proxy with endpoint:', testUrl);
                    const response = await fetch(testUrl, {
                        method: 'GET',
                        signal: AbortSignal.timeout(8000),
                        cache: 'no-cache'
                    });

                    // 检查响应状态（401/403/404都表示代理连接成功，只是没有认证）
                    if (response.ok || response.status === 401 || response.status === 403 || response.status === 404) {
                        successCount++;
                        console.log(`[Background] Proxy test successful for ${testUrl}, status:`, response.status);
                        break; // 只要有一个成功就足够了
                    } else {
                        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }
                } catch (error) {
                    lastError = error;
                    console.warn(`[Background] Proxy test failed for ${testUrl}:`, error.message);
                }
            }

            if (successCount > 0) {
                sendResponse({
                    success: true,
                    message: `Proxy connection successful (tested ${successCount} endpoint${successCount > 1 ? 's' : ''})`
                });
            } else {
                throw lastError || new Error('All proxy tests failed');
            }

        } finally {
            // 恢复原始代理设置
            try {
                if (originalProxyConfig && originalProxyConfig.mode !== 'direct') {
                    await browser.proxy.settings.set({
                        value: originalProxyConfig,
                        scope: 'regular'
                    });
                } else {
                    await browser.proxy.settings.clear({});
                }
                console.log('[Background] Restored original proxy settings after test');
            } catch (restoreError) {
                console.error('[Background] Error restoring proxy settings:', restoreError);
            }
        }

    } catch (error) {
        console.error('[Background] Proxy test failed:', error);
        sendResponse({
            success: false,
            error: error.message || 'Proxy test failed'
        });
    }
}

// 代理健康检查相关变量

/**
 * 检查是否具备使用 proxy.settings 的权限（Firefox 需开启“在隐私浏览窗口中运行”）
 */
async function canUseProxySettings() {
    try {
        // 浏览器不支持 proxy API
        if (!browser.proxy || !browser.proxy.settings) return false;
        // 直接尝试读取当前设置，若抛错则无权限
        await browser.proxy.settings.get({});
        return true;
    } catch (e) {
        console.warn('[Background] proxy.settings not usable:', e?.message || e);
        return false;
    }
}

/**
 * 面向用户的权限提示（通过 tabs 广播给 content，再由面板 UI 展示）
 */
function notifyProxyPermissionRequired() {
    try {
        browser.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                if (tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
                    browser.tabs.sendMessage(tab.id, {
                        action: 'proxyAutoCleared',
                        failedProxy: 'Permission missing: please enable "Run in Private Windows" for InfinPilot to use proxy.'
                    }).catch(() => {});
                }
            });
        });
    } catch (_) {}
}

let proxyHealthCheckInterval = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 2; // 连续失败2次后清除代理
const HEALTH_CHECK_INTERVAL = 5000; // 5秒检查一次
const HEALTH_CHECK_TIMEOUT = 5000; // 5秒超时

/**
 * 启动代理健康检查
 */
function startProxyHealthCheck() {
    canUseProxySettings().then((ok) => {
        if (!ok) {
            console.warn('[Background] Proxy health check disabled (missing private browsing permission).');
            return;
        }
        // 清除现有的检查
        if (proxyHealthCheckInterval) {
            clearInterval(proxyHealthCheckInterval);
        }

        console.log('[Background] Starting proxy health check');

        // 立即执行一次检查
        checkProxyHealth();

        // 设置定期检查
        proxyHealthCheckInterval = setInterval(checkProxyHealth, HEALTH_CHECK_INTERVAL);
    });
    return; // 延迟到权限回调中处理
}

/**
 * 停止代理健康检查
 */
function stopProxyHealthCheck() {
    if (proxyHealthCheckInterval) {
        clearInterval(proxyHealthCheckInterval);
        proxyHealthCheckInterval = null;
        consecutiveFailures = 0;
        console.log('[Background] Stopped proxy health check');
    }
}

/**
 * 检查代理健康状态 - 使用当前代理设置测试AI API端点
 */
async function checkProxyHealth() {
    const hasPermission = await canUseProxySettings();
    if (!hasPermission) {
        // 无权限则不进行健康检查
        return;
    }
    try {
        // 获取当前代理设置
        const result = await browser.storage.sync.get(['proxyAddress']);
        const proxyAddress = result.proxyAddress;

        // 如果没有设置代理，停止健康检查
        if (!proxyAddress || proxyAddress.trim() === '') {
            stopProxyHealthCheck();
            return;
        }

        console.log('[Background] Checking proxy health for:', proxyAddress);

        // 使用多个AI API端点进行健康检查，提高可靠性
        const healthCheckEndpoints = getHealthCheckEndpoints(providers);

        let healthCheckPassed = false;

        for (const testUrl of healthCheckEndpoints) {
            try {
                // 直接使用当前的代理设置进行健康检查
                const response = await fetch(testUrl, {
                    method: 'GET',
                    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
                    cache: 'no-cache'
                });

                if (response.ok || response.status === 401 || response.status === 403 || response.status === 404) {
                    // 代理工作正常
                    healthCheckPassed = true;
                    console.log(`[Background] Proxy health check passed for ${testUrl}, status:`, response.status);
                    break; // 只要有一个端点成功就认为代理正常
                }
            } catch (fetchError) {
                // 继续尝试下一个端点
                console.warn(`[Background] Health check failed for ${testUrl}:`, fetchError.message);
            }
        }

        if (healthCheckPassed) {
            // 代理工作正常
            if (consecutiveFailures > 0) {
                console.log('[Background] Proxy recovered, resetting failure count');
                consecutiveFailures = 0;
            }
        } else {
            // 所有端点都失败
            consecutiveFailures++;
            console.warn(`[Background] Proxy health check failed for all endpoints (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

            // 如果连续失败次数达到阈值，自动清除代理
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.error('[Background] Proxy appears to be dead after 2 consecutive failures, automatically clearing proxy settings');
                await clearProxyDueToFailure(proxyAddress);
            }
        }

    } catch (error) {
        console.error('[Background] Error during proxy health check:', error);
    }
}

/**
 * 由于代理失败而清除代理设置
 */
async function clearProxyDueToFailure(failedProxyAddress) {
    const hasPermission = await canUseProxySettings();
    if (!hasPermission) {
        console.warn('[Background] Cannot clear proxy due to missing permission.');
        // 即便不能清除浏览器层代理，也清空存储以避免下次继续尝试
        try { await browser.storage.sync.remove('proxyAddress'); } catch (_) {}
        notifyProxyPermissionRequired();
        return;
    }
    try {
        // 清除Chrome代理设置
        await browser.proxy.settings.clear({});
        console.log('[Background] Cleared Chrome proxy settings due to failure');

        // 清除存储中的代理设置
        await browser.storage.sync.remove('proxyAddress');
        console.log('[Background] Cleared stored proxy address due to failure');

        // 停止健康检查
        stopProxyHealthCheck();

        // 通知所有标签页代理已被自动清除
        notifyProxyAutoCleared(failedProxyAddress);

    } catch (error) {
        console.error('[Background] Error clearing proxy due to failure:', error);
    }
}

/**
 * 通知用户代理已被自动清除
 */
function notifyProxyAutoCleared(failedProxyAddress) {
    // 如果连 proxy.settings 都没有权限，就不要再发“自动清除”误导信息
    canUseProxySettings().then((ok) => {
        if (!ok) {
            notifyProxyPermissionRequired();
            return;
        }
        // 向所有标签页发送通知
        browser.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                if (tab.url && (tab.url.startsWith('http:') || tab.url.startsWith('https:'))) {
                    browser.tabs.sendMessage(tab.id, {
                        action: 'proxyAutoCleared',
                        failedProxy: failedProxyAddress
                    }).catch(() => {
                        // 忽略发送失败的标签页
                    });
                }
            });
        });
    }).catch(() => {
        // 忽略 canUseProxySettings 错误
    });
}

/**
 * 在background中直接调用OpenAI兼容API（支持流式）
 */
async function callOpenAICompatibleAPIInBackgroundStream(apiHost, apiKey, modelName, messages, options, providerId, streamCallback) {
    const omitTemperature = isTemperatureUnsupported(providerId, modelName);
    const requestBody = {
        model: modelName,
        messages: messages,
        stream: true // 启用流式输出
    };
    if (!omitTemperature) {
        requestBody.temperature = options.temperature || 0.7;
    }

    if (options.maxTokens && parseInt(options.maxTokens) > 0) {
        requestBody.max_tokens = parseInt(options.maxTokens);
    }

    const headers = {
        'Content-Type': 'application/json'
    };

    // 根据供应商设置认证方式
    if (providerId === 'chatglm') {
        // ChatGLM 使用直接的 API key 认证，不需要 Bearer 前缀
        headers['Authorization'] = apiKey;
    } else {
        // 其他供应商使用标准的 Bearer 认证
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // OpenRouter特殊请求头
    if (providerId === 'openrouter') {
        headers['HTTP-Referer'] = 'https://infinpilot.extension';
        headers['X-Title'] = 'InfinPilot Browser Extension';
    }

    // 智能构建端点URL
    const endpoint = formatApiUrl(apiHost, providerId, '/chat/completions');
    console.log('[Background] Calling OpenAI-compatible API with streaming:', endpoint);

    const response = await makeApiRequest(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    // 处理流式响应
    let fullResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') {
                        streamCallback('', true);
                        return fullResponse;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content || '';
                        if (content) {
                            fullResponse += content;
                            streamCallback(content, false);
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    streamCallback('', true);
    return fullResponse;
}

/**
 * 在background中直接调用Gemini API（支持流式）
 */
async function callGeminiAPIInBackgroundStream(apiHost, apiKey, modelName, messages, options, params, streamCallback) {
    // 转换消息格式
    const geminiMessages = messages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
    }));

    const requestBody = {
        contents: geminiMessages,
        generationConfig: {
            temperature: options.temperature || 0.7,
            ...(params?.generationConfig || {})
        }
    };

    if (options.maxTokens && parseInt(options.maxTokens) > 0) {
        requestBody.generationConfig.maxOutputTokens = parseInt(options.maxTokens);
    }

    const endpoint = `${apiHost}/v1beta/models/${modelName}:streamGenerateContent?key=${apiKey}&alt=sse`;
    console.log('[Background] Calling Gemini API with streaming:', endpoint);

    const response = await makeApiRequest(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${errorText}`);
    }

    // 处理流式响应
    let fullResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
                        if (content) {
                            fullResponse += content;
                            streamCallback(content, false);
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    streamCallback('', true);
    return fullResponse;
}

/**
 * 在background中直接调用Anthropic API（支持流式）
 */
async function callAnthropicAPIInBackgroundStream(apiHost, apiKey, modelName, messages, options, streamCallback) {
    // 分离系统消息和用户消息
    const systemMessage = messages.find(msg => msg.role === 'system');
    const userMessages = messages.filter(msg => msg.role !== 'system');

    const requestBody = {
        model: modelName,
        messages: userMessages,
        temperature: options.temperature || 0.7,
        stream: true
    };

    if (systemMessage) {
        requestBody.system = systemMessage.content;
    }

    if (options.maxTokens && parseInt(options.maxTokens) > 0) {
        requestBody.max_tokens = parseInt(options.maxTokens);
    }

    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
    };

    const endpoint = `${apiHost}/v1/messages`;
    console.log('[Background] Calling Anthropic API with streaming:', endpoint);

    const response = await makeApiRequest(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${errorText}`);
    }

    // 处理流式响应
    let fullResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') {
                        streamCallback('', true);
                        return fullResponse;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.type === 'content_block_delta') {
                            const content = parsed.delta?.text || '';
                            if (content) {
                                fullResponse += content;
                                streamCallback(content, false);
                            }
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    streamCallback('', true);
    return fullResponse;
}

/**
 * 判断是否需要为该供应商/模型省略 temperature 参数
 * 与适配器中的逻辑保持一致
 */
function isTemperatureUnsupported(providerId, modelName) {
    if (!providerId || !modelName) return false;
    const m = String(modelName).toLowerCase();
    if (providerId === 'openai') {
        if (m.startsWith('gpt-5')) return true;
        if (/^o\d/.test(m) || m.startsWith('o-')) return true;
        return false;
    }
    if (providerId === 'deepseek') {
        return m.startsWith('deepseek-reasoner');
    }
    return false;
}

async function handleAutomationCall(tool, args) {
    // Lightweight schema check (Phase 1 - log only)
    try {
        if (Array.isArray(toolCatalog)) {
            const def = toolCatalog.find(t => t.name === tool);
            const schema = def && def.inputSchema;
            const req = schema && Array.isArray(schema.required) ? schema.required : [];
            const missing = req.filter(k => !(args && (args[k] !== undefined)));
            if (missing.length > 0) {
                console.warn(`[Automation] Missing required args for tool "${tool}": ${missing.join(', ')}`, { args });
            }
            // Basic type checks (non-blocking)
            if (schema && schema.properties && args && typeof args === 'object') {
                Object.entries(schema.properties).forEach(([key, prop]) => {
                    if (args[key] !== undefined && prop && prop.type) {
                        const expected = Array.isArray(prop.type) ? prop.type : [prop.type];
                        const actual = Array.isArray(args[key]) ? 'array' : typeof args[key];
                        if (!expected.includes(actual)) {
                            console.warn(`[Automation] Type mismatch for arg "${key}" in tool "${tool}". Expected ${expected.join('|')}, got ${actual}.`, { value: args[key] });
                        }
                    }
                });
            }
        }
    } catch (e) {
        console.warn('[Automation] Tool arg validation check failed:', e);
    }
    console.log(`[Background] Automation call: ${tool}`, args);

    const domTools = [
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
        // Newly routed tools per automationUP.md (Phase 1)
        'go_back',
        'go_forward',
        'select_option',
        'wait_for_selector',
        'wait_for_network_idle',
        'sleep'
    ];

    if (domTools.includes(tool)) {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            throw new Error('No active tab found');
        }
        // Extract frameId from args, default to 0 (main frame)
        const targetFrameId = args.frameId || 0;
        // Pass the rest of the args to the content script
        const { frameId, ...restArgs } = args;

        return browser.tabs.sendMessage(
            tab.id,
            { action: `dom.${tool}`, args: restArgs },
            { frameId: targetFrameId }
        );
    }

    switch (tool) {
        case 'get_all_tabs':
            return browser.tabs.query({});
        case 'get_current_tab':
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            return tab;
        case 'get_page_frames': {
            const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (!activeTab) throw new Error('No active tab found');
            const frames = await browser.webNavigation.getAllFrames({ tabId: activeTab.id });
            // Sanitize the result to return only relevant info
            const frameInfo = frames.map(f => ({
                frameId: f.frameId,
                parentFrameId: f.parentFrameId,
                url: f.url,
                errorOccurred: f.errorOccurred
            }));
            return frameInfo;
        }
        case 'switch_to_tab':
            return browser.tabs.update(args.tabId, { active: true });
        case 'open_url':
            return browser.tabs.create({ url: args.url });
        case 'close_tab':
            if (!args || typeof args.tabId !== 'number') throw new Error('tabId is required');
            await browser.tabs.remove(args.tabId);
            return { closed: true };
        case 'reload_tab':
            if (args && typeof args.tabId === 'number') {
                await browser.tabs.reload(args.tabId);
                return { reloaded: true, tabId: args.tabId };
            } else {
                const [active] = await browser.tabs.query({ active: true, currentWindow: true });
                if (!active) throw new Error('No active tab to reload');
                await browser.tabs.reload(active.id);
                return { reloaded: true, tabId: active.id };
            }
        case 'navigate': {
            const tabId = (args && typeof args.tabId === 'number') ? args.tabId : (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
            if (!tabId) throw new Error('No target tab to navigate');
            if (!args || typeof args.url !== 'string' || !args.url) throw new Error('url is required');
            await browser.tabs.update(tabId, { url: args.url });
            return { navigated: true, tabId, url: args.url };
        }
        case 'wait_for_navigation': {
            const timeoutMs = (args && typeof args.timeoutMs === 'number') ? args.timeoutMs : 10000;
            const targetTabId = (args && typeof args.tabId === 'number') ? args.tabId : (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
            if (!targetTabId) throw new Error('No target tab to wait on');
            return await new Promise(async (resolve) => {
                let done = false;
                const timeout = setTimeout(() => {
                    if (done) return;
                    done = true;
                    cleanup();
                    resolve({ completed: false, timeout: true, tabId: targetTabId });
                }, timeoutMs);
                const onUpdated = (tabId, changeInfo, tab) => {
                    if (tabId === targetTabId && changeInfo.status === 'complete') {
                        if (done) return;
                        done = true;
                        cleanup();
                        resolve({ completed: true, tabId: targetTabId, url: tab?.url });
                    }
                };
                function cleanup() {
                    try { browser.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
                    clearTimeout(timeout);
                }
                try { browser.tabs.onUpdated.addListener(onUpdated); } catch (_) {}
                // Also check if already complete
                try {
                    const t = await browser.tabs.get(targetTabId);
                    if (t.status === 'complete') {
                        if (!done) {
                            done = true; cleanup(); resolve({ completed: true, tabId: targetTabId, url: t.url });
                        }
                    }
                } catch (_) { /* ignore */ }
            });
        }
        default:
            throw new Error(`Unknown tool: ${tool}`);
    }
}
