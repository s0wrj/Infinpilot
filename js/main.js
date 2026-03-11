/**
 * Infinpilot - Main Sidepanel Script (Coordinator)
 */

console.log('[Main] main.js loaded, importing chat.js...');

const isEmbeddedPanel = window.parent && window.parent !== window;

// --- Imports ---
import { generateUniqueId } from './utils.js';
import vectorDB from './vectorDB.js';
import { renderDynamicContent, rerenderAllMermaidCharts, showMermaidModal, hideMermaidModal } from './render.js';
import { applyTheme, updateMermaidTheme, toggleTheme, makeDraggable, loadButtonPosition, setThemeButtonVisibility } from './theme.js';
import { setupImagePaste, handleImageSelect, handleImageFile, updateImagesPreview, removeImageById, clearImages, showFullSizeImage, hideImageModal } from './image.js';
import { handleYouTubeUrl, updateVideosPreview, removeVideoById, clearVideos, showYouTubeDialog, hideYouTubeDialog } from './video.js';
// Correctly import autoSaveAgentSettings with an alias
import {
    loadAgents,
    updateAgentsListUI,
    createNewAgent,
    showDeleteConfirmDialog,
    confirmDeleteAgent,
    switchAgent,
    updateAgentSelectionInChat,
    saveAgentsList,
    saveCurrentAgentId,
    handleAgentExport,
    handleAgentImport,
    loadCurrentAgentSettingsIntoState,
    autoSaveAgentSettings as autoSaveAgentSettingsFromAgent // Alias the import
} from './agent.js';
import { loadSettings as loadAppSettings, handleLanguageChange, handleExportChat, initModelSelection, updateModelCardsDisplay, handleProxyAddressChange, handleProxyTest, setupProviderEventListeners, initQuickActionsSettings, renderQuickActionsList } from './settings.js';
import * as QuickActionsManager from './quick-actions-manager.js';
import { initTextSelectionHelperSettings, isTextSelectionHelperEnabled } from './text-selection-helper-settings.js';
import { initAutomationRecorder } from './automation/recorder.js';
import { buildTemplateFromRecording } from './automation/workflowEngine.js';
import { sendUserMessage as sendUserMessageAction, clearContext as clearContextAction, deleteMessage as deleteMessageAction, regenerateMessage as regenerateMessageAction, abortStreaming as abortStreamingAction, handleRemoveSentTabContext as handleRemoveSentTabContextAction, createWelcomeMessage, loadChatSession, deleteChatSession } from './chat.js';
import projectService from './projectService.js';
import {
    switchTab,
    switchSettingsSubTab,
    addMessageToChat,
    updateStreamingMessage as uiUpdateStreamingMessage, // Renamed import
    finalizeBotMessage as uiFinalizeBotMessage,       // Renamed import
    addThinkingAnimation as uiAddThinkingAnimation,     // Renamed import for clarity
    showConnectionStatus,
    updateConnectionIndicator,
    updateContextStatus,
    showToast,
    resizeTextarea,
    setupAutoresizeTextarea,
    updateUIElementsWithTranslations,
    restoreSendButtonAndInput,
    toggleApiKeyVisibility,
    showChatStatusMessage,
    addCopyButtonToCodeBlock,
    addMessageActionButtons,
    showCopyCodeFeedback,
    showCopyMessageFeedback,
    // 新增导入 for Tab Selection and Bar
    showTabSelectionPopupUI,
    closeTabSelectionPopupUI as uiCloseTabSelectionPopupUI, // Alias to avoid naming conflict if any future local var
    updateSelectedTabsBarUI,
    showHistoryModal
} from './ui.js';

// --- State Management ---
const state = {
    apiKey: '',
    model: 'google::gemini-2.5-flash',
    agents: [],
    currentAgentId: null,
    currentSessionId: null, // Add this for chat history
    // Settings derived from current agent
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: '', // 改为空值，让模型使用自己的默认值
    // Other state
    pageContext: null, // Use null initially to indicate not yet extracted
    chatHistory: [],
    isConnected: false,
    hasDeterminedConnection: false, // 新增：是否已判定连接状态，避免初始闪烁
    images: [],
    videos: [],
    darkMode: false,
    language: 'en', // Changed default language to English
    proxyAddress: '', // 代理地址
    isStreaming: false,
    userScrolledUpDuringStream: false, // 新增：跟踪用户在流式传输期间是否已向上滚动
    // userHasSetPreference: false, // Removed
    selectedContextTabs: [], // 新增：存储用户选择的用于上下文的标签页
    availableTabsForSelection: [], // 新增：存储查询到的供用户选择的标签页
    isTabSelectionPopupOpen: false, // 新增：跟踪标签页选择弹窗的状态
    locallyIgnoredTabs: {}, // 新增: 跟踪用户从特定消息上下文中移除的标签页 { messageId: [tabId1, tabId2] }
    quickActionIgnoreAssistant: false, // 新增：快捷操作忽略助手标记
    automationEnabled: false, // 浏览器自动化开关
    collectiveResearchEnabled: false,
    automationMaxToolSteps: 8, // Max tool steps for ReAct loop
    currentProjectId: null,
    currentProject: null,
    currentProjectSummary: null,
    currentProjectTemplates: [],
    currentProjectRuns: [],
    currentProjectPreviewRecord: null,
    currentTemplateDraft: null,
};

const MCP_AGENT_PREFERENCES_KEY = 'infinpilot-mcp-agent-preferences';

// Default settings (used by agent module)
const defaultSettings = {
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: '', // 改为空值，让模型使用自己的默认值
};
// Default agent (used by agent module)
const defaultAgent = {
    id: 'default',
    name: 'Default', // Base name, will be translated on load
    ...defaultSettings
};

// --- DOM Elements ---
const elements = {
    // Main Navigation & Content
    tabs: document.querySelectorAll('.footer-tab'),
    tabContents: document.querySelectorAll('.tab-content'),
    // Chat Interface
    chatMessages: document.getElementById('chat-messages'),
    automationToggleBtn: document.getElementById('automation-toggle-btn'),
    collectiveResearchBtn: document.getElementById('collective-research-btn'),
    userInput: document.getElementById('user-input'),
    sendMessage: document.getElementById('send-message'),
    summarizeButton: document.getElementById('summarize-page'), // Note: This might be dynamically added now
    chatModelSelection: document.getElementById('chat-model-selection'),
    chatAgentToolbarSlot: document.getElementById('chat-agent-toolbar-slot'),
    chatAgentSelection: document.getElementById('chat-agent-selection'),
    dbSelector: document.getElementById('db-selector'),
    projectSelector: document.getElementById('project-selector'),
    projectCreateBtn: document.getElementById('project-create-btn'),
    projectRefreshBtn: document.getElementById('project-refresh-btn'),
    projectSummaryTitle: document.getElementById('project-summary-title'),
    projectSummaryMeta: document.getElementById('project-summary-meta'),
    projectSummaryItems: document.getElementById('project-summary-items'),
    projectSummaryBrowseBtn: null,
    projectSummaryPublicBtn: null,
    projectSummaryTemplatesBtn: null,
    clearContextBtn: document.getElementById('clear-context'),
    chatHistoryBtn: document.getElementById('chat-history-btn'), // Add this
    closePanelBtnChat: document.getElementById('close-panel'),
    uploadImage: document.getElementById('upload-image'),
    fileInput: document.getElementById('file-input'),
    fileInputBtn: document.getElementById('file-input-btn'),
    addYoutubeUrl: document.getElementById('add-youtube-url'),
    fetchPageContent: document.getElementById('fetch-page-content'), // 新增获取页面内容按钮
    savePageToProject: document.getElementById('save-page-to-project'),
    extractArticleToProject: document.getElementById('extract-article-to-project'),
    extractTableToProject: document.getElementById('extract-table-to-project'),
    mermaidBtn: document.getElementById('mermaid-btn'),
    imagePreviewContainer: document.getElementById('image-preview-container'),
    imagesGrid: document.getElementById('images-grid'),
    videoPreviewContainer: document.getElementById('video-preview-container'),
    videosGrid: document.getElementById('videos-grid'),
    youtubeUrlDialog: document.getElementById('youtube-url-dialog'),
    youtubeUrlInput: document.getElementById('youtube-url-input'),
    cancelYoutube: document.getElementById('cancel-youtube'),
    confirmYoutube: document.getElementById('confirm-youtube'),
    imageModal: document.getElementById('image-modal'),
    modalImage: document.getElementById('modal-image'),
    closeModal: document.querySelector('.close-modal'),
    mermaidModal: document.getElementById('mermaid-modal'),
    mermaidModalContent: document.getElementById('mermaid-modal-content'),
    mermaidCloseModal: document.querySelector('.mermaid-close-modal'),
    chatStatusMessage: document.getElementById('chat-status-message'),
    // Settings Interface
    settingsSection: document.getElementById('settings'),
    settingsNavBtns: document.querySelectorAll('.settings-nav-btn'),
    settingsSubContents: document.querySelectorAll('.settings-sub-content'),
    closePanelBtnSettings: document.getElementById('close-panel-settings'),
    // Settings - General
    languageSelect: document.getElementById('language-select'),
    userNameInput: document.getElementById('user-name-input'),
    userAvatarInput: document.getElementById('user-avatar-input'),
    proxyAddressInput: document.getElementById('proxy-address-input'),
    testProxyBtn: document.getElementById('test-proxy-btn'),
    themeToggleBtnSettings: document.getElementById('theme-toggle-btn'), // Draggable button
    moonIconSettings: document.getElementById('moon-icon'),
    sunIconSettings: document.getElementById('sun-icon'),
    exportFormatSelect: document.getElementById('export-format'),
    exportChatHistoryBtn: document.getElementById('export-chat-history'),
    // Unified Import/Export
    exportAllSettingsBtn: document.getElementById('export-all-settings'),
    importAllSettingsBtn: document.getElementById('import-all-settings'),
    unifiedImportInput: document.getElementById('unified-import-input'),
    // Settings - Agent
    agentsList: document.getElementById('agents-list'),
    addNewAgent: document.getElementById('add-new-agent'),
    deleteConfirmDialog: document.getElementById('delete-confirm-dialog'),
    deleteAgentNameSpan: document.getElementById('delete-agent-name'), // Span inside prompt
    confirmDelete: document.getElementById('confirm-delete'),
    cancelDelete: document.getElementById('cancel-delete'),
    importAgentsBtn: document.getElementById('import-agents'),
    importAgentInput: document.getElementById('import-agent-input'),
    exportAgentsBtn: document.getElementById('export-agents'),
    // Settings - Model
    apiKey: null, // 多供应商模式下不再使用单一API Key
    modelSelection: document.getElementById('model-selection'),
    selectedModelsContainer: document.getElementById('selected-models-container'),

    connectionStatus: document.getElementById('connection-status'),
    toggleApiKey: null, // 多供应商模式下不再使用单一切换按钮
    apiKeyInput: null, // 多供应商模式下不再使用单一API Key输入框
    // Footer Status Bar
    contextStatus: document.getElementById('context-status'),
    connectionIndicator: document.getElementById('connection-indicator'),
    editorProjectSelector: document.getElementById('editor-project-selector-tree'),
    editorProjectCreateBtn: document.getElementById('editor-project-create-btn-tree'),
    editorAddCurrentFileToProject: document.getElementById('editor-add-current-file-to-project-tree'),
    editorProjectFileStatus: document.getElementById('editor-project-file-status-tree'),
    projectPreviewModal: null,
    projectPreviewType: null,
    projectPreviewTitle: null,
    projectPreviewMeta: null,
    projectPreviewActions: null,
    projectPreviewBody: null,
    projectBrowserModal: null,
    projectBrowserList: null,
    projectTemplateBrowserModal: null,
    projectTemplateList: null,
    projectRunList: null,
    templateEditorModal: null,
};

// --- Translation ---
let currentTranslations = {}; // Loaded from translations.js
function _(key, replacements = {}) {
    // 优先使用统一 i18n 工具（若可用），并传入当前翻译对象
    if (window.I18n && typeof window.I18n.tr === 'function') {
        return window.I18n.tr(key, replacements, currentTranslations);
    }
    // 回退：使用 main.js 维护的当前翻译对象
    let translation = currentTranslations[key] || key;
    for (const placeholder in replacements) {
        translation = translation.replace(`{${placeholder}}`, replacements[placeholder]);
    }
    return translation;
}

// --- Scroll Tracking ---
let isUserNearBottom = true; // This remains the live state
const SCROLL_THRESHOLD = 30; // Increased threshold slightly

function createToolbarIconButton({ id, title, svgPath }) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = 'icon-btn project-toolbar-action toolbar-menu-action';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = svgPath;
    return button;
}

function ensureChatToolbarProjectButtonsLegacy() {
    if (
        elements.savePageToProject &&
        elements.extractArticleToProject &&
        elements.extractTableToProject &&
        elements.extractFaqToProject &&
        elements.extractProductToProject &&
        elements.extractTimelineToProject
    ) {
        return;
    }

    const toolbar = document.querySelector('.chat-input-toolbar');
    const anchor = document.getElementById('toolbar-automation-group') || elements.fetchPageContent;
    if (!toolbar || !anchor) {
        return;
    }

    const buttonDefinitions = [
        {
            id: 'save-page-to-project',
            title: '保存当前页面到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M2.5 1A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-8.793a1.5 1.5 0 0 0-.44-1.06l-2.207-2.207A1.5 1.5 0 0 0 11.793 1H2.5zm0 1h8.793a.5.5 0 0 1 .354.146l2.207 2.207a.5.5 0 0 1 .146.354V13.5a.5.5 0 0 1-.5.5H13V9.5A1.5 1.5 0 0 0 11.5 8h-7A1.5 1.5 0 0 0 3 9.5V14h-.5a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5zM4 14V9.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5V14H4z"/></svg>'
        },
        {
            id: 'extract-article-to-project',
            title: '提取文章到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M14 4.5V14a1 1 0 0 1-1 1H4.5a1 1 0 0 1-.707-.293l-2.5-2.5A1 1 0 0 1 1 11.5V2a1 1 0 0 1 1-1h7.5a1 1 0 0 1 .707.293l3.5 3.5A1 1 0 0 1 14 4.5zM10 2v2.5a.5.5 0 0 0 .5.5H13L10 2zM4 7.25a.75.75 0 0 0 0 1.5h8a.75.75 0 0 0 0-1.5H4zm0 3a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5H4z"/></svg>'
        },
        {
            id: 'extract-table-to-project',
            title: '提取表格到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2zm1 3v3h4V5H1zm5 0v3h4V5H6zm5 0v3h4V5h-4zM1 9v5h4V9H1zm5 0v5h4V9H6zm5 0v5h4V9h-4zM1 1a1 1 0 0 0-1 1v2h15V2a1 1 0 0 0-1-1H1z"/></svg>'
        }
        ,
        {
            id: 'extract-faq-to-project',
            title: '提取 FAQ 到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M8 16a6 6 0 1 0-4.906-2.544c-.17.32-.443.648-.896.872-.407.2-.802.314-1.09.38a.5.5 0 0 0-.108.918c.34.188.815.297 1.402.284.655-.015 1.242-.175 1.743-.455A5.978 5.978 0 0 0 8 16zm.93-10.412c-.388-.221-.83-.319-1.352-.319-.883 0-1.53.338-1.905.916a.5.5 0 0 0 .838.545c.189-.291.55-.498 1.067-.498.291 0 .56.052.783.18.212.121.339.285.339.52 0 .268-.173.44-.48.635-.144.091-.309.182-.475.279-.498.29-1.065.687-1.065 1.54V9.5a.5.5 0 0 0 1 0v-.184c0-.323.157-.495.567-.736.14-.082.306-.173.476-.281.447-.284.977-.72.977-1.438 0-.61-.345-1.08-.79-1.333zM8 12a.75.75 0 1 0 0-1.5A.75.75 0 0 0 8 12z"/></svg>'
        },
        {
            id: 'extract-product-to-project',
            title: '提取商品到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 1a.5.5 0 0 0-.447.276L3.82 3.5H1.5A1.5 1.5 0 0 0 0 5v1a2 2 0 0 0 1 1.732V13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5V7.732A2 2 0 0 0 16 6V5a1.5 1.5 0 0 0-1.5-1.5h-2.32l-1.233-2.224A.5.5 0 0 0 10.5 1h-5zM4.82 3l.833-1.5h4.694L11.18 3H4.82zM1.5 4h13a.5.5 0 0 1 .5.5V6a1 1 0 0 1-1 1h-1.5a1.5 1.5 0 0 0-3 0h-3a1.5 1.5 0 0 0-3 0H2A1 1 0 0 1 1 6V4.5a.5.5 0 0 1 .5-.5zm3.5 4a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0zm7 0a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0z"/></svg>'
        },
        {
            id: 'extract-timeline-to-project',
            title: '提取时间线到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M8 3.5a.5.5 0 0 1 .5.5v3.293l2.354 2.353a.5.5 0 0 1-.708.708L7.646 7.854A.5.5 0 0 1 7.5 7.5V4a.5.5 0 0 1 .5-.5z"/><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm0-1A7 7 0 1 1 8 1a7 7 0 0 1 0 14z"/></svg>'
        }
    ];

    let insertAfter = anchor;
    buttonDefinitions.forEach(definition => {
        let button = document.getElementById(definition.id);
        if (!button) {
            button = createToolbarIconButton(definition);
            insertAfter.insertAdjacentElement('afterend', button);
        }
        insertAfter = button;
    });

    elements.savePageToProject = document.getElementById('save-page-to-project');
    elements.extractArticleToProject = document.getElementById('extract-article-to-project');
    elements.extractTableToProject = document.getElementById('extract-table-to-project');
    elements.extractFaqToProject = document.getElementById('extract-faq-to-project');
    elements.extractProductToProject = document.getElementById('extract-product-to-project');
    elements.extractTimelineToProject = document.getElementById('extract-timeline-to-project');
}

function ensureToolbarMenu({
    menuId,
    anchor,
    label,
    title,
    icon
}) {
    if (!anchor?.parentElement) {
        return null;
    }

    let menu = document.getElementById(menuId);
    if (!menu) {
        menu = document.createElement('details');
        menu.id = menuId;
        menu.className = 'toolbar-menu';
        menu.innerHTML = `
            <summary class="toolbar-menu-toggle" title="${title}" aria-label="${title}">
                <span class="toolbar-menu-icon">${icon}</span>
                <span class="toolbar-menu-label">${label}</span>
                <svg class="toolbar-menu-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>
            </summary>
            <div class="toolbar-menu-panel"></div>
        `;
    }

    if (anchor.nextElementSibling !== menu) {
        anchor.insertAdjacentElement('afterend', menu);
    }

    if (!menu.dataset.dismissBound) {
        menu.addEventListener('click', (event) => {
            if (event.target.closest('.toolbar-menu-action')) {
                menu.open = false;
            }
        });
        menu.dataset.dismissBound = 'true';
    }

    return menu;
}

function removeToolbarMenu(menuId) {
    const menu = document.getElementById(menuId);
    if (menu) {
        menu.remove();
    }
}

async function populateMcpContextMenuPanel(panel, { closeMenu } = {}) {
    if (!panel) {
        return;
    }

    const stateResponse = await browser.runtime.sendMessage({ action: 'mcp.getState' }).catch(() => ({ success: false }));
    const servers = stateResponse?.success && Array.isArray(stateResponse.data?.servers)
        ? stateResponse.data.servers.filter((server) => server.enabled !== false)
        : [];

    panel.innerHTML = `
        <div class="toolbar-menu-section">
            <div class="toolbar-menu-section-title">服务</div>
            <select class="toolbar-menu-select" data-role="mcp-context-server" ${servers.length ? '' : 'disabled'}>
                ${servers.length
                    ? servers.map((server, index) => `<option value="${String(server.id).replace(/"/g, '&quot;')}" ${index === 0 ? 'selected' : ''}>${String(server.name || server.id).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</option>`).join('')
                    : '<option value="">当前没有可用服务</option>'}
            </select>
        </div>
        <div class="toolbar-menu-section">
            <button type="button" class="toolbar-menu-action" data-role="mcp-add-resource" ${servers.length ? '' : 'disabled'}>
                <span class="toolbar-menu-action-label">选择资源加入上下文</span>
            </button>
            <button type="button" class="toolbar-menu-action" data-role="mcp-add-prompt" ${servers.length ? '' : 'disabled'}>
                <span class="toolbar-menu-action-label">选择提示词加入上下文</span>
            </button>
            <div class="toolbar-menu-note">加入后会进入当前聊天或深度研究上下文，并随下一次发送一起提交。</div>
        </div>
    `;

    const serverSelect = panel.querySelector('[data-role="mcp-context-server"]');
    const addResourceBtn = panel.querySelector('[data-role="mcp-add-resource"]');
    const addPromptBtn = panel.querySelector('[data-role="mcp-add-prompt"]');

    const chooseMcpItemByPrompt = async (kind) => {
        const serverId = serverSelect?.value || '';
        if (!serverId) {
            showToastUI('请先选择一个 MCP 服务', 'warning');
            return;
        }

        const listAction = kind === 'resource' ? 'mcp.listResources' : 'mcp.listPrompts';
        const readAction = kind === 'resource' ? 'mcp.readResource' : 'mcp.getPrompt';
        const listResponse = await browser.runtime.sendMessage({ action: listAction, serverId, refresh: false });
        if (!listResponse?.success) {
            showToastUI(listResponse?.error || `读取 MCP ${kind === 'resource' ? '资源' : '提示词'}列表失败`, 'error');
            return;
        }

        const items = Array.isArray(listResponse.data) ? listResponse.data : [];
        if (!items.length) {
            showToastUI(`当前服务没有可用的 MCP ${kind === 'resource' ? '资源' : '提示词'}`, 'warning');
            return;
        }

        const displayItems = items.slice(0, 20);
        const promptText = displayItems.map((item, index) => {
            const label = kind === 'resource'
                ? (item.title || item.name || item.uri || `资源 ${index + 1}`)
                : (item.name || item.title || `提示词 ${index + 1}`);
            const suffix = kind === 'resource'
                ? (item.uri ? ` | ${item.uri}` : '')
                : (item.description ? ` | ${item.description}` : '');
            return `${index + 1}. ${label}${suffix}`;
        }).join('\n');
        const answer = window.prompt(
            `选择要加入上下文的 MCP ${kind === 'resource' ? '资源' : '提示词'}编号：\n${promptText}${items.length > displayItems.length ? `\n仅显示前 ${displayItems.length} 项。` : ''}`,
            '1'
        );
        if (answer === null) {
            return;
        }

        const selectedIndex = Number.parseInt(answer, 10) - 1;
        if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= displayItems.length) {
            showToastUI('输入的编号无效', 'warning');
            return;
        }

        const selectedItem = displayItems[selectedIndex];
        const readResponse = await browser.runtime.sendMessage(
            kind === 'resource'
                ? { action: readAction, serverId, uri: selectedItem.uri }
                : { action: readAction, serverId, name: selectedItem.name, arguments: {} }
        );
        if (!readResponse?.success) {
            showToastUI(readResponse?.error || `读取 MCP ${kind === 'resource' ? '资源' : '提示词'}内容失败`, 'error');
            return;
        }

        const record = kind === 'resource'
            ? {
                id: `mcp-resource-${serverId}-${selectedItem.uri}`,
                type: 'mcp_resource',
                title: selectedItem.title || selectedItem.name || selectedItem.uri,
                sourceUrl: '',
                content: readResponse.data?.result || {},
                meta: {
                    serverId,
                    serverName: readResponse.data?.serverName || servers.find((server) => server.id === serverId)?.name || '',
                    uri: selectedItem.uri
                }
            }
            : {
                id: `mcp-prompt-${serverId}-${selectedItem.name}`,
                type: 'mcp_prompt',
                title: selectedItem.name || selectedItem.title || 'MCP 提示词',
                sourceUrl: '',
                content: readResponse.data?.result || {},
                meta: {
                    serverId,
                    serverName: readResponse.data?.serverName || servers.find((server) => server.id === serverId)?.name || '',
                    promptName: selectedItem.name
                }
            };

        addProjectRecordToContext(record);
        if (typeof closeMenu === 'function') {
            closeMenu();
        }
    };

    addResourceBtn?.addEventListener('click', async () => {
        await chooseMcpItemByPrompt('resource');
    });

    addPromptBtn?.addEventListener('click', async () => {
        await chooseMcpItemByPrompt('prompt');
    });
}

function reorderChatToolbar() {
    const toolbar = document.querySelector('.chat-input-toolbar');
    if (!toolbar) {
        return;
    }

    const fixedNodes = [
        elements.chatModelSelection?.closest('.toolbar-selector'),
        elements.chatAgentToolbarSlot,
        toolbar.querySelector('.toolbar-divider'),
        document.getElementById('toolbar-automation-group'),
        document.getElementById('toolbar-project-menu'),
        document.getElementById('toolbar-recorder-menu'),
        document.getElementById('toolbar-mcp-menu')
    ].filter(Boolean);

    const remainingNodes = Array.from(toolbar.children).filter((node) => !fixedNodes.includes(node));
    [...fixedNodes, ...remainingNodes].forEach((node) => {
        toolbar.appendChild(node);
    });
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
        console.warn('[main.js] Failed to read MCP agent preferences:', error);
        return {
            enabled: true,
            allowAllServers: true,
            allowedServerIds: []
        };
    }
}

async function saveMcpAgentPreferences(preferences) {
    await browser.storage.local.set({
        [MCP_AGENT_PREFERENCES_KEY]: {
            enabled: preferences.enabled !== false,
            allowAllServers: preferences.allowAllServers !== false,
            allowedServerIds: Array.isArray(preferences.allowedServerIds)
                ? preferences.allowedServerIds.map((id) => String(id || '').trim()).filter(Boolean)
                : []
        }
    });
    window.dispatchEvent(new CustomEvent('infinpilot:mcp-preferences-changed'));
}

async function ensureChatToolbarMcpMenuLegacy() {
    const toolbar = document.querySelector('.chat-input-toolbar');
    const anchor = document.getElementById('toolbar-recorder-menu')
        || document.getElementById('toolbar-project-menu')
        || document.getElementById('toolbar-automation-group');
    if (!toolbar || !anchor) {
        return;
    }

    const menu = ensureToolbarMenu({
        menuId: 'toolbar-mcp-menu',
        anchor,
        label: 'MCP',
        title: '配置 Agent 可用的 MCP 服务',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 16 16"><path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h2A1.5 1.5 0 0 1 8 3.5v1A1.5 1.5 0 0 1 6.5 6h-2A1.5 1.5 0 0 1 3 4.5v-1Zm5 8A1.5 1.5 0 0 1 9.5 10h2a1.5 1.5 0 0 1 1.5 1.5v1A1.5 1.5 0 0 1 11.5 14h-2A1.5 1.5 0 0 1 8 12.5v-1Zm0-8A1.5 1.5 0 0 1 9.5 2h2A1.5 1.5 0 0 1 13 3.5v1A1.5 1.5 0 0 1 11.5 6h-2A1.5 1.5 0 0 1 8 4.5v-1ZM3.5 10h2A1.5 1.5 0 0 1 7 11.5v1A1.5 1.5 0 0 1 5.5 14h-2A1.5 1.5 0 0 1 2 12.5v-1A1.5 1.5 0 0 1 3.5 10ZM6 4h4M4 10V6m8 4V6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path></svg>'
    });
    const panel = menu?.querySelector('.toolbar-menu-panel');
    if (!panel) {
        return;
    }

    const [prefs, stateResponse] = await Promise.all([
        getMcpAgentPreferences(),
        browser.runtime.sendMessage({ action: 'mcp.getState' }).catch(() => ({ success: false }))
    ]);
    const escapeMenuHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const servers = stateResponse?.success && Array.isArray(stateResponse.data?.servers)
        ? stateResponse.data.servers.filter((server) => server.enabled !== false)
        : [];

    const selectedServerIds = prefs.allowAllServers !== false
        ? prefs.allowedServerIds
        : prefs.allowedServerIds;
    const effectiveCheckedIds = prefs.allowAllServers !== false
        ? servers.map((server) => server.id)
        : selectedServerIds;

    panel.innerHTML = `
        <div class="toolbar-menu-section">
            <label class="toolbar-menu-switch">
                <input type="checkbox" id="toolbar-mcp-enabled" ${prefs.enabled ? 'checked' : ''}>
                <span>允许 Agent 使用 MCP</span>
            </label>
        </div>
            <div class="toolbar-menu-section">
            <div class="toolbar-menu-section-title">可用服务</div>
            <div class="toolbar-menu-checklist" id="toolbar-mcp-server-list">
                ${servers.length ? servers.map((server) => `
                    <label class="toolbar-menu-check">
                        <input type="checkbox" value="${escapeMenuHtml(server.id)}" ${effectiveCheckedIds.includes(server.id) ? 'checked' : ''} ${prefs.enabled ? '' : 'disabled'}>
                        <span>${escapeMenuHtml(server.name)}</span>
                    </label>
                `).join('') : '<div class="toolbar-menu-note">当前没有已启用的 MCP 服务</div>'}
            </div>
            <div class="toolbar-menu-note">勾选需要开放给 Agent 的 MCP 服务；取消全部勾选会禁止使用任何 MCP 服务。</div>
        </div>
    `;

    const enabledInput = panel.querySelector('#toolbar-mcp-enabled');
    const serverInputs = Array.from(panel.querySelectorAll('#toolbar-mcp-server-list input[type="checkbox"]'));

    const syncDisabledState = () => {
        serverInputs.forEach((input) => {
            input.disabled = !enabledInput.checked;
        });
    };

    enabledInput?.addEventListener('change', async () => {
        const nextPrefs = {
            enabled: enabledInput.checked,
            allowAllServers: prefs.allowAllServers !== false,
            allowedServerIds: serverInputs.filter((input) => input.checked).map((input) => input.value)
        };
        syncDisabledState();
        await saveMcpAgentPreferences(nextPrefs);
    });

    serverInputs.forEach((input) => {
        input.addEventListener('change', async () => {
            const checkedIds = serverInputs.filter((node) => node.checked).map((node) => node.value);
            await saveMcpAgentPreferences({
                enabled: enabledInput.checked,
                allowAllServers: checkedIds.length === serverInputs.length,
                allowedServerIds: checkedIds
            });
        });
    });

    syncDisabledState();
    reorderChatToolbar();
}

function ensureChatToolbarProjectButtons() {
    if (
        elements.savePageToProject &&
        elements.extractArticleToProject &&
        elements.extractTableToProject &&
        elements.extractFaqToProject &&
        elements.extractProductToProject &&
        elements.extractTimelineToProject
    ) {
        return;
    }

    const toolbar = document.querySelector('.chat-input-toolbar');
    const anchor = elements.fetchPageContent;
    if (!toolbar || !anchor) {
        return;
    }

    const menu = ensureToolbarMenu({
        menuId: 'toolbar-project-menu',
        anchor,
        label: '项目',
        title: '保存或提取到项目',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 16 16"><path d="M2.5 1.75h5.293a1 1 0 0 1 .707.293l1.457 1.457a1 1 0 0 0 .707.293H13.5A1.75 1.75 0 0 1 15.25 5.5v6A1.75 1.75 0 0 1 13.5 13.25h-11A1.75 1.75 0 0 1 .75 11.5v-8A1.75 1.75 0 0 1 2.5 1.75Z" stroke="currentColor" stroke-width="1.2"></path></svg>'
    });
    const panel = menu?.querySelector('.toolbar-menu-panel');
    if (!panel) {
        return;
    }

    const buttonDefinitions = [
        {
            id: 'save-page-to-project',
            label: '保存当前页',
            title: '保存当前页面到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M2.5 1A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-8.793a1.5 1.5 0 0 0-.44-1.06l-2.207-2.207A1.5 1.5 0 0 0 11.793 1H2.5zm0 1h8.793a.5.5 0 0 1 .354.146l2.207 2.207a.5.5 0 0 1 .146.354V13.5a.5.5 0 0 1-.5.5H13V9.5A1.5 1.5 0 0 0 11.5 8h-7A1.5 1.5 0 0 0 3 9.5V14h-.5a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5zM4 14V9.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5V14H4z"/></svg>'
        },
        {
            id: 'extract-article-to-project',
            label: '提取文章',
            title: '提取文章到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M14 4.5V14a1 1 0 0 1-1 1H4.5a1 1 0 0 1-.707-.293l-2.5-2.5A1 1 0 0 1 1 11.5V2a1 1 0 0 1 1-1h7.5a1 1 0 0 1 .707.293l3.5 3.5A1 1 0 0 1 14 4.5zM10 2v2.5a.5.5 0 0 0 .5.5H13L10 2zM4 7.25a.75.75 0 0 0 0 1.5h8a.75.75 0 0 0 0-1.5H4zm0 3a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5H4z"/></svg>'
        },
        {
            id: 'extract-table-to-project',
            label: '提取表格',
            title: '提取表格到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2zm1 3v3h4V5H1zm5 0v3h4V5H6zm5 0v3h4V5h-4zM1 9v5h4V9H1zm5 0v5h4V9H6zm5 0v5h4V9h-4zM1 1a1 1 0 0 0-1 1v2h15V2a1 1 0 0 0-1-1H1z"/></svg>'
        },
        {
            id: 'extract-faq-to-project',
            label: '提取 FAQ',
            title: '提取 FAQ 到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M8 16a6 6 0 1 0-4.906-2.544c-.17.32-.443.648-.896.872-.407.2-.802.314-1.09.38a.5.5 0 0 0-.108.918c.34.188.815.297 1.402.284.655-.015 1.242-.175 1.743-.455A5.978 5.978 0 0 0 8 16zm.93-10.412c-.388-.221-.83-.319-1.352-.319-.883 0-1.53.338-1.905.916a.5.5 0 0 0 .838.545c.189-.291.55-.498 1.067-.498.291 0 .56.052.783.18.212.121.339.285.339.52 0 .268-.173.44-.48.635-.144.091-.309.182-.475.279-.498.29-1.065.687-1.065 1.54V9.5a.5.5 0 0 0 1 0v-.184c0-.323.157-.495.567-.736.14-.082.306-.173.476-.281.447-.284.977-.72.977-1.438 0-.61-.345-1.08-.79-1.333zM8 12a.75.75 0 1 0 0-1.5A.75.75 0 0 0 8 12z"/></svg>'
        },
        {
            id: 'extract-product-to-project',
            label: '提取商品',
            title: '提取商品到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 1a.5.5 0 0 0-.447.276L3.82 3.5H1.5A1.5 1.5 0 0 0 0 5v1a2 2 0 0 0 1 1.732V13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5V7.732A2 2 0 0 0 16 6V5a1.5 1.5 0 0 0-1.5-1.5h-2.32l-1.233-2.224A.5.5 0 0 0 10.5 1h-5zM4.82 3l.833-1.5h4.694L11.18 3H4.82zM1.5 4h13a.5.5 0 0 1 .5.5V6a1 1 0 0 1-1 1h-1.5a1.5 1.5 0 0 0-3 0h-3a1.5 1.5 0 0 0-3 0H2A1 1 0 0 1 1 6V4.5a.5.5 0 0 1 .5-.5zm3.5 4a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0zm7 0a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0z"/></svg>'
        },
        {
            id: 'extract-timeline-to-project',
            label: '提取时间线',
            title: '提取时间线到项目',
            svgPath: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M8 3.5a.5.5 0 0 1 .5.5v3.293l2.354 2.353a.5.5 0 0 1-.708.708L7.646 7.854A.5.5 0 0 1 7.5 7.5V4a.5.5 0 0 1 .5-.5z"/><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm0-1A7 7 0 1 1 8 1a7 7 0 0 1 0 14z"/></svg>'
        }
    ];

    buttonDefinitions.forEach((definition) => {
        let button = document.getElementById(definition.id);
        if (!button) {
            button = createToolbarIconButton(definition);
            const text = document.createElement('span');
            text.className = 'toolbar-menu-action-label';
            text.textContent = definition.label;
            button.appendChild(text);
        }
        if (button.parentElement !== panel) {
            panel.appendChild(button);
        }
    });

    reorderChatToolbar();

    elements.savePageToProject = document.getElementById('save-page-to-project');
    elements.extractArticleToProject = document.getElementById('extract-article-to-project');
    elements.extractTableToProject = document.getElementById('extract-table-to-project');
    elements.extractFaqToProject = document.getElementById('extract-faq-to-project');
    elements.extractProductToProject = document.getElementById('extract-product-to-project');
    elements.extractTimelineToProject = document.getElementById('extract-timeline-to-project');
}

function normalizeProjectUILabels() {
    const setText = (selector, text) => {
        const node = document.querySelector(selector);
        if (node) {
            node.textContent = text;
        }
    };

    const setAttribute = (selector, attribute, value) => {
        const node = document.querySelector(selector);
        if (node) {
            node.setAttribute(attribute, value);
        }
    };

    setText('.chat-agent-selector label[for="chat-agent-selection"]', '助手');
    setText('.chat-db-selector label[for="db-selector"]', '知识库');
    setText('.chat-project-selector label[for="project-selector"]', '项目');
    setText('.project-summary-label', '当前项目');
    setText('.project-summary-refresh', '刷新');

    setAttribute('#chat-agent-selection', 'aria-label', '选择助手');
    setAttribute('#db-selector', 'aria-label', '选择知识库');
    setAttribute('#project-selector', 'aria-label', '选择项目');

    if (elements.projectCreateBtn) {
        elements.projectCreateBtn.title = '新建项目';
        elements.projectCreateBtn.setAttribute('aria-label', '新建项目');
    }

    if (elements.projectSummaryTitle && !state.currentProjectId) {
        elements.projectSummaryTitle.textContent = '未选择项目';
    }
    if (elements.projectSummaryMeta && !state.currentProjectId) {
        elements.projectSummaryMeta.textContent = '项目素材 0 项';
    }

    const defaultDbOption = elements.dbSelector?.querySelector('option[value="null"]');
    if (defaultDbOption) {
        defaultDbOption.textContent = '不使用知识库';
    }
}

function relocateChatAgentSelector() {
    const slot = elements.chatAgentToolbarSlot;
    const selector = document.querySelector('.chat-agent-selector');
    if (!slot || !selector || slot.contains(selector)) {
        return;
    }
    selector.classList.add('toolbar-agent-selector');
    slot.appendChild(selector);
}

function updateProjectActionButtonsState() {
    const buttons = [
        elements.savePageToProject,
        elements.extractArticleToProject,
        elements.extractTableToProject,
        elements.extractFaqToProject,
        elements.extractProductToProject,
        elements.extractTimelineToProject
    ].filter(Boolean);

    const hasProject = Boolean(state.currentProjectId);
    buttons.forEach(button => {
        button.disabled = !hasProject;
        button.classList.toggle('is-disabled', !hasProject);
    });
}

async function ensureCurrentProjectSelection(actionLabel) {
    if (state.currentProjectId) {
        return state.currentProjectId;
    }

    showToastUI(`请先选择项目再${actionLabel}`, 'warning');
    return null;
}

async function requestProjectAction(message) {
    const response = await browser.runtime.sendMessage(message);
    if (!response?.success) {
        throw new Error(response?.error || '项目操作失败');
    }
    return response;
}

function buildProjectExtractTitleLegacy(pattern, response) {
    if (pattern === 'article') {
        return response.data?.title || response.title || '页面文章提取';
    }
    if (pattern === 'table') {
        return response.title ? `${response.title} 表格提取` : '页面表格提取';
    }
    return response.title || '页面提取';
}
// --- Initialization ---
function buildProjectExtractTitle(pattern, response) {
    if (pattern === 'article') {
        return response.data?.title || response.title || '页面文章提取';
    }
    if (pattern === 'table') {
        return response.title ? `${response.title} 表格提取` : '页面表格提取';
    }
    if (pattern === 'faq') {
        return response.title ? `${response.title} FAQ` : '页面 FAQ 提取';
    }
    if (pattern === 'product') {
        return response.data?.name || response.title || '页面商品提取';
    }
    if (pattern === 'timeline') {
        return response.title ? `${response.title} 时间线` : '页面时间线提取';
    }
    return response.title || '页面提取';
}

// --- Initialization ---
async function init() {
    console.log("Infinpilot Initializing...");

    // Request theme early
    requestThemeFromContentScript();

    // Initialize ModelManager first
    if (window.ModelManager?.instance) {
        try {
            await window.ModelManager.instance.initialize();
            console.log('[main.js] ModelManager initialized successfully');
        } catch (error) {
            console.error('[main.js] Failed to initialize ModelManager:', error);
        }
    } else {
        console.error('[main.js] ModelManager not available');
    }

    // Ensure delete-confirm dialog exists before wiring events
    ensureDeleteConfirmDialogStructure();

    // Load settings (app, agents) - this also loads language and applies initial theme/translations
    loadAppSettings(
        state, elements,
        () => updateConnectionIndicator(state.isConnected, elements, currentTranslations), // Pass updateConnectionIndicator directly
        loadAndApplyTranslations, // Pass translation loader
        (isDark) => applyTheme(isDark, elements) // Pass applyTheme
    );
    
    // 从 storage 加载保存的主题设置
    const savedDarkMode = localStorage.getItem('infinpilot-darkMode');
    if (savedDarkMode !== null) {
        state.darkMode = savedDarkMode === 'true';
        applyTheme(state.darkMode, elements);
        updateMermaidTheme(state.darkMode, rerenderAllMermaidChartsUI);
        console.log("Theme preference loaded from localStorage.");
    }
    loadAgents(
        state,
        () => updateAgentsListUI(state, elements, currentTranslations, autoSaveAgentSettings, showDeleteConfirmDialogUI, switchAgentAndUpdateState), // Pass agent UI update. autoSaveAgentSettings here is the main.js wrapper.
        () => updateAgentSelectionInChat(state, elements, currentTranslations), // Pass chat dropdown update with translations
        () => saveCurrentAgentId(state), // Pass save current ID
        currentTranslations // Pass translations for default agent name
    );

    // Load draggable button position
    loadButtonPosition(elements);
    if (elements.themeToggleBtnSettings) {
        setTimeout(() => {
            makeDraggable(elements.themeToggleBtnSettings, () => toggleThemeAndUpdate(state, elements, rerenderAllMermaidChartsUI)); // Pass toggleTheme callback
        }, 100);
    }

    // Setup core features
    await initModelSelection(state, elements); // Populate model dropdowns (now async)
    ensureChatToolbarProjectButtons();
    await ensureChatToolbarMcpMenu();
    await ensureChatToolbarMcpContextMenu();
    await ensureProjectSummaryMcpContextMenu();
    normalizeProjectUILabels();
    relocateChatAgentSelector();
    ensureProjectSummaryBrowseButton();
    ensureProjectSummaryPublicButton();
    ensureProjectSummaryTemplatesButton();
    ensureProjectBrowserModal();
    ensureProjectTemplateBrowserModalV2();

    // 确保翻译已加载后再初始化划词助手设置和快捷操作设置
    setTimeout(async () => {
        console.log('[main.js] Initializing text selection helper with translations:', currentTranslations);
        await initTextSelectionHelperSettings(elements, currentTranslations, showToastUI); // Initialize text selection helper settings

        console.log('[main.js] Initializing quick actions manager...');
        // 先初始化快捷操作管理器
        await QuickActionsManager.initQuickActionsManager();

        // 设置全局快捷操作相关函数
        setupQuickActionsGlobals();

        console.log('[main.js] Initializing quick actions settings with translations:', currentTranslations);
        await initQuickActionsSettings(elements, currentTranslations); // Initialize quick actions settings

        // Render any initially pinned actions
        renderPinnedActionButtons();

        // 初始化欢迎消息（如果聊天区域为空）
        if (elements.chatMessages && elements.chatMessages.children.length === 0) {
            // 确保快捷操作管理器已经初始化后再创建欢迎消息
            const welcomeMessage = await createWelcomeMessage(currentTranslations);
            elements.chatMessages.appendChild(welcomeMessage);
            console.log('[main.js] Initial welcome message created with quick actions');
        }
    }, 100); // 给翻译加载一些时间
    setupEventListeners(); // Setup all event listeners
    ensureCollectiveResearchToggle();
    setupImagePaste(elements, (file) => handleImageFile(file, state, updateImagesPreviewUI)); // Setup paste
    setupAutoresizeTextarea(elements); // Setup textarea resize

    // Load automation settings
    try {
        const stored = await browser.storage.sync.get(['automationEnabled','automationMaxToolSteps']);
        if (stored && typeof stored.automationEnabled === 'boolean') {
            state.automationEnabled = stored.automationEnabled;
        }
        if (stored && typeof stored.automationMaxToolSteps === 'number') {
            state.automationMaxToolSteps = stored.automationMaxToolSteps;
        }
    } catch (e) {
        console.warn('[main.js] Failed to load automation settings:', e);
    }
    updateAutomationToggleUI();

    // Sync body class with automation state on load
    document.body.classList.toggle('automation-mode', state.automationEnabled);
    syncResearchModeButtons();

    await projectService.initialize();
    await syncProjectStateFromService();
    setupProjectEventBridge();
    initAutomationRecorder({
        showToast: showToastUI,
        ensureCurrentProjectSelection,
        projectService,
        syncProjectState: syncProjectStateFromService,
        reorderToolbar: reorderChatToolbar
    });

    // Initial UI updates
    updateDbSelector();
    // 避免尚未判定连接状态时显示“未连接”造成闪烁
    if (state.hasDeterminedConnection) {
        updateConnectionIndicator(state.isConnected, elements, currentTranslations);
    }
    updateContextStatus('contextStatusNone', {}, elements, currentTranslations); // Initial context status

    // Request page content after setup
    requestPageContent();

    // Mermaid Initialization (ensure library is loaded)
    if (typeof mermaid !== 'undefined') {
        try {
            mermaid.initialize({
                startOnLoad: false,
                theme: state.darkMode ? 'dark' : 'default',
                logLevel: 'error'
            });
            console.log('Mermaid initialized.');

            // Fix for Mermaid charts not re-rendering on panel open.
            // We call the same function used for theme toggling, which correctly re-renders existing charts.
            setTimeout(() => {
                rerenderAllMermaidCharts(elements);
            }, 250); // Delay to ensure chat history and other content is painted.

        } catch (error) {
            console.error('Mermaid initialization failed:', error);
        }
    } else {
        console.warn('Mermaid library not found during init.');
    }

    // Set initial visibility for theme button - ensure it's hidden on chat tab
    const initialTab = document.querySelector('.footer-tab.active')?.dataset.tab || 'chat';
    setThemeButtonVisibility(initialTab, elements);

    // Additional safety check to ensure button is hidden on chat tab
    if (initialTab === 'chat' && elements.themeToggleBtnSettings) {
        elements.themeToggleBtnSettings.style.display = 'none';
        elements.themeToggleBtnSettings.style.visibility = 'hidden';
    }

    // Global Exposures for API module callbacks
    // These wrappers ensure that the live `isUserNearBottom` from main.js is used.

    // Wrapper for ui.js's updateStreamingMessage
    window.updateStreamingMessage = (messageElement, content) => {
        // `elements` is live from main.js's scope
        // Determine if scroll should happen based on the new logic
        const shouldScroll = state.isStreaming ? !state.userScrolledUpDuringStream : isUserNearBottom;
        uiUpdateStreamingMessage(messageElement, content, shouldScroll, elements); // Pass the decision
    };

    // Wrapper for ui.js's finalizeBotMessage
    window.finalizeBotMessage = (messageElement, finalContent, extraFooterHtml = '') => {
        // `elements`, `addCopyButtonToCodeBlockUI`,
        // `addMessageActionButtonsUI`, `restoreSendButtonAndInputUI`
        // are all live from main.js's scope
        const shouldScroll = state.isStreaming ? !state.userScrolledUpDuringStream : isUserNearBottom; // Similar logic for finalize
        uiFinalizeBotMessage(messageElement, finalContent, addCopyButtonToCodeBlockUI, addMessageActionButtonsUI, restoreSendButtonAndInputUI, shouldScroll, elements, extraFooterHtml);
    };

    // 确保在所有初始化完成后，输入框获得焦点
    if (elements.userInput) {
        setTimeout(() => elements.userInput.focus(), 150); // 增加延迟以确保DOM完全准备好
    }

    // Expose the handler on the window object so ui.js can call it
    window.handleRemoveSentTabContext = (messageId, tabId) => {
        handleRemoveSentTabContextAction(messageId, tabId, state);
    };

    // Expose text selection helper functions to global scope
    window.isTextSelectionHelperEnabled = isTextSelectionHelperEnabled;

    // Expose state object to global scope for settings functions
    window.state = state;
    window.InfinPilotProjectTools = {
        savePageToProject: handleSavePageToProject,
        extractToProject: handleExtractPatternToProject,
        openProjectPreview,
        closeProjectPreview,
        addRecordToContext: addProjectRecordToContext,
        openProjectTemplateBrowser,
        createTemplateFromPreviewRecord,
        runTemplateFromPreviewRecord
    };

    window.addEventListener('infinpilot:mcp-changed', () => {
        void ensureChatToolbarMcpMenu();
        void ensureChatToolbarMcpContextMenu();
        void ensureProjectSummaryMcpContextMenu();
    });

    window.addEventListener('infinpilot:mcp-preferences-changed', () => {
        void ensureChatToolbarMcpMenu();
        void ensureChatToolbarMcpContextMenu();
        void ensureProjectSummaryMcpContextMenu();
    });

    // Render all lucide icons
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    console.log("Infinpilot Initialized.");
}

let projectEventBridgeBound = false;

function setupProjectEventBridge() {
    if (projectEventBridgeBound) {
        return;
    }

    const syncHandler = () => {
        void syncProjectStateFromService();
    };

    document.addEventListener('infinpilot:project-changed', syncHandler);
    document.addEventListener('infinpilot:projects-updated', syncHandler);
    document.addEventListener('infinpilot:project-items-updated', syncHandler);
    window.addEventListener('infinpilot:editor-current-file-changed', syncHandler);

    projectEventBridgeBound = true;
}

async function syncProjectStateFromService() {
    const [projects, currentProject, summary, templates, runs] = await Promise.all([
        projectService.listProjects(),
        projectService.getCurrentProject(),
        projectService.getProjectSummary(null, 3),
        projectService.listProjectTemplates(),
        projectService.listProjectRuns(null, 6)
    ]);

    state.currentProjectId = currentProject?.id || null;
    state.currentProject = currentProject;
    state.currentProjectSummary = summary;
    state.currentProjectTemplates = templates.map(template => ({
        ...template,
        entityType: 'template'
    }));
    state.currentProjectRuns = runs.map(run => ({
        ...run,
        entityType: 'run',
        templateName: templates.find(template => template.id === run.templateId)?.name || ''
    }));

    renderProjectSelectors(projects, state.currentProjectId);
    renderProjectSummary(summary);
    normalizeProjectUILabels();
    updateProjectActionButtonsState();
    if (elements.projectTemplateBrowserModal?.classList.contains('is-open')) {
        renderProjectTemplateBrowserContent();
    }
    await updateEditorProjectFileStatus();
}

function renderProjectSelectors(projects, currentProjectId) {
    const selectors = [elements.projectSelector, elements.editorProjectSelector].filter(Boolean);
    selectors.forEach(select => {
        select.innerHTML = '';
        projects.forEach(project => {
            const option = document.createElement('option');
            option.value = project.id;
            option.textContent = project.name;
            select.appendChild(option);
        });
        select.value = currentProjectId || projects[0]?.id || '';
        select.disabled = projects.length === 0;
    });
}

function getProjectItemTypeLabelLegacy(type) {
    const labels = {
        editor_file_ref: '文件',
        page_snapshot: '页面',
        page_extract: '提取',
        screenshot: '截图',
        note: '笔记',
        automation_recording: '录制',
        workflow_result: '工作流'
    };
    return labels[type] || '素材';
}

function getProjectItemTypeLabelCurrent(type) {
    const labels = {
        editor_file_ref: '文件',
        page_snapshot: '页面',
        page_extract: '提取',
        screenshot: '截图',
        note: '笔记',
        automation_recording: '录制',
        workflow_result: '工作流'
    };
    return labels[type] || '素材';
}

function renderProjectSummaryLegacyEarly(summary) {
    if (!elements.projectSummaryTitle || !elements.projectSummaryMeta || !elements.projectSummaryItems) {
        return;
    }

    if (!summary?.project) {
        elements.projectSummaryTitle.textContent = '未选择项目';
        elements.projectSummaryMeta.textContent = '项目素材 0 个';
        elements.projectSummaryItems.innerHTML = '<span class="project-summary-empty">还没有可展示的项目素材</span>';
        return;
    }

    elements.projectSummaryTitle.textContent = summary.project.name;

    const typeFragments = Object.entries(summary.typeCounts || {})
        .slice(0, 3)
        .map(([type, count]) => `${getProjectItemTypeLabel(type)} ${count}`);
    elements.projectSummaryMeta.textContent = typeFragments.length > 0
        ? `项目素材 ${summary.itemCount} 个 · ${typeFragments.join(' · ')}`
        : `项目素材 ${summary.itemCount} 个`;

    elements.projectSummaryItems.innerHTML = '';
    if (!summary.recentItems || summary.recentItems.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'project-summary-empty';
        empty.textContent = '当前项目还没有素材';
        elements.projectSummaryItems.appendChild(empty);
        return;
    }

    summary.recentItems.forEach(item => {
        const chip = document.createElement('span');
        chip.className = 'project-summary-item';

        const type = document.createElement('span');
        type.className = 'project-summary-item-type';
        type.textContent = getProjectItemTypeLabel(item.type);

        const title = document.createElement('span');
        title.textContent = item.title;

        chip.appendChild(type);
        chip.appendChild(title);
        elements.projectSummaryItems.appendChild(chip);
    });
}

function renderProjectSummary(summary) {
    if (!elements.projectSummaryTitle || !elements.projectSummaryMeta || !elements.projectSummaryItems) {
        return;
    }

    if (!summary?.project) {
        elements.projectSummaryTitle.textContent = '未选择项目';
        elements.projectSummaryMeta.textContent = '项目素材 0 项';
        elements.projectSummaryItems.innerHTML = '<span class="project-summary-empty">还没有可展示的项目素材</span>';
        return;
    }

    elements.projectSummaryTitle.textContent = summary.project.name;

    const typeFragments = Object.entries(summary.typeCounts || {})
        .slice(0, 3)
        .map(([type, count]) => `${getProjectItemTypeLabel(type)} ${count}`);
    elements.projectSummaryMeta.textContent = typeFragments.length > 0
        ? `项目素材 ${summary.itemCount} 项 · ${typeFragments.join(' · ')}`
        : `项目素材 ${summary.itemCount} 项`;

    elements.projectSummaryItems.innerHTML = '';
    if (!summary.recentItems || summary.recentItems.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'project-summary-empty';
        empty.textContent = '当前项目还没有素材';
        elements.projectSummaryItems.appendChild(empty);
        return;
    }

    summary.recentItems.forEach(item => {
        const chip = document.createElement('span');
        chip.className = 'project-summary-item';

        const type = document.createElement('span');
        type.className = 'project-summary-item-type';
        type.textContent = getProjectItemTypeLabel(item.type);

        const title = document.createElement('span');
        title.textContent = item.title;

        chip.appendChild(type);
        chip.appendChild(title);
        elements.projectSummaryItems.appendChild(chip);
    });
}

function getProjectItemTypeLabel(type) {
    const labels = {
        editor_file_ref: '文件',
        page_snapshot: '页面',
        page_extract: '提取',
        screenshot: '截图',
        note: '笔记',
        automation_recording: '录制',
        workflow_result: '工作流',
        workflow_template: '模板',
        workflow_run: '运行',
        mcp_resource: 'MCP 资源',
        mcp_prompt: 'MCP 提示词'
    };
    return labels[type] || '素材';
}

function getExecutionModeLabelLegacy(mode) {
    return mode === 'parallel' ? '并行' : '前台';
}

function escapePreviewHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stringifyPreviewValue(value) {
    if (typeof value === 'string') {
        return value;
    }
    return JSON.stringify(value ?? {}, null, 2);
}

function buildPreviewTextBlock(title, value) {
    const text = stringifyPreviewValue(value);
    if (!text) {
        return '';
    }
    return `
        <section class="project-preview-section">
            <div class="project-preview-section-title">${escapePreviewHtml(title)}</div>
            <pre class="project-preview-code">${escapePreviewHtml(text)}</pre>
        </section>
    `;
}

function extractMcpResourceDisplay(result) {
    if (result && Array.isArray(result.contents) && result.contents.length > 0) {
        const firstText = result.contents
            .map((entry) => entry?.text || entry?.data || entry?.blob || entry?.json)
            .find((entry) => entry !== undefined && entry !== null);
        if (firstText !== undefined) {
            return firstText;
        }
    }
    return result;
}

function renderProjectPreviewBodyLegacyEarly(item) {
    if (!elements.projectPreviewBody) {
        return;
    }

    if (item?.type === 'mcp_resource') {
        const meta = item.meta || {};
        const content = extractMcpResourceDisplay(item.content);
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>服务</span><strong>${escapePreviewHtml(meta.serverName || meta.serverId || '-')}</strong></div>
                <div class="project-preview-kv"><span>URI</span><strong>${escapePreviewHtml(meta.uri || '-')}</strong></div>
            </section>
            ${buildPreviewTextBlock('资源内容', content)}
        `;
        return;
    }

    if (item?.type === 'mcp_prompt') {
        const meta = item.meta || {};
        const content = item.content || {};
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>服务</span><strong>${escapePreviewHtml(meta.serverName || meta.serverId || '-')}</strong></div>
                <div class="project-preview-kv"><span>提示词</span><strong>${escapePreviewHtml(meta.promptName || item.title || '-')}</strong></div>
            </section>
            ${buildPreviewTextBlock('提示词内容', content)}
        `;
        return;
    }

    elements.projectPreviewBody.textContent = '';
    renderProjectPreviewBody(item);
}

function ensureProjectSummaryBrowseButton() {
    if (elements.projectSummaryBrowseBtn) {
        return elements.projectSummaryBrowseBtn;
    }

    const refreshButton = elements.projectRefreshBtn;
    if (!refreshButton?.parentElement) {
        return null;
    }

    const button = document.createElement('button');
    button.id = 'project-browse-btn';
    button.type = 'button';
    button.className = 'project-summary-browse';
    button.textContent = '全部';
    refreshButton.insertAdjacentElement('beforebegin', button);
    elements.projectSummaryBrowseBtn = button;
    return button;
}

function ensureProjectSummaryTemplatesButton() {
    if (elements.projectSummaryTemplatesBtn) {
        return elements.projectSummaryTemplatesBtn;
    }

    const publicButton = ensureProjectSummaryPublicButton();
    const anchor = publicButton || ensureProjectSummaryBrowseButton() || elements.projectRefreshBtn;
    if (!anchor?.parentElement) {
        return null;
    }

    const button = document.createElement('button');
    button.id = 'project-templates-btn';
    button.type = 'button';
    button.className = 'project-summary-browse';
    button.textContent = '模板';
    anchor.insertAdjacentElement('beforebegin', button);
    elements.projectSummaryTemplatesBtn = button;
    return button;
}

function ensureProjectSummaryPublicButton() {
    if (elements.projectSummaryPublicBtn) {
        return elements.projectSummaryPublicBtn;
    }

    const browseButton = ensureProjectSummaryBrowseButton();
    const anchor = browseButton || elements.projectRefreshBtn;
    if (!anchor?.parentElement) {
        return null;
    }

    const button = document.createElement('button');
    button.id = 'project-public-btn';
    button.type = 'button';
    button.className = 'project-summary-browse';
    button.textContent = '公共';
    anchor.insertAdjacentElement('beforebegin', button);
    elements.projectSummaryPublicBtn = button;
    return button;
}

async function ensureProjectSummaryMcpContextMenu() {
    removeToolbarMenu('project-summary-mcp-context-menu');
    return;
    const anchor = ensureProjectSummaryTemplatesButton()
        || ensureProjectSummaryPublicButton()
        || ensureProjectSummaryBrowseButton()
        || elements.projectRefreshBtn;
    if (!anchor) {
        return;
    }

    const menu = ensureToolbarMenu({
        menuId: 'project-summary-mcp-context-menu',
        anchor,
        label: 'MCP上下文',
        title: '选择 MCP 资源或提示词加入当前上下文',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 16 16"><path d="M2.75 3.25A1.5 1.5 0 0 1 4.25 1.75h2.5a1.5 1.5 0 0 1 1.5 1.5v2.5a1.5 1.5 0 0 1-1.5 1.5h-2.5a1.5 1.5 0 0 1-1.5-1.5v-2.5Zm6 0a1.5 1.5 0 0 1 1.5-1.5h1.5a1.5 1.5 0 0 1 1.5 1.5v1.5a1.5 1.5 0 0 1-1.5 1.5h-1.5a1.5 1.5 0 0 1-1.5-1.5v-1.5Zm-6 7.5a1.5 1.5 0 0 1 1.5-1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v1a2.5 2.5 0 0 1-2.5 2.5h-5a2.5 2.5 0 0 1-2.5-2.5v-1Z" stroke="currentColor" stroke-width="1.2"></path></svg>'
    });
    if (!menu) {
        return;
    }

    menu.classList.add('project-summary-menu');
    const panel = menu.querySelector('.toolbar-menu-panel');
    await populateMcpContextMenuPanel(panel, {
        closeMenu: () => {
            menu.open = false;
        }
    });
}

function ensureProjectBrowserModalLegacy() {
    if (elements.projectBrowserModal) {
        return elements.projectBrowserModal;
    }

    const modal = document.createElement('div');
    modal.id = 'project-browser-modal';
    modal.className = 'project-browser-modal';
    modal.innerHTML = `
        <div class="project-browser-dialog" role="dialog" aria-modal="true" aria-labelledby="project-browser-title">
            <div class="project-browser-header">
                <h3 id="project-browser-title">项目素材</h3>
                <button type="button" class="project-preview-close" data-close-project-browser aria-label="关闭素材列表">×</button>
            </div>
            <div class="project-browser-list" id="project-browser-list"></div>
        </div>
    `;

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('[data-close-project-browser]')) {
            closeProjectBrowser();
        }
    });

    document.body.appendChild(modal);
    elements.projectBrowserModal = modal;
    elements.projectBrowserList = modal.querySelector('#project-browser-list');
    return modal;
}

function ensureProjectTemplateBrowserModal() {
    if (elements.projectTemplateBrowserModal) {
        return elements.projectTemplateBrowserModal;
    }

    const modal = document.createElement('div');
    modal.id = 'project-template-browser-modal';
    modal.className = 'project-browser-modal';
    modal.innerHTML = `
        <div class="project-browser-dialog project-template-browser-dialog" role="dialog" aria-modal="true" aria-labelledby="project-template-browser-title">
            <div class="project-browser-header">
                <h3 id="project-template-browser-title">任务模板</h3>
                <button type="button" class="project-preview-close" data-close-project-template-browser aria-label="关闭模板列表">×</button>
            </div>
            <div class="project-template-section">
                <div class="project-template-section-title">模板</div>
                <div class="project-browser-list" id="project-template-list"></div>
            </div>
            <div class="project-template-section">
                <div class="project-template-section-title">最近运行</div>
                <div class="project-browser-list project-run-list" id="project-run-list"></div>
            </div>
        </div>
    `;

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('[data-close-project-template-browser]')) {
            closeProjectTemplateBrowser();
        }
    });

    document.body.appendChild(modal);
    elements.projectTemplateBrowserModal = modal;
    elements.projectTemplateList = modal.querySelector('#project-template-list');
    elements.projectRunList = modal.querySelector('#project-run-list');
    return modal;
}

function ensureProjectPreviewModal() {
    if (elements.projectPreviewModal) {
        return elements.projectPreviewModal;
    }

    const modal = document.createElement('div');
    modal.id = 'project-preview-modal';
    modal.className = 'project-preview-modal';
    modal.innerHTML = `
        <div class="project-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="project-preview-title">
            <div class="project-preview-header">
                <div class="project-preview-heading">
                    <span class="project-preview-type" id="project-preview-type"></span>
                    <h3 id="project-preview-title">项目素材</h3>
                    <div class="project-preview-meta" id="project-preview-meta"></div>
                </div>
                <button type="button" class="project-preview-close" data-close-project-preview aria-label="关闭预览">×</button>
            </div>
            <div class="project-preview-body" id="project-preview-body"></div>
        </div>
    `;

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('[data-close-project-preview]')) {
            closeProjectPreview();
        }
    });

    document.body.appendChild(modal);
    elements.projectPreviewModal = modal;
    elements.projectPreviewType = modal.querySelector('#project-preview-type');
    elements.projectPreviewTitle = modal.querySelector('#project-preview-title');
    elements.projectPreviewMeta = modal.querySelector('#project-preview-meta');
    elements.projectPreviewBody = modal.querySelector('#project-preview-body');
    return modal;
}

function ensureProjectTemplateBrowserModalV2() {
    if (elements.projectTemplateBrowserModal) {
        return elements.projectTemplateBrowserModal;
    }

    const modal = document.createElement('div');
    modal.id = 'project-template-browser-modal';
    modal.className = 'project-browser-modal';
    modal.innerHTML = `
        <div class="project-browser-dialog project-template-browser-dialog" role="dialog" aria-modal="true" aria-labelledby="project-template-browser-title">
            <div class="project-browser-header">
                <h3 id="project-template-browser-title">任务模板</h3>
                <button type="button" class="project-preview-close" data-close-project-template-browser aria-label="关闭模板列表">×</button>
            </div>
            <div class="project-template-section">
                <div class="project-template-section-title">模板</div>
                <div class="project-browser-list" id="project-template-list"></div>
            </div>
            <div class="project-template-section">
                <div class="project-template-section-title">最近运行</div>
                <div class="project-browser-list project-run-list" id="project-run-list"></div>
            </div>
        </div>
    `;

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('[data-close-project-template-browser]')) {
            closeProjectTemplateBrowser();
        }
    });

    document.body.appendChild(modal);
    elements.projectTemplateBrowserModal = modal;
    elements.projectTemplateList = modal.querySelector('#project-template-list');
    elements.projectRunList = modal.querySelector('#project-run-list');
    return modal;
}

function ensureProjectPreviewModalV2() {
    if (elements.projectPreviewModal && elements.projectPreviewActions) {
        return elements.projectPreviewModal;
    }

    if (elements.projectPreviewModal && !elements.projectPreviewActions) {
        elements.projectPreviewModal.remove();
        elements.projectPreviewModal = null;
    }

    const modal = document.createElement('div');
    modal.id = 'project-preview-modal';
    modal.className = 'project-preview-modal';
    modal.innerHTML = `
        <div class="project-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="project-preview-title">
            <div class="project-preview-header">
                <div class="project-preview-heading">
                    <span class="project-preview-type" id="project-preview-type"></span>
                    <h3 id="project-preview-title">项目详情</h3>
                    <div class="project-preview-meta" id="project-preview-meta"></div>
                </div>
                <button type="button" class="project-preview-close" data-close-project-preview aria-label="关闭预览">×</button>
            </div>
            <div class="project-preview-actions" id="project-preview-actions"></div>
            <div class="project-preview-body" id="project-preview-body"></div>
        </div>
    `;

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('[data-close-project-preview]')) {
            closeProjectPreview();
        }
    });

    document.body.appendChild(modal);
    elements.projectPreviewModal = modal;
    elements.projectPreviewType = modal.querySelector('#project-preview-type');
    elements.projectPreviewTitle = modal.querySelector('#project-preview-title');
    elements.projectPreviewMeta = modal.querySelector('#project-preview-meta');
    elements.projectPreviewActions = modal.querySelector('#project-preview-actions');
    elements.projectPreviewBody = modal.querySelector('#project-preview-body');
    return modal;
}

function buildEditableTemplateFromRecording(record, name) {
    const steps = Array.isArray(record?.content) ? record.content : [];
    const editableRecording = {
        ...record,
        content: steps.map((step, index) => {
            if (step?.type === 'input' || step?.type === 'select') {
                return {
                    ...step,
                    type: 'prompt_input',
                    promptKey: step.promptKey || `runtime_input_${index + 1}`,
                    promptLabel: step.promptLabel || `运行时输入 ${index + 1}`,
                    promptMode: step.type === 'select' ? 'select' : 'text',
                    sampleValue: typeof step.value === 'string' ? step.value : '',
                    required: true
                };
            }
            return { ...step };
        })
    };

    return buildTemplateFromRecording(editableRecording, {
        projectId: record?.projectId || state.currentProjectId || '',
        name
    });
}

function ensureTemplateEditorModalLegacy() {
    if (elements.templateEditorModal) {
        return elements.templateEditorModal;
    }

    const modal = document.createElement('div');
    modal.id = 'template-editor-modal';
    modal.className = 'project-browser-modal';
    modal.innerHTML = `
        <div class="project-browser-dialog template-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="template-editor-title">
            <div class="project-browser-header">
                <h3 id="template-editor-title">保存任务模板</h3>
                <button type="button" class="project-preview-close" data-close-template-editor aria-label="关闭模板编辑">×</button>
            </div>
            <div class="template-editor-form">
                <label class="template-editor-field">
                    <span>模板名称</span>
                    <input id="template-editor-name" type="text" />
                </label>
                <label class="template-editor-field">
                    <span>模板描述</span>
                    <textarea id="template-editor-description" rows="2"></textarea>
                </label>
                <div class="template-editor-section">
                    <div class="template-editor-section-title">运行时输入</div>
                    <div class="template-editor-list" id="template-editor-inputs"></div>
                </div>
                <div class="project-preview-actions">
                    <button type="button" class="project-preview-action-btn" data-save-template-editor>保存模板</button>
                </div>
            </div>
        </div>
    `;

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('[data-close-template-editor]')) {
            closeTemplateEditor();
            return;
        }
        if (event.target.closest('[data-save-template-editor]')) {
            void saveTemplateEditorDraft();
        }
    });

    document.body.appendChild(modal);
    elements.templateEditorModal = modal;
    return modal;
}

function renderTemplateEditorModalLegacy() {
    ensureTemplateEditorModal();
    const draft = state.currentTemplateDraft;
    if (!draft || !elements.templateEditorModal) {
        return;
    }

    elements.templateEditorModal.querySelector('#template-editor-name').value = draft.name || '';
    elements.templateEditorModal.querySelector('#template-editor-description').value = draft.description || '';

    const container = elements.templateEditorModal.querySelector('#template-editor-inputs');
    container.innerHTML = '';

    const fields = Array.isArray(draft.inputSchema?.fields) ? draft.inputSchema.fields : [];
    if (fields.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'project-browser-empty';
        empty.textContent = '这条录制里没有需要配置的输入步骤，直接保存即可。';
        container.appendChild(empty);
        return;
    }

    fields.forEach((field, index) => {
        const row = document.createElement('div');
        row.className = 'template-editor-input';
        row.dataset.inputIndex = String(index);
        const isManual = field.mode === 'manual' || field.mode === 'file_upload';
        row.innerHTML = `
            <label class="template-editor-field">
                <span>提示文案</span>
                <input type="text" data-template-field="label" value="${String(field.label || '').replace(/"/g, '&quot;')}" />
            </label>
            <label class="template-editor-field">
                <span>参数键</span>
                <input type="text" data-template-field="key" value="${String(field.key || '').replace(/"/g, '&quot;')}" />
            </label>
            <label class="template-editor-field">
                <span>模式</span>
                <select data-template-field="mode" ${isManual ? 'disabled' : ''}>
                    <option value="text" ${field.mode === 'text' ? 'selected' : ''}>文本</option>
                    <option value="password" ${field.mode === 'password' ? 'selected' : ''}>密码</option>
                    <option value="select" ${field.mode === 'select' ? 'selected' : ''}>下拉选择</option>
                    <option value="otp" ${field.mode === 'otp' ? 'selected' : ''}>验证码</option>
                    <option value="manual" ${field.mode === 'manual' ? 'selected' : ''}>手动确认</option>
                    <option value="file_upload" ${field.mode === 'file_upload' ? 'selected' : ''}>文件上传</option>
                </select>
            </label>
            <label class="template-editor-field">
                <span>${isManual ? '操作说明' : '示例值'}</span>
                <textarea rows="2" data-template-field="${isManual ? 'instructions' : 'sampleValue'}">${String(isManual ? (field.instructions || '') : (field.sampleValue || '')).replace(/</g, '&lt;')}</textarea>
            </label>
        `;
        container.appendChild(row);
    });
}

function closeTemplateEditorLegacy() {
    state.currentTemplateDraft = null;
    elements.templateEditorModal?.classList.remove('is-open');
}

function readTemplateEditorDraftLegacy() {
    const modal = ensureTemplateEditorModal();
    const draft = structuredClone(state.currentTemplateDraft);
    draft.name = modal.querySelector('#template-editor-name').value.trim() || draft.name;
    draft.description = modal.querySelector('#template-editor-description').value.trim();

    const rows = Array.from(modal.querySelectorAll('.template-editor-input[data-input-index]'));
    const fields = rows.map((row, index) => {
        const originalField = draft.inputSchema?.fields?.[index] || {};
        const modeElement = row.querySelector('[data-template-field="mode"]');
        const mode = modeElement?.disabled ? originalField.mode : modeElement?.value || originalField.mode || 'text';
        return {
            ...originalField,
            label: row.querySelector('[data-template-field="label"]').value.trim() || originalField.label || `运行时输入 ${index + 1}`,
            key: row.querySelector('[data-template-field="key"]').value.trim() || originalField.key || `runtime_input_${index + 1}`,
            mode,
            sampleValue: row.querySelector('[data-template-field="sampleValue"]')?.value ?? originalField.sampleValue ?? '',
            instructions: row.querySelector('[data-template-field="instructions"]')?.value ?? originalField.instructions ?? ''
        };
    });

    draft.inputSchema = { fields };
    let fieldIndex = 0;
    draft.steps = (draft.steps || []).map((step) => {
        if (step.type !== 'prompt_input' && step.type !== 'manual_action') {
            return step;
        }
        const field = fields[fieldIndex] || step.payload || {};
        fieldIndex += 1;
        return {
            ...step,
            label: field.label || step.label,
            payload: {
                ...step.payload,
                ...field
            }
        };
    });

    return draft;
}

async function saveTemplateEditorDraftLegacy() {
    const draft = readTemplateEditorDraft();
    if (!draft?.name) {
        showToastUI('模板名称不能为空', 'warning');
        return;
    }

    const template = await projectService.createProjectTemplate(draft);
    await syncProjectStateFromService();
    closeTemplateEditor();
    showToastUI(`已创建模板：${template.name}`, 'success');
}

function ensureTemplateEditorModal() {
    if (elements.templateEditorModal) {
        return elements.templateEditorModal;
    }

    const modal = document.createElement('div');
    modal.id = 'template-editor-modal';
    modal.className = 'project-browser-modal';
    modal.innerHTML = `
        <div class="project-browser-dialog template-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="template-editor-title">
            <div class="project-browser-header">
                <h3 id="template-editor-title">保存任务模板</h3>
                <button type="button" class="project-preview-close" data-close-template-editor aria-label="关闭模板编辑">×</button>
            </div>
            <div class="template-editor-form">
                <label class="template-editor-field">
                    <span>模板名称</span>
                    <input id="template-editor-name" type="text" />
                </label>
                <label class="template-editor-field">
                    <span>模板描述</span>
                    <textarea id="template-editor-description" rows="2"></textarea>
                </label>
                <div class="template-editor-section">
                    <div class="template-editor-section-title">运行时输入</div>
                    <div class="template-editor-list" id="template-editor-inputs"></div>
                </div>
                <div class="project-preview-actions">
                    <button type="button" class="project-preview-action-btn" data-save-template-editor>保存模板</button>
                </div>
            </div>
        </div>
    `;

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('[data-close-template-editor]')) {
            closeTemplateEditor();
            return;
        }
        if (event.target.closest('[data-save-template-editor]')) {
            void saveTemplateEditorDraft();
        }
    });

    document.body.appendChild(modal);
    elements.templateEditorModal = modal;
    return modal;
}

function renderTemplateEditorModal() {
    ensureTemplateEditorModal();
    const draft = state.currentTemplateDraft;
    if (!draft || !elements.templateEditorModal) {
        return;
    }

    const modal = elements.templateEditorModal;
    modal.querySelector('#template-editor-name').value = draft.name || '';
    modal.querySelector('#template-editor-description').value = draft.description || '';

    const container = modal.querySelector('#template-editor-inputs');
    container.innerHTML = '';

    const fields = Array.isArray(draft.inputSchema?.fields) ? draft.inputSchema.fields : [];
    if (fields.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'project-browser-empty';
        empty.textContent = '这条录制里没有需要配置的输入步骤，直接保存即可。';
        container.appendChild(empty);
        return;
    }

    fields.forEach((field, index) => {
        const row = document.createElement('div');
        row.className = 'template-editor-input';
        row.dataset.inputIndex = String(index);
        const isManual = field.mode === 'manual' || field.mode === 'file_upload';
        row.innerHTML = `
            <label class="template-editor-field">
                <span>提示文案</span>
                <input type="text" data-template-field="label" value="${String(field.label || '').replace(/"/g, '&quot;')}" />
            </label>
            <label class="template-editor-field">
                <span>参数键</span>
                <input type="text" data-template-field="key" value="${String(field.key || '').replace(/"/g, '&quot;')}" />
            </label>
            <label class="template-editor-field">
                <span>模式</span>
                <select data-template-field="mode">
                    <option value="text" ${field.mode === 'text' ? 'selected' : ''}>文本</option>
                    <option value="password" ${field.mode === 'password' ? 'selected' : ''}>密码</option>
                    <option value="select" ${field.mode === 'select' ? 'selected' : ''}>下拉选择</option>
                    <option value="otp" ${field.mode === 'otp' ? 'selected' : ''}>验证码</option>
                    <option value="manual" ${field.mode === 'manual' ? 'selected' : ''}>手动确认</option>
                    <option value="file_upload" ${field.mode === 'file_upload' ? 'selected' : ''}>文件上传</option>
                </select>
            </label>
            <label class="template-editor-field">
                <span>${isManual ? '操作说明' : '示例值'}</span>
                <textarea rows="2" data-template-field="${isManual ? 'instructions' : 'sampleValue'}">${String(isManual ? (field.instructions || '') : (field.sampleValue || '')).replace(/</g, '&lt;')}</textarea>
            </label>
        `;
        container.appendChild(row);
    });
}

function closeTemplateEditor() {
    state.currentTemplateDraft = null;
    elements.templateEditorModal?.classList.remove('is-open');
}

function readTemplateEditorDraft() {
    const modal = ensureTemplateEditorModal();
    const draft = structuredClone(state.currentTemplateDraft);
    draft.name = modal.querySelector('#template-editor-name').value.trim() || draft.name;
    draft.description = modal.querySelector('#template-editor-description').value.trim();

    const rows = Array.from(modal.querySelectorAll('.template-editor-input[data-input-index]'));
    const fields = rows.map((row, index) => {
        const originalField = draft.inputSchema?.fields?.[index] || {};
        return {
            ...originalField,
            label: row.querySelector('[data-template-field="label"]').value.trim() || originalField.label || `运行时输入 ${index + 1}`,
            key: row.querySelector('[data-template-field="key"]').value.trim() || originalField.key || `runtime_input_${index + 1}`,
            mode: row.querySelector('[data-template-field="mode"]').value || originalField.mode || 'text',
            sampleValue: row.querySelector('[data-template-field="sampleValue"]')?.value ?? originalField.sampleValue ?? '',
            instructions: row.querySelector('[data-template-field="instructions"]')?.value ?? originalField.instructions ?? ''
        };
    });

    draft.inputSchema = { fields };
    let fieldIndex = 0;
    draft.steps = (draft.steps || []).map((step) => {
        if (step.type !== 'prompt_input' && step.type !== 'manual_action') {
            return step;
        }
        const field = fields[fieldIndex] || step.payload || {};
        fieldIndex += 1;
        const isManual = field.mode === 'manual' || field.mode === 'file_upload';
        return {
            ...step,
            type: isManual ? 'manual_action' : 'prompt_input',
            label: field.label || step.label,
            payload: {
                ...step.payload,
                ...field
            }
        };
    });

    return draft;
}

async function saveTemplateEditorDraft() {
    const draft = readTemplateEditorDraft();
    if (!draft?.name) {
        showToastUI('模板名称不能为空', 'warning');
        return;
    }

    const template = await projectService.createProjectTemplate(draft);
    await syncProjectStateFromService();
    closeTemplateEditor();
    showToastUI(`已创建模板：${template.name}`, 'success');
}

function stringifyProjectPreviewContent(item) {
    if (!item) {
        return '';
    }

    if (item.entityType === 'template') {
        const lines = [
            `名称: ${item.name || '未命名模板'}`,
            item.description ? `描述: ${item.description}` : null,
            `步骤数: ${Array.isArray(item.steps) ? item.steps.length : 0}`,
            Array.isArray(item.steps) && item.steps.length > 0 ? '步骤:' : null,
            ...(Array.isArray(item.steps) ? item.steps.map((step, index) => {
                const payloadSteps = Array.isArray(step?.payload?.steps) ? step.payload.steps.length : 0;
                return `${index + 1}. ${step.label || step.type || 'step'} | type=${step.type || 'unknown'} | replaySteps=${payloadSteps}`;
            }) : [])
        ].filter(Boolean);
        return lines.join('\n');
    }

    if (item.entityType === 'run') {
        const lines = [
            `状态: ${item.status || 'unknown'}`,
            item.templateName ? `模板: ${item.templateName}` : null,
            item.error ? `错误: ${item.error}` : null,
            Array.isArray(item.steps) && item.steps.length > 0 ? '步骤执行:' : null,
            ...(Array.isArray(item.steps) ? item.steps.map((step, index) => {
                const outputText = step.output ? ` | output=${JSON.stringify(step.output)}` : '';
                const errorText = step.error ? ` | error=${step.error}` : '';
                return `${index + 1}. ${step.label || step.type || 'step'} | status=${step.status || 'unknown'}${outputText}${errorText}`;
            }) : []),
            item.outputs ? `输出: ${JSON.stringify(item.outputs, null, 2)}` : null
        ].filter(Boolean);
        return lines.join('\n');
    }

    if (item.type === 'automation_recording') {
        const steps = Array.isArray(item.content) ? item.content : [];
        if (steps.length === 0) {
            return '当前录制没有步骤。';
        }
        return steps.map((step, index) => {
            const parts = [`${index + 1}. ${step.type || 'step'}`];
            if (step.selector) {
                parts.push(`selector=${step.selector}`);
            }
            if (typeof step.value === 'string' && step.value !== '') {
                parts.push(`value=${step.value}`);
            }
            if (step.key) {
                parts.push(`key=${step.key}`);
            }
            if (typeof step.durationMs === 'number') {
                parts.push(`wait=${step.durationMs}ms`);
            }
            if (typeof step.x === 'number' || typeof step.y === 'number') {
                parts.push(`scroll=(${step.x || 0}, ${step.y || 0})`);
            }
            if (step.text) {
                parts.push(`text=${step.text}`);
            }
            return parts.join(' | ');
        }).join('\n');
    }

    if (item.type === 'page_snapshot') {
        return typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2);
    }

    if (item.type === 'page_extract') {
        if (item.meta?.pattern === 'article' && item.content?.textContent) {
            return item.content.textContent;
        }
        return JSON.stringify(item.content, null, 2);
    }

    if (item.type === 'editor_file_ref') {
        return JSON.stringify(item.meta || item.content || {}, null, 2);
    }

    if (item.type === 'workflow_result') {
        return JSON.stringify({
            status: item.content?.status || item.meta?.status || '',
            outputs: item.content?.outputs ?? null,
            templateName: item.meta?.templateName || '',
            steps: item.meta?.steps || []
        }, null, 2);
    }

    if (typeof item.content === 'string') {
        return item.content;
    }

    return JSON.stringify(item.content ?? item.meta ?? {}, null, 2);
}

function stringifyProjectPreviewContentReadableLegacy(item) {
    if (!item) {
        return '';
    }

    if (item.entityType === 'template') {
        const lines = [
            `名称: ${item.name || '未命名模板'}`,
            item.description ? `描述: ${item.description}` : null,
            `步骤数: ${Array.isArray(item.steps) ? item.steps.length : 0}`,
            Array.isArray(item.steps) && item.steps.length > 0 ? '步骤:' : null,
            ...(Array.isArray(item.steps) ? item.steps.map((step, index) => {
                const payloadSteps = Array.isArray(step?.payload?.steps) ? step.payload.steps.length : 0;
                return `${index + 1}. ${step.label || step.type || 'step'} | type=${step.type || 'unknown'} | replaySteps=${payloadSteps}`;
            }) : [])
        ].filter(Boolean);
        return lines.join('\n');
    }

    if (item.entityType === 'run') {
        const lines = [
            `状态: ${item.status || 'unknown'}`,
            item.templateName ? `模板: ${item.templateName}` : null,
            item.error ? `错误: ${item.error}` : null,
            Array.isArray(item.steps) && item.steps.length > 0 ? '步骤执行:' : null,
            ...(Array.isArray(item.steps) ? item.steps.map((step, index) => {
                const outputText = step.output ? ` | output=${JSON.stringify(step.output)}` : '';
                const errorText = step.error ? ` | error=${step.error}` : '';
                return `${index + 1}. ${step.label || step.type || 'step'} | status=${step.status || 'unknown'}${outputText}${errorText}`;
            }) : []),
            item.outputs ? `输出: ${JSON.stringify(item.outputs, null, 2)}` : null
        ].filter(Boolean);
        return lines.join('\n');
    }

    if (item.type === 'automation_recording') {
        const steps = Array.isArray(item.content) ? item.content : [];
        if (steps.length === 0) {
            return '当前录制没有步骤。';
        }
        return steps.map((step, index) => {
            const parts = [`${index + 1}. ${step.type || 'step'}`];
            if (step.selector) {
                parts.push(`selector=${step.selector}`);
            }
            if (typeof step.value === 'string' && step.value !== '') {
                parts.push(`value=${step.value}`);
            }
            if (step.key) {
                parts.push(`key=${step.key}`);
            }
            if (typeof step.durationMs === 'number') {
                parts.push(`wait=${step.durationMs}ms`);
            }
            if (typeof step.x === 'number' || typeof step.y === 'number') {
                parts.push(`scroll=(${step.x || 0}, ${step.y || 0})`);
            }
            if (step.text) {
                parts.push(`text=${step.text}`);
            }
            return parts.join(' | ');
        }).join('\n');
    }

    if (item.type === 'page_snapshot') {
        return typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2);
    }

    if (item.type === 'page_extract') {
        if (item.meta?.pattern === 'article' && item.content?.textContent) {
            return item.content.textContent;
        }
        return JSON.stringify(item.content, null, 2);
    }

    if (item.type === 'editor_file_ref') {
        return JSON.stringify(item.meta || item.content || {}, null, 2);
    }

    if (item.type === 'workflow_result') {
        return JSON.stringify({
            status: item.content?.status || item.meta?.status || '',
            outputs: item.content?.outputs ?? null,
            templateName: item.meta?.templateName || '',
            steps: item.meta?.steps || []
        }, null, 2);
    }

    if (typeof item.content === 'string') {
        return item.content;
    }

    return JSON.stringify(item.content ?? item.meta ?? {}, null, 2);
}

function escapeProjectPreviewHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildProjectPreviewTextSection(title, value) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
    return `
        <section class="project-preview-section">
            <div class="project-preview-section-title">${escapeProjectPreviewHtml(title)}</div>
            <pre class="project-preview-code">${escapeProjectPreviewHtml(raw)}</pre>
        </section>
    `;
}

function renderProjectPreviewBodyLegacyMid(item) {
    if (!elements.projectPreviewBody) {
        return;
    }

    if (item?.type === 'mcp_resource') {
        const meta = item.meta || {};
        const resourceResult = item.content?.contents ? item.content : (item.content?.result || item.content || {});
        const displayContent = Array.isArray(resourceResult?.contents)
            ? resourceResult.contents.map((entry) => entry?.text || entry?.data || entry?.blob || JSON.stringify(entry ?? {}, null, 2)).join('\n\n')
            : resourceResult;
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>服务</span><strong>${escapeProjectPreviewHtml(meta.serverName || meta.serverId || '-')}</strong></div>
                <div class="project-preview-kv"><span>URI</span><strong>${escapeProjectPreviewHtml(meta.uri || '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('资源内容', displayContent)}
        `;
        return;
    }

    if (item?.type === 'mcp_prompt') {
        const meta = item.meta || {};
        const promptResult = item.content?.messages ? item.content : (item.content?.result || item.content || {});
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>服务</span><strong>${escapeProjectPreviewHtml(meta.serverName || meta.serverId || '-')}</strong></div>
                <div class="project-preview-kv"><span>提示词</span><strong>${escapeProjectPreviewHtml(meta.promptName || item.title || '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('提示词内容', promptResult)}
        `;
        return;
    }

    elements.projectPreviewBody.textContent = stringifyProjectPreviewContentReadable(item);
}

function openProjectPreviewLegacyV1(itemOrId) {
    const item = typeof itemOrId === 'string'
        ? (
            state.currentProjectSummary?.recentItems?.find(entry => entry.id === itemOrId)
            || state.currentProjectBrowserItems?.find(entry => entry.id === itemOrId)
        )
        : itemOrId;
    if (!item) {
        return;
    }

    ensureProjectPreviewModal();
    elements.projectPreviewType.textContent = getProjectItemTypeLabel(item.type);
    elements.projectPreviewTitle.textContent = item.title || '未命名素材';
    elements.projectPreviewMeta.textContent = item.sourceUrl || state.currentProject?.name || '当前项目';
    elements.projectPreviewBody.textContent = stringifyProjectPreviewContent(item);
    elements.projectPreviewModal.classList.add('is-open');
}

function closeProjectPreviewLegacy() {
    if (!elements.projectPreviewModal) {
        return;
    }
    elements.projectPreviewModal.classList.remove('is-open');
}

function findProjectPreviewRecordById(recordId) {
    return (
        state.currentProjectSummary?.recentItems?.find(entry => entry.id === recordId)
        || state.currentProjectBrowserItems?.find(entry => entry.id === recordId)
        || state.currentProjectTemplates?.find(entry => entry.id === recordId)
        || state.currentProjectRuns?.find(entry => entry.id === recordId)
        || null
    );
}

function renderProjectPreviewActionsLegacySync(record) {
    ensureProjectPreviewModalV2();
    if (!elements.projectPreviewActions) {
        return;
    }

    elements.projectPreviewActions.innerHTML = '';
    const actions = [];

    if (record?.type === 'automation_recording' && !record.entityType) {
        actions.push({
            label: '保存为模板',
            handler: createTemplateFromPreviewRecord
        });
    }

    if (record?.entityType === 'template') {
        actions.push({
            label: '执行模板',
            handler: runTemplateFromPreviewRecord
        });
    }

    actions.forEach(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'project-preview-action-btn';
        button.textContent = action.label;
        button.addEventListener('click', action.handler);
        elements.projectPreviewActions.appendChild(button);
    });

    elements.projectPreviewActions.classList.toggle('is-empty', actions.length === 0);
}

async function handleCopyProjectResource(record) {
    const entityType = record?.entityType === 'template' ? 'template' : 'item';
    const targetProject = await promptTargetProjectSelection('复制到项目', record.projectId || state.currentProjectId);
    if (!targetProject) {
        return;
    }

    const result = await projectService.copyResourceToProject(entityType, record.id, targetProject.id);
    if (!result.success) {
        showToastUI(result.error || '复制资源失败', 'error');
        return;
    }

    await syncProjectStateFromService();
    showToastUI(`已复制到项目：${targetProject.name}`, 'success');
}

async function handleMoveProjectResource(record) {
    const entityType = record?.entityType === 'template' ? 'template' : 'item';
    const targetProject = await promptTargetProjectSelection('转移到项目', record.projectId || state.currentProjectId);
    if (!targetProject) {
        return;
    }

    const result = await projectService.moveResourceToProject(entityType, record.id, targetProject.id);
    if (!result.success) {
        showToastUI(result.error || '转移资源失败', 'error');
        return;
    }

    await syncProjectStateFromService();
    closeProjectPreview();
    showToastUI(`已转移到项目：${targetProject.name}`, 'success');
}

async function handleToggleProjectResourcePublic(record) {
    const entityType = record?.entityType === 'template' ? 'template' : 'item';
    const isPublic = await projectService.isResourcePublic(entityType, record.id);
    const result = await projectService.setResourcePublic(entityType, record.id, !isPublic);
    if (!result.success) {
        showToastUI(result.error || '更新公共资源状态失败', 'error');
        return;
    }

    await syncProjectStateFromService();
    await renderProjectPreviewActions(record);
    showToastUI(isPublic ? '已移出公共资源' : '已设为公共资源', 'success');
}

async function handleDeleteProjectResource(record) {
    const entityType = record?.entityType === 'template' ? 'template' : 'item';
    const confirmed = window.confirm(`确认删除“${record.title || record.name || '资源'}”？`);
    if (!confirmed) {
        return;
    }

    const result = await projectService.deleteProjectResource(entityType, record.id);
    if (!result.success) {
        showToastUI(result.error || '删除资源失败', 'error');
        return;
    }

    await syncProjectStateFromService();
    closeProjectPreview();
    showToastUI('资源已删除', 'success');
}

async function renderProjectPreviewActionsLegacyAsync(record) {
    ensureProjectPreviewModalV2();
    if (!elements.projectPreviewActions) {
        return;
    }

    elements.projectPreviewActions.innerHTML = '';
    const actions = [];
    const isProjectResource = Boolean(record && !record.entityType) || record?.entityType === 'template';

    if (record?.type === 'automation_recording' && !record.entityType) {
        actions.push({
            label: '保存为模板',
            handler: createTemplateFromPreviewRecord
        });
    }

    if (record?.entityType === 'template') {
        actions.push({
            label: '执行模板',
            handler: runTemplateFromPreviewRecord
        });
    }

    if (isProjectResource) {
        const entityType = record?.entityType === 'template' ? 'template' : 'item';
        const isPublic = await projectService.isResourcePublic(entityType, record.id);
        actions.push(
            {
                label: '复制到项目',
                handler: () => handleCopyProjectResource(record)
            },
            {
                label: '转移到项目',
                handler: () => handleMoveProjectResource(record)
            },
            {
                label: isPublic ? '取消公共' : '设为公共',
                handler: () => handleToggleProjectResourcePublic(record)
            },
            {
                label: '删除资源',
                handler: () => handleDeleteProjectResource(record)
            }
        );
    }

    actions.forEach(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'project-preview-action-btn';
        button.textContent = action.label;
        button.addEventListener('click', action.handler);
        elements.projectPreviewActions.appendChild(button);
    });

    elements.projectPreviewActions.classList.toggle('is-empty', actions.length === 0);
}

function openProjectPreviewDeprecated(itemOrId) {
    const record = typeof itemOrId === 'string'
        ? findProjectPreviewRecordById(itemOrId)
        : itemOrId;
    if (!record) {
        return;
    }

    state.currentProjectPreviewRecord = record;
    ensureProjectPreviewModalV2();
    elements.projectPreviewType.textContent = getProjectItemTypeLabel(record.entityType === 'template'
        ? 'workflow_template'
        : record.entityType === 'run'
            ? 'workflow_run'
            : record.type);
    elements.projectPreviewTitle.textContent = record.title || record.name || '未命名记录';
    elements.projectPreviewMeta.textContent = record.sourceUrl
        || record.templateName
        || state.currentProject?.name
        || '当前项目';
    if (elements.projectPreviewMeta && (record.entityType === 'template' || record.entityType === 'run')) {
        elements.projectPreviewMeta.textContent = `${elements.projectPreviewMeta.textContent} | ${getExecutionModeLabel(record.executionMode || record.outputs?.executionMode || 'foreground')}`;
    }
    void renderProjectPreviewActions(record);
    elements.projectPreviewBody.textContent = '';
    renderProjectPreviewBody(record);
    elements.projectPreviewModal.classList.add('is-open');
}

async function ensureChatToolbarMcpMenu() {
    const toolbar = document.querySelector('.chat-input-toolbar');
    const anchor = document.getElementById('toolbar-recorder-menu')
        || document.getElementById('toolbar-project-menu')
        || document.getElementById('toolbar-automation-group');
    if (!toolbar || !anchor) {
        return;
    }

    const menu = ensureToolbarMenu({
        menuId: 'toolbar-mcp-menu',
        anchor,
        label: 'MCP',
        title: '配置 Agent 可用的 MCP 服务',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 16 16"><path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h2A1.5 1.5 0 0 1 8 3.5v1A1.5 1.5 0 0 1 6.5 6h-2A1.5 1.5 0 0 1 3 4.5v-1Zm5 8A1.5 1.5 0 0 1 9.5 10h2a1.5 1.5 0 0 1 1.5 1.5v1A1.5 1.5 0 0 1 11.5 14h-2A1.5 1.5 0 0 1 8 12.5v-1Zm0-8A1.5 1.5 0 0 1 9.5 2h2A1.5 1.5 0 0 1 13 3.5v1A1.5 1.5 0 0 1 11.5 6h-2A1.5 1.5 0 0 1 8 4.5v-1ZM3.5 10h2A1.5 1.5 0 0 1 7 11.5v1A1.5 1.5 0 0 1 5.5 14h-2A1.5 1.5 0 0 1 2 12.5v-1A1.5 1.5 0 0 1 3.5 10ZM6 4h4M4 10V6m8 4V6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path></svg>'
    });
    const panel = menu?.querySelector('.toolbar-menu-panel');
    if (!panel) {
        return;
    }

    const [prefs, stateResponse] = await Promise.all([
        getMcpAgentPreferences(),
        browser.runtime.sendMessage({ action: 'mcp.getState' }).catch(() => ({ success: false }))
    ]);

    const escapeMenuHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const servers = stateResponse?.success && Array.isArray(stateResponse.data?.servers)
        ? stateResponse.data.servers.filter((server) => server.enabled !== false)
        : [];
    const effectiveCheckedIds = prefs.allowAllServers !== false
        ? servers.map((server) => server.id)
        : prefs.allowedServerIds;

    panel.innerHTML = `
        <div class="toolbar-menu-section">
            <label class="toolbar-menu-switch">
                <input type="checkbox" id="toolbar-mcp-enabled" ${prefs.enabled ? 'checked' : ''}>
                <span>允许 Agent 使用 MCP</span>
            </label>
        </div>
        <div class="toolbar-menu-section">
            <div class="toolbar-menu-section-title">可用服务</div>
            <div class="toolbar-menu-checklist" id="toolbar-mcp-server-list">
                ${servers.length ? servers.map((server) => `
                    <label class="toolbar-menu-check">
                        <input type="checkbox" value="${escapeMenuHtml(server.id)}" ${effectiveCheckedIds.includes(server.id) ? 'checked' : ''} ${prefs.enabled ? '' : 'disabled'}>
                        <span>${escapeMenuHtml(server.name)}</span>
                    </label>
                `).join('') : '<div class="toolbar-menu-note">当前没有已启用的 MCP 服务</div>'}
            </div>
            <div class="toolbar-menu-note">勾选允许 Agent 调用的 MCP 服务；全部取消后，Agent 将无法使用任何 MCP 服务。</div>
        </div>
    `;

    const enabledInput = panel.querySelector('#toolbar-mcp-enabled');
    const serverInputs = Array.from(panel.querySelectorAll('#toolbar-mcp-server-list input[type="checkbox"]'));

    const syncDisabledState = () => {
        serverInputs.forEach((input) => {
            input.disabled = !enabledInput.checked;
        });
    };

    enabledInput?.addEventListener('change', async () => {
        const checkedIds = serverInputs.filter((input) => input.checked).map((input) => input.value);
        await saveMcpAgentPreferences({
            enabled: enabledInput.checked,
            allowAllServers: checkedIds.length === serverInputs.length,
            allowedServerIds: checkedIds
        });
        syncDisabledState();
    });

    serverInputs.forEach((input) => {
        input.addEventListener('change', async () => {
            const checkedIds = serverInputs.filter((node) => node.checked).map((node) => node.value);
            await saveMcpAgentPreferences({
                enabled: enabledInput.checked,
                allowAllServers: checkedIds.length === serverInputs.length,
                allowedServerIds: checkedIds
            });
        });
    });

    syncDisabledState();
    reorderChatToolbar();
}

async function ensureChatToolbarMcpContextMenuLegacy() {
    const toolbar = document.querySelector('.chat-input-toolbar');
    const anchor = document.getElementById('toolbar-mcp-menu')
        || document.getElementById('toolbar-recorder-menu')
        || document.getElementById('toolbar-project-menu')
        || document.getElementById('toolbar-automation-group');
    if (!toolbar || !anchor) {
        return;
    }

    const menu = ensureToolbarMenu({
        menuId: 'toolbar-mcp-context-menu',
        anchor,
        label: 'MCP上下文',
        title: '选择 MCP 资源或提示词加入当前上下文',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 16 16"><path d="M2.75 3.25A1.5 1.5 0 0 1 4.25 1.75h2.5a1.5 1.5 0 0 1 1.5 1.5v2.5a1.5 1.5 0 0 1-1.5 1.5h-2.5a1.5 1.5 0 0 1-1.5-1.5v-2.5Zm6 0a1.5 1.5 0 0 1 1.5-1.5h1.5a1.5 1.5 0 0 1 1.5 1.5v1.5a1.5 1.5 0 0 1-1.5 1.5h-1.5a1.5 1.5 0 0 1-1.5-1.5v-1.5Zm-6 7.5a1.5 1.5 0 0 1 1.5-1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v1a2.5 2.5 0 0 1-2.5 2.5h-5a2.5 2.5 0 0 1-2.5-2.5v-1Z" stroke="currentColor" stroke-width="1.2"></path></svg>'
    });
    const panel = menu?.querySelector('.toolbar-menu-panel');
    if (!panel) {
        return;
    }

    const stateResponse = await browser.runtime.sendMessage({ action: 'mcp.getState' }).catch(() => ({ success: false }));
    const servers = stateResponse?.success && Array.isArray(stateResponse.data?.servers)
        ? stateResponse.data.servers.filter((server) => server.enabled !== false)
        : [];

    panel.innerHTML = `
        <div class="toolbar-menu-section">
            <div class="toolbar-menu-section-title">服务</div>
            <select id="toolbar-mcp-context-server" class="toolbar-menu-select" ${servers.length ? '' : 'disabled'}>
                ${servers.length
                    ? servers.map((server, index) => `<option value="${String(server.id).replace(/"/g, '&quot;')}" ${index === 0 ? 'selected' : ''}>${String(server.name || server.id).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</option>`).join('')
                    : '<option value="">当前没有可用服务</option>'}
            </select>
        </div>
        <div class="toolbar-menu-section">
            <button type="button" class="toolbar-menu-action" id="toolbar-mcp-add-resource" ${servers.length ? '' : 'disabled'}>
                <span class="toolbar-menu-action-label">选择资源加入上下文</span>
            </button>
            <button type="button" class="toolbar-menu-action" id="toolbar-mcp-add-prompt" ${servers.length ? '' : 'disabled'}>
                <span class="toolbar-menu-action-label">选择提示词加入上下文</span>
            </button>
            <div class="toolbar-menu-note">加入后会进入当前聊天/深度研究上下文，和标签页上下文一起发送。</div>
        </div>
    `;

    const serverSelect = panel.querySelector('#toolbar-mcp-context-server');
    const addResourceBtn = panel.querySelector('#toolbar-mcp-add-resource');
    const addPromptBtn = panel.querySelector('#toolbar-mcp-add-prompt');

    const chooseMcpItemByPrompt = async (kind) => {
        const serverId = serverSelect?.value || '';
        if (!serverId) {
            showToastUI('请先选择一个 MCP 服务', 'warning');
            return;
        }

        const listAction = kind === 'resource' ? 'mcp.listResources' : 'mcp.listPrompts';
        const readAction = kind === 'resource' ? 'mcp.readResource' : 'mcp.getPrompt';
        const listResponse = await browser.runtime.sendMessage({ action: listAction, serverId, refresh: false });
        if (!listResponse?.success) {
            showToastUI(listResponse?.error || `读取 MCP ${kind === 'resource' ? '资源' : '提示词'}列表失败`, 'error');
            return;
        }

        const items = Array.isArray(listResponse.data) ? listResponse.data : [];
        if (!items.length) {
            showToastUI(`当前服务没有可用的 MCP ${kind === 'resource' ? '资源' : '提示词'}`, 'warning');
            return;
        }

        const displayItems = items.slice(0, 20);
        const promptText = displayItems.map((item, index) => {
            const label = kind === 'resource'
                ? (item.title || item.name || item.uri || `资源 ${index + 1}`)
                : (item.name || item.title || `提示词 ${index + 1}`);
            const suffix = kind === 'resource'
                ? (item.uri ? ` | ${item.uri}` : '')
                : (item.description ? ` | ${item.description}` : '');
            return `${index + 1}. ${label}${suffix}`;
        }).join('\n');
        const answer = window.prompt(
            `选择要加入上下文的 MCP ${kind === 'resource' ? '资源' : '提示词'}编号：\n${promptText}${items.length > displayItems.length ? `\n仅显示前 ${displayItems.length} 项。` : ''}`,
            '1'
        );
        if (answer === null) {
            return;
        }

        const selectedIndex = Number.parseInt(answer, 10) - 1;
        if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= displayItems.length) {
            showToastUI('输入的编号无效', 'warning');
            return;
        }

        const selectedItem = displayItems[selectedIndex];
        const readResponse = await browser.runtime.sendMessage(
            kind === 'resource'
                ? { action: readAction, serverId, uri: selectedItem.uri }
                : { action: readAction, serverId, name: selectedItem.name, arguments: {} }
        );
        if (!readResponse?.success) {
            showToastUI(readResponse?.error || `读取 MCP ${kind === 'resource' ? '资源' : '提示词'}内容失败`, 'error');
            return;
        }

        const record = kind === 'resource'
            ? {
                id: `mcp-resource-${serverId}-${selectedItem.uri}`,
                type: 'mcp_resource',
                title: selectedItem.title || selectedItem.name || selectedItem.uri,
                sourceUrl: '',
                content: readResponse.data?.result || {},
                meta: {
                    serverId,
                    serverName: readResponse.data?.serverName || servers.find((server) => server.id === serverId)?.name || '',
                    uri: selectedItem.uri
                }
            }
            : {
                id: `mcp-prompt-${serverId}-${selectedItem.name}`,
                type: 'mcp_prompt',
                title: selectedItem.name || selectedItem.title || 'MCP 提示词',
                sourceUrl: '',
                content: readResponse.data?.result || {},
                meta: {
                    serverId,
                    serverName: readResponse.data?.serverName || servers.find((server) => server.id === serverId)?.name || '',
                    promptName: selectedItem.name
                }
            };

        addProjectRecordToContext(record);
    };

    addResourceBtn?.addEventListener('click', async () => {
        await chooseMcpItemByPrompt('resource');
        menu.open = false;
    });

    addPromptBtn?.addEventListener('click', async () => {
        await chooseMcpItemByPrompt('prompt');
        menu.open = false;
    });

    reorderChatToolbar();
}

async function ensureChatToolbarMcpContextMenu() {
    removeToolbarMenu('toolbar-mcp-context-menu');
}

function getProjectItemDisplayTitle(item) {
    if (!item) {
        return '未命名素材';
    }

    if (item.title) {
        return item.title;
    }

    if (item.type === 'mcp_resource') {
        return item.meta?.uri || item.meta?.serverName || item.meta?.serverId || 'MCP 资源';
    }

    if (item.type === 'mcp_prompt') {
        return item.meta?.promptName || item.meta?.serverName || item.meta?.serverId || 'MCP 提示词';
    }

    return '未命名素材';
}

function getProjectItemSummaryText(item) {
    if (!item) {
        return '';
    }

    if (item.type === 'mcp_resource') {
        const parts = [
            item.meta?.serverName || item.meta?.serverId || '',
            item.meta?.uri || ''
        ].filter(Boolean);
        return parts.join(' · ');
    }

    if (item.type === 'mcp_prompt') {
        const parts = [
            item.meta?.serverName || item.meta?.serverId || '',
            item.meta?.promptName || ''
        ].filter(Boolean);
        return parts.join(' · ');
    }

    if (item.type === 'page_extract') {
        return item.meta?.pattern ? `模式: ${item.meta.pattern}` : '';
    }

    if (item.type === 'editor_file_ref') {
        return item.meta?.path || item.meta?.fileName || '';
    }

    if (item.sourceUrl) {
        return item.sourceUrl;
    }

    return '';
}

function renderProjectSummaryLegacy(summary) {
    if (!elements.projectSummaryTitle || !elements.projectSummaryMeta || !elements.projectSummaryItems) {
        return;
    }

    if (!summary?.project) {
        elements.projectSummaryTitle.textContent = '未选择项目';
        elements.projectSummaryMeta.textContent = '项目素材 0 项';
        elements.projectSummaryItems.innerHTML = '<span class="project-summary-empty">还没有可展示的项目素材</span>';
        return;
    }

    elements.projectSummaryTitle.textContent = summary.project.name;

    const typeFragments = Object.entries(summary.typeCounts || {})
        .slice(0, 3)
        .map(([type, count]) => `${getProjectItemTypeLabel(type)} ${count}`);
    elements.projectSummaryMeta.textContent = typeFragments.length > 0
        ? `项目素材 ${summary.itemCount} 项 · ${typeFragments.join(' · ')}`
        : `项目素材 ${summary.itemCount} 项`;

    elements.projectSummaryItems.innerHTML = '';
    if (!summary.recentItems || summary.recentItems.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'project-summary-empty';
        empty.textContent = '当前项目还没有素材';
        elements.projectSummaryItems.appendChild(empty);
        return;
    }

    summary.recentItems.forEach((item) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'project-summary-item';
        chip.dataset.projectItemId = item.id;
        const summaryText = getProjectItemSummaryText(item);
        if (summaryText) {
            chip.title = `${getProjectItemDisplayTitle(item)}\n${summaryText}`;
        }

        const type = document.createElement('span');
        type.className = 'project-summary-item-type';
        type.textContent = getProjectItemTypeLabel(item.type);

        const title = document.createElement('span');
        title.className = 'project-summary-item-title';
        title.textContent = getProjectItemDisplayTitle(item);

        chip.appendChild(type);
        chip.appendChild(title);
        elements.projectSummaryItems.appendChild(chip);
    });
}

async function openProjectBrowserLegacy() {
    const projectId = await ensureCurrentProjectSelection('查看项目素材');
    if (!projectId) {
        return;
    }

    const items = await projectService.listProjectItems(projectId);
    state.currentProjectBrowserItems = items;
    ensureProjectBrowserModal();
    elements.projectBrowserList.innerHTML = '';

    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'project-browser-empty';
        empty.textContent = '当前项目还没有素材';
        elements.projectBrowserList.appendChild(empty);
    } else {
        items.forEach((item) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'project-browser-item';
            row.dataset.projectItemId = item.id;

            const metaText = getProjectItemSummaryText(item);
            row.innerHTML = `
                <span class="project-browser-item-type">${getProjectItemTypeLabel(item.type)}</span>
                <span class="project-browser-item-content">
                    <span class="project-browser-item-title">${getProjectItemDisplayTitle(item)}</span>
                    ${metaText ? `<span class="project-browser-item-meta">${metaText}</span>` : ''}
                </span>
            `;

            if (metaText) {
                row.title = `${getProjectItemDisplayTitle(item)}\n${metaText}`;
            }

            elements.projectBrowserList.appendChild(row);
        });
    }

    elements.projectBrowserModal.classList.add('is-open');
}

function closeProjectPreview() {
    if (!elements.projectPreviewModal) {
        return;
    }
    state.currentProjectPreviewRecord = null;
    elements.projectPreviewModal.classList.remove('is-open');
}

async function openProjectBrowserLegacyV2() {
    const projectId = await ensureCurrentProjectSelection('查看项目素材');
    if (!projectId) {
        return;
    }

    const items = await projectService.listProjectItems(projectId);
    state.currentProjectBrowserItems = items;
    ensureProjectBrowserModal();
    elements.projectBrowserList.innerHTML = '';

    if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'project-browser-empty';
        empty.textContent = '当前项目还没有素材';
        elements.projectBrowserList.appendChild(empty);
    } else {
        items.forEach(item => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'project-browser-item';
            row.dataset.projectItemId = item.id;
            row.innerHTML = `
                <span class="project-browser-item-type">${getProjectItemTypeLabel(item.type)}</span>
                <span class="project-browser-item-title">${item.title}</span>
            `;
            elements.projectBrowserList.appendChild(row);
        });
    }

    elements.projectBrowserModal.classList.add('is-open');
}

function closeProjectBrowser() {
    if (!elements.projectBrowserModal) {
        return;
    }
    elements.projectBrowserModal.classList.remove('is-open');
}

function handleProjectBrowserClickLegacy(event) {
    const item = event.target.closest('.project-browser-item[data-project-item-id]');
    if (!item) {
        return;
    }
    const record = state.currentProjectBrowserItems?.find(entry => entry.id === item.dataset.projectItemId);
    if (!record) {
        return;
    }
    closeProjectBrowser();
    openProjectPreview(record);
}

async function openProjectTemplateBrowser() {
    const projectId = await ensureCurrentProjectSelection('查看任务模板');
    if (!projectId) {
        return;
    }

    const [templates, runs] = await Promise.all([
        projectService.listProjectTemplates(projectId),
        projectService.listProjectRuns(projectId, 8)
    ]);

    state.currentProjectTemplates = templates.map(template => ({
        ...template,
        entityType: 'template'
    }));
    state.currentProjectRuns = runs.map(run => ({
        ...run,
        entityType: 'run',
        templateName: templates.find(template => template.id === run.templateId)?.name || ''
    }));

    ensureProjectTemplateBrowserModalV2();
    renderProjectTemplateBrowserContent();
    elements.projectTemplateBrowserModal.classList.add('is-open');
}

function closeProjectTemplateBrowser() {
    if (!elements.projectTemplateBrowserModal) {
        return;
    }
    elements.projectTemplateBrowserModal.classList.remove('is-open');
}

function renderProjectTemplateBrowserContentLegacy() {
    if (!elements.projectTemplateList || !elements.projectRunList) {
        return;
    }

    elements.projectTemplateList.innerHTML = '';
    elements.projectRunList.innerHTML = '';

    if (!state.currentProjectTemplates?.length) {
        const empty = document.createElement('div');
        empty.className = 'project-browser-empty';
        empty.textContent = '当前项目还没有模板。';
        elements.projectTemplateList.appendChild(empty);
    } else {
        state.currentProjectTemplates.forEach(template => {
            const row = document.createElement('div');
            row.className = 'project-template-item';
            row.dataset.projectTemplateId = template.id;
            row.innerHTML = `
                <button type="button" class="project-browser-item project-template-open" data-action="preview-template" data-template-id="${template.id}">
                    <span class="project-browser-item-type">模板</span>
                    <span class="project-browser-item-title">${template.name}</span>
                </button>
                <button type="button" class="project-template-run-btn" data-action="run-template" data-template-id="${template.id}">运行</button>
            `;
            elements.projectTemplateList.appendChild(row);
        });
    }

    if (!state.currentProjectRuns?.length) {
        const empty = document.createElement('div');
        empty.className = 'project-browser-empty';
        empty.textContent = '当前项目还没有运行记录。';
        elements.projectRunList.appendChild(empty);
    } else {
        state.currentProjectRuns.forEach(run => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'project-browser-item';
            row.dataset.projectRunId = run.id;
            row.innerHTML = `
                <span class="project-browser-item-type">${run.status === 'success' ? '成功' : run.status === 'failed' ? '失败' : '运行'}</span>
                <span class="project-browser-item-title">${run.templateName || '任务模板'}</span>
            `;
            elements.projectRunList.appendChild(row);
        });
    }
}

function renderProjectTemplateBrowserContent() {
    if (!elements.projectTemplateList || !elements.projectRunList) {
        return;
    }

    elements.projectTemplateList.innerHTML = '';
    elements.projectRunList.innerHTML = '';

    if (!state.currentProjectTemplates?.length) {
        const empty = document.createElement('div');
        empty.className = 'project-browser-empty';
        empty.textContent = '当前项目还没有模板。';
        elements.projectTemplateList.appendChild(empty);
    } else {
        state.currentProjectTemplates.forEach(template => {
            const row = document.createElement('div');
            row.className = 'project-template-item';
            row.dataset.projectTemplateId = template.id;
            row.innerHTML = `
                <button type="button" class="project-browser-item project-template-open" data-action="preview-template" data-template-id="${template.id}">
                    <span class="project-browser-item-type">模板</span>
                    <span class="project-browser-item-type project-browser-item-mode">${getExecutionModeLabel(template.executionMode || 'foreground')}</span>
                    <span class="project-browser-item-title">${template.name}</span>
                </button>
                <button type="button" class="project-template-run-btn" data-action="run-template" data-template-id="${template.id}">运行</button>
            `;
            elements.projectTemplateList.appendChild(row);
        });
    }

    if (!state.currentProjectRuns?.length) {
        const empty = document.createElement('div');
        empty.className = 'project-browser-empty';
        empty.textContent = '当前项目还没有运行记录。';
        elements.projectRunList.appendChild(empty);
    } else {
        state.currentProjectRuns.forEach(run => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'project-browser-item';
            row.dataset.projectRunId = run.id;
            row.innerHTML = `
                <span class="project-browser-item-type">${run.status === 'success' ? '成功' : run.status === 'failed' ? '失败' : run.status === 'needs_input' ? '等待输入' : '运行'}</span>
                <span class="project-browser-item-type project-browser-item-mode">${getExecutionModeLabel(run.executionMode || run.outputs?.executionMode || 'foreground')}</span>
                <span class="project-browser-item-title">${run.templateName || '任务模板'}</span>
            `;
            elements.projectRunList.appendChild(row);
        });
    }
}

async function handleProjectTemplateBrowserClick(event) {
    const runButton = event.target.closest('[data-action="run-template"][data-template-id]');
    if (runButton) {
        event.preventDefault();
        const templateId = runButton.dataset.templateId;
        const template = state.currentProjectTemplates?.find(entry => entry.id === templateId);
        if (!template) {
            return;
        }
        closeProjectTemplateBrowser();
        openProjectPreview(template);
        await runTemplateFromPreviewRecord();
        return;
    }

    const previewButton = event.target.closest('[data-action="preview-template"][data-template-id]');
    if (previewButton) {
        const template = state.currentProjectTemplates?.find(entry => entry.id === previewButton.dataset.templateId);
        if (template) {
            closeProjectTemplateBrowser();
            openProjectPreview(template);
        }
        return;
    }

    const runRow = event.target.closest('.project-browser-item[data-project-run-id]');
    if (!runRow) {
        return;
    }
    const record = state.currentProjectRuns?.find(entry => entry.id === runRow.dataset.projectRunId);
    if (!record) {
        return;
    }
    closeProjectTemplateBrowser();
    openProjectPreview(record);
}

function handleProjectSummaryItemClick(event) {
    const item = event.target.closest('.project-summary-item[data-project-item-id]');
    if (!item) {
        return;
    }
    openProjectPreview(item.dataset.projectItemId);
}

function handleProjectBrowserClick(event) {
    handleProjectBrowserClickLegacyV2(event);
}

async function createTemplateFromPreviewRecordLegacy() {
    const record = state.currentProjectPreviewRecord;
    if (!record || record.type !== 'automation_recording') {
        return;
    }

    state.currentTemplateDraft = buildEditableTemplateFromRecording(
        record,
        `${record.title || '页面录制'}模板`
    );
    renderTemplateEditorModal();
    ensureTemplateEditorModal().classList.add('is-open');
    return;

    const suggestedName = `${record.title || '页面录制'}模板`;
    const name = window.prompt('请输入模板名称', suggestedName);
    if (!name) {
        return;
    }

    try {
        const result = await projectService.createTemplateFromRecording(record, { name });
        if (!result?.success) {
            throw new Error(result?.error || '模板创建失败');
        }
        await syncProjectStateFromService();
        showToastUI(`已创建模板：${result.template.name}`, 'success');
    } catch (error) {
        showToastUI(error.message || '模板创建失败', 'error');
    }
}

async function createTemplateFromPreviewRecord() {
    const record = state.currentProjectPreviewRecord;
    if (!record || record.type !== 'automation_recording') {
        return;
    }

    state.currentTemplateDraft = buildEditableTemplateFromRecording(
        record,
        `${record.title || '页面录制'}模板`
    );
    renderTemplateEditorModal();
    ensureTemplateEditorModal().classList.add('is-open');
    showToastUI('已打开模板编辑面板，请先配置所有输入项后再保存。', 'info');
}

async function resolveTemplateRunInputs(runResult) {
    let currentResult = runResult;
    while (currentResult?.run?.status === 'needs_input') {
        const requiredInputs = Array.isArray(currentResult.requiredInputs)
            ? currentResult.requiredInputs
            : (currentResult.run?.outputs?.requiredInputs || []);
        if (requiredInputs.length === 0) {
            break;
        }

        const inputPatch = {};
        for (const field of requiredInputs) {
            if (field.mode === 'file_upload' || field.mode === 'manual') {
                const confirmed = window.confirm(field.instructions || `请先完成步骤“${field.label || field.key}”，完成后点击确定继续。`);
                if (!confirmed) {
                    throw new Error('已取消继续执行模板');
                }
                inputPatch[field.key] = true;
                continue;
            }

            const value = window.prompt(field.label || '请输入运行时输入', '');
            if (value === null) {
                throw new Error('已取消继续执行模板');
            }
            inputPatch[field.key] = value;
        }

        currentResult = await projectService.resumeProjectRun(currentResult.run.id, inputPatch);
        await syncProjectStateFromService();
    }
    return currentResult;
}

async function runTemplateFromPreviewRecord() {
    const record = state.currentProjectPreviewRecord;
    if (!record || record.entityType !== 'template') {
        return;
    }

    try {
        let result = await projectService.executeProjectTemplate(record.id, {});
        await syncProjectStateFromService();
        result = await resolveTemplateRunInputs(result);
        await syncProjectStateFromService();
        if (result?.run) {
            const previewRun = {
                ...result.run,
                entityType: 'run',
                templateName: record.name
            };
            openProjectPreview(previewRun);
        }
        showToastUI(
            result?.run?.status === 'success'
                ? `模板已执行：${record.name}`
                : `模板执行失败：${record.name}`,
            result?.run?.status === 'success' ? 'success' : 'warning'
        );
    } catch (error) {
        showToastUI(error.message || '模板执行失败', 'error');
    }
}

function renderProjectSummaryLegacyV2(summary) {
    if (!elements.projectSummaryTitle || !elements.projectSummaryMeta || !elements.projectSummaryItems) {
        return;
    }

    if (!summary?.project) {
        elements.projectSummaryTitle.textContent = '未选择项目';
        elements.projectSummaryMeta.textContent = '项目素材 0 项';
        elements.projectSummaryItems.innerHTML = '<span class="project-summary-empty">还没有可展示的项目素材</span>';
        return;
    }

    elements.projectSummaryTitle.textContent = summary.project.name;

    const typeFragments = Object.entries(summary.typeCounts || {})
        .slice(0, 3)
        .map(([type, count]) => `${getProjectItemTypeLabel(type)} ${count}`);
    elements.projectSummaryMeta.textContent = typeFragments.length > 0
        ? `项目素材 ${summary.itemCount} 项 · ${typeFragments.join(' · ')}`
        : `项目素材 ${summary.itemCount} 项`;

    elements.projectSummaryItems.innerHTML = '';
    if (!summary.recentItems || summary.recentItems.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'project-summary-empty';
        empty.textContent = '当前项目还没有素材';
        elements.projectSummaryItems.appendChild(empty);
        return;
    }

    summary.recentItems.forEach(item => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'project-summary-item';
        chip.dataset.projectItemId = item.id;

        const type = document.createElement('span');
        type.className = 'project-summary-item-type';
        type.textContent = getProjectItemTypeLabel(item.type);

        const title = document.createElement('span');
        title.textContent = item.title;

        chip.appendChild(type);
        chip.appendChild(title);
        elements.projectSummaryItems.appendChild(chip);
    });
}

function getCurrentEditorFileRecord() {
    const editorApi = window.InfinPilotEditor;
    if (!editorApi?.getCurrentFileId || !editorApi?.getAllFiles) {
        return null;
    }

    const currentFileId = editorApi.getCurrentFileId();
    if (!currentFileId) {
        return null;
    }

    const files = editorApi.getAllFiles();
    return files.find(file => file.id === currentFileId) || null;
}

async function updateEditorProjectFileStatusLegacy() {
    if (!elements.editorProjectFileStatus || !elements.editorAddCurrentFileToProject) {
        return;
    }

    if (!state.currentProjectId) {
        elements.editorProjectFileStatus.textContent = '未选择项目';
        elements.editorAddCurrentFileToProject.disabled = true;
        return;
    }

    const currentFile = getCurrentEditorFileRecord();
    if (!currentFile) {
        elements.editorProjectFileStatus.textContent = '当前没有可加入项目的文件';
        elements.editorAddCurrentFileToProject.disabled = true;
        return;
    }

    const attached = await projectService.isEditorFileAttached(currentFile.id, state.currentProjectId);
    elements.editorProjectFileStatus.textContent = attached
        ? `已加入项目：${currentFile.name}`
        : '当前文件未加入项目';
    elements.editorAddCurrentFileToProject.disabled = attached;
}

async function handleCreateProjectLegacyV1() {
    const name = window.prompt('输入新项目名称', '新项目');
    if (name === null) {
        return;
    }

    const nextName = name.trim();
    if (!nextName) {
        showToastUI('项目名称不能为空', 'warning');
        return;
    }

    await projectService.createProject(nextName);
    await syncProjectStateFromService();
    showToastUI(`已创建项目：${nextName}`, 'success');
}

async function handleProjectSelectorChangeLegacy(event) {
    const projectId = event.target.value;
    if (!projectId || projectId === state.currentProjectId) {
        return;
    }

    const result = await projectService.switchProject(projectId);
    if (!result.success) {
        showToastUI(result.error || '切换项目失败', 'error');
        return;
    }

    await syncProjectStateFromService();
}

async function handleAddCurrentEditorFileToProjectLegacy() {
    const currentFile = getCurrentEditorFileRecord();
    if (!currentFile) {
        showToastUI('当前没有可加入项目的文件', 'warning');
        return;
    }

    const result = await projectService.addEditorFileReference(currentFile, state.currentProjectId);
    if (!result.success) {
        showToastUI(result.error || '加入项目失败', 'error');
        return;
    }

    await syncProjectStateFromService();
    showToastUI(`已加入项目：${currentFile.name}`, 'success');
}

async function updateEditorProjectFileStatus() {
    if (!elements.editorProjectFileStatus || !elements.editorAddCurrentFileToProject) {
        return;
    }

    if (!state.currentProjectId) {
        elements.editorProjectFileStatus.textContent = '未选择项目';
        elements.editorAddCurrentFileToProject.disabled = true;
        return;
    }

    const currentFile = getCurrentEditorFileRecord();
    if (!currentFile) {
        elements.editorProjectFileStatus.textContent = '当前没有可加入项目的文件';
        elements.editorAddCurrentFileToProject.disabled = true;
        return;
    }

    const attached = await projectService.isEditorFileAttached(currentFile.id, state.currentProjectId);
    elements.editorProjectFileStatus.textContent = attached
        ? `已加入项目：${currentFile.name}`
        : '当前文件未加入项目';
    elements.editorAddCurrentFileToProject.disabled = attached;
}

async function handleCreateProjectLegacyV2() {
    const name = window.prompt('输入新项目名称', '新项目');
    if (name === null) {
        return;
    }

    const nextName = name.trim();
    if (!nextName) {
        showToastUI('项目名称不能为空', 'warning');
        return;
    }

    await projectService.createProject(nextName);
    await syncProjectStateFromService();
    showToastUI(`已创建项目：${nextName}`, 'success');
}

function parseSelectionIndices(input, max) {
    if (!input || !input.trim()) {
        return [];
    }

    return Array.from(new Set(
        input
            .split(/[\s,，]+/)
            .map((value) => Number.parseInt(value, 10) - 1)
            .filter((value) => Number.isInteger(value) && value >= 0 && value < max)
    ));
}

async function promptTargetProjectSelection(actionLabel, currentProjectId = null) {
    const projects = (await projectService.listProjects()).filter((project) => project.id !== currentProjectId);
    if (projects.length === 0) {
        showToastUI('没有其他可选项目', 'warning');
        return null;
    }

    const answer = window.prompt(
        `${actionLabel}：请选择目标项目编号\n${projects.map((project, index) => `${index + 1}. ${project.name}`).join('\n')}`,
        '1'
    );
    if (answer === null) {
        return null;
    }

    const selectedIndex = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= projects.length) {
        showToastUI('无效的项目编号', 'warning');
        return null;
    }

    return projects[selectedIndex];
}

async function collectProjectImportSelections() {
    const [publicResources, resourceBundles] = await Promise.all([
        projectService.listPublicResources(),
        projectService.listResourceBundles()
    ]);

    let selectedBundleIds = [];
    let selectedResourceIds = [];

    if (resourceBundles.length > 0) {
        const bundleAnswer = window.prompt(
            `可选资源包，输入编号可一键导入，多个编号用逗号分隔。\n${resourceBundles.map((bundle, index) => `${index + 1}. ${bundle.name} (${bundle.resourceIds.length} 项)`).join('\n')}`,
            ''
        );
        if (bundleAnswer === null) {
            return null;
        }
        selectedBundleIds = parseSelectionIndices(bundleAnswer, resourceBundles.length).map((index) => resourceBundles[index].id);
    }

    if (publicResources.length > 0) {
        const resourceAnswer = window.prompt(
            `可选公共资源，输入编号导入，多个编号用逗号分隔。\n${publicResources.map((resource, index) => `${index + 1}. [${resource.entityType === 'template' ? '模板' : getProjectItemTypeLabel(resource.type)}] ${resource.title}`).join('\n')}`,
            ''
        );
        if (resourceAnswer === null) {
            return null;
        }
        selectedResourceIds = parseSelectionIndices(resourceAnswer, publicResources.length).map((index) => publicResources[index].id);
    }

    return {
        publicResourceIds: selectedResourceIds,
        bundleIds: selectedBundleIds
    };
}

async function handlePublicResourceLibrary() {
    const [publicResources, resourceBundles] = await Promise.all([
        projectService.listPublicResources(),
        projectService.listResourceBundles()
    ]);

    const action = window.prompt(
        [
            '公共资源管理：',
            '1. 从公共资源创建资源包',
            '2. 删除公共资源',
            '3. 删除资源包',
            '',
            `公共资源：${publicResources.length} 个`,
            `资源包：${resourceBundles.length} 个`
        ].join('\n'),
        '1'
    );
    if (action === null) {
        return;
    }

    if (action === '1') {
        if (publicResources.length === 0) {
            showToastUI('当前没有公共资源可用于创建资源包', 'warning');
            return;
        }
        const selection = window.prompt(
            `选择要放入资源包的公共资源编号，多个编号用逗号分隔。\n${publicResources.map((resource, index) => `${index + 1}. [${resource.entityType === 'template' ? '模板' : getProjectItemTypeLabel(resource.type)}] ${resource.title}`).join('\n')}`,
            ''
        );
        if (selection === null) {
            return;
        }
        const resourceIds = parseSelectionIndices(selection, publicResources.length).map((index) => publicResources[index].id);
        const name = window.prompt('输入资源包名称', '新资源包');
        if (!name) {
            return;
        }
        const result = await projectService.createResourceBundle(name, resourceIds);
        if (!result.success) {
            showToastUI(result.error || '创建资源包失败', 'error');
            return;
        }
        await syncProjectStateFromService();
        showToastUI(`已创建资源包：${result.bundle.name}`, 'success');
        return;
    }

    if (action === '2') {
        if (publicResources.length === 0) {
            showToastUI('当前没有公共资源', 'warning');
            return;
        }
        const selection = window.prompt(
            `选择要删除的公共资源编号。\n${publicResources.map((resource, index) => `${index + 1}. ${resource.title}`).join('\n')}`,
            '1'
        );
        if (selection === null) {
            return;
        }
        const indices = parseSelectionIndices(selection, publicResources.length);
        if (indices.length === 0) {
            showToastUI('未选择有效公共资源', 'warning');
            return;
        }
        await Promise.all(indices.map((index) => projectService.removePublicResource(publicResources[index].id)));
        await syncProjectStateFromService();
        showToastUI('已删除所选公共资源', 'success');
        return;
    }

    if (action === '3') {
        if (resourceBundles.length === 0) {
            showToastUI('当前没有资源包', 'warning');
            return;
        }
        const selection = window.prompt(
            `选择要删除的资源包编号。\n${resourceBundles.map((bundle, index) => `${index + 1}. ${bundle.name}`).join('\n')}`,
            '1'
        );
        if (selection === null) {
            return;
        }
        const indices = parseSelectionIndices(selection, resourceBundles.length);
        if (indices.length === 0) {
            showToastUI('未选择有效资源包', 'warning');
            return;
        }
        await Promise.all(indices.map((index) => projectService.deleteResourceBundle(resourceBundles[index].id)));
        await syncProjectStateFromService();
        showToastUI('已删除所选资源包', 'success');
    }
}

async function handleCreateProject() {
    const name = window.prompt('输入新项目名称', '新项目');
    if (name === null) {
        return;
    }

    const nextName = name.trim();
    if (!nextName) {
        showToastUI('项目名称不能为空', 'warning');
        return;
    }

    const selections = await collectProjectImportSelections();
    if (selections === null) {
        return;
    }

    await projectService.createProject(nextName, '', selections);
    await syncProjectStateFromService();
    showToastUI(`已创建项目：${nextName}`, 'success');
}

async function handleProjectSelectorChange(event) {
    const projectId = event.target.value;
    if (!projectId || projectId === state.currentProjectId) {
        return;
    }

    const result = await projectService.switchProject(projectId);
    if (!result.success) {
        showToastUI(result.error || '切换项目失败', 'error');
        return;
    }

    await syncProjectStateFromService();
}

async function handleAddCurrentEditorFileToProject() {
    const currentFile = getCurrentEditorFileRecord();
    if (!currentFile) {
        showToastUI('当前没有可加入项目的文件', 'warning');
        return;
    }

    const result = await projectService.addEditorFileReference(currentFile, state.currentProjectId);
    if (!result.success) {
        showToastUI(result.error || '加入项目失败', 'error');
        return;
    }

    await syncProjectStateFromService();
    showToastUI(`已加入项目：${currentFile.name}`, 'success');
}

async function handleSavePageToProject() {
    const projectId = await ensureCurrentProjectSelection('保存页面');
    if (!projectId) {
        return;
    }

    try {
        const response = await requestProjectAction({ action: 'project.capturePage' });
        await projectService.addProjectItem({
            projectId,
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

        await syncProjectStateFromService();
        showToastUI(`已保存页面到项目：${response.title || '未命名页面'}`, 'success');
    } catch (error) {
        showToastUI(error.message || '保存页面失败', 'error');
    }
}

async function handleExtractPatternToProject(pattern) {
    const projectId = await ensureCurrentProjectSelection(`提取${pattern === 'table' ? '表格' : '文章'}`);
    if (!projectId) {
        return;
    }

    try {
        const response = await requestProjectAction({ action: 'project.extractElements', pattern });
        await projectService.addProjectItem({
            projectId,
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

        await syncProjectStateFromService();
        showToastUI(`已提取${pattern === 'table' ? '表格' : '文章'}到项目`, 'success');
    } catch (error) {
        showToastUI(error.message || '提取失败', 'error');
    }
}

// --- Event Listener Setup ---
function setupEventListeners() {
    // Footer Tabs
    elements.tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.dataset.tab;
            // 新增：在切换标签页前关闭标签页选择弹窗
            closeTabSelectionPopupUIFromMain();
            // 调用 ui.js 中的 switchTab (假设 switchTab 是一个可访问的函数，或者这部分逻辑在 main.js 中)
            switchTab(tabId, elements, (subTab) => switchSettingsSubTab(subTab, elements));
            setThemeButtonVisibility(tabId, elements); // Update button visibility on tab switch

            // Refresh editor if it's being switched to
            if (tabId === 'editor' && window.InfinPilotEditor?.refresh) {
                window.InfinPilotEditor.refresh();
            }

            // 额外的安全检查：确保主题按钮在聊天界面被隐藏
            if (tabId === 'chat' && elements.themeToggleBtnSettings) {
                elements.themeToggleBtnSettings.style.display = 'none';
                elements.themeToggleBtnSettings.style.visibility = 'hidden';
            }

            // 新增：如果切换到聊天标签页，则聚焦输入框
            if (tabId === 'chat' && elements.userInput) {
                // 使用 setTimeout 确保在标签页内容完全显示后再聚焦
                setTimeout(() => elements.userInput.focus(), 50);
                // console.log("User input focused on tab switch to chat (from main.js event listener).");
            }
        });
    });

    // Settings Sub-Tabs
    elements.settingsNavBtns.forEach(btn => {
        btn.addEventListener('click', () => switchSettingsSubTab(btn.dataset.subtab, elements));
    });

    // Chat Actions
    elements.sendMessage.addEventListener('click', sendUserMessageTrigger); // Initial listener
    elements.userInput.addEventListener('keydown', handleUserInputKeydown);
    // 新增：监听用户输入框的 input 事件，用于检测 "@"
    elements.userInput.addEventListener('input', handleUserInputForTabSelection);
    elements.clearContextBtn.addEventListener('click', async () => {
        await clearContextAction(state, elements, clearImagesUI, clearVideosUI, showToastUI, currentTranslations);
        // Also clear the UI for selected tabs
        state.selectedContextTabs = [];
        updateSelectedTabsBarFromMain();
    });

    // Add listener for the history button
    const chatHistoryBtn = document.getElementById('chat-history-btn');
    if (chatHistoryBtn) {
        elements.chatHistoryBtn = chatHistoryBtn; // Ensure the elements object is updated
        chatHistoryBtn.addEventListener('click', () => {
            showHistoryModal(elements, currentTranslations, loadChatSessionUI, deleteChatSessionUI);
        });
    }

    elements.chatModelSelection.addEventListener('change', handleChatModelChange);
    elements.chatAgentSelection.addEventListener('change', handleChatAgentChange);

    if (elements.projectSelector) {
        elements.projectSelector.addEventListener('change', handleProjectSelectorChange);
    }
    if (elements.editorProjectSelector) {
        elements.editorProjectSelector.addEventListener('change', handleProjectSelectorChange);
    }
    if (elements.projectCreateBtn) {
        elements.projectCreateBtn.addEventListener('click', handleCreateProject);
    }
    if (elements.editorProjectCreateBtn) {
        elements.editorProjectCreateBtn.addEventListener('click', handleCreateProject);
    }
    if (elements.projectRefreshBtn) {
        elements.projectRefreshBtn.addEventListener('click', () => syncProjectStateFromService());
    }
    if (elements.projectSummaryBrowseBtn) {
        elements.projectSummaryBrowseBtn.addEventListener('click', openProjectBrowser);
    }
    if (elements.projectSummaryPublicBtn) {
        elements.projectSummaryPublicBtn.addEventListener('click', handlePublicResourceLibrary);
    }
    if (elements.projectSummaryTemplatesBtn) {
        elements.projectSummaryTemplatesBtn.addEventListener('click', openProjectTemplateBrowser);
    }
    if (elements.projectSummaryItems) {
        elements.projectSummaryItems.addEventListener('click', handleProjectSummaryItemClick);
    }
    if (elements.editorAddCurrentFileToProject) {
        elements.editorAddCurrentFileToProject.addEventListener('click', handleAddCurrentEditorFileToProject);
    }

    if (elements.dbSelector) {
        elements.dbSelector.addEventListener('change', (e) => {
            browser.storage.session.set({ selectedDbId: e.target.value });
            console.log(`Selected Knowledge Base ID: ${e.target.value}`);
        });
    }

    // 新增：监听由 ui.js 触发的弹窗关闭事件，以同步状态
    document.addEventListener('tabPopupManuallyClosed', () => {
        if (state.isTabSelectionPopupOpen) {
            state.isTabSelectionPopupOpen = false;
            console.log("Tab selection popup closed via custom event, state updated.");
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeProjectPreview();
            closeProjectBrowser();
            closeProjectTemplateBrowser();
        }
    });

    // 获取页面内容按钮事件 (只获取内容)
    if (elements.fetchPageContent) {
        elements.fetchPageContent.addEventListener('click', async () => {
            await requestPageContent(); // This function already provides user feedback.
        });
    }
    if (elements.savePageToProject) {
        elements.savePageToProject.addEventListener('click', handleSavePageToProject);
    }
    if (elements.extractArticleToProject) {
        elements.extractArticleToProject.addEventListener('click', () => handleExtractPatternToProject('article'));
    }
    if (elements.extractTableToProject) {
        elements.extractTableToProject.addEventListener('click', () => handleExtractPatternToProject('table'));
    }
    if (elements.extractFaqToProject) {
        elements.extractFaqToProject.addEventListener('click', () => handleExtractPatternToProject('faq'));
    }
    if (elements.extractProductToProject) {
        elements.extractProductToProject.addEventListener('click', () => handleExtractPatternToProject('product'));
    }
    if (elements.extractTimelineToProject) {
        elements.extractTimelineToProject.addEventListener('click', () => handleExtractPatternToProject('timeline'));
    }
    if (elements.projectBrowserList) {
        elements.projectBrowserList.addEventListener('click', handleProjectBrowserClick);
    }
    if (elements.projectTemplateList) {
        elements.projectTemplateList.addEventListener('click', handleProjectTemplateBrowserClick);
    }
    if (elements.projectRunList) {
        elements.projectRunList.addEventListener('click', handleProjectTemplateBrowserClick);
    }

    // 添加内容到知识库按钮事件
    const addContentToDbBtn = document.getElementById('add-content-to-db-btn'); // REVERT: Reverted to original button ID
    if (addContentToDbBtn) {
        addContentToDbBtn.addEventListener('click', async () => {
            const selectedDbId = elements.dbSelector.value;
            const content = state.pageContext; // Read content from state

            if (!selectedDbId || selectedDbId === 'null') {
                showToastUI('Please select a knowledge base first', 'error'); // TODO: i18n
                return;
            }

            if (!content || content === 'error' || !content.trim()) {
                showToastUI('There is no page content to add', 'warning'); // TODO: i18n
                return;
            }

            try {
                // Get page URL from background script or state
                const tabs = await browser.tabs.query({ active: true, currentWindow: true });
                const sourceUrl = tabs[0]?.url || 'Manual Input';
                await vectorDB.addDocument(parseInt(selectedDbId, 10), content, sourceUrl);
                showToastUI('Content added to knowledge base', 'success'); // TODO: i18n
            } catch (error) {
                console.error('Failed to add content to DB:', error);
                showToastUI('Failed to add content to knowledge base', 'error'); // TODO: i18n
            }
        });
    }
    
    // Summarize按钮事件
    if (elements.summarizeButton) {
        elements.summarizeButton.addEventListener('click', () => {
            // 触发一个快捷操作 - 总结页面
            if (window.triggerQuickAction) {
                // 使用默认的总结快捷操作ID
                window.triggerQuickAction('default-summarize', _('summarizeAction', {}, currentTranslations), false);
            } else {
                console.warn('Quick action trigger function not available');
            }
        });
    }
    
    // Mermaid按钮事件
    if (elements.mermaidBtn) {
        elements.mermaidBtn.addEventListener('click', () => {
            // 触发一个快捷操作 - 生成Mermaid图表
            if (window.triggerQuickAction) {
                // 使用默认的mermaid快捷操作ID
                window.triggerQuickAction('default-mermaid', _('defaultQuickActionMermaid', {}, currentTranslations), false);
            } else {
                console.warn('Quick action trigger function not available');
            }
        });
    }

    // Image Handling
    elements.uploadImage.addEventListener('click', () => elements.fileInput.click());
    elements.fileInputBtn.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', (e) => handleImageSelect(e, (file) => handleImageFile(file, state, updateImagesPreviewUI), elements));
    elements.closeModal.addEventListener('click', () => hideImageModal(elements));
    window.addEventListener('click', (e) => { if (e.target === elements.imageModal) hideImageModal(elements); }); // Close modal on overlay click

    // YouTube Video Handling
    elements.addYoutubeUrl.addEventListener('click', () => showYouTubeDialog(elements));
    elements.cancelYoutube.addEventListener('click', () => hideYouTubeDialog(elements));
    elements.confirmYoutube.addEventListener('click', () => {
        const url = elements.youtubeUrlInput.value.trim();
        if (url) {
            handleYouTubeUrl(url, state, updateVideosPreviewUI, currentTranslations);
            hideYouTubeDialog(elements);
        }
    });
    elements.youtubeUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            elements.confirmYoutube.click();
        }
    });
    window.addEventListener('click', (e) => { if (e.target === elements.youtubeUrlDialog) hideYouTubeDialog(elements); }); // Close dialog on overlay click

    // Mermaid Modal
    elements.mermaidCloseModal.addEventListener('click', () => hideMermaidModal(elements));
    elements.mermaidModal.addEventListener('click', (e) => { if (e.target === elements.mermaidModal) hideMermaidModal(elements); });

    // Settings Actions
    // Removed discover models button event listener



    // 多供应商模式下，API Key 可见性切换由 setupProviderEventListeners 处理
    // elements.toggleApiKey.addEventListener('click', () => toggleApiKeyVisibility(elements));
    elements.languageSelect.addEventListener('change', () => handleLanguageChange(state, elements, loadAndApplyTranslations, showToastUI, currentTranslations));
    elements.exportChatHistoryBtn.addEventListener('click', () => handleExportChat(state, elements, showToastUI, currentTranslations));

    // Proxy Address Change
    if (elements.proxyAddressInput) {
        elements.proxyAddressInput.addEventListener('blur', () => handleProxyAddressChange(state, elements, showToastUI, currentTranslations));
        elements.proxyAddressInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                elements.proxyAddressInput.blur(); // Trigger blur event to save
            }
        });
    }

    // Proxy Test Button
    if (elements.testProxyBtn) {
        elements.testProxyBtn.addEventListener('click', () => handleProxyTest(state, elements, showToastUI, currentTranslations));
    }

    // Unified Import/Export
    if (elements.exportAllSettingsBtn) {
        elements.exportAllSettingsBtn.addEventListener('click', () => handleUnifiedExport(showToastUI, currentTranslations));
    }
    if (elements.importAllSettingsBtn) {
        elements.importAllSettingsBtn.addEventListener('click', () => {
            elements.unifiedImportInput.click();
        });
    }
    if (elements.unifiedImportInput) {
        elements.unifiedImportInput.addEventListener('change', (e) => handleUnifiedImport(e, showToastUI, currentTranslations));
    }

    // Agent Actions
    elements.addNewAgent.addEventListener('click', () => createNewAgent(state, updateAgentsListUIAllArgs, updateAgentSelectionInChatUI, saveAgentsListState, showToastUI, currentTranslations));
    elements.importAgentsBtn.addEventListener('click', () => elements.importAgentInput.click());
    elements.importAgentInput.addEventListener('change', (e) => handleAgentImport(e, state, saveAgentsListState, updateAgentsListUIAllArgs, updateAgentSelectionInChatUI, saveCurrentAgentIdState, showToastUI, currentTranslations));
    elements.exportAgentsBtn.addEventListener('click', () => handleAgentExport(state, showToastUI, currentTranslations));
    // Re-resolve elements in case dialog was reconstructed
    elements.deleteConfirmDialog = document.getElementById('delete-confirm-dialog');
    elements.confirmDelete = document.getElementById('confirm-delete');
    elements.cancelDelete = document.getElementById('cancel-delete');
    if (elements.cancelDelete) {
        elements.cancelDelete.addEventListener('click', () => { if (elements.deleteConfirmDialog) elements.deleteConfirmDialog.style.display = 'none'; });
    }
    if (elements.confirmDelete) {
        elements.confirmDelete.addEventListener('click', () => confirmDeleteAgent(state, elements, updateAgentsListUIAllArgs, updateAgentSelectionInChatUI, saveAgentsListState, showToastUI, currentTranslations));
    }
    window.addEventListener('click', (e) => { if (e.target === elements.deleteConfirmDialog) elements.deleteConfirmDialog.style.display = 'none'; }); // Close delete confirm on overlay click

    // Panel Closing with smarter Escape handling
    elements.closePanelBtnChat.addEventListener('click', closePanel);
    elements.closePanelBtnSettings.addEventListener('click', closePanel);

    // Automation toggle button
    if (elements.automationToggleBtn) {
        elements.automationToggleBtn.addEventListener('click', async () => {
            // 使用统一的更新函数
            if (window.updateButtonStates) {
                const isActive = elements.automationToggleBtn.classList.contains('automation-on') || elements.automationToggleBtn.classList.contains('active');
                window.updateButtonStates(!isActive, false, false);
                const _ = (key) => (window.i18n && window.i18n[key]) || key;
                showToastUI(!isActive ? _('automationToggleOn') : _('automationToggleOff'), 'info');
            } else {
                // 回退到原来的逻辑
                state.automationEnabled = !state.automationEnabled;
                document.body.classList.toggle('automation-mode', state.automationEnabled);
                try {
                    await browser.storage.sync.set({ automationEnabled: state.automationEnabled });
                } catch (e) {
                    console.warn('[main.js] Failed to save automationEnabled:', e);
                }
                updateAutomationToggleUI();
                showToastUI(state.automationEnabled ? _('automationToggleOn') : _('automationToggleOff'), 'info');
            }
        });
    }

    if (elements.collectiveResearchBtn) {
        elements.collectiveResearchBtn.addEventListener('click', () => {
            if (!window.updateButtonStates) return;

            const automationBtn = elements.automationToggleBtn || document.getElementById('automation-toggle-btn');
            const collectiveBtn = elements.collectiveResearchBtn || document.getElementById('collective-research-btn');
            const isAutomationActive = Boolean(automationBtn && (automationBtn.classList.contains('automation-on') || automationBtn.classList.contains('active')));
            const isCollectiveActive = Boolean(collectiveBtn && collectiveBtn.classList.contains('active'));

            if (!isAutomationActive) {
                window.updateButtonStates(true, false, true);
                return;
            }

            if (isCollectiveActive) {
                window.updateButtonStates(true, false, false);
            } else {
                window.updateButtonStates(true, false, true);
            }
        });
    }

    // Add to DB button listener
    elements.chatMessages.addEventListener('click', async (e) => {
        if (e.target.closest('.add-to-db-btn')) {
            const messageElement = e.target.closest('.message');
            const messageId = messageElement.dataset.messageId;
            const selectedDbId = elements.dbSelector.value;

            if (!selectedDbId || selectedDbId === 'null') {
                showToastUI('Please select a knowledge base first', 'error'); // TODO: i18n
                return;
            }

            const message = state.chatHistory.find(m => m.id === messageId);
            if (message && message.parts) {
                const textContent = message.parts.map(p => p.text || '').join('\n');
                if (textContent.trim()) {
                    try {
                        await vectorDB.addDocument(parseInt(selectedDbId, 10), textContent, 'Chat History');
                        showToastUI('Added to knowledge base', 'success'); // TODO: i18n
                    } catch (error) {
                        console.error('Failed to add document to DB:', error);
                        showToastUI('Failed to add to knowledge base', 'error'); // TODO: i18n
                    }
                }
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // If any modal/popup is open, close that first and do not close the panel
        if (handleGlobalEscapeForModals()) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        // No modals open – allow Escape to close the panel
        closePanel();
    });

    // Window Messages (from content script)
    window.addEventListener('message', handleContentScriptMessages);

    // Scroll Tracking
    if (elements.chatMessages) {
        elements.chatMessages.addEventListener('scroll', handleChatScroll);
    }

    // --- 多供应商模式下，API Key 保存逻辑由 setupProviderEventListeners 处理 ---
    // 旧的单一 API Key 自动保存逻辑已移除，现在由各个供应商的输入框独立处理

    // 设置多供应商事件监听器
    setupProviderEventListeners(state, elements, showToastUI, () => updateConnectionIndicator(state.isConnected, elements, currentTranslations));

    // Listen for changes to pinned actions
    document.addEventListener('infinpilot:pinnedActionsChanged', renderPinnedActionButtons);
}



// --- Event Handlers & Triggers ---

function handleUserInputKeydown(e) {
    // Check if the IME is composing text. If so, don't send the message.
    // The `isComposing` property is true during the composition session.
    // Pressing Enter to confirm an IME candidate will not trigger the send action.
    // 检查输入法是否正在输入（拼字）。如果是，则不发送消息。
    // `isComposing` 属性在输入法拼字期间为 true。
    // 按下回车键确认候选词时，不会触发发送操作。
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!state.isStreaming) {
            sendUserMessageTrigger();
        }
    }
    // 如果标签选择弹窗打开，并且按下了 Escape 键，则关闭弹窗
    if (state.isTabSelectionPopupOpen && e.key === 'Escape') {
        e.preventDefault();
        closeTabSelectionPopupUIFromMain();
    }
    // 如果标签选择弹窗打开，并且按下了 Tab 键或箭头键，则阻止默认行为并处理导航
    if (state.isTabSelectionPopupOpen && (e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // e.preventDefault(); //  ui.js 中的 handlePopupKeyDown 会处理 preventDefault
        // navigateTabSelectionPopupUI(e.key); // 这个UI函数将在后面步骤定义
    }
}

// 新增：处理用户输入以触发标签页选择
function handleUserInputForTabSelection(e) {
    const text = e.target.value;
    const cursorPos = e.target.selectionStart;
    const atCharIndex = text.lastIndexOf('@', cursorPos - 1);

    // 定义有效的标签页名称匹配字符：字母、数字、下划线、连字符
    const validTabNameCharRegex = /^[a-zA-Z0-9_-]*$/;

    if (atCharIndex !== -1) {
        const textAfterAt = text.substring(atCharIndex + 1, cursorPos);
        const textBeforeAt = text.substring(0, atCharIndex);

        // 检查 @ 符号是否在开头或前面有空格，并且 @ 后面没有空格
        const isValidTrigger = (atCharIndex === 0 || /\s$/.test(textBeforeAt)) && !/\s/.test(textAfterAt);

        if (isValidTrigger) {
            // 如果弹窗未打开，则尝试打开
            if (!state.isTabSelectionPopupOpen) {
                console.log('尝试打开标签页选择列表，触发字符: @');
                fetchAndShowTabsForSelection();
            }
            // 如果弹窗已打开，且 @ 后的内容不再是有效匹配字符，则关闭
            // 或者 @ 后的内容为空，且弹窗已打开，也关闭 (例如用户删除了 @ 后的所有内容)
            if (state.isTabSelectionPopupOpen && !validTabNameCharRegex.test(textAfterAt)) {
                closeTabSelectionPopupUIFromMain();
            }
        } else if (state.isTabSelectionPopupOpen) {
            // 如果 @ 符号不再是有效触发条件（例如 @ 后面有空格），则关闭弹窗
            closeTabSelectionPopupUIFromMain();
        }
    } else if (state.isTabSelectionPopupOpen) {
        // 如果输入框中不再有 @ 符号，且弹窗是打开的，则关闭弹窗
        closeTabSelectionPopupUIFromMain();
    }
}

// 新增：获取并显示标签页以供选择
async function fetchAndShowTabsForSelection() {
    if (state.isStreaming) return; 

    try {
        const tabs = await browser.tabs.query({});
        const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
        const activeTabId = activeTabs && activeTabs.length > 0 ? activeTabs[0].id : null;
        if (tabs && tabs.length > 0) {
            const currentExtensionId = browser.runtime.id;
            state.availableTabsForSelection = tabs.filter(tab => 
                tab.id && 
                tab.url && 
                !tab.url.startsWith(`chrome-extension://${currentExtensionId}`) &&
                !tab.url.startsWith('chrome://') &&
                !tab.url.startsWith('about:') &&
                !tab.url.startsWith('edge://') &&
                tab.id !== activeTabId // 忽略当前页面，避免冗余
            ).map(tab => ({
                id: tab.id,
                title: tab.title || 'Untitled Tab',
                url: tab.url,
                favIconUrl: tab.favIconUrl || '../magic.png' 
            }));

            if (state.availableTabsForSelection.length > 0) {
                // 调用UI函数显示弹窗（多选） 
                showTabSelectionPopupUI(state.availableTabsForSelection, handleTabsSelectedFromPopup, elements, currentTranslations);
                state.isTabSelectionPopupOpen = true;
            } else {
                state.availableTabsForSelection = [];
                state.isTabSelectionPopupOpen = false;
            }
        } else {
            state.availableTabsForSelection = [];
            state.isTabSelectionPopupOpen = false;
        }
    } catch (error) {
        console.error('Error querying tabs:', error);
        state.availableTabsForSelection = [];
        state.isTabSelectionPopupOpen = false;
        if (showToastUI) showToastUI('获取标签页列表失败', 'error');
    }
}

// 新增：处理从弹窗中选择标签页的回调
function handleTabSelectedFromPopup(selectedTab) {
    if (!selectedTab) {
        // state.isTabSelectionPopupOpen = false; // closeTabSelectionPopupUIFromMain 会处理
        closeTabSelectionPopupUIFromMain(); // <--- Ensure state is updated if no tab selected (e.g. Esc)
        return;
    }

    console.log('Tab selected:', selectedTab);
    // state.isTabSelectionPopupOpen = false; // closeTabSelectionPopupUIFromMain 会处理
    closeTabSelectionPopupUIFromMain(); // <--- MODIFIED HERE (called by ui.js click handler, but ensure state sync) 
    
    const currentText = elements.userInput.value;
    const cursorPos = elements.userInput.selectionStart;
    const atCharIndex = currentText.lastIndexOf('@', cursorPos -1);
    if (atCharIndex !== -1) {
        elements.userInput.value = currentText.substring(0, atCharIndex); 
    }
    elements.userInput.focus(); 
    
    const isAlreadySelected = state.selectedContextTabs.some(tab => tab.id === selectedTab.id);
    if (isAlreadySelected) {
        if (showToastUI) showToastUI(`标签页 "${selectedTab.title.substring(0,20)}"... 已添加`, 'info');
        return;
    }

    const newSelectedTabEntry = { 
        id: selectedTab.id, 
        title: selectedTab.title, 
        url: selectedTab.url, 
        favIconUrl: selectedTab.favIconUrl,
        content: null, 
        isLoading: true,
        isContextSent: false
    };
    state.selectedContextTabs.push(newSelectedTabEntry);
    updateSelectedTabsBarUI(state.selectedContextTabs, elements, removeSelectedTabFromMain, currentTranslations); // <--- MODIFIED HERE (added removeSelectedTabFromMain)

    browser.runtime.sendMessage({ action: 'extractTabContent', tabId: selectedTab.id }, (response) => {
        const tabData = state.selectedContextTabs.find(t => t.id === selectedTab.id);
        if (tabData) {
            if (response.content && !response.error) {
                tabData.content = response.content;
                tabData.isLoading = false;
                tabData.error = false;
                console.log(`Content for tab ${selectedTab.id} loaded, length: ${response.content?.length}`);
                // 使用自定义类名调用 showToastUI
                showToastUI(_('tabContentLoadedSuccess', { title: tabData.title.substring(0, 20) }), 'success', 'toast-tab-loaded');
            } else {
                tabData.content = null; // 确保错误时内容为空
                tabData.isLoading = false;
                tabData.error = true;
                const errorMessage = response.error || _('unknownErrorLoadingTab', {}, currentTranslations);
                console.error(`Failed to load content for tab ${selectedTab.id}: ${errorMessage}`);
                // 使用自定义类名调用 showToastUI
                showToastUI(_('tabContentLoadFailed', { title: tabData.title.substring(0, 20), error: errorMessage }), 'error', 'toast-tab-loaded');
            }
            updateSelectedTabsBarUI(state.selectedContextTabs, elements, removeSelectedTabFromMain, currentTranslations); // 更新UI以反映加载/错误状态
        }
    });
}

// 新增：处理从弹窗中多选标签页的回调
function handleTabsSelectedFromPopup(selectedTabs) {
    if (!Array.isArray(selectedTabs) || selectedTabs.length === 0) {
        closeTabSelectionPopupUIFromMain();
        return;
    }

    // 关闭弹窗并同步状态
    closeTabSelectionPopupUIFromMain();

    // 移除输入框中最后一个 '@' 及其后内容
    const currentText = elements.userInput.value;
    const cursorPos = elements.userInput.selectionStart;
    const atCharIndex = currentText.lastIndexOf('@', cursorPos - 1);
    if (atCharIndex !== -1) {
        elements.userInput.value = currentText.substring(0, atCharIndex);
    }
    elements.userInput.focus();

    // 逐个加入到选中列表
    const suppressPerTabSuccessToast = selectedTabs.length > 1; // 多选时仅显示汇总提示，抑制单条成功提示
    let addedCount = 0;
    selectedTabs.forEach((tab) => {
        const isAlreadySelected = state.selectedContextTabs.some(t => t.id === tab.id);
        if (isAlreadySelected) return;

        const newSelectedTabEntry = {
            id: tab.id,
            title: tab.title,
            url: tab.url,
            favIconUrl: tab.favIconUrl,
            content: null,
            isLoading: true,
            isContextSent: false
        };
        state.selectedContextTabs.push(newSelectedTabEntry);
        addedCount++;

        browser.runtime.sendMessage({ action: 'extractTabContent', tabId: tab.id }, (response) => {
            const tabData = state.selectedContextTabs.find(t => t.id === tab.id);
            if (tabData) {
                if (response && response.content && !response.error) {
                    tabData.content = response.content;
                    tabData.isLoading = false;
                    tabData.error = false;
                    if (!suppressPerTabSuccessToast) {
                        showToastUI(_('tabContentLoadedSuccess', { title: tabData.title.substring(0, 20) }), 'success', 'toast-tab-loaded');
                    }
                } else {
                    tabData.content = null;
                    tabData.isLoading = false;
                    tabData.error = true;
                    const errorMessage = response?.error || _('unknownErrorLoadingTab', {}, currentTranslations);
                    console.error(`Failed to load content for tab ${tab.id}: ${errorMessage}`);
                    showToastUI(_('tabContentLoadFailed', { title: tabData.title.substring(0, 20), error: errorMessage }), 'error', 'toast-tab-loaded');
                }
                updateSelectedTabsBarUI(state.selectedContextTabs, elements, removeSelectedTabFromMain, currentTranslations);
            }
        });
    });

    // 更新一次选中栏，显示 loading 状态
    if (addedCount > 0) {
        updateSelectedTabsBarUI(state.selectedContextTabs, elements, removeSelectedTabFromMain, currentTranslations);
        if (showToastUI && addedCount > 1) {
            showToastUI(_('tabsAddedSuccess', { count: addedCount }), 'info', 'toast-tabs-added');
        }
    }
}

// 后续步骤将定义:
// - showTabSelectionPopupUI (在ui.js)
// - closeTabSelectionPopupUI (在ui.js)
// - navigateTabSelectionPopupUI (在ui.js)
// - updateSelectedTabsBarUI (在ui.js)

function handleChatModelChange() {
    state.model = elements.chatModelSelection.value;
    // 同步设置页下拉（若存在）
    if (elements.modelSelection) {
        elements.modelSelection.value = state.model;
    }

    // 在多供应商模式下，只需要保存模型选择，不需要测试API Key
    browser.storage.sync.set({ model: state.model }, () => {
        if (browser.runtime.lastError) {
            console.error("Error saving model selection:", browser.runtime.lastError);
            showToastUI(_('saveFailedToast', { error: browser.runtime.lastError.message }, currentTranslations), 'error');
        } else {
            console.log(`Model selection saved: ${state.model}`);
        }
    });
}

function handleChatAgentChange() {
    switchAgentAndUpdateState(elements.chatAgentSelection.value);
}

function handleChatScroll() {
    const el = elements.chatMessages;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;

    if (state.isStreaming) {
        if (!atBottom && !state.userScrolledUpDuringStream) {
            // User scrolled up for the first time during this stream
            state.userScrolledUpDuringStream = true;
            console.log("User scrolled up during stream, auto-scroll disabled for this stream.");
        } else if (atBottom && state.userScrolledUpDuringStream) {
            // User scrolled back to bottom, re-enable auto-scroll
            state.userScrolledUpDuringStream = false;
            console.log("User scrolled back to bottom during stream, auto-scroll re-enabled.");
        }
    }
    isUserNearBottom = atBottom; // Keep this for non-streaming contexts or as a general flag
}

// Wrapper function to trigger sendUserMessage with all dependencies
function sendUserMessageTrigger() {
    // 若存在欢迎消息，先移除，避免占用顶部空间
    try {
        const welcome = elements.chatMessages && elements.chatMessages.querySelector('.welcome-message');
        if (welcome && welcome.parentNode) {
            welcome.parentNode.removeChild(welcome);
        }
    } catch (e) {
        console.warn('[main.js] Failed to remove welcome message before sending:', e);
    }

    // 添加发送动效
    if (elements.sendMessage) {
        elements.sendMessage.classList.add('sending');
        // 移除发送动效，让动画完成
        setTimeout(() => {
            if (elements.sendMessage) {
                elements.sendMessage.classList.remove('sending');
            }
        }, 600);
    }
    
    // 准备 sentContextTabs 数据 (只包含必要信息)
    const tabsForMessageBubble = state.selectedContextTabs.map(tab => ({
        title: tab.title,
        favIconUrl: tab.favIconUrl
        // 不传递 tab.content 或 tab.id 到气泡渲染中
    }));

    sendUserMessageAction(
        state, elements, currentTranslations,
        (msg, type) => showConnectionStatus(msg, type, elements), // showConnectionStatusCallback
        (content, sender, options) => { // Modified addMessageToChatCallback wrapper
            let messageOptions = {...options};
            if (sender === 'user' && tabsForMessageBubble.length > 0) {
                // tabsForBubbleDisplay should now include id, title, favIconUrl
                messageOptions.sentContextTabs = tabsForMessageBubble;
            }
            return addMessageToChatUI(content, sender, messageOptions);
        },
        (afterEl) => uiAddThinkingAnimation(afterEl, elements, isUserNearBottom), 
        () => resizeTextarea(elements), 
        clearImagesUI, 
        clearVideosUI, 
        showToastUI, 
        restoreSendButtonAndInputUI, 
        abortStreamingUI,
        updateSelectedTabsBarFromMain
    );
}

// Wrapper function to trigger abortStreaming
function abortStreamingUI() {
    abortStreamingAction(state, restoreSendButtonAndInputUI, showToastUI, currentTranslations);
}

// Wrapper function to restore send button UI
function restoreSendButtonAndInputUI() {
    restoreSendButtonAndInput(state, elements, currentTranslations, sendUserMessageTrigger, abortStreamingUI);
}

// Wrapper function for toggleTheme used by draggable button
function toggleThemeAndUpdate() {
    toggleTheme(state, elements, rerenderAllMermaidChartsUI);
}

// Wrapper function for rerenderAllMermaidCharts
function rerenderAllMermaidChartsUI() {
    rerenderAllMermaidCharts(elements);
}

// Wrapper function for updateAgentsListUI with all args
function updateAgentsListUIAllArgs() {
    updateAgentsListUI(state, elements, currentTranslations, autoSaveAgentSettings, showDeleteConfirmDialogUI, switchAgentAndUpdateState);
}

// Wrapper function for autoSaveAgentSettings in main.js
// This function is passed as a callback when updateAgentsListUI is called.
function autoSaveAgentSettings(agentId, agentItemElement) {
    // Call the aliased imported function from agent.js
    autoSaveAgentSettingsFromAgent(agentId, agentItemElement, state, saveAgentsListState, updateAgentSelectionInChatUI, showToastUI, currentTranslations);
}

// Wrapper function for showDeleteConfirmDialog
function showDeleteConfirmDialogUI(agentId) {
    showDeleteConfirmDialog(agentId, state, elements, currentTranslations);
}

// Wrapper function for switchAgent that also saves ID and updates state
function switchAgentAndUpdateState(agentId) {
    switchAgent(agentId, state, saveCurrentAgentIdState);
    // No need to explicitly call loadCurrentAgentSettingsIntoState here,
    // switchAgent internally calls it.
}

// Wrapper function for updateAgentSelectionInChat
function updateAgentSelectionInChatUI() {
    updateAgentSelectionInChat(state, elements, currentTranslations);
}

// Wrapper function for saveAgentsList
function saveAgentsListState() {
    saveAgentsList(state);
}

// Wrapper function for saveCurrentAgentId
function saveCurrentAgentIdState() {
    saveCurrentAgentId(state);
}

// Wrapper function for addMessageToChat
function addMessageToChatUI(content, sender, options) {
    // 将 isUserNearBottom 的当前值传递给 ui.js 中的 addMessageToChat
    // options 现在可能包含 sentContextTabs
    return addMessageToChat(content, sender, options, state, elements, currentTranslations, addCopyButtonToCodeBlockUI, addMessageActionButtonsUI, isUserNearBottom);
}

// Wrapper function for addCopyButtonToCodeBlock
function addCopyButtonToCodeBlockUI(block) {
    addCopyButtonToCodeBlock(block, currentTranslations, copyCodeToClipboard);
}

// Wrapper function for addMessageActionButtons
function addMessageActionButtonsUI(messageElement, content) {
    addMessageActionButtons(messageElement, content, currentTranslations, copyMessageContent, regenerateMessageUI, deleteMessageUI);
}

// Wrapper function for copyCodeToClipboard (handles feedback)
function copyCodeToClipboard(code, buttonElement) {
    if (isEmbeddedPanel) {
        window.parent.postMessage({ action: 'copyText', text: code }, '*');
    } else {
        void navigator.clipboard.writeText(code).catch((error) => {
            console.warn('[main.js] Failed to copy code via clipboard API:', error);
        });
    }
    showCopyCodeFeedback(buttonElement); // Show UI feedback
}

// Wrapper function for copyMessageContent (handles feedback)
function copyMessageContent(messageElement, originalContent, buttonElement) {
    const formattedContent = originalContent.replace(/\n/g, '\r\n');
    if (isEmbeddedPanel) {
        window.parent.postMessage({ action: 'copyText', text: formattedContent }, '*');
    } else {
        void navigator.clipboard.writeText(formattedContent).catch((error) => {
            console.warn('[main.js] Failed to copy message via clipboard API:', error);
        });
    }
    showCopyMessageFeedback(buttonElement); // Show UI feedback
}


// Wrapper function for regenerateMessage
function regenerateMessageUI(messageId) {
    regenerateMessageAction(
        messageId, state, elements, currentTranslations,
        addMessageToChatUI,
        (afterEl) => uiAddThinkingAnimation(afterEl, elements, isUserNearBottom),
        restoreSendButtonAndInputUI,
        abortStreamingUI,
        showToastUI,
        updateSelectedTabsBarFromMain
    );
}

// Wrapper function for deleteMessage
function deleteMessageUI(messageId) {
    deleteMessageAction(messageId, state);
}

// Wrapper function for clearImages
function clearImagesUI() {
    clearImages(state, updateImagesPreviewUI);
}

// Wrapper function for updateImagesPreview
function updateImagesPreviewUI() {
    updateImagesPreview(state, elements, currentTranslations, removeImageByIdUI);
}

// Wrapper function for removeImageById
function removeImageByIdUI(imageId) {
    removeImageById(imageId, state, updateImagesPreviewUI);
}

// Wrapper function for clearVideos
function clearVideosUI() {
    clearVideos(state, updateVideosPreviewUI);
}

// Wrapper function for updateVideosPreview
function updateVideosPreviewUI() {
    updateVideosPreview(state, elements, currentTranslations, removeVideoByIdUI);
}

// Wrapper function for removeVideoById
function removeVideoByIdUI(videoId) {
    removeVideoById(videoId, state, updateVideosPreviewUI);
}

// Wrapper function for showToast
function showToastUI(message, type, customClass = '') {
    showToast(message, type, customClass);
}

// --- Chat History Wrappers ---
function loadChatSessionUI(sessionId) {
    loadChatSession(sessionId, state, elements, addMessageToChatUI, (showToast) => clearContextAction(state, elements, clearImagesUI, clearVideosUI, showToastUI, currentTranslations, showToast), currentTranslations);
}

function deleteChatSessionUI(sessionId) {
    deleteChatSession(sessionId, state);
}


// --- Communication with Content Script ---

function handleContentScriptMessages(event) {
    const message = event.data;
    switch (message.action) {
        case 'pageContentExtracted':
            state.pageContext = message.content;
            updateContextStatus('contextStatusChars', { charCount: message.content.length }, elements, currentTranslations);
            if (message.showSuccessMessage) {
                const msgText = _('pageContentExtractedSuccess', {}, currentTranslations);
                showChatStatusMessage(msgText, 'success', elements);
            }
            break;
        case 'pageContentLoaded':
            requestPageContent();
            break;
        case 'copySuccess':
            // Feedback is now handled within the copy functions themselves
            // console.log('Copy successful (message from content script)');
            break;
        case 'panelShownAndFocusInput': // 修改：处理新的 action
            // 首先确保聊天标签页是当前活动的标签页
            // 强制切换到聊天标签页并聚焦输入框
            switchTab('chat', elements, (subTab) => switchSettingsSubTab(subTab, elements)); // 确保聊天标签页被激活
            if (elements.userInput) {
                setTimeout(() => elements.userInput.focus(), 50);
                // console.log("User input focused on panel shown (forced via panelShownAndFocusInput).");
            }
            resizeTextarea(elements); // 保持原有 resize 逻辑
            break;
        case 'panelResized':
            resizeTextarea(elements);
            break;
        case 'webpageThemeDetected':
            console.log(`[main.js] Received webpage theme: ${message.theme}`);
            if (message.theme === 'dark' || message.theme === 'light') {
                const isWebpageDark = message.theme === 'dark';
                console.log(`Applying webpage theme: ${message.theme}`);
                state.darkMode = isWebpageDark;
                applyTheme(isWebpageDark, elements);
                updateMermaidTheme(isWebpageDark, rerenderAllMermaidChartsUI);
            } else {
                console.log(`Ignoring non-explicit webpage theme: ${message.theme}`);
            }
            break;
        case 'languageChanged':
            console.log(`[main.js] Received language change: ${message.newLanguage}`);
            handleLanguageChangeFromContent(message.newLanguage);
            break;
        case 'extensionReloaded':
            console.log(`[main.js] Extension reloaded - reinitializing`);
            handleExtensionReloadFromContent();
            break;
        case 'proxyAutoCleared':
            console.log(`[main.js] Proxy auto-cleared notification:`, message.failedProxy);
            handleProxyAutoClearedFromContent(message.failedProxy);
            break;
        case 'callUnifiedAPIFromBackground':
            console.log(`[main.js] Received API call request from background:`, message.model);
            handleUnifiedAPICallFromBackground(message);
            break;
        case 'modelsUpdated':
            console.log(`[main.js] Models updated - refreshing model selectors`);
            handleModelsUpdatedFromContent();
            break;
    }
}

async function requestPageContent() {
    try {
        updateContextStatus('contextStatusExtracting', {}, elements, currentTranslations);

        // 分两种环境处理：
        // 1) 作为注入到页面中的 iframe（content.js 创建的面板）
        // 2) 作为 Firefox 的 sidebar_action（独立扩展页面，不在 iframe 中）
        const isInIframe = window.parent && window.parent !== window;

        if (isInIframe) {
            // 仍然使用与 content.js 的 postMessage 通信
            window.parent.postMessage({ action: 'requestPageContent' }, '*');

            // 超时回退：若 20 秒无响应，显示失败
            setTimeout(() => {
                if (state.pageContext === null) {
                    console.warn('[main.js] Page content extraction timeout (iframe pathway)');
                    state.pageContext = 'error';
                    updateContextStatus('contextStatusFailed', {}, elements, currentTranslations);
                }
            }, 20000);
            return;
        }

        // 不在 iframe 中：很可能是 Firefox sidebar_action 场景。
        // 先尝试通过 postMessage 路径（兼容早先已修复的稳定路径），若失败再走 background 路径。
        try {
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
            if (!activeTab || !activeTab.id) {
                throw new Error('No active tab detected');
            }

            // 检查受限或不受支持的页面
            const tabUrl = activeTab.url || '';
            const isRestrictedScheme = tabUrl.startsWith('about:') || tabUrl.startsWith('chrome://') || tabUrl.startsWith('edge://') || tabUrl.startsWith('moz-extension://');
            let isRestrictedHost = false;
            try {
                const u = new URL(tabUrl);
                // Firefox AMO 禁止注入
                if (u.hostname === 'addons.mozilla.org') isRestrictedHost = true;
                // Chrome/Edge 商店（跨浏览器兼容考虑）
                if (u.hostname === 'chrome.google.com' || u.hostname === 'microsoftedge.microsoft.com' || u.hostname === 'edge.microsoft.com') isRestrictedHost = true;
            } catch (_) { /* ignore parse error for non-URL schemes */ }

            if (isRestrictedScheme || isRestrictedHost) {
                console.warn('[main.js] Active tab is a restricted page:', tabUrl);
                state.pageContext = 'error';
                updateContextStatus('contextStatusFailed', {}, elements, currentTranslations);
                return;
            }

            // 通过 background 统一路径请求（带有自动注入重试与受限页面判断）
            const response = await browser.runtime.sendMessage({ action: 'extractTabContent', tabId: activeTab.id });

            if (!response || response.error) {
                const errMsg = response?.error || 'Unknown error from background.extractTabContent';
                console.error('[main.js] Failed to get page content from active tab via background:', errMsg);
                state.pageContext = 'error';
                updateContextStatus('contextStatusFailed', {}, elements, currentTranslations);
                return;
            }

            // 成功：更新状态与 UI（与 pageContentExtracted 分支保持一致）
            state.pageContext = response.content || '';
            updateContextStatus('contextStatusChars', { charCount: state.pageContext.length }, elements, currentTranslations);
            const msgText = _('pageContentExtractedSuccess', {}, currentTranslations);
            showChatStatusMessage(msgText, 'success', elements);
        } catch (err) {
            if (err.message && err.message.includes('Could not establish connection')) {
                console.warn(`[main.js] Could not connect to content script on active tab (likely a restricted page): ${err.message}`);
            } else {
                console.error('[main.js] Error requesting page content from active tab:', err);
            }
            state.pageContext = 'error';
            updateContextStatus('contextStatusFailed', {}, elements, currentTranslations);
        }
    } catch (outerErr) {
        console.error('[main.js] Unexpected error in requestPageContent:', outerErr);
        state.pageContext = 'error';
        updateContextStatus('contextStatusFailed', {}, elements, currentTranslations);
    }
}

function requestThemeFromContentScript() {
    // 检查是否在iframe中
    if (window.parent !== window) {
        // 在iframe中，检查Chrome API是否可用
        if (!chrome || !browser.tabs || !browser.runtime) {
            console.log("[main.js] In iframe context with invalidated extension context, requesting theme via content script message");
            // 通过content script代理请求主题
            window.parent.postMessage({ action: 'requestThemeFromIframe' }, '*');
            return;
        }
    }

    // 检查Chrome API的可用性，避免在失效状态下调用
    if (!chrome || !browser.tabs || !browser.runtime) {
        console.log("[main.js] Chrome API not available, applying system theme preference");
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        state.darkMode = prefersDark;
        applyTheme(state.darkMode, elements);
        updateMermaidTheme(state.darkMode, rerenderAllMermaidChartsUI);
        return;
    }

    try {
        // 如果Chrome API可用，直接使用
        browser.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (browser.runtime.lastError) {
                console.log("[main.js] Chrome API context invalidated, applying system theme preference");
                const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                state.darkMode = prefersDark;
                applyTheme(state.darkMode, elements);
                updateMermaidTheme(state.darkMode, rerenderAllMermaidChartsUI);
                return;
            }

            if (tabs && tabs[0] && tabs[0].id) {
                browser.tabs.sendMessage(tabs[0].id, { action: "requestTheme" }, (response) => {
                    if (browser.runtime.lastError) {
                        // console.warn("Could not request theme from content script:", browser.runtime.lastError.message);
                        // Apply default theme based on system preference if request fails
                        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                        console.log("Falling back to system theme preference:", prefersDark ? 'dark' : 'light');
                        state.darkMode = prefersDark;
                        applyTheme(state.darkMode, elements);
                        updateMermaidTheme(state.darkMode, rerenderAllMermaidChartsUI);
                    } else {
                        // Theme will be applied via 'webpageThemeDetected' message handler
                        // console.log("Theme request sent to content script.");
                    }
                });
            } else {
                console.warn("Could not get active tab ID to request theme.");
                // Apply default theme based on system preference
                const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                state.darkMode = prefersDark;
                applyTheme(state.darkMode, elements);
                updateMermaidTheme(state.darkMode, rerenderAllMermaidChartsUI);
            }
        });
    } catch (e) {
        // 如果在iframe中且Chrome API失效，使用代理方式
        if (window.parent !== window) {
            console.log("[main.js] Chrome API failed in iframe, using content script proxy");
            window.parent.postMessage({ action: 'requestThemeFromIframe' }, '*');
        } else {
            console.log("[main.js] Error requesting theme, applying system theme preference");
            // Apply default theme based on system preference
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            state.darkMode = prefersDark;
            applyTheme(state.darkMode, elements);
            updateMermaidTheme(state.darkMode, rerenderAllMermaidChartsUI);
        }
    }
}

function closePanel() {
    if (isEmbeddedPanel) {
        window.parent.postMessage({ action: 'closePanel' }, '*');
        return;
    }

    if (chrome.sidePanel?.close) {
        void chrome.windows.getCurrent().then((currentWindow) => (
            chrome.sidePanel.close({ windowId: currentWindow.id })
        )).catch((error) => {
            console.warn('[main.js] Failed to close Chrome side panel:', error);
        });
    }
}

/**
 * 处理来自background的API调用转发请求
 */
async function handleUnifiedAPICallFromBackground(message) {
    try {
        const { model, messages, options } = message;
        console.log('[main.js] Handling unified API call from background for model:', model);

        // 检查统一API接口是否可用
        if (!window.ModelManager?.instance || !window.InfinPilotAPI?.callApi) {
            throw new Error(_('unifiedApiNotAvailable', {}, currentTranslations));
        }

        // 确保ModelManager已初始化
        await window.ModelManager.instance.initialize();

        let accumulatedText = '';

        // 流式回调函数
        const streamCallback = (chunk, complete) => {
            accumulatedText += chunk;
            // 对于划词助手，我们不需要实时流式更新，只需要最终结果
        };

        // 调用统一API接口
        await window.InfinPilotAPI.callApi(model, messages, streamCallback, options);

        // 发送成功响应
        window.parent.postMessage({
            action: 'unifiedAPIResponse',
            success: true,
            response: accumulatedText
        }, '*');

    } catch (error) {
        console.error('[main.js] Error handling unified API call from background:', error);

        // 发送错误响应
        window.parent.postMessage({
            action: 'unifiedAPIResponse',
            success: false,
            error: error.message
        }, '*');
    }
}

/**
 * 处理来自content script的模型更新通知
 */
async function handleModelsUpdatedFromContent() {
    console.log(`[main.js] Handling models updated from content`);

    try {
        // 重新初始化模型选择器
        await initModelSelection(state, elements);
        console.log(`[main.js] Model selectors refreshed successfully`);
    } catch (error) {
        console.error(`[main.js] Error refreshing model selectors:`, error);
    }
}

/**
 * 处理来自content script的语言变化通知
 */
async function handleLanguageChangeFromContent(newLanguage) {
    console.log(`[main.js] Handling language change from content: ${newLanguage}`);

    // 更新状态
    state.language = newLanguage;

    // 重新加载并应用翻译
    await loadAndApplyTranslations(newLanguage);

    // 重新初始化划词助手设置（如果设置页面打开）
    if (window.initTextSelectionHelperSettings && elements.textSelectionHelperSettings) {
        const settingsContainer = elements.textSelectionHelperSettings;
        if (settingsContainer && settingsContainer.style.display !== 'none') {
            console.log('[main.js] Reinitializing text selection helper settings for language change');
            const translations = window.translations && window.translations[newLanguage] ? window.translations[newLanguage] : {};
            window.initTextSelectionHelperSettings(elements, translations, showToastUI);
        }
    }
}

/**
 * 处理来自content script的扩展重载通知
 */
async function handleExtensionReloadFromContent() {
    console.log(`[main.js] Handling extension reload from content`);

    // 扩展重载后，content script会自动重新检测主题，所以这里不需要主动请求
    // 只在必要时才请求主题（比如用户手动触发）
    console.log('[main.js] Extension reloaded, theme will be auto-detected by content script');

    // 重新加载当前语言的翻译
    if (state.language) {
        await loadAndApplyTranslations(state.language);
    }

    // 重新初始化所有设置
    if (window.initTextSelectionHelperSettings && elements.textSelectionHelperSettings) {
        console.log('[main.js] Reinitializing text selection helper settings after extension reload');
        const translations = window.translations && window.translations[state.language] ? window.translations[state.language] : {};
        window.initTextSelectionHelperSettings(elements, translations, showToastUI);
    }
}

/**
 * 处理代理自动清除通知
 */
function handleProxyAutoClearedFromContent(failedProxy) {
    console.log('[main.js] Handling proxy auto-cleared notification for:', failedProxy);

    // 更新UI中的代理地址输入框
    if (elements.proxyAddressInput) {
        elements.proxyAddressInput.value = '';
    }

    // 更新状态
    state.proxyAddress = '';

    // 显示通知给用户
    const message = _('proxyConnectionFailed', { proxy: failedProxy }, currentTranslations);
    if (showToastUI) {
        showToastUI(message, 'warning', 'toast-proxy-cleared');
    }

    console.log('[main.js] Proxy settings cleared due to connection failure');
}

// --- Translation Loading ---
async function loadAndApplyTranslations(language) {
    if (typeof window.translations === 'undefined') {
        console.error(_('translationsNotFound', {}, currentTranslations));
        return;
    }
    currentTranslations = window.translations[language] || window.translations['en']; // Fallback to English
    state.language = language; // Ensure state is updated
    console.log(`Applying translations for: ${language}`);
    updateUIElementsWithTranslations(currentTranslations); // Update static UI text

    // Update dynamic parts that depend on translations
    updateAgentsListUIAllArgs(); // Re-render agent list with translated labels/placeholders
    updateAgentSelectionInChatUI(); // Ensure chat agent selection is updated with translations
    // 仅当已判定连接状态后才渲染连接状态文案
    if (state.hasDeterminedConnection) {
        updateConnectionIndicator(state.isConnected, elements, currentTranslations);
    }

    // 更新默认快捷操作的翻译
    try {
        await QuickActionsManager.updateDefaultActionsTranslations();
    } catch (error) {
        console.warn('[main.js] Error updating default quick actions translations:', error);
    }

    // 重新渲染快捷操作列表以更新翻译
    try {
        await renderQuickActionsList(currentTranslations);
    } catch (error) {
        console.warn('[main.js] Error updating quick actions list translations:', error);
    }

    // 广播语言变化事件给动态创建的UI组件（如自定义选项对话框）
    try {
        const languageChangeEvent = new CustomEvent('infinpilot:languageChanged', {
            detail: { newLanguage: language }
        });
        document.dispatchEvent(languageChangeEvent);
        console.log(`[main.js] Language change event dispatched for: ${language}`);
    } catch (error) {
        console.warn('[main.js] Error dispatching language change event:', error);
    }
    // Update context status based on current state.pageContext
    let contextKey = 'contextStatusNone';
    let contextReplacements = {};
    if (state.pageContext === null) contextKey = 'contextStatusExtracting';
    else if (state.pageContext === 'error') contextKey = 'contextStatusFailed';
    else if (state.pageContext) {
        contextKey = 'contextStatusChars';
        contextReplacements = { charCount: state.pageContext.length };
    }
    updateContextStatus(contextKey, contextReplacements, elements, currentTranslations);

    // Re-render welcome message if chat is empty
    if (elements.chatMessages && elements.chatMessages.children.length === 1 && elements.chatMessages.firstElementChild.classList.contains('welcome-message')) {
        // 只有在快捷操作管理器已经初始化的情况下才刷新欢迎消息
        if (window.QuickActionsManager && window.QuickActionsManager.isQuickActionsManagerInitialized && window.QuickActionsManager.isQuickActionsManagerInitialized()) {
            await refreshWelcomeMessageQuickActions();
        } else {
            console.log('[main.js] Skipping welcome message refresh - QuickActionsManager not yet initialized');
        }
    } else {
        // Update existing welcome message if present
        const welcomeHeading = elements.chatMessages.querySelector('.welcome-message h2');
        if (welcomeHeading) welcomeHeading.textContent = _('welcomeHeading');
        // 注意：不再更新快捷操作按钮的文本，因为它们现在是动态的
        // 如果需要更新快捷操作，应该使用 refreshWelcomeMessageQuickActions()
        // Also update existing message action button titles
        document.querySelectorAll('.message-action-btn, .copy-button').forEach(btn => {
            if (btn.classList.contains('copy-button')) btn.title = _('copyAll');
            else if (btn.classList.contains('regenerate-btn')) btn.title = _('regenerate');
            else if (btn.classList.contains('delete-btn')) btn.title = _('deleteMessage');
        });
        document.querySelectorAll('.code-copy-button').forEach(btn => btn.title = _('copyCode'));
    }


    // Sync Day.js locale
    if (typeof dayjs !== 'undefined') {
        dayjs.locale(language.toLowerCase() === 'zh-cn' ? 'zh-cn' : 'en');
        console.log(`Day.js locale set to: ${dayjs.locale()}`);
    } else {
        console.warn('Day.js not loaded, cannot set locale.');
    }
}

// --- Global Access (if needed for dynamic buttons, etc.) ---
// Expose functions needed by dynamically created elements if necessary
window.sendUserMessageTrigger = sendUserMessageTrigger;
window.addCopyButtonToCodeBlock = addCopyButtonToCodeBlockUI; // Expose wrappers if needed elsewhere
window.addMessageActionButtons = addMessageActionButtonsUI;
// window.updateStreamingMessage and window.finalizeBotMessage are set in init()
window.showToast = showToastUI; // Expose toast globally if needed
window.showToastUI = showToastUI; // Also expose as showToastUI for consistency

// 假设这是在"首次操作"完成，并且聊天消息等已添加到DOM之后
function onFirstOperationComplete() {
    // ... 其他逻辑 ...

    // 尝试强制重绘/回流聊天头部来修正选择框位置
    const chatHeader = elements.chatMessages.previousElementSibling; // 假设 .chat-header 就在 .chat-messages 前面
    if (chatHeader && chatHeader.classList.contains('chat-header')) {
        // 一种轻微强制回流的方法
        chatHeader.style.display = 'none';
        void chatHeader.offsetHeight; // 读取 offsetHeight 会强制浏览器回流
        chatHeader.style.display = 'flex'; // 恢复原状
    }
    // 或者，如果确认 resizeTextarea 能解决且无明显副作用，也可以调用它
    // if (elements.userInput) {
    //     resizeTextarea(elements);
    // }
}

// --- Start Application ---
document.addEventListener('DOMContentLoaded', init);

// 更新自动化开关UI
function updateAutomationToggleUI() {
    const btn = elements.automationToggleBtn;
    if (!btn) return;
    if (state.automationEnabled) {
        btn.classList.add('automation-on');
        btn.title = _('automationToggleOn');
    } else {
        btn.classList.remove('automation-on');
        btn.title = _('automationToggleOff');
    }
}
// 新增包装函数，用于从 main.js 中关闭弹窗并更新状态
function isCollectiveResearchMode() {
    return document.body.classList.contains('collective-research-mode');
}

function syncResearchModeButtons() {
    const automationBtn = elements.automationToggleBtn || document.getElementById('automation-toggle-btn');
    const deepBtn = document.getElementById('deep-research-btn');
    const collectiveBtn = elements.collectiveResearchBtn || document.getElementById('collective-research-btn');
    const isAutomationActive = document.body.classList.contains('automation-mode');
    const isDeepResearchActive = document.body.classList.contains('deep-research-mode');
    const isCollectiveActive = isCollectiveResearchMode();

    if (automationBtn) {
        automationBtn.classList.toggle('active', isAutomationActive);
        automationBtn.classList.toggle('automation-on', isAutomationActive);
    }
    if (deepBtn) {
        deepBtn.classList.toggle('active', isDeepResearchActive);
    }
    if (collectiveBtn) {
        collectiveBtn.classList.toggle('active', isCollectiveActive);
    }
}

function setCollectiveResearchMode(enabled) {
    state.collectiveResearchEnabled = Boolean(enabled);
    document.body.classList.toggle('collective-research-mode', state.collectiveResearchEnabled);
    syncResearchModeButtons();
}

function ensureCollectiveResearchToggle() {
    if (!elements.collectiveResearchBtn) {
        elements.collectiveResearchBtn = document.getElementById('collective-research-btn');
    }
    syncResearchModeButtons();
    return elements.collectiveResearchBtn;
}

window.ensureCollectiveResearchToggle = ensureCollectiveResearchToggle;
window.setCollectiveResearchMode = setCollectiveResearchMode;
window.isCollectiveResearchMode = isCollectiveResearchMode;
window.syncResearchModeButtons = syncResearchModeButtons;

function closeTabSelectionPopupUIFromMain() {
    if (state.isTabSelectionPopupOpen) { // 只有在弹窗确实打开时才操作
        uiCloseTabSelectionPopupUI(); // 调用从 ui.js 导入的函数来移除DOM
        state.isTabSelectionPopupOpen = false;
        console.log("Tab selection popup closed from main.js, state updated.");
    }
}

// New: Handle Escape priority for modals/popups before closing the panel
function handleGlobalEscapeForModals() {
    try {
        // 0) Agent delete confirm dialog (sidepanel built-in)
        const deleteConfirmOverlay = document.getElementById('delete-confirm-dialog');
        if (deleteConfirmOverlay && getComputedStyle(deleteConfirmOverlay).display !== 'none') {
            deleteConfirmOverlay.style.display = 'none';
            return true;
        }
        // 1) Tab selection popup inside chat
        const tabPopup = document.getElementById('tab-selection-popup');
        // 仅当弹窗实际可见时才拦截 ESC
        if (tabPopup && getComputedStyle(tabPopup).display !== 'none') {
            closeTabSelectionPopupUIFromMain();
            return true;
        }

        // 2) Custom provider modal
        const customProviderModal = document.getElementById('custom-provider-modal');
        if (customProviderModal && customProviderModal.classList.contains('show')) {
            customProviderModal.classList.remove('show');
            return true;
        }

        // 3) Model discovery dialog
        const modelDialog = document.querySelector('.model-discovery-dialog');
        if (modelDialog) {
            const closeBtn = modelDialog.querySelector('.close-btn');
            if (closeBtn) closeBtn.click(); else modelDialog.remove();
            return true;
        }

        // 4) Custom option edit dialog (Selection Helper Settings)
        const customOptionDialog = document.querySelector('.custom-option-dialog-overlay');
        if (customOptionDialog) {
            const closeBtn = customOptionDialog.querySelector('.custom-option-dialog-close');
            if (closeBtn) closeBtn.click(); else customOptionDialog.remove();
            return true;
        }

        // 5) Delete/Import conflict overlays in Selection Helper Settings
        const deleteDialog = document.getElementById('delete-custom-option-dialog');
        if (deleteDialog) {
            const cancelBtn = deleteDialog.querySelector('.dialog-cancel');
            if (cancelBtn) cancelBtn.click(); else deleteDialog.remove();
            return true;
        }
        const importConflictDialog = document.getElementById('import-conflict-dialog');
        if (importConflictDialog) {
            const cancelBtn = importConflictDialog.querySelector('.dialog-cancel');
            if (cancelBtn) cancelBtn.click(); else importConflictDialog.remove();
            return true;
        }

        // 6) Generic overlays created in settings (e.g., import/export confirms)
        // 仅处理“可见”的 overlay，避免隐藏的对话框常驻导致 ESC 失效
        const overlays = Array
            .from(document.querySelectorAll('body > .dialog-overlay'))
            .filter(ov => {
                const cs = getComputedStyle(ov);
                return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
            });
        if (overlays.length > 0) {
            const topOverlay = overlays[overlays.length - 1];
            // Try common cancel/close selectors across the project
            const cancelBtn = topOverlay.querySelector('.dialog-cancel, .cancel-btn, .close-btn');
            if (topOverlay.id === 'delete-confirm-dialog') {
                topOverlay.style.display = 'none';
            } else if (cancelBtn) {
                cancelBtn.click();
            } else {
                // Fallback: hide instead of removing to avoid breaking cached references
                topOverlay.style.display = 'none';
            }
            return true;
        }

        // 7) Image preview modal
        if (elements.imageModal && getComputedStyle(elements.imageModal).display !== 'none') {
            hideImageModal(elements);
            return true;
        }

        // 8) Mermaid preview modal
        if (elements.mermaidModal && getComputedStyle(elements.mermaidModal).display !== 'none') {
            hideMermaidModal(elements);
            return true;
        }

        return false;
    } catch (err) {
        console.warn('[main.js] handleGlobalEscapeForModals error:', err);
        return false;
    }
}

// Ensure the delete-confirm dialog exists and has the expected structure
function ensureDeleteConfirmDialogStructure() {
    const existing = document.getElementById('delete-confirm-dialog');
    if (existing) return;
    // Build a minimal dialog compatible with our event wiring
    const overlay = document.createElement('div');
    overlay.id = 'delete-confirm-dialog';
    overlay.className = 'dialog-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
        <div class="dialog-content">
            <h3>${(window.I18n?.tr && window.I18n.tr('deleteConfirmHeading', {}, {})) || '确认删除'}</h3>
            <p>${(window.I18n?.tr && window.I18n.tr('deleteConfirmPrompt', { agentName: '<strong></strong>' }, {})) || '您确定要删除助手吗？此操作无法撤销。'}</p>
            <div class="dialog-actions">
                <button id="cancel-delete" class="cancel-btn">${(window.I18n?.tr && window.I18n.tr('cancel', {}, {})) || '取消'}</button>
                <button id="confirm-delete" class="delete-btn" style="background-color: var(--error-color); color: white;">${(window.I18n?.tr && window.I18n.tr('delete', {}, {})) || '删除'}</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
}

// 新增：移除选中的上下文标签页
function removeSelectedTabFromMain(tabId) {
    state.selectedContextTabs = state.selectedContextTabs.filter(tab => tab.id !== tabId);
    // 调用 ui.js 中的函数更新UI (确保此函数接受正确的参数)
    updateSelectedTabsBarUI(state.selectedContextTabs, elements, removeSelectedTabFromMain, currentTranslations);
    console.log(`Selected context tab ${tabId} removed. Remaining:`, state.selectedContextTabs.length);
}

// 新增：用于更新已选标签栏UI的回调函数
function updateSelectedTabsBarFromMain() {
    updateSelectedTabsBarUI(state.selectedContextTabs, elements, removeSelectedTabFromMain, currentTranslations);
}

// === 快捷操作相关函数 ===

/**
 * 设置快捷操作相关的全局函数
 */
function setupQuickActionsGlobals() {
    // 设置全局快捷操作管理器引用
    window.QuickActionsManager = QuickActionsManager;

    // 设置快捷操作触发函数
    window.triggerQuickAction = triggerQuickAction;

    console.log('[main.js] Quick actions globals set up');
}

/**
 * 触发快捷操作
 * @param {string} actionId - 快捷操作ID
 * @param {string} prompt - 快捷操作的提示词
 * @param {boolean} ignoreAssistant - 是否忽略助手设置
 */
async function triggerQuickAction(actionId, prompt, ignoreAssistant) {
    console.log(`[main.js] Triggering quick action: ${actionId}, ignoreAssistant: ${ignoreAssistant}`);

    if (!prompt || !prompt.trim()) {
        console.warn('[main.js] Quick action prompt is empty');
        return;
    }

    // 检查是否正在流式传输
    if (state.isStreaming) {
        console.warn('[main.js] Cannot trigger quick action while streaming');
        if (showToastUI) {
            showToastUI(_('streamingInProgress', {}, currentTranslations), 'warning');
        }
        return;
    }

    // 检查API连接
    let hasValidApiKey = false;
    if (window.ModelManager?.instance) {
        try {
            await window.ModelManager.instance.initialize();
            const modelConfig = window.ModelManager.instance.getModelApiConfig(state.model);
            const providerId = modelConfig.providerId;
            hasValidApiKey = window.ModelManager.instance.isProviderConfigured(providerId);
        } catch (error) {
            console.warn('[main.js] Failed to check provider configuration:', error);
        }
    }

    if (!hasValidApiKey) {
        if (showToastUI) {
            showToastUI(_('apiKeyMissingError', {}, currentTranslations), 'error');
        }
        return;
    }

    // 设置输入框内容
    elements.userInput.value = prompt.trim();
    elements.userInput.focus();

    // 如果需要忽略助手，设置全局标记
    if (ignoreAssistant) {
        state.quickActionIgnoreAssistant = true;
        console.log('[main.js] Set quick action ignore assistant flag');
    }

    try {
        // 触发发送消息
        sendUserMessageTrigger();

        console.log(`[main.js] Quick action "${actionId}" executed successfully`);
    } catch (error) {
        console.error('[main.js] Error executing quick action:', error);
        if (showToastUI) {
            showToastUI(_('quickActionError', { error: error.message }, currentTranslations) || '快捷操作执行失败', 'error');
        }
    } finally {
        // 清除标记
        if (ignoreAssistant) {
            // 延迟清除标记，确保API调用已经完成
            setTimeout(() => {
                state.quickActionIgnoreAssistant = false;
                console.log('[main.js] Cleared quick action ignore assistant flag');
            }, 2000);
        }
    }
}

/**
 * 刷新欢迎消息中的快捷操作
 */
async function refreshWelcomeMessageQuickActions() {
    const welcomeMessage = elements.chatMessages.querySelector('.welcome-message');
    if (welcomeMessage) {
        // 确保快捷操作管理器可用
        if (!window.QuickActionsManager) {
            console.warn('[main.js] QuickActionsManager not available, skipping welcome message refresh');
            return;
        }

        const newWelcomeMessage = await createWelcomeMessage(currentTranslations);
        welcomeMessage.replaceWith(newWelcomeMessage);
        console.log('[main.js] Welcome message quick actions refreshed');
    }
}

// 导出刷新函数供设置界面使用
window.refreshWelcomeMessageQuickActions = refreshWelcomeMessageQuickActions;

// --- 统一导入导出功能 ---

/**
 * 处理统一导出功能
 * @param {function} showToastUI - Toast显示函数
 * @param {object} currentTranslations - 当前翻译对象
 */
async function handleUnifiedExport(showToastUI, currentTranslations) {
    try {
        console.log('[main.js] Starting unified export...');

        // 收集所有需要导出的数据
        const exportData = await collectAllSettingsData();

        // 生成文件名
        const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const filename = `infinpilot_all_settings_${timestamp}.json`;

        // 创建并下载文件
        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const message = currentTranslations?.unifiedExportSuccess || '所有设置已导出';
        showToastUI(message, 'success');
        console.log('[main.js] Unified export completed successfully');

    } catch (error) {
        console.error('[main.js] Unified export failed:', error);
        const message = currentTranslations?.unifiedExportError || '导出设置时出错: {error}';
        showToastUI(message.replace('{error}', error.message), 'error');
    }
}

/**
 * 处理统一导入功能
 * @param {Event} event - 文件选择事件
 * @param {function} showToastUI - Toast显示函数
 * @param {object} currentTranslations - 当前翻译对象
 */
async function handleUnifiedImport(event, showToastUI, currentTranslations) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            console.log('[main.js] Starting unified import...');

            // 解析JSON数据
            const importData = JSON.parse(e.target.result);

            // 验证数据格式
            if (!validateImportData(importData)) {
                throw new Error('Invalid file format');
            }

            // 用户确认
            const confirmMessage = currentTranslations?.unifiedImportConfirm ||
                '这将覆盖您所有的当前设置，操作无法撤销。是否继续？';

            if (!window.confirm(confirmMessage)) {
                return;
            }

            // 执行导入
            await importAllSettingsData(importData);

            // 显示成功消息
            const successMessage = currentTranslations?.unifiedImportSuccess ||
                '设置导入成功！界面将自动刷新以应用新设置。';
            showToastUI(successMessage, 'success');

            // 延迟刷新界面
            setTimeout(() => {
                window.location.reload();
            }, 2000);

            console.log('[main.js] Unified import completed successfully');

        } catch (error) {
            console.error('[main.js] Unified import failed:', error);
            const message = currentTranslations?.unifiedImportError || '导入失败：{error}';
            showToastUI(message.replace('{error}', error.message), 'error');
        }
    };

    reader.readAsText(file);

    // 清空文件输入，允许重复选择同一文件
    event.target.value = '';
}

/**
 * 收集所有设置数据
 * @returns {Promise<Object>} 包含所有设置的对象
 */
async function collectAllSettingsData() {
    return new Promise((resolve) => {
        // 从sync存储获取数据
        browser.storage.sync.get(null, (syncResult) => {
            if (browser.runtime.lastError) {
                console.error('[main.js] Error reading from sync storage:', browser.runtime.lastError);
                syncResult = {};
            }

            // 从local存储获取数据
            browser.storage.local.get(null, (localResult) => {
                if (browser.runtime.lastError) {
                    console.error('[main.js] Error reading from local storage:', browser.runtime.lastError);
                    localResult = {};
                }

                // 构建导出数据结构
                const exportData = {
                    app: 'InfinPilot',
                    version: '1.0',
                    exportDate: new Date().toISOString(),
                    settings: {
                        sync: {
                            // 助手配置
                            agents: syncResult.agents || [],
                            currentAgentId: syncResult.currentAgentId || null,
                            // 供应商设置（API Keys等）
                            providerSettings: syncResult.providerSettings || {},
                            // 模型管理器相关
                            managedModels: syncResult.managedModels || [],
                            userActiveModels: syncResult.userActiveModels || [],
                            modelManagerVersion: syncResult.modelManagerVersion || null,
                            // 通用设置
                            language: syncResult.language || 'zh-CN',
                            proxyAddress: syncResult.proxyAddress || '',
                            model: syncResult.model || null,
                            // 自定义供应商
                            customProviders: syncResult.customProviders || []
                        },
                        local: {
                            // 划词助手设置
                            textSelectionHelperSettings: localResult.textSelectionHelperSettings || {},
                            textSelectionHelperSettingsVersion: localResult.textSelectionHelperSettingsVersion || null,
                            // 快捷操作
                            quickActions: localResult.quickActions || { actions: [] }
                        }
                    }
                };

                console.log('[main.js] Collected settings data:', exportData);
                resolve(exportData);
            });
        });
    });
}

/**
 * 验证导入数据格式
 * @param {Object} importData - 导入的数据
 */
function validateImportData(importData) {
    // 检查基本结构
    if (!importData || typeof importData !== 'object') {
        return false;
    }

    // 检查必要字段
    if (!importData.settings || typeof importData.settings !== 'object') {
        return false;
    }

    // 检查sync和local字段
    if (!importData.settings.sync || typeof importData.settings.sync !== 'object') {
        return false;
    }

    if (!importData.settings.local || typeof importData.settings.local !== 'object') {
        return false;
    }

    console.log('[main.js] Import data validation passed');
    return true;
}

/**
 * 导入所有设置数据
 * @param {Object} importData - 导入的数据
 * @returns {Promise<void>}
 */
async function importAllSettingsData(importData) {
    return new Promise((resolve, reject) => {
        // 导入sync数据
        browser.storage.sync.set(importData.settings.sync, () => {
            if (browser.runtime.lastError) {
                console.error('[main.js] Error saving to sync storage:', browser.runtime.lastError);
                reject(new Error('Failed to save sync settings'));
                return;
            }

            // 导入local数据
            browser.storage.local.set(importData.settings.local, () => {
                if (browser.runtime.lastError) {
                    console.error('[main.js] Error saving to local storage:', browser.runtime.lastError);
                    reject(new Error('Failed to save local settings'));
                    return;
                }

                console.log('[main.js] All settings imported successfully');
                resolve();
            });
        });
    });
}

// --- Vector DB UI ---

/**
 * Populates the knowledge base selector dropdown in the chat UI.
 */
async function updateDbSelector() {
    if (!elements.dbSelector) return;

    try {
        await vectorDB.init();
        const dbs = await vectorDB.getAllDBs();
        
        elements.dbSelector.innerHTML = ''; // Clear existing options

        // Add the default "Do not use" option
        const defaultOption = document.createElement('option');
        defaultOption.value = 'null';
        defaultOption.textContent = '不使用知识库'; // TODO: Add to translations
        elements.dbSelector.appendChild(defaultOption);

        // Add options for each database
        dbs.forEach(db => {
            const option = document.createElement('option');
            option.value = db.id;
            option.textContent = db.name;
            elements.dbSelector.appendChild(option);
        });

        // Restore selection from session storage
        const selectedDb = await browser.storage.session.get('selectedDbId');
        if (selectedDb && selectedDb.selectedDbId) {
            elements.dbSelector.value = selectedDb.selectedDbId;
        }

    } catch (error) {
        console.error('Failed to update DB selector:', error);
    }
}

// Expose a refresh function to be called from settings.js
window.refreshDbSelector = updateDbSelector;

// --- Pinned Quick Actions ---

/**
 * Renders pinned quick action buttons in the chat input area.
 */
function renderPinnedActionButtons() {
    const container = document.querySelector('.chat-input-toolbar');
    if (!container) {
        console.warn('[main.js] Pinned actions container not found.');
        return;
    }

    // Remove existing pinned buttons to avoid duplication
    const existingPinnedButtons = container.querySelectorAll('.pinned-action-btn');
    existingPinnedButtons.forEach(btn => btn.remove());

    const allActions = QuickActionsManager.getAllQuickActions();
    const pinnedActions = allActions.filter(action => action.pinned);

    pinnedActions.forEach(action => {
        const button = document.createElement('button');
        button.className = 'icon-btn pinned-action-btn';
        button.title = action.name;
        button.dataset.actionId = action.id;

        // Using a generic 'zap' icon for pinned actions
        button.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                <path d="M5.52.359A.5.5 0 0 1 6 0h4a.5.5 0 0 1 .474.658L8.694 6H12.5a.5.5 0 0 1 .395.807l-7 9a.5.5 0 0 1-.873-.454L6.823 9.5H3.5a.5.5 0 0 1-.48-.641l2.5-8.5z"/>
            </svg>
        `;

        button.addEventListener('click', () => {
            if (window.triggerQuickAction) {
                window.triggerQuickAction(action.id, action.prompt, action.ignoreAssistant);
            }
        });

        // Add the new button to the container
        container.appendChild(button);
    });
}

function buildProjectRecordContextContent(record) {
    if (!record) {
        return '';
    }

    if (record.type === 'mcp_resource') {
        const meta = record.meta || {};
        const resourceResult = record.content?.contents ? record.content : (record.content?.result || record.content || {});
        const text = Array.isArray(resourceResult?.contents)
            ? resourceResult.contents.map((entry) => entry?.text || entry?.data || entry?.blob || JSON.stringify(entry ?? {}, null, 2)).join('\n\n')
            : (typeof resourceResult === 'string' ? resourceResult : JSON.stringify(resourceResult ?? {}, null, 2));
        return [
            `MCP 资源`,
            `服务: ${meta.serverName || meta.serverId || '-'}`,
            meta.uri ? `URI: ${meta.uri}` : null,
            '',
            text
        ].filter(Boolean).join('\n');
    }

    if (record.type === 'mcp_prompt') {
        const meta = record.meta || {};
        const promptResult = record.content?.messages ? record.content : (record.content?.result || record.content || {});
        const text = typeof promptResult === 'string' ? promptResult : JSON.stringify(promptResult ?? {}, null, 2);
        return [
            `MCP 提示词`,
            `服务: ${meta.serverName || meta.serverId || '-'}`,
            `提示词: ${meta.promptName || record.title || '-'}`,
            '',
            text
        ].filter(Boolean).join('\n');
    }

    if (record.type === 'page_extract' || record.type === 'page_snapshot' || record.type === 'note' || record.type === 'workflow_result') {
        return stringifyProjectPreviewContentReadable(record);
    }

    return '';
}

function canAddProjectRecordToContext(record) {
    return Boolean(record && buildProjectRecordContextContent(record));
}

function addProjectRecordToContext(record) {
    if (!canAddProjectRecordToContext(record)) {
        showToastUI('当前资源暂不支持加入上下文', 'warning');
        return false;
    }

    const contextId = `project:${record.type || record.entityType || 'item'}:${record.id}`;
    if (state.selectedContextTabs.some((entry) => entry.id === contextId)) {
        showToastUI('该资源已在上下文中', 'info');
        return false;
    }

    const contextEntry = {
        id: contextId,
        title: getProjectItemDisplayTitle(record),
        url: record.sourceUrl || record.meta?.uri || '',
        favIconUrl: '../magic.png',
        content: buildProjectRecordContextContent(record),
        isLoading: false,
        isContextSent: false,
        contextKind: record.type
    };

    state.selectedContextTabs.push(contextEntry);
    updateSelectedTabsBarFromMain();
    showToastUI(`已加入上下文：${contextEntry.title}`, 'success');
    return true;
}

function renderProjectBrowserListLegacy(items) {
    if (!elements.projectBrowserList) {
        return;
    }

    const filteredItems = filterProjectBrowserItems(Array.isArray(items) ? items : []);
    elements.projectBrowserList.innerHTML = '';

    if (filteredItems.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'project-browser-empty';
        empty.textContent = '当前筛选条件下没有素材';
        elements.projectBrowserList.appendChild(empty);
        return;
    }

    filteredItems.forEach((item) => {
        const row = document.createElement('div');
        row.className = `project-browser-row project-browser-row--${String(item.type || 'unknown').replace(/_/g, '-')}`;
        row.dataset.projectItemId = item.id;

        const metaText = getProjectItemSummaryText(item);
        const canAddContext = canAddProjectRecordToContext(item);
        row.innerHTML = `
            <button type="button" class="project-browser-item project-browser-item--${String(item.type || 'unknown').replace(/_/g, '-')}" data-project-item-id="${item.id}">
                <span class="project-browser-item-type project-browser-item-type--${String(item.type || 'unknown').replace(/_/g, '-')}">${getProjectItemTypeLabel(item.type)}</span>
                <span class="project-browser-item-content">
                    <span class="project-browser-item-title">${getProjectItemDisplayTitle(item)}</span>
                    ${metaText ? `<span class="project-browser-item-meta">${metaText}</span>` : ''}
                </span>
            </button>
            ${canAddContext ? `<button type="button" class="project-browser-context-btn" data-action="add-context" data-project-item-id="${item.id}">加入上下文</button>` : ''}
        `;

        const primary = row.querySelector('.project-browser-item');
        if (metaText && primary) {
            primary.title = `${getProjectItemDisplayTitle(item)}\n${metaText}`;
        }

        elements.projectBrowserList.appendChild(row);
    });
}

function handleProjectBrowserClickLegacyV2(event) {
    const contextButton = event.target.closest('[data-action="add-context"][data-project-item-id]');
    if (contextButton) {
        const record = state.currentProjectBrowserItems?.find((entry) => entry.id === contextButton.dataset.projectItemId);
        if (record) {
            addProjectRecordToContext(record);
        }
        return;
    }

    const item = event.target.closest('.project-browser-item[data-project-item-id]');
    if (!item) {
        return;
    }
    const record = state.currentProjectBrowserItems?.find(entry => entry.id === item.dataset.projectItemId);
    if (!record) {
        return;
    }
    closeProjectBrowser();
    openProjectPreview(record);
}

async function renderProjectPreviewActions(record) {
    ensureProjectPreviewModalV2();
    if (!elements.projectPreviewActions) {
        return;
    }

    elements.projectPreviewActions.innerHTML = '';
    const actions = [];
    const isProjectResource = Boolean(record && !record.entityType) || record?.entityType === 'template';

    if (record?.type === 'automation_recording' && !record.entityType) {
        actions.push({
            label: '保存为模板',
            handler: createTemplateFromPreviewRecord
        });
    }

    if (record?.entityType === 'template') {
        actions.push({
            label: '运行模板',
            handler: runTemplateFromPreviewRecord
        });
    }

    if (canAddProjectRecordToContext(record)) {
        actions.push({
            label: '加入上下文',
            handler: () => addProjectRecordToContext(record)
        });
    }

    if (isProjectResource) {
        const entityType = record?.entityType === 'template' ? 'template' : 'item';
        const isPublic = await projectService.isResourcePublic(entityType, record.id);
        actions.push(
            {
                label: '复制到项目',
                handler: () => handleCopyProjectResource(record)
            },
            {
                label: '转移到项目',
                handler: () => handleMoveProjectResource(record)
            },
            {
                label: isPublic ? '取消公共' : '设为公共',
                handler: () => handleToggleProjectResourcePublic(record)
            },
            {
                label: '删除资源',
                handler: () => handleDeleteProjectResource(record)
            }
        );
    }

    actions.forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'project-preview-action-btn';
        button.textContent = action.label;
        button.addEventListener('click', action.handler);
        elements.projectPreviewActions.appendChild(button);
    });

    elements.projectPreviewActions.classList.toggle('is-empty', actions.length === 0);
}

function ensureProjectBrowserModal() {
    if (elements.projectBrowserModal) {
        const existingFilter = elements.projectBrowserModal.querySelector('#project-browser-filter');
        if (!existingFilter) {
            const list = elements.projectBrowserModal.querySelector('#project-browser-list');
            if (list) {
                const toolbar = document.createElement('div');
                toolbar.className = 'project-browser-toolbar';
                toolbar.innerHTML = `
                    <label class="project-browser-filter-label">
                        <span>筛选</span>
                        <select id="project-browser-filter" class="project-browser-filter">
                            <option value="all">全部素材</option>
                            <option value="mcp">MCP 素材</option>
                            <option value="mcp_resource">MCP 资源</option>
                            <option value="mcp_prompt">MCP 提示词</option>
                            <option value="page_extract">页面提取</option>
                            <option value="editor_file_ref">编辑器文件</option>
                            <option value="automation_recording">录制</option>
                        </select>
                    </label>
                `;
                list.insertAdjacentElement('beforebegin', toolbar);
            }
        }
        return elements.projectBrowserModal;
    }

    const modal = document.createElement('div');
    modal.id = 'project-browser-modal';
    modal.className = 'project-browser-modal';
    modal.innerHTML = `
        <div class="project-browser-dialog" role="dialog" aria-modal="true" aria-labelledby="project-browser-title">
            <div class="project-browser-header">
                <h3 id="project-browser-title">项目素材</h3>
                <button type="button" class="project-preview-close" data-close-project-browser aria-label="关闭素材列表">×</button>
            </div>
            <div class="project-browser-toolbar">
                <label class="project-browser-filter-label">
                    <span>筛选</span>
                    <select id="project-browser-filter" class="project-browser-filter">
                        <option value="all">全部素材</option>
                        <option value="mcp">MCP 素材</option>
                        <option value="mcp_resource">MCP 资源</option>
                        <option value="mcp_prompt">MCP 提示词</option>
                        <option value="page_extract">页面提取</option>
                        <option value="editor_file_ref">编辑器文件</option>
                        <option value="automation_recording">录制</option>
                    </select>
                </label>
            </div>
            <div class="project-browser-list" id="project-browser-list"></div>
        </div>
    `;

    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('[data-close-project-browser]')) {
            closeProjectBrowser();
        }
    });

    document.body.appendChild(modal);
    elements.projectBrowserModal = modal;
    elements.projectBrowserList = modal.querySelector('#project-browser-list');

    const filter = modal.querySelector('#project-browser-filter');
    filter?.addEventListener('change', () => {
        renderProjectBrowserList(state.currentProjectBrowserItems || []);
    });

    return modal;
}

function ensureCollectiveProjectBrowserFilters() {
    const filter = elements.projectBrowserModal?.querySelector('#project-browser-filter');
    if (!filter) {
        return;
    }
    const options = [
        { value: 'collective', label: '群体研究' },
        { value: 'collective_report', label: '研究报告' }
    ];
    options.forEach((option) => {
        if (!filter.querySelector(`option[value="${option.value}"]`)) {
            const node = document.createElement('option');
            node.value = option.value;
            node.textContent = option.label;
            filter.appendChild(node);
        }
    });
}

function getProjectBrowserFilterValue() {
    return elements.projectBrowserModal?.querySelector('#project-browser-filter')?.value || 'all';
}

function filterProjectBrowserItems(items) {
    const filterValue = getProjectBrowserFilterValue();
    if (filterValue === 'all') {
        return items;
    }
    if (filterValue === 'mcp') {
        return items.filter((item) => item.type === 'mcp_resource' || item.type === 'mcp_prompt');
    }
    if (filterValue === 'collective') {
        return items.filter((item) => String(item.type || '').startsWith('collective_'));
    }
    return items.filter((item) => item.type === filterValue);
}

function renderProjectBrowserList(items) {
    if (!elements.projectBrowserList) {
        return;
    }

    const filteredItems = filterProjectBrowserItems(Array.isArray(items) ? items : []);
    elements.projectBrowserList.innerHTML = '';

    if (filteredItems.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'project-browser-empty';
        empty.textContent = '当前筛选条件下没有素材';
        elements.projectBrowserList.appendChild(empty);
        return;
    }

    filteredItems.forEach((item) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `project-browser-item project-browser-item--${String(item.type || 'unknown').replace(/_/g, '-')}`;
        row.dataset.projectItemId = item.id;

        const metaText = getProjectItemSummaryText(item);
        row.innerHTML = `
            <span class="project-browser-item-type project-browser-item-type--${String(item.type || 'unknown').replace(/_/g, '-')}">${getProjectItemTypeLabel(item.type)}</span>
            <span class="project-browser-item-content">
                <span class="project-browser-item-title">${getProjectItemDisplayTitle(item)}</span>
                ${metaText ? `<span class="project-browser-item-meta">${metaText}</span>` : ''}
            </span>
        `;

        if (metaText) {
            row.title = `${getProjectItemDisplayTitle(item)}\n${metaText}`;
        }

        elements.projectBrowserList.appendChild(row);
    });
}

async function openProjectBrowser() {
    const projectId = await ensureCurrentProjectSelection('查看项目素材');
    if (!projectId) {
        return;
    }

    const items = await projectService.listProjectItems(projectId);
    state.currentProjectBrowserItems = items;
    ensureProjectBrowserModal();
    ensureCollectiveProjectBrowserFilters();
    renderProjectBrowserList(items);
    elements.projectBrowserModal.classList.add('is-open');
}

function getExecutionModeLabel(mode) {
    return mode === 'parallel' ? '并行' : '前台';
}

function stringifyProjectPreviewContentReadable(item) {
    if (!item) {
        return '';
    }

    if (item.entityType === 'template') {
        const lines = [
            `名称: ${item.name || '未命名模板'}`,
            item.description ? `描述: ${item.description}` : null,
            `步骤数: ${Array.isArray(item.steps) ? item.steps.length : 0}`,
            Array.isArray(item.steps) && item.steps.length > 0 ? '步骤:' : null,
            ...(Array.isArray(item.steps) ? item.steps.map((step, index) => {
                const payloadSteps = Array.isArray(step?.payload?.steps) ? step.payload.steps.length : 0;
                return `${index + 1}. ${step.label || step.type || 'step'} | type=${step.type || 'unknown'} | replaySteps=${payloadSteps}`;
            }) : [])
        ].filter(Boolean);
        return lines.join('\n');
    }

    if (item.entityType === 'run') {
        const lines = [
            `状态: ${item.status || 'unknown'}`,
            item.templateName ? `模板: ${item.templateName}` : null,
            item.error ? `错误: ${item.error}` : null,
            Array.isArray(item.steps) && item.steps.length > 0 ? '步骤执行:' : null,
            ...(Array.isArray(item.steps) ? item.steps.map((step, index) => {
                const outputText = step.output ? ` | output=${JSON.stringify(step.output)}` : '';
                const errorText = step.error ? ` | error=${step.error}` : '';
                return `${index + 1}. ${step.label || step.type || 'step'} | status=${step.status || 'unknown'}${outputText}${errorText}`;
            }) : []),
            item.outputs ? `输出: ${JSON.stringify(item.outputs, null, 2)}` : null
        ].filter(Boolean);
        return lines.join('\n');
    }

    if (item.type === 'automation_recording') {
        const steps = Array.isArray(item.content) ? item.content : [];
        if (steps.length === 0) {
            return '当前录制没有步骤。';
        }
        return steps.map((step, index) => {
            const parts = [`${index + 1}. ${step.type || 'step'}`];
            if (step.selector) {
                parts.push(`selector=${step.selector}`);
            }
            if (typeof step.value === 'string' && step.value !== '') {
                parts.push(`value=${step.value}`);
            }
            if (step.key) {
                parts.push(`key=${step.key}`);
            }
            if (typeof step.durationMs === 'number') {
                parts.push(`wait=${step.durationMs}ms`);
            }
            if (typeof step.x === 'number' || typeof step.y === 'number') {
                parts.push(`scroll=(${step.x || 0}, ${step.y || 0})`);
            }
            if (step.text) {
                parts.push(`text=${step.text}`);
            }
            return parts.join(' | ');
        }).join('\n');
    }

    if (item.type === 'page_snapshot') {
        return typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2);
    }

    if (item.type === 'page_extract') {
        if (item.meta?.pattern === 'article' && item.content?.textContent) {
            return item.content.textContent;
        }
        return JSON.stringify(item.content, null, 2);
    }

    if (item.type === 'editor_file_ref') {
        return JSON.stringify(item.meta || item.content || {}, null, 2);
    }

    if (item.type === 'workflow_result') {
        return JSON.stringify({
            status: item.content?.status || item.meta?.status || '',
            outputs: item.content?.outputs ?? null,
            templateName: item.meta?.templateName || '',
            steps: item.meta?.steps || []
        }, null, 2);
    }

    if (typeof item.content === 'string') {
        return item.content;
    }

    return JSON.stringify(item.content ?? item.meta ?? {}, null, 2);
}

function getProjectPreviewMetaText(record) {
    if (!record) {
        return state.currentProject?.name || '当前项目';
    }

    if (record.type === 'mcp_resource') {
        return record.meta?.serverName || record.meta?.serverId || state.currentProject?.name || '当前项目';
    }

    if (record.type === 'mcp_prompt') {
        return record.meta?.serverName || record.meta?.serverId || state.currentProject?.name || '当前项目';
    }

    return record.sourceUrl || record.templateName || state.currentProject?.name || '当前项目';
}

function renderProjectPreviewBody(item) {
    if (!elements.projectPreviewBody) {
        return;
    }

    if (item?.type === 'mcp_resource') {
        const meta = item.meta || {};
        const resourceResult = item.content?.contents ? item.content : (item.content?.result || item.content || {});
        const displayContent = Array.isArray(resourceResult?.contents)
            ? resourceResult.contents.map((entry) => entry?.text || entry?.data || entry?.blob || JSON.stringify(entry ?? {}, null, 2)).join('\n\n')
            : resourceResult;
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>服务</span><strong>${escapeProjectPreviewHtml(meta.serverName || meta.serverId || '-')}</strong></div>
                <div class="project-preview-kv"><span>URI</span><strong>${escapeProjectPreviewHtml(meta.uri || '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('资源内容', displayContent)}
        `;
        return;
    }

    if (item?.type === 'mcp_prompt') {
        const meta = item.meta || {};
        const promptResult = item.content?.messages ? item.content : (item.content?.result || item.content || {});
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>服务</span><strong>${escapeProjectPreviewHtml(meta.serverName || meta.serverId || '-')}</strong></div>
                <div class="project-preview-kv"><span>提示词</span><strong>${escapeProjectPreviewHtml(meta.promptName || item.title || '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('提示词内容', promptResult)}
        `;
        return;
    }

    elements.projectPreviewBody.textContent = stringifyProjectPreviewContentReadable(item);
}

getProjectItemTypeLabel = function(type) {
    const labels = {
        editor_file_ref: '文件',
        page_snapshot: '页面',
        page_extract: '提取',
        screenshot: '截图',
        note: '笔记',
        automation_recording: '录制',
        workflow_result: '工作流',
        collective_research_result: '群体研究',
        collective_session: '研究会话',
        collective_blackboard: '研究黑板',
        collective_report: '研究报告',
        workflow_template: '模板',
        workflow_run: '运行',
        mcp_resource: 'MCP 资源',
        mcp_prompt: 'MCP 提示词'
    };
    return labels[type] || '素材';
};

getProjectItemDisplayTitle = function(item) {
    if (!item) {
        return '未命名素材';
    }
    if (item.title) {
        return item.title;
    }
    if (item.type === 'mcp_resource') {
        return item.meta?.uri || item.meta?.serverName || item.meta?.serverId || 'MCP 资源';
    }
    if (item.type === 'mcp_prompt') {
        return item.meta?.promptName || item.meta?.serverName || item.meta?.serverId || 'MCP 提示词';
    }
    if (item.type === 'collective_research_result') {
        return item.content?.topic || '群体研究结果';
    }
    if (item.type === 'collective_session') {
        return item.content?.topic || '群体研究会话';
    }
    if (item.type === 'collective_blackboard') {
        return '群体研究黑板';
    }
    if (item.type === 'collective_report') {
        return item.content?.topic || '群体研究报告';
    }
    return '未命名素材';
};

getProjectItemSummaryText = function(item) {
    if (!item) {
        return '';
    }
    if (item.type === 'mcp_resource') {
        return [item.meta?.serverName || item.meta?.serverId || '', item.meta?.uri || ''].filter(Boolean).join(' · ');
    }
    if (item.type === 'mcp_prompt') {
        return [item.meta?.serverName || item.meta?.serverId || '', item.meta?.promptName || ''].filter(Boolean).join(' · ');
    }
    if (item.type === 'page_extract') {
        return item.meta?.pattern ? `模式: ${item.meta.pattern}` : '';
    }
    if (item.type === 'editor_file_ref') {
        return item.meta?.path || item.meta?.fileName || '';
    }
    if (item.type === 'collective_research_result') {
        const rounds = item.content?.roundsCompleted;
        return Number.isFinite(rounds) ? `已完成 ${rounds} 轮` : '群体研究结果';
    }
    if (item.type === 'collective_session') {
        const rounds = item.content?.currentRound ?? item.content?.roundsCompleted;
        return Number.isFinite(rounds) ? `会话轮次 ${rounds}` : '群体研究会话';
    }
    if (item.type === 'collective_blackboard') {
        const count = Array.isArray(item.content?.entries) ? item.content.entries.length : 0;
        return `黑板条目 ${count}`;
    }
    if (item.type === 'collective_report') {
        const rounds = item.content?.roundsCompleted;
        return Number.isFinite(rounds) ? `报告轮次 ${rounds}` : '群体研究报告';
    }
    if (item.sourceUrl) {
        return item.sourceUrl;
    }
    return '';
};

stringifyProjectPreviewContentReadable = function(item) {
    if (!item) {
        return '';
    }
    if (item.entityType === 'template') {
        const lines = [
            `名称: ${item.name || '未命名模板'}`,
            item.description ? `描述: ${item.description}` : null,
            `步骤数: ${Array.isArray(item.steps) ? item.steps.length : 0}`,
            Array.isArray(item.steps) && item.steps.length > 0 ? '步骤:' : null,
            ...(Array.isArray(item.steps) ? item.steps.map((step, index) => {
                const payloadSteps = Array.isArray(step?.payload?.steps) ? step.payload.steps.length : 0;
                return `${index + 1}. ${step.label || step.type || 'step'} | type=${step.type || 'unknown'} | replaySteps=${payloadSteps}`;
            }) : [])
        ].filter(Boolean);
        return lines.join('\n');
    }
    if (item.entityType === 'run') {
        const lines = [
            `状态: ${item.status || 'unknown'}`,
            item.templateName ? `模板: ${item.templateName}` : null,
            item.error ? `错误: ${item.error}` : null,
            Array.isArray(item.steps) && item.steps.length > 0 ? '步骤执行:' : null,
            ...(Array.isArray(item.steps) ? item.steps.map((step, index) => {
                const outputText = step.output ? ` | output=${JSON.stringify(step.output)}` : '';
                const errorText = step.error ? ` | error=${step.error}` : '';
                return `${index + 1}. ${step.label || step.type || 'step'} | status=${step.status || 'unknown'}${outputText}${errorText}`;
            }) : []),
            item.outputs ? `输出: ${JSON.stringify(item.outputs, null, 2)}` : null
        ].filter(Boolean);
        return lines.join('\n');
    }
    if (item.type === 'automation_recording') {
        const steps = Array.isArray(item.content) ? item.content : [];
        if (steps.length === 0) {
            return '当前录制没有步骤。';
        }
        return steps.map((step, index) => {
            const parts = [`${index + 1}. ${step.type || 'step'}`];
            if (step.selector) parts.push(`selector=${step.selector}`);
            if (typeof step.value === 'string' && step.value !== '') parts.push(`value=${step.value}`);
            if (step.key) parts.push(`key=${step.key}`);
            if (typeof step.durationMs === 'number') parts.push(`wait=${step.durationMs}ms`);
            if (typeof step.x === 'number' || typeof step.y === 'number') parts.push(`scroll=(${step.x || 0}, ${step.y || 0})`);
            if (step.text) parts.push(`text=${step.text}`);
            return parts.join(' | ');
        }).join('\n');
    }
    if (item.type === 'page_snapshot') {
        return typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2);
    }
    if (item.type === 'page_extract') {
        if (item.meta?.pattern === 'article' && item.content?.textContent) {
            return item.content.textContent;
        }
        return JSON.stringify(item.content, null, 2);
    }
    if (item.type === 'editor_file_ref') {
        return JSON.stringify(item.meta || item.content || {}, null, 2);
    }
    if (item.type === 'collective_research_result') {
        const lines = [
            `主题: ${item.content?.topic || item.title || '群体研究'}`,
            Number.isFinite(item.content?.roundsCompleted) ? `轮次: ${item.content.roundsCompleted}` : null,
            item.content?.finalReport ? '最终报告:' : null,
            item.content?.finalReport || null
        ].filter(Boolean);
        return lines.join('\n\n');
    }
    if (item.type === 'collective_session') {
        return JSON.stringify(item.content || {}, null, 2);
    }
    if (item.type === 'collective_blackboard') {
        return JSON.stringify(item.content || {}, null, 2);
    }
    if (item.type === 'collective_report') {
        const lines = [
            `主题: ${item.content?.topic || item.title || '群体研究报告'}`,
            Number.isFinite(item.content?.roundsCompleted) ? `轮次: ${item.content.roundsCompleted}` : null,
            item.content?.finalReport ? '最终报告:' : null,
            item.content?.finalReport || null
        ].filter(Boolean);
        return lines.join('\n\n');
    }
    if (item.type === 'workflow_result') {
        return JSON.stringify({
            status: item.content?.status || item.meta?.status || '',
            outputs: item.content?.outputs ?? null,
            templateName: item.meta?.templateName || '',
            steps: item.meta?.steps || []
        }, null, 2);
    }
    if (typeof item.content === 'string') {
        return item.content;
    }
    return JSON.stringify(item.content ?? item.meta ?? {}, null, 2);
};

getProjectPreviewMetaText = function(record) {
    if (!record) {
        return state.currentProject?.name || '当前项目';
    }
    if (record.type === 'mcp_resource' || record.type === 'mcp_prompt') {
        return record.meta?.serverName || record.meta?.serverId || state.currentProject?.name || '当前项目';
    }
    if (record.type === 'collective_research_result') {
        return Number.isFinite(record.content?.roundsCompleted)
            ? `群体研究 · ${record.content.roundsCompleted} 轮`
            : '群体研究';
    }
    if (record.type === 'collective_session') {
        return '群体研究会话';
    }
    if (record.type === 'collective_blackboard') {
        return '群体研究黑板';
    }
    if (record.type === 'collective_report') {
        return '群体研究报告';
    }
    return record.sourceUrl || record.templateName || state.currentProject?.name || '当前项目';
};

renderProjectPreviewBody = function(item) {
    if (!elements.projectPreviewBody) {
        return;
    }
    if (item?.type === 'mcp_resource') {
        const meta = item.meta || {};
        const resourceResult = item.content?.contents ? item.content : (item.content?.result || item.content || {});
        const displayContent = Array.isArray(resourceResult?.contents)
            ? resourceResult.contents.map((entry) => entry?.text || entry?.data || entry?.blob || JSON.stringify(entry ?? {}, null, 2)).join('\n\n')
            : resourceResult;
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>服务</span><strong>${escapeProjectPreviewHtml(meta.serverName || meta.serverId || '-')}</strong></div>
                <div class="project-preview-kv"><span>URI</span><strong>${escapeProjectPreviewHtml(meta.uri || '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('资源内容', displayContent)}
        `;
        return;
    }
    if (item?.type === 'mcp_prompt') {
        const meta = item.meta || {};
        const promptResult = item.content?.messages ? item.content : (item.content?.result || item.content || {});
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>服务</span><strong>${escapeProjectPreviewHtml(meta.serverName || meta.serverId || '-')}</strong></div>
                <div class="project-preview-kv"><span>提示词</span><strong>${escapeProjectPreviewHtml(meta.promptName || item.title || '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('提示词内容', promptResult)}
        `;
        return;
    }
    if (item?.type === 'collective_research_result') {
        const content = item.content || {};
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>主题</span><strong>${escapeProjectPreviewHtml(content.topic || item.title || '-')}</strong></div>
                <div class="project-preview-kv"><span>轮次</span><strong>${escapeProjectPreviewHtml(content.roundsCompleted ?? '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('最终报告', content.finalReport || '')}
        `;
        return;
    }
    if (item?.type === 'collective_report') {
        const content = item.content || {};
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>主题</span><strong>${escapeProjectPreviewHtml(content.topic || item.title || '-')}</strong></div>
                <div class="project-preview-kv"><span>轮次</span><strong>${escapeProjectPreviewHtml(content.roundsCompleted ?? '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('最终报告', content.finalReport || '')}
        `;
        return;
    }
    elements.projectPreviewBody.textContent = stringifyProjectPreviewContentReadable(item);
};

function openProjectPreviewLegacy(itemOrId) {
    const item = typeof itemOrId === 'string'
        ? (
            state.currentProjectSummary?.recentItems?.find(entry => entry.id === itemOrId)
            || state.currentProjectBrowserItems?.find(entry => entry.id === itemOrId)
        )
        : itemOrId;
    if (!item) {
        return;
    }

    ensureProjectPreviewModal();
    elements.projectPreviewType.textContent = getProjectItemTypeLabel(item.type);
    elements.projectPreviewTitle.textContent = item.title || '未命名素材';
    elements.projectPreviewMeta.textContent = getProjectPreviewMetaText(item);
    elements.projectPreviewBody.textContent = '';
    renderProjectPreviewBody(item);
    elements.projectPreviewModal.classList.add('is-open');
}

function openProjectPreview(itemOrId) {
    const record = typeof itemOrId === 'string'
        ? findProjectPreviewRecordById(itemOrId)
        : itemOrId;
    if (!record) {
        return;
    }

    state.currentProjectPreviewRecord = record;
    ensureProjectPreviewModalV2();
    elements.projectPreviewType.textContent = getProjectItemTypeLabel(record.entityType === 'template'
        ? 'workflow_template'
        : record.entityType === 'run'
            ? 'workflow_run'
            : record.type);
    elements.projectPreviewTitle.textContent = record.title || record.name || '未命名记录';
    elements.projectPreviewMeta.textContent = getProjectPreviewMetaText(record);
    if (elements.projectPreviewMeta && (record.entityType === 'template' || record.entityType === 'run')) {
        elements.projectPreviewMeta.textContent = `${elements.projectPreviewMeta.textContent} | ${getExecutionModeLabel(record.executionMode || record.outputs?.executionMode || 'foreground')}`;
    }
    void renderProjectPreviewActions(record);
    elements.projectPreviewBody.textContent = '';
    renderProjectPreviewBody(record);
    elements.projectPreviewModal.classList.add('is-open');
}

function getCollectivePreviewTopic(record) {
    return record?.content?.topic || record?.content?.snapshot?.topic || record?.title || '群体研究';
}

function getCollectivePreviewReport(record) {
    return record?.content?.finalReport || record?.content?.snapshot?.finalReport || '';
}

async function createCollectiveTemplateFromPreviewRecordAction() {
    const record = state.currentProjectPreviewRecord;
    if (!record || !['collective_research_result', 'collective_session', 'collective_report'].includes(record.type)) {
        return;
    }

    try {
        const result = await projectService.createTemplateFromCollectiveRecord(record, {
            name: `${getCollectivePreviewTopic(record)} 模板`
        });
        if (!result?.success) {
            throw new Error(result?.error || '群体研究模板创建失败');
        }
        await syncProjectStateFromService();
        showToastUI(`已创建模板：${result.template.name}`, 'success');
    } catch (error) {
        showToastUI(error.message || '群体研究模板创建失败', 'error');
    }
}

async function saveCollectivePreviewToEditorAction() {
    const record = state.currentProjectPreviewRecord;
    const report = getCollectivePreviewReport(record);
    if (!report) {
        showToastUI('当前素材没有可写入编辑器的研究报告', 'warning');
        return;
    }

    const saved = await window.saveCollectiveReportToEditor?.(report, getCollectivePreviewTopic(record));
    if (saved?.success) {
        showToastUI(`已写入编辑器：${getCollectivePreviewTopic(record)}`, 'success');
    } else {
        showToastUI('写入编辑器失败', 'error');
    }
}

async function continueCollectivePreviewRecordAction() {
    const record = state.currentProjectPreviewRecord;
    if (!record) {
        return;
    }

    const result = await window.continueCollectiveResearchFromRecord?.(record, { additionalRounds: 1 });
    if (!result?.success) {
        showToastUI(result?.error || '继续群体研究失败', 'error');
        return;
    }

    await syncProjectStateFromService();
    showToastUI(`已继续群体研究：${result.topic || getCollectivePreviewTopic(record)}`, 'success');
}

ensureCollectiveProjectBrowserFilters = function ensureCollectiveProjectBrowserFiltersClean() {
    const filter = elements.projectBrowserModal?.querySelector('#project-browser-filter');
    if (!filter) {
        return;
    }

    const baseLabels = {
        all: '全部素材',
        mcp: 'MCP 素材',
        mcp_resource: 'MCP 资源',
        mcp_prompt: 'MCP 提示词',
        page_extract: '页面提取',
        editor_file_ref: '编辑器文件',
        automation_recording: '录制',
        collective: '群体研究',
        collective_report: '研究报告',
        collective_session: '研究会话',
        collective_blackboard: '研究黑板',
        collective_research_result: '研究结果'
    };

    Object.entries(baseLabels).forEach(([value, label]) => {
        let option = filter.querySelector(`option[value="${value}"]`);
        if (!option) {
            option = document.createElement('option');
            option.value = value;
            filter.appendChild(option);
        }
        option.textContent = label;
    });
};

getProjectItemTypeLabel = function getProjectItemTypeLabelClean(type) {
    const labels = {
        editor_file_ref: '文件',
        page_snapshot: '页面',
        page_extract: '提取',
        screenshot: '截图',
        note: '笔记',
        automation_recording: '录制',
        workflow_result: '工作流',
        collective_research_result: '群体研究',
        collective_session: '研究会话',
        collective_blackboard: '研究黑板',
        collective_report: '研究报告',
        workflow_template: '模板',
        workflow_run: '运行',
        mcp_resource: 'MCP 资源',
        mcp_prompt: 'MCP 提示词'
    };
    return labels[type] || '素材';
};

getProjectItemDisplayTitle = function getProjectItemDisplayTitleClean(item) {
    if (!item) {
        return '未命名素材';
    }
    if (item.title || item.name) {
        return item.title || item.name;
    }
    if (item.type === 'mcp_resource') {
        return item.meta?.uri || item.meta?.serverName || item.meta?.serverId || 'MCP 资源';
    }
    if (item.type === 'mcp_prompt') {
        return item.meta?.promptName || item.meta?.serverName || item.meta?.serverId || 'MCP 提示词';
    }
    if (String(item.type || '').startsWith('collective_')) {
        return getCollectivePreviewTopic(item);
    }
    return '未命名素材';
};

getProjectItemSummaryText = function getProjectItemSummaryTextClean(item) {
    if (!item) {
        return '';
    }
    if (item.type === 'mcp_resource') {
        return [item.meta?.serverName || item.meta?.serverId || '', item.meta?.uri || ''].filter(Boolean).join(' · ');
    }
    if (item.type === 'mcp_prompt') {
        return [item.meta?.serverName || item.meta?.serverId || '', item.meta?.promptName || ''].filter(Boolean).join(' · ');
    }
    if (item.type === 'page_extract') {
        return item.meta?.pattern ? `模式：${item.meta.pattern}` : '';
    }
    if (item.type === 'editor_file_ref') {
        return item.meta?.path || item.meta?.fileName || '';
    }
    if (item.type === 'collective_research_result') {
        return Number.isFinite(item.content?.roundsCompleted) ? `已完成 ${item.content.roundsCompleted} 轮` : '群体研究结果';
    }
    if (item.type === 'collective_session') {
        const round = item.content?.currentRound ?? item.content?.roundsCompleted;
        return Number.isFinite(round) ? `会话轮次 ${round}` : '群体研究会话';
    }
    if (item.type === 'collective_blackboard') {
        const count = Array.isArray(item.content?.entries) ? item.content.entries.length : 0;
        return `黑板条目 ${count}`;
    }
    if (item.type === 'collective_report') {
        const round = item.content?.roundsCompleted;
        return Number.isFinite(round) ? `报告轮次 ${round}` : '群体研究报告';
    }
    return item.sourceUrl || '';
};

stringifyProjectPreviewContentReadable = function stringifyProjectPreviewContentReadableClean(item) {
    if (!item) {
        return '';
    }

    if (item.entityType === 'template') {
        const lines = [
            `名称: ${item.name || '未命名模板'}`,
            item.description ? `描述: ${item.description}` : null,
            `步骤数: ${Array.isArray(item.steps) ? item.steps.length : 0}`,
            Array.isArray(item.steps) && item.steps.length > 0 ? '步骤:' : null,
            ...(Array.isArray(item.steps) ? item.steps.map((step, index) => `${index + 1}. ${step.label || step.type || 'step'} | type=${step.type || 'unknown'}`) : [])
        ].filter(Boolean);
        return lines.join('\n');
    }

    if (item.entityType === 'run') {
        const lines = [
            `状态: ${item.status || 'unknown'}`,
            item.templateName ? `模板: ${item.templateName}` : null,
            item.error ? `错误: ${item.error}` : null,
            Array.isArray(item.steps) && item.steps.length > 0 ? '步骤执行:' : null,
            ...(Array.isArray(item.steps) ? item.steps.map((step, index) => `${index + 1}. ${step.label || step.type || 'step'} | status=${step.status || 'unknown'}`) : []),
            item.outputs ? `输出: ${JSON.stringify(item.outputs, null, 2)}` : null
        ].filter(Boolean);
        return lines.join('\n');
    }

    if (item.type === 'collective_research_result' || item.type === 'collective_report') {
        return [
            `主题: ${getCollectivePreviewTopic(item)}`,
            Number.isFinite(item.content?.roundsCompleted) ? `轮次: ${item.content.roundsCompleted}` : null,
            '',
            getCollectivePreviewReport(item)
        ].filter(Boolean).join('\n');
    }

    if (item.type === 'collective_session' || item.type === 'collective_blackboard') {
        return JSON.stringify(item.content || {}, null, 2);
    }

    if (item.type === 'mcp_resource' || item.type === 'mcp_prompt') {
        return JSON.stringify(item.content || item.meta || {}, null, 2);
    }

    if (typeof item.content === 'string') {
        return item.content;
    }
    return JSON.stringify(item.content ?? item.meta ?? {}, null, 2);
};

getProjectPreviewMetaText = function getProjectPreviewMetaTextClean(record) {
    if (!record) {
        return state.currentProject?.name || '当前项目';
    }
    if (record.type === 'mcp_resource' || record.type === 'mcp_prompt') {
        return record.meta?.serverName || record.meta?.serverId || state.currentProject?.name || '当前项目';
    }
    if (record.type === 'collective_research_result') {
        return Number.isFinite(record.content?.roundsCompleted)
            ? `群体研究 · ${record.content.roundsCompleted} 轮`
            : '群体研究';
    }
    if (record.type === 'collective_session') {
        return '群体研究会话';
    }
    if (record.type === 'collective_blackboard') {
        return '群体研究黑板';
    }
    if (record.type === 'collective_report') {
        return '群体研究报告';
    }
    return record.sourceUrl || record.templateName || state.currentProject?.name || '当前项目';
};

renderProjectPreviewBody = function renderProjectPreviewBodyClean(item) {
    if (!elements.projectPreviewBody) {
        return;
    }

    if (item?.type === 'mcp_resource') {
        const meta = item.meta || {};
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>服务</span><strong>${escapeProjectPreviewHtml(meta.serverName || meta.serverId || '-')}</strong></div>
                <div class="project-preview-kv"><span>URI</span><strong>${escapeProjectPreviewHtml(meta.uri || '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('资源内容', item.content || {})}
        `;
        return;
    }

    if (item?.type === 'mcp_prompt') {
        const meta = item.meta || {};
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>服务</span><strong>${escapeProjectPreviewHtml(meta.serverName || meta.serverId || '-')}</strong></div>
                <div class="project-preview-kv"><span>提示词</span><strong>${escapeProjectPreviewHtml(meta.promptName || item.title || '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('提示词内容', item.content || {})}
        `;
        return;
    }

    if (item?.type === 'collective_research_result' || item?.type === 'collective_report') {
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>主题</span><strong>${escapeProjectPreviewHtml(getCollectivePreviewTopic(item))}</strong></div>
                <div class="project-preview-kv"><span>轮次</span><strong>${escapeProjectPreviewHtml(item.content?.roundsCompleted ?? '-')}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('最终报告', getCollectivePreviewReport(item))}
        `;
        return;
    }

    if (item?.type === 'collective_session') {
        const blackboard = item.content?.blackboard || {};
        elements.projectPreviewBody.innerHTML = `
            <section class="project-preview-section">
                <div class="project-preview-kv"><span>主题</span><strong>${escapeProjectPreviewHtml(getCollectivePreviewTopic(item))}</strong></div>
                <div class="project-preview-kv"><span>当前轮次</span><strong>${escapeProjectPreviewHtml(item.content?.currentRound ?? '-')}</strong></div>
                <div class="project-preview-kv"><span>最大轮次</span><strong>${escapeProjectPreviewHtml(item.content?.maxRounds ?? '-')}</strong></div>
                <div class="project-preview-kv"><span>黑板条目</span><strong>${escapeProjectPreviewHtml(Array.isArray(blackboard.entries) ? blackboard.entries.length : 0)}</strong></div>
            </section>
            ${buildProjectPreviewTextSection('黑板摘要', JSON.stringify(blackboard, null, 2))}
        `;
        return;
    }

    if (item?.type === 'collective_blackboard') {
        elements.projectPreviewBody.innerHTML = buildProjectPreviewTextSection('黑板内容', JSON.stringify(item.content || {}, null, 2));
        return;
    }

    elements.projectPreviewBody.textContent = stringifyProjectPreviewContentReadable(item);
};

renderProjectPreviewActions = async function renderProjectPreviewActionsClean(record) {
    ensureProjectPreviewModalV2();
    if (!elements.projectPreviewActions) {
        return;
    }

    elements.projectPreviewActions.innerHTML = '';
    const actions = [];
    const isProjectResource = Boolean(record && !record.entityType) || record?.entityType === 'template';

    if (record?.type === 'automation_recording' && !record.entityType) {
        actions.push({
            label: '保存为模板',
            handler: createTemplateFromPreviewRecord
        });
    }

    if (record?.entityType === 'template') {
        actions.push({
            label: '执行模板',
            handler: runTemplateFromPreviewRecord
        });
    }

    if (record?.type === 'collective_research_result' || record?.type === 'collective_session' || record?.type === 'collective_report') {
        actions.push({
            label: '保存为模板',
            handler: createCollectiveTemplateFromPreviewRecordAction
        });
    }

    if (record?.type === 'collective_research_result' || record?.type === 'collective_report') {
        actions.push({
            label: '写入编辑器',
            handler: saveCollectivePreviewToEditorAction
        });
    }

    if (record?.type === 'collective_research_result' || record?.type === 'collective_session') {
        actions.push({
            label: '继续研究',
            handler: continueCollectivePreviewRecordAction
        });
    }

    if (canAddProjectRecordToContext(record)) {
        actions.push({
            label: '加入上下文',
            handler: () => addProjectRecordToContext(record)
        });
    }

    if (isProjectResource) {
        const entityType = record?.entityType === 'template' ? 'template' : 'item';
        const isPublic = await projectService.isResourcePublic(entityType, record.id);
        actions.push(
            {
                label: '复制到项目',
                handler: () => handleCopyProjectResource(record)
            },
            {
                label: '转移到项目',
                handler: () => handleMoveProjectResource(record)
            },
            {
                label: isPublic ? '取消公共' : '设为公共',
                handler: () => handleToggleProjectResourcePublic(record)
            },
            {
                label: '删除资源',
                handler: () => handleDeleteProjectResource(record)
            }
        );
    }

    actions.forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'project-preview-action-btn';
        button.textContent = action.label;
        button.addEventListener('click', action.handler);
        elements.projectPreviewActions.appendChild(button);
    });

    elements.projectPreviewActions.classList.toggle('is-empty', actions.length === 0);
};
