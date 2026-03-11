/**
 * Infinpilot - Settings Management Functions (Model, General)
 */
import vectorDB from './vectorDB.js';
import { generateUniqueId } from './utils.js'; // Might need utils later
import * as QuickActionsManager from './quick-actions-manager.js';
import { tr as _, getCurrentTranslations } from './utils/i18n.js';
import toolCatalog from './automation/toolCatalog.js';
import { runtimeFetch } from './utils/runtimeFetch.js';


/**
 * 获取浏览器语言设置
 * @returns {string} 浏览器语言代码
 */
function getBrowserLanguage() {
    return navigator.language || 
           navigator.userLanguage || 
           navigator.browserLanguage || 
           navigator.systemLanguage || 
           'en';
}

/**
 * 根据浏览器语言确定适合的界面语言
 * @returns {string} 界面语言代码 ('zh-CN' 或 'en')
 */
function detectUserLanguage() {
    const browserLang = getBrowserLanguage();
    // 如果浏览器语言是中文（简体、繁体等任何中文变种），返回简体中文
    if (browserLang === 'zh-CN' || browserLang.startsWith('zh')) {
        return 'zh-CN';
    } 
    // 否则默认返回英文
    return 'en';
}

/**
 * Loads settings relevant to the Model and General tabs.
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {function} updateConnectionIndicatorCallback - Callback
 * @param {function} loadAndApplyTranslationsCallback - Callback
 * @param {function} applyThemeCallback - Callback
 */
export function loadSettings(state, elements, updateConnectionIndicatorCallback, loadAndApplyTranslationsCallback, applyThemeCallback) {
    // Setup Automation Settings UI bindings after DOM is ready
    try { setupAutomationSettingsUI(state, elements); } catch (_) {}

    // 设置全局变量以便动态创建的按钮可以访问
    window.settingsState = state;
    window.settingsElements = elements;

    // 监听语言变化事件，更新动态创建的UI元素
    document.addEventListener('infinpilot:languageChanged', (event) => {
        console.log('[Settings] Received language change event:', event.detail);
        const newLanguage = event.detail.newLanguage;

        // 更新手动添加按钮的翻译
        const currentTranslations = getCurrentTranslations();
        updateManualAddButton(currentTranslations);

        console.log('[Settings] Updated manual add button for language:', newLanguage);
    });

    Promise.all([
        browser.storage.sync.get(['apiKey', 'model', 'language', 'proxyAddress', 'providerSettings', 'userName']),
        browser.storage.local.get(['userAvatar'])
    ]).then(async ([syncResult, localResult]) => {
        // 初始化 ModelManager
        if (window.ModelManager?.instance) {
            try {
                await window.ModelManager.instance.initialize();
            } catch (error) {
                console.error('[Settings] Failed to initialize ModelManager:', error);
            }
        }

        // 处理旧版本兼容性 - API Key 和模型
        if (syncResult.apiKey) {
            // 旧版本的 API Key，迁移到 Google 供应商设置
            state.apiKey = syncResult.apiKey;
            if (window.ModelManager?.instance) {
                await window.ModelManager.instance.setProviderApiKey('google', syncResult.apiKey);
            }
        }
        if (syncResult.model) state.model = syncResult.model;

        // 加载自定义提供商
        await window.ProviderManager?.loadCustomProviders();

        // 创建所有供应商的设置UI
        await createAllProviderSettings();

        // 加载供应商设置到 UI
        await loadProviderSettingsToUI(elements);

        // 初始化供应商选择器（已集成到供应商卡片头部）
        await initProviderSelection(elements);

        // 初始化自定义提供商功能（事件委托方式）
        initCustomProviderModal();

        // 初始化快捷操作管理器
        await QuickActionsManager.initQuickActionsManager();

        // 设置模型选择器
        if (elements.modelSelection) elements.modelSelection.value = state.model;
        if (elements.chatModelSelection) elements.chatModelSelection.value = state.model;

        // Language - 检测浏览器语言
        if (syncResult.language) {
            // 如果用户已经设置了语言，使用用户设置
            state.language = syncResult.language;
        } else {
            // 如果用户没有设置语言，自动检测并设置
            state.language = detectUserLanguage();
            // 保存检测到的语言设置
            browser.storage.sync.set({ language: state.language });
        }

        if (elements.languageSelect) elements.languageSelect.value = state.language;
        loadAndApplyTranslationsCallback(state.language); // Apply translations

        // Proxy Address
        if (syncResult.proxyAddress) {
            state.proxyAddress = syncResult.proxyAddress;
        } else {
            state.proxyAddress = '';
        }
        if (elements.proxyAddressInput) elements.proxyAddressInput.value = state.proxyAddress;

        // User Profile
        if (syncResult.userName) {
            state.userName = syncResult.userName;
        } else {
            state.userName = '';
        }
        if (elements.userNameInput) elements.userNameInput.value = state.userName;

        if (localResult.userAvatar) {
            state.userAvatar = localResult.userAvatar;
        } else {
            state.userAvatar = '';
        }
        // Note: we don't set the value of the userAvatarInput here as it is a file input

        // Theme (Load default, content script might override)
        // 不再在这里设置默认主题，而是在 main.js 中从 localStorage 加载
        // state.darkMode = false; // Default to light
        applyThemeCallback(state.darkMode); // Apply current theme from state

        // Connection Status (检查是否有任何供应商配置了 API Key)
        state.isConnected = await checkAnyProviderConnected();
        updateConnectionIndicatorCallback(); // Update footer indicator

        // Initialize Vector DB Settings
        initializeVectorDbSettings(state, elements, window.showToastUI, getCurrentTranslations);

        // Initialize User Account UI
        initUserAccount();

        // Initialize Editor Appearance Settings
        initEditorAppearanceSettings();
        initMcpSettingsRuntime();

        if (elements.userNameInput) {
            elements.userNameInput.addEventListener('change', () => handleUserProfileChange(state, elements, window.showToastUI, getCurrentTranslations()));
        }
        if (elements.userAvatarInput) {
            elements.userAvatarInput.addEventListener('change', () => handleUserProfileChange(state, elements, window.showToastUI, getCurrentTranslations()));
        }
    });
}

/**
 * Saves model settings after testing the API key.
 * @param {boolean} showToastNotification - Whether to show the 'Saved' toast notification.
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {function} showConnectionStatusCallback - Callback for model settings status
 * @param {function} showToastCallback - Callback for general toast
 * @param {function} updateConnectionIndicatorCallback - Callback for footer indicator
 * @param {object} currentTranslations - Translations object
 */
export async function saveModelSettings(showToastNotification = true, state, elements, showConnectionStatusCallback, showToastCallback, updateConnectionIndicatorCallback, currentTranslations) {
    const apiKey = elements.apiKey.value.trim();
    const model = elements.modelSelection.value;

    if (!apiKey) {
        showToastCallback(_('apiKeyMissingError', {}, currentTranslations), 'error'); // Changed to showToastCallback
        return;
    }

    // UI feedback for saving/testing
    showConnectionStatusCallback(_('testingConnection', {}, currentTranslations), 'info');

    let testResult;
    try {
        // 使用新的统一 API 测试接口
        testResult = await window.InfinPilotAPI.testApiKey('google', apiKey, model);

        if (testResult.success) {
            state.apiKey = apiKey;
            state.model = model;
            state.isConnected = true;

            browser.storage.sync.set({ apiKey: state.apiKey, model: state.model }, async () => {
                if (browser.runtime.lastError) {
                    console.error("Error saving model settings:", browser.runtime.lastError);
                    showToastCallback(_('saveFailedToast', { error: browser.runtime.lastError.message }, currentTranslations), 'error'); // Changed to showToastCallback
                    state.isConnected = false; // Revert status
                    state.hasDeterminedConnection = true;
                } else {
                    if (showToastNotification) {
                        showToastCallback(testResult.message, 'success'); // 仅在需要时弹出API验证成功提示
                        // showToastCallback(_('settingsSaved', {}, currentTranslations), 'success'); // 可选：额外的"已保存"提示
                    }
                    // Sync chat model selector
                    if (elements.chatModelSelection) {
                        elements.chatModelSelection.value = state.model;
                    }

                    // API测试成功后，自动发现并添加默认模型
                    await autoDiscoverModelsAfterTest('google', showToastCallback);
                    state.hasDeterminedConnection = true;
                }
                updateConnectionIndicatorCallback(); // Update footer indicator
            });
        } else {
            // Test failed
            state.isConnected = false;
            state.hasDeterminedConnection = true;
            showToastCallback(_('connectionTestFailed', { error: testResult.message }, currentTranslations), 'error'); // Changed to showToastCallback
            updateConnectionIndicatorCallback();
        }
    } catch (error) {
        console.error("Error during API key test:", error);
        state.isConnected = false;
        state.hasDeterminedConnection = true;
        showToastCallback(_('connectionTestFailed', { error: error.message }, currentTranslations), 'error');
        updateConnectionIndicatorCallback();
    } finally {
        // No button to restore since we removed the save button
    }
}

/**
 * Handles language selection change.
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {function} loadAndApplyTranslationsCallback - Callback
 * @param {function} showToastCallback - Callback
 * @param {object} currentTranslations - Translations object (before change)
 */
export function handleLanguageChange(state, elements, loadAndApplyTranslationsCallback, showToastCallback, currentTranslations) {
    const selectedLanguage = elements.languageSelect.value;
    state.language = selectedLanguage; // Update state immediately

    browser.storage.sync.set({ language: selectedLanguage }, () => {
        if (browser.runtime.lastError) {
            console.error("Error saving language:", browser.runtime.lastError);
            showToastCallback(_('saveFailedToast', { error: browser.runtime.lastError.message }, currentTranslations), 'error'); // Use old translations for error
        } else {
            console.log(`Language saved: ${selectedLanguage}`);
            loadAndApplyTranslationsCallback(selectedLanguage); // Load and apply NEW translations
        }
    });
}

/**
 * 验证代理地址格式
 */
function validateProxyAddress(proxyAddress) {
    if (!proxyAddress || proxyAddress.trim() === '') {
        return { valid: true, message: '' }; // 空地址是有效的（表示不使用代理）
    }

    try {
        const url = new URL(proxyAddress.trim());
        const scheme = url.protocol.slice(0, -1);

        // 检查支持的协议
        const supportedSchemes = ['http', 'https', 'socks4', 'socks5'];
        if (!supportedSchemes.includes(scheme)) {
            return {
                valid: false,
                message: `不支持的代理协议: ${scheme}。支持的协议: ${supportedSchemes.join(', ')}`
            };
        }

        // 检查主机名
        if (!url.hostname) {
            return { valid: false, message: '代理地址缺少主机名' };
        }

        // 检查端口（如果提供）
        if (url.port && (isNaN(url.port) || url.port < 1 || url.port > 65535)) {
            return { valid: false, message: '代理端口必须在1-65535范围内' };
        }

        return { valid: true, message: '' };
    } catch (error) {
        return { valid: false, message: '代理地址格式无效' };
    }
}

/**
 * Handles proxy address changes
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {function} showToastCallback - Callback for showing toast messages
 * @param {object} currentTranslations - Current translations object
 */
export function handleProxyAddressChange(state, elements, showToastCallback, currentTranslations) {
    const proxyAddress = elements.proxyAddressInput.value.trim();

    // 验证代理地址
    const validation = validateProxyAddress(proxyAddress);
    if (!validation.valid) {
        showToastCallback(validation.message, 'error');
        return;
    }

    // Update state
    state.proxyAddress = proxyAddress;

    // Save to storage
    browser.storage.sync.set({ proxyAddress: proxyAddress }, () => {
        if (browser.runtime.lastError) {
            console.error("Error saving proxy url:", browser.runtime.lastError);
            showToastCallback(_('saveFailedToast', { error: browser.runtime.lastError.message }, currentTranslations), 'error');
        } else {
            console.log(`Proxy address saved: ${proxyAddress || '(empty)'}`);
            if (proxyAddress) {
                showToastCallback(_('proxySetSuccess', {}, currentTranslations), 'success');
            } else {
                showToastCallback(_('proxyCleared', {}, currentTranslations), 'success');
            }
        }
    });
}

/**
 * 测试代理连接
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {function} showToastCallback - Callback for showing toast messages
 * @param {object} currentTranslations - Current translations object
 */
export function handleProxyTest(state, elements, showToastCallback, currentTranslations) {
    const proxyAddress = elements.proxyAddressInput.value.trim();

    // 验证代理地址
    const validation = validateProxyAddress(proxyAddress);
    if (!validation.valid) {
        showToastCallback(validation.message, 'error');
        return;
    }

    if (!proxyAddress) {
        showToastCallback(_('proxyInvalidUrl', {}, currentTranslations), 'error');
        return;
    }

    // 禁用测试按钮并显示加载状态
    const testBtn = elements.testProxyBtn;
    const originalText = testBtn.textContent;
    testBtn.disabled = true;
    testBtn.textContent = _('testingConnection', {}, currentTranslations);

    // 发送测试请求到background.js
    browser.runtime.sendMessage({
        action: 'testProxy',
        proxyAddress: proxyAddress
    }, (response) => {
        // 恢复按钮状态
        testBtn.disabled = false;
        testBtn.textContent = originalText;

        if (browser.runtime.lastError) {
            console.error('Error testing proxy:', browser.runtime.lastError);
            showToastCallback(_('proxySetError', { error: browser.runtime.lastError.message }, currentTranslations), 'error');
            return;
        }

        if (response && response.success) {
            showToastCallback(_('proxySetSuccess', {}, currentTranslations), 'success');
        } else {
            const errorMsg = response?.error || 'Connection failed';
            showToastCallback(_('proxySetError', { error: errorMsg }, currentTranslations), 'error');
        }
    });
}

/**
 * Handles exporting chat history.
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {function} showToastCallback - Callback
 * @param {object} currentTranslations - Translations object
 */
export function handleExportChat(state, elements, showToastCallback, currentTranslations) {
    const format = elements.exportFormatSelect.value;
    let content = '';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let filename = `infinpilot_chat_${timestamp}`;

    if (format === 'markdown') {
        filename += '.md';
        content = exportChatToMarkdown(state, currentTranslations);
    } else { // text format
        filename += '.txt';
        content = exportChatToText(state, currentTranslations);
    }

    if (!content) {
        showToastCallback(_('chatExportEmptyError', {}, currentTranslations), 'error');
        return;
    }

    try {
        const blob = new Blob([content], { type: format === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        if (a && a.parentNode) {
            a.parentNode.removeChild(a);
        } else if (typeof a.remove === 'function') {
            a.remove();
        }
        URL.revokeObjectURL(url);
        showToastCallback(_('chatExportSuccess', {}, currentTranslations), 'success');
    } catch (error) {
        console.error("Error creating download link:", error);
        showToastCallback(_('chatExportError', { error: error.message }, currentTranslations), 'error'); // Need translation
    }
}

/**
 * Exports chat history to Markdown format.
 * @param {object} state - Global state reference
 * @param {object} currentTranslations - Translations object
 * @returns {string} Markdown content
 */
function exportChatToMarkdown(state, currentTranslations) {
    if (state.chatHistory.length === 0) return '';

    const _tr = (key, rep = {}) => _(key, rep, currentTranslations);
    const locale = state.language.toLowerCase() === 'zh-cn' ? 'zh-cn' : 'en';
    if (typeof dayjs !== 'undefined') dayjs.locale(locale);
    const timestamp = typeof dayjs !== 'undefined' ? dayjs().format('YYYY-MM-DD HH:mm:ss') : new Date().toLocaleString();

    let markdown = `# ${_tr('appName')} ${_tr('chatTab')} History (${timestamp})

`;

    state.chatHistory.forEach(message => {
        const { text, images } = extractPartsFromMessage(message); // Use helper
        const role = message.role === 'user' ? _tr('chatTab') : _tr('appName');
        markdown += `## ${role}\n\n`;

        if (images.length > 0) {
            images.forEach((img, index) => {
                // Include image placeholder, maybe with mime type
                markdown += `[${_tr('imageAlt', { index: index + 1 })} - ${img.mimeType}]\n`;
            });
            markdown += '\n';
        }

        if (text) {
            // Basic Markdown escaping (optional, depends on desired output)
            // const escapedText = text.replace(/([\\`*_{}[\]()#+.!-])/g, '\\$1');
            markdown += `${text}\n\n`; // Use original text for Markdown
        }
    });

    return markdown;
}

/**
 * Exports chat history to plain text format.
 * @param {object} state - Global state reference
 * @param {object} currentTranslations - Translations object
 * @returns {string} Plain text content
 */
function exportChatToText(state, currentTranslations) {
    if (state.chatHistory.length === 0) return '';

    const _tr = (key, rep = {}) => _(key, rep, currentTranslations);
    const locale = state.language.toLowerCase() === 'zh-cn' ? 'zh-cn' : 'en';
    if (typeof dayjs !== 'undefined') dayjs.locale(locale);
    const timestamp = typeof dayjs !== 'undefined' ? dayjs().format('YYYY-MM-DD HH:mm:ss') : new Date().toLocaleString();

    let textContent = `${_tr('appName')} ${_tr('chatTab')} History (${timestamp})\n\n`;

    state.chatHistory.forEach(message => {
        const { text, images } = extractPartsFromMessage(message); // Use helper
        const role = message.role === 'user' ? _tr('chatTab') : _tr('appName');
        textContent += `--- ${role} ---\n`;

        if (images.length > 0) {
            textContent += `[${_tr('containsNImages', { count: images.length })}]\n`;
        }

        if (text) {
            textContent += `${text}\n`;
        }
        textContent += '\n';
    });

    return textContent;
}

/**
 * Helper to extract text and image info from a message object.
 * (Could be moved to utils.js if used elsewhere)
 * @param {object} message - A message object from state.chatHistory
 * @returns {{text: string, images: Array<{dataUrl: string, mimeType: string}>}}
 */
function extractPartsFromMessage(message) {
    let text = '';
    const images = [];
    if (message && message.parts && Array.isArray(message.parts)) {
        message.parts.forEach(part => {
            if (part.text) {
                text += (text ? '\n' : '') + part.text; // Combine text parts with newline
            } else if (part.inlineData && part.inlineData.data && part.inlineData.mimeType) {
                images.push({
                    dataUrl: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
                    mimeType: part.inlineData.mimeType
                });
            }
        });
    }
    return { text, images };
}

/**
 * Initializes model selection dropdowns using ModelManager.
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 */
export async function initModelSelection(state, elements) {
    // 确保模型管理器已初始化
    if (!window.ModelManager?.instance) {
        console.error('[Settings] ModelManager not available');
        return;
    }

    const modelManager = window.ModelManager.instance;
    await modelManager.initialize();

    // 获取用户可用的模型选项
    const modelOptions = modelManager.getModelOptionsForUI();

    // 填充选择器的通用函数 - 按提供商分组
    const populateSelect = (selectElement) => {
        if (!selectElement) return;
        selectElement.innerHTML = '';

        // 按提供商分组模型
        const modelsByProvider = {};
        modelOptions.forEach(option => {
            const providerId = option.providerId || 'unknown';
            const providerName = option.providerName || 'Unknown';

            if (!modelsByProvider[providerId]) {
                modelsByProvider[providerId] = {
                    name: providerName,
                    models: []
                };
            }
            modelsByProvider[providerId].models.push(option);
        });

        // 按提供商名称排序
        const sortedProviders = Object.entries(modelsByProvider).sort(([, a], [, b]) =>
            a.name.localeCompare(b.name)
        );

        // 为每个提供商创建 optgroup
        sortedProviders.forEach(([providerId, providerData]) => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = providerData.name;
            optgroup.setAttribute('data-provider-id', providerId);

            // 按模型名称排序
            const sortedModels = providerData.models.sort((a, b) => a.text.localeCompare(b.text));

            sortedModels.forEach(option => {
                const optionElement = document.createElement('option');
                optionElement.value = option.value;
                optionElement.textContent = option.text; // 不再显示提供商名称，因为已经分组了
                if (option.disabled) {
                    optionElement.disabled = true;
                }
                // 添加数据属性用于样式控制
                optionElement.setAttribute('data-provider-id', option.providerId || '');
                optionElement.setAttribute('data-provider-name', option.providerName || '');
                optgroup.appendChild(optionElement);
            });

            selectElement.appendChild(optgroup);
        });

        // 确保当前状态的模型被选中，或默认选择第一个
        if (modelOptions.some(o => o.value === state.model)) {
            selectElement.value = state.model;
        } else if (modelOptions.length > 0) {
            selectElement.value = modelOptions[0].value;
            state.model = modelOptions[0].value; // 如果模型无效则更新状态
        }
    };

    populateSelect(elements.modelSelection); // Settings tab
    populateSelect(elements.chatModelSelection); // Chat tab

    // 更新模型卡片显示
    updateModelCardsDisplay();

    console.log('[Settings] Model selection initialized with', modelOptions.length, 'models');
}

/**
 * 更新模型卡片显示
 */
export async function updateModelCardsDisplay() {
    const container = document.getElementById('selected-models-container');
    if (!container) return;

    if (!window.ModelManager?.instance) {
        console.error('[Settings] ModelManager not available for cards display');
        return;
    }

    const modelManager = window.ModelManager.instance;
    await modelManager.initialize();

    // 获取用户激活的模型
    const activeModels = modelManager.getUserActiveModels();

    // 获取当前翻译对象
    const currentTranslations = getCurrentTranslations();

    // 清空容器
    container.innerHTML = '';

    // 创建模型卡片
    activeModels.forEach(model => {
        const card = createModelCard(model, currentTranslations);
        container.appendChild(card);
    });

    // 添加或更新手动添加按钮到header区域
    updateManualAddButton(currentTranslations);
}

/**
 * 创建模型卡片
 * @param {Object} model - 模型对象
 * @param {Object} currentTranslations - 当前翻译对象
 * @returns {HTMLElement} 卡片元素
 */
function createModelCard(model, currentTranslations) {
    const card = document.createElement('div');
    card.className = 'model-card';
    // 复合键用于准确操作
    const modelKey = `${model.providerId}::${model.id}`;
    card.dataset.modelKey = modelKey;

    const removeTooltip = (model.canDelete !== false)
        ? (_('deleteModelTooltip', {}, currentTranslations) || '删除此模型')
        : (_('removeModelTooltip', {}, currentTranslations) || '移除此模型');

    // 根据模型的canDelete属性决定是否显示删除按钮
    const canDelete = model.canDelete !== false; // 默认可删除，除非明确设置为false
    const removeButtonHtml = canDelete ? `
        <button class="model-card-remove" title="${removeTooltip}" aria-label="${removeTooltip}">
            <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
        </button>
    ` : '';

    // 悬浮展示“provider: model id” - 使用自定义 tooltip（立即显示）
    const hoverLabel = `${model.providerId}: ${model.id}`;
    card.classList.add('has-tooltip');
    card.setAttribute('data-tooltip', hoverLabel);

    // 确保 tooltip 样式只注入一次
    if (!document.getElementById('model-card-tooltip-style')) {
        const style = document.createElement('style');
        style.id = 'model-card-tooltip-style';
        style.textContent = `
            .model-card.has-tooltip { position: relative; }
            .model-card.has-tooltip::after {
                content: attr(data-tooltip);
                position: absolute;
                bottom: 100%;
                left: 50%;
                transform: translate(-50%, -6px);
                background: rgba(0, 0, 0, 0.85);
                color: #fff;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 12px;
                line-height: 1;
                white-space: nowrap;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.06s ease;
                z-index: 2000;
            }
            .model-card.has-tooltip:hover::after { opacity: 1; }

            /* 深色模式适配 */
            body.dark-mode .model-card.has-tooltip::after {
                background: rgba(255, 255, 255, 0.95);
                color: #000;
            }
        `;
        document.head.appendChild(style);
    }

    card.innerHTML = `
        <span class="model-card-name">${model.displayName}</span>
        ${removeButtonHtml}
    `;

    // 只有可删除的模型才添加删除事件
    if (canDelete) {
        const removeBtn = card.querySelector('.model-card-remove');
        if (removeBtn) {
            removeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await removeModelFromSelection(modelKey);
            });
        }
    }

    return card;
}

/**
 * 更新手动添加模型按钮到header区域
 * @param {Object} currentTranslations - 当前翻译对象
 */
function updateManualAddButton(currentTranslations) {
    const header = document.querySelector('.model-management-header');
    if (!header) return;

    // 清理右侧按钮容器
    const existingGroup = header.querySelector('.model-actions-right');
    if (existingGroup) existingGroup.remove();

    // 创建右侧按钮容器
    const group = document.createElement('div');
    group.className = 'model-actions-right';

    // 创建“抓取模型”按钮（从当前选中供应商抓取）
    const discoverBtn = createDiscoverHeaderButton(currentTranslations);
    group.appendChild(discoverBtn);

    // 创建“添加自定义模型”按钮
    const manualBtn = createManualAddButton(currentTranslations);
    group.appendChild(manualBtn);

    header.appendChild(group);
}

/**
 * 创建手动添加模型按钮
 * @param {Object} currentTranslations - 当前翻译对象
 * @returns {HTMLElement} 按钮元素
 */
function createManualAddButton(currentTranslations) {
    const button = document.createElement('button');
    button.className = 'manual-add-model-btn';
    button.title = _('manualAddModel', {}, currentTranslations);
    button.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
        </svg>
        <span>${_('manualAddModel', {}, currentTranslations)}</span>
    `;

    // 添加点击事件监听器
    button.addEventListener('click', () => {
        // 获取最新的翻译对象
        const latestTranslations = getCurrentTranslations();
        showManualAddModelDialog(latestTranslations);
    });

    return button;
}

/**
 * 创建“抓取模型”按钮（放在模型管理头部）
 */
function createDiscoverHeaderButton(currentTranslations) {
    const button = document.createElement('button');
    // 复用 discover-models-btn 的视觉风格，便于一致性
    button.className = 'discover-models-btn';
    button.title = _('discoverModels', {}, currentTranslations);
    button.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;margin-right:6px;">
            <path d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7z"/>
        </svg>
        <span>${_('discoverModels', {}, currentTranslations)}</span>
    `;

    button.addEventListener('click', async () => {
        // 直接调用发现模型逻辑，并以此按钮作为UI反馈对象
        const providerId = getCurrentVisibleProviderId();
        if (!providerId) return;

        const state = window.state || {};
        const elements = {
            modelSelection: document.getElementById('model-selection'),
            chatModelSelection: document.getElementById('chat-model-selection')
        };
        await handleDiscoverModelsForProvider(providerId, state, elements, window.showToastUI || (()=>{}), button);
    });

    return button;
}

/**
 * 从选择中移除模型
 * @param {string} modelKey - 复合键 providerId::modelId（兼容旧id）
 */
async function removeModelFromSelection(modelKey) {
    if (!window.ModelManager?.instance) {
        console.error('[Settings] ModelManager not available for model removal');
        return;
    }

    const modelManager = window.ModelManager.instance;
    await modelManager.initialize();

    // 检查模型是否可以删除
    const model = modelManager.getModelByKey(modelKey);
    if (!model) {
        console.error('[Settings] Model not found:', modelKey);
        return;
    }

    if (model.canDelete === false) {
        const currentTranslations = getCurrentTranslations();
        alert(_('cannotRemoveProtectedModel', {}, currentTranslations) || '无法删除受保护的模型');
        return;
    }

    // 检查是否是最后一个模型
    const activeModels = modelManager.getUserActiveModels();
    if (activeModels.length <= 1) {
        const currentTranslations = getCurrentTranslations();
        alert(_('minOneModelError', {}, currentTranslations));
        return;
    }

    // 可删除且非默认 -> 彻底删除；否则仅从激活列表移除
    if (model.canDelete !== false && model.isDefault !== true) {
        await modelManager.deleteModel(modelKey);
    } else {
        await modelManager.removeModel(modelKey);
    }

    // 更新UI
    await updateModelCardsDisplay();

    // 重新填充下拉选择器
    const modelSelection = document.getElementById('model-selection');
    const chatModelSelection = document.getElementById('chat-model-selection');
    if (modelSelection || chatModelSelection) {
        const modelOptions = modelManager.getModelOptionsForUI();

        [modelSelection, chatModelSelection].forEach(selectElement => {
            if (!selectElement) return;

            const currentValue = selectElement.value;
            selectElement.innerHTML = '';

            // 按提供商分组模型
            const modelsByProvider = {};
            modelOptions.forEach(option => {
                const providerId = option.providerId || 'unknown';
                const providerName = option.providerName || 'Unknown';

                if (!modelsByProvider[providerId]) {
                    modelsByProvider[providerId] = {
                        name: providerName,
                        models: []
                    };
                }
                modelsByProvider[providerId].models.push(option);
            });

            // 按提供商名称排序
            const sortedProviders = Object.entries(modelsByProvider).sort(([, a], [, b]) =>
                a.name.localeCompare(b.name)
            );

            // 为每个提供商创建 optgroup
            sortedProviders.forEach(([providerId, providerData]) => {
                const optgroup = document.createElement('optgroup');
                optgroup.label = providerData.name;
                optgroup.setAttribute('data-provider-id', providerId);

                // 按模型名称排序
                const sortedModels = providerData.models.sort((a, b) => a.text.localeCompare(b.text));

                sortedModels.forEach(option => {
                    const optionElement = document.createElement('option');
                    optionElement.value = option.value;
                    optionElement.textContent = option.text;
                    // 添加数据属性用于样式控制
                    optionElement.setAttribute('data-provider-id', option.providerId || '');
                    optionElement.setAttribute('data-provider-name', option.providerName || '');
                    optgroup.appendChild(optionElement);
                });

                selectElement.appendChild(optgroup);
            });

            // 如果当前选中的模型被删除了，选择第一个可用的
            if (modelOptions.some(o => o.value === currentValue)) {
                selectElement.value = currentValue;
            } else if (modelOptions.length > 0) {
                selectElement.value = modelOptions[0].value;
            }
        });
    }

    console.log(`[Settings] Removed model: ${modelKey}`);
}



/**
 * 显示模型选择对话框
 * @param {Array} models - 可选择的模型列表
 * @param {Object} currentTranslations - 当前翻译对象
 * @param {function} onConfirm - 确认回调函数
 * @param {function} onCancel - 取消回调函数（可选）
 */
function showModelSelectionDialog(models, currentTranslations, onConfirm, onCancel = null) {
    // 创建对话框
    const dialog = document.createElement('div');
    dialog.className = 'model-discovery-dialog';
    dialog.innerHTML = `
        <div class="dialog-overlay">
            <div class="dialog-content">
                <div class="dialog-header">
                    <h3>${_('addModelsDialogTitle', {}, currentTranslations)}</h3>
                    <button type="button" class="close-btn" aria-label="${_('addModelsDialogClose', {}, currentTranslations)}">×</button>
                </div>
                <div class="dialog-body">
                    <p class="model-count">${_('modelsFoundMessage', { count: models.length }, currentTranslations)}</p>
                    <div class="search-container">
                        <input type="text" class="model-search-input" placeholder="${_('searchModelsPlaceholder', {}, currentTranslations)}" autocomplete="off">
                        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"></circle>
                            <path d="m21 21-4.35-4.35"></path>
                        </svg>
                    </div>
                    <div class="model-list">
                        ${models.map(model => `
                            <div class="model-item" data-model-id="${model.id}">
                                <span class="model-name">${model.id}</span>
                                <div class="model-checkbox">
                                    <input type="checkbox" id="model-${model.id}" value="${model.id}">
                                    <label for="model-${model.id}" class="checkbox-label">
                                        <svg class="checkmark" viewBox="0 0 24 24">
                                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                                        </svg>
                                    </label>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="dialog-footer">
                    <div class="selection-info">
                        <span class="selected-count">${_('selectedCountMessage', { count: 0 }, currentTranslations)}</span>
                    </div>
                    <div class="dialog-actions">
                        <button type="button" class="cancel-btn">${_('addModelsCancel', {}, currentTranslations)}</button>
                        <button type="button" class="confirm-btn" disabled>${_('addModelsConfirm', {}, currentTranslations)}</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // 添加样式
    const style = document.createElement('style');
    style.textContent = `
        .model-discovery-dialog .dialog-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            backdrop-filter: blur(4px);
        }

        .model-discovery-dialog .dialog-content {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
            width: 90vw;
            max-width: 600px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .model-discovery-dialog .dialog-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 24px 24px 16px 24px;
            border-bottom: 1px solid #e9ecef;
        }

        .model-discovery-dialog .dialog-header h3 {
            margin: 0;
            font-size: 20px;
            font-weight: 600;
            color: #2c3e50;
        }

        .model-discovery-dialog .close-btn {
            background: none;
            border: none;
            font-size: 24px;
            color: #6c757d;
            cursor: pointer;
            padding: 4px;
            border-radius: 50%;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
        }

        .model-discovery-dialog .close-btn:hover {
            background: #f8f9fa;
            color: #495057;
        }

        .model-discovery-dialog .dialog-body {
            flex: 1;
            padding: 16px 24px;
            overflow-y: auto;
        }

        .model-discovery-dialog .model-count {
            margin: 0 0 20px 0;
            color: #6c757d;
            font-size: 14px;
        }

        .model-discovery-dialog .search-container {
            position: relative;
            margin-bottom: 16px;
        }

        .model-discovery-dialog .model-search-input {
            width: 100%;
            padding: 12px 16px 12px 40px;
            border: 2px solid #e9ecef;
            border-radius: 12px;
            font-size: 14px;
            background: #ffffff;
            transition: all 0.2s ease;
            outline: none;
            box-sizing: border-box;
        }

        .model-discovery-dialog .model-search-input:focus {
            border-color: #007bff;
            background: #f8f9ff;
            box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.1);
        }

        .model-discovery-dialog .search-icon {
            position: absolute;
            left: 12px;
            top: 14px;
            width: 16px;
            height: 16px;
            color: #6c757d;
            pointer-events: none;
        }

        .model-discovery-dialog .model-list {
            display: grid;
            gap: 8px;
            max-height: 400px;
            overflow-y: auto;
            padding-right: 8px;
        }

        .model-discovery-dialog .model-list::-webkit-scrollbar {
            width: 6px;
        }

        .model-discovery-dialog .model-list::-webkit-scrollbar-track {
            background: #f1f3f4;
            border-radius: 3px;
        }

        .model-discovery-dialog .model-list::-webkit-scrollbar-thumb {
            background: #c1c8cd;
            border-radius: 3px;
        }

        .model-discovery-dialog .model-list::-webkit-scrollbar-thumb:hover {
            background: #a8b2ba;
        }

        .model-discovery-dialog .model-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px;
            border: 2px solid #e9ecef;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s ease;
            background: #ffffff;
        }

        .model-discovery-dialog .model-item:hover {
            border-color: #007bff;
            background: #f8f9ff;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0, 123, 255, 0.1);
        }

        .model-discovery-dialog .model-item.selected {
            border-color: #007bff;
            background: #e7f3ff;
        }

        .model-discovery-dialog .model-name {
            font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
            font-size: 14px;
            font-weight: 500;
            color: #2c3e50;
            flex: 1;
        }

        .model-discovery-dialog .model-checkbox {
            position: relative;
        }

        .model-discovery-dialog .model-checkbox input[type="checkbox"] {
            position: absolute;
            opacity: 0;
            width: 0;
            height: 0;
            margin: 0;
            padding: 0;
            border: none;
            outline: none;
            pointer-events: none;
        }

        .model-discovery-dialog .checkbox-label {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            border: 2px solid #dee2e6;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s ease;
            background: transparent;
            position: relative;
            flex-shrink: 0;
        }

        .model-discovery-dialog .checkbox-label:hover {
            border-color: #007bff;
        }

        .model-discovery-dialog .checkmark {
            width: 16px;
            height: 16px;
            fill: #007bff;
            opacity: 0;
            transform: scale(0);
            transition: all 0.15s ease;
            stroke: #007bff;
            stroke-width: 2;
        }

        .model-discovery-dialog input[type="checkbox"]:checked + .checkbox-label {
            border-color: #007bff;
            background: transparent;
        }

        .model-discovery-dialog input[type="checkbox"]:checked + .checkbox-label .checkmark {
            opacity: 1;
            transform: scale(1);
        }

        .model-discovery-dialog .dialog-footer {
            padding: 16px 24px 24px 24px;
            border-top: 1px solid #e9ecef;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .model-discovery-dialog .selection-info {
            color: #6c757d;
            font-size: 14px;
        }

        .model-discovery-dialog .selected-count {
            font-weight: 500;
        }

        .model-discovery-dialog .dialog-actions {
            display: flex;
            gap: 12px;
        }

        .model-discovery-dialog .dialog-actions button {
            padding: 10px 20px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s ease;
            min-width: 80px;
        }

        .model-discovery-dialog .cancel-btn {
            background: #f8f9fa;
            color: #6c757d;
            border: 1px solid #dee2e6;
        }

        .model-discovery-dialog .cancel-btn:hover {
            background: #e9ecef;
            color: #495057;
        }

        .model-discovery-dialog .confirm-btn {
            background: #007bff;
            color: white;
        }

        .model-discovery-dialog .confirm-btn:hover:not(:disabled) {
            background: #0056b3;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0, 123, 255, 0.3);
        }

        .model-discovery-dialog .confirm-btn:disabled {
            background: #dee2e6;
            color: #6c757d;
            cursor: not-allowed;
        }

        /* 深色模式适配 */
        body.dark-mode .model-discovery-dialog .dialog-content {
            background: var(--card-background);
            color: var(--text-color);
        }

        body.dark-mode .model-discovery-dialog .dialog-header {
            border-bottom-color: var(--border-color);
        }

        body.dark-mode .model-discovery-dialog .dialog-header h3 {
            color: var(--text-color);
        }

        body.dark-mode .model-discovery-dialog .close-btn {
            color: var(--text-secondary);
        }

        body.dark-mode .model-discovery-dialog .close-btn:hover {
            background: var(--button-hover-bg);
            color: var(--text-color);
        }

        body.dark-mode .model-discovery-dialog .model-count {
            color: var(--text-secondary);
        }

        body.dark-mode .model-discovery-dialog .model-search-input {
            background: var(--input-background);
            border-color: var(--border-color);
            color: var(--text-color);
        }

        body.dark-mode .model-discovery-dialog .model-search-input:focus {
            border-color: var(--primary-color);
            background: rgba(116, 143, 252, 0.1);
            box-shadow: 0 0 0 3px rgba(116, 143, 252, 0.2);
        }

        body.dark-mode .model-discovery-dialog .search-icon {
            color: var(--text-secondary);
        }

        body.dark-mode .model-discovery-dialog .model-list::-webkit-scrollbar-track {
            background: var(--background-color);
        }

        body.dark-mode .model-discovery-dialog .model-list::-webkit-scrollbar-thumb {
            background: var(--scrollbar-thumb);
        }

        body.dark-mode .model-discovery-dialog .model-list::-webkit-scrollbar-thumb:hover {
            background: var(--scrollbar-thumb-hover);
        }

        body.dark-mode .model-discovery-dialog .model-item {
            background: var(--background-color);
            border-color: var(--border-color);
        }

        body.dark-mode .model-discovery-dialog .model-item:hover {
            border-color: var(--primary-color);
            background: rgba(116, 143, 252, 0.1);
        }

        body.dark-mode .model-discovery-dialog .model-item.selected {
            border-color: var(--primary-color);
            background: rgba(116, 143, 252, 0.2);
        }

        body.dark-mode .model-discovery-dialog .model-name {
            color: var(--text-color);
        }

        body.dark-mode .model-discovery-dialog .checkbox-label {
            background: transparent;
            border-color: var(--border-color);
        }

        body.dark-mode .model-discovery-dialog .checkbox-label:hover {
            border-color: var(--primary-color);
        }

        body.dark-mode .model-discovery-dialog input[type="checkbox"]:checked + .checkbox-label {
            background: transparent;
            border-color: var(--primary-color);
        }

        body.dark-mode .model-discovery-dialog .checkmark {
            fill: var(--primary-color);
            stroke: var(--primary-color);
        }

        body.dark-mode .model-discovery-dialog .dialog-footer {
            border-top-color: var(--border-color);
        }

        body.dark-mode .model-discovery-dialog .selection-info {
            color: var(--text-secondary);
        }

        body.dark-mode .model-discovery-dialog .cancel-btn {
            background: var(--button-hover-bg);
            color: var(--text-secondary);
            border-color: var(--border-color);
        }

        body.dark-mode .model-discovery-dialog .cancel-btn:hover {
            background: var(--border-color);
            color: var(--text-color);
        }

        body.dark-mode .model-discovery-dialog .confirm-btn {
            background: var(--primary-color);
            color: white;
        }

        body.dark-mode .model-discovery-dialog .confirm-btn:hover:not(:disabled) {
            background: var(--secondary-color);
        }

        body.dark-mode .model-discovery-dialog .confirm-btn:disabled {
            background: var(--border-color);
            color: var(--text-secondary);
        }

        @media (max-width: 768px) {
            .model-discovery-dialog .dialog-content {
                width: 95vw;
                max-height: 90vh;
            }

            .model-discovery-dialog .dialog-header,
            .model-discovery-dialog .dialog-body,
            .model-discovery-dialog .dialog-footer {
                padding-left: 16px;
                padding-right: 16px;
            }

            .model-discovery-dialog .model-item {
                padding: 12px 16px;
            }
        }
    `;
    document.head.appendChild(style);

    // 事件处理
    const cancelBtn = dialog.querySelector('.cancel-btn');
    const confirmBtn = dialog.querySelector('.confirm-btn');
    const closeBtn = dialog.querySelector('.close-btn');
    const selectedCountSpan = dialog.querySelector('.selected-count');
    const searchInput = dialog.querySelector('.model-search-input');
    const modelList = dialog.querySelector('.model-list');
    const modelItems = dialog.querySelectorAll('.model-item');
    const checkboxes = dialog.querySelectorAll('input[type="checkbox"]');

    // 搜索过滤功能
    function filterModels(searchTerm) {
        const term = searchTerm.toLowerCase().trim();

        modelItems.forEach(item => {
            const modelName = item.querySelector('.model-name').textContent.toLowerCase();
            const matches = modelName.includes(term);

            if (matches) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    }

    // 更新选中计数
    function updateSelectedCount() {
        const checkedCount = dialog.querySelectorAll('input[type="checkbox"]:checked').length;
        selectedCountSpan.textContent = _('selectedCountMessage', { count: checkedCount }, currentTranslations);
        confirmBtn.disabled = checkedCount === 0;
    }

    // 关闭对话框
    function closeDialog() {
        if (dialog && dialog.parentNode) {
            dialog.parentNode.removeChild(dialog);
        } else if (dialog && typeof dialog.remove === 'function') {
            dialog.remove();
        }
        if (style && style.parentNode) {
            style.parentNode.removeChild(style);
        } else if (style && typeof style.remove === 'function') {
            style.remove();
        }
        // 调用取消回调（如果提供）
        if (onCancel && typeof onCancel === 'function') {
            onCancel();
        }
    }

    // 模型项点击事件
    modelItems.forEach(item => {
        item.addEventListener('click', (e) => {
            // 如果点击的是checkbox或label，不处理（让默认行为处理）
            if (e.target.type === 'checkbox' || e.target.classList.contains('checkbox-label') || e.target.closest('.checkbox-label')) {
                return;
            }

            // 点击模型项其他区域时，切换checkbox状态
            const checkbox = item.querySelector('input[type="checkbox"]');
            checkbox.checked = !checkbox.checked;

            // 更新视觉状态
            if (checkbox.checked) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }

            updateSelectedCount();
        });
    });

    // Checkbox变化事件
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const item = e.target.closest('.model-item');
            if (e.target.checked) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
            updateSelectedCount();
        });
    });

    // 搜索输入事件
    searchInput.addEventListener('input', (e) => {
        filterModels(e.target.value);
    });

    // 按钮事件
    cancelBtn.addEventListener('click', closeDialog);
    closeBtn.addEventListener('click', closeDialog);

    confirmBtn.addEventListener('click', () => {
        const checkedBoxes = dialog.querySelectorAll('input[type="checkbox"]:checked');
        const selectedIds = Array.from(checkedBoxes).map(cb => cb.value);

        closeDialog();
        onConfirm(selectedIds);
    });

    // 点击遮罩关闭
    dialog.querySelector('.dialog-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closeDialog();
        }
    });

    // ESC键关闭
    function handleKeyDown(e) {
        if (e.key === 'Escape') {
            closeDialog();
            document.removeEventListener('keydown', handleKeyDown);
        }
    }
    document.addEventListener('keydown', handleKeyDown);

    // 初始化选中计数
    updateSelectedCount();

    document.body.appendChild(dialog);
}

// === 多供应商支持函数 ===

/**
 * 获取当前可见的供应商设置卡片元素
 */
function getVisibleProviderSettingsEl() {
    const all = document.querySelectorAll('.provider-settings');
    for (const el of all) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none') return el;
    }
    return null;
}

/**
 * 获取当前可见供应商ID
 */
function getCurrentVisibleProviderId() {
    const visible = getVisibleProviderSettingsEl();
    if (!visible || !visible.id) return null;
    return visible.id.replace('provider-settings-', '');
}

/**
 * 填充供应商下拉框
 */
function populateProviderSelect(selectEl, options, selectedValue) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.text;
        selectEl.appendChild(o);
    });
    if (selectedValue) {
        selectEl.value = selectedValue;
    }
}

/**
 * 更新当前可见卡片中的供应商选择器
 */
function updateProviderSelectInVisibleCard() {
    const providerOptions = window.ProviderManager?.getProviderOptionsForUI() || [];
    const visible = getVisibleProviderSettingsEl();
    if (!visible) return;
    const currentId = getCurrentVisibleProviderId() || 'google';
    const select = visible.querySelector('select.provider-select');
    if (!select) return;

    populateProviderSelect(select, providerOptions, currentId);

    // 绑定变更事件（重置以避免重复）
    select.onchange = async (e) => {
        const nextId = e.target.value;
        await showProviderSettings(nextId);
        // 切换后更新新卡片中的下拉框
        updateProviderSelectInVisibleCard();
    };
}

/**
 * 初始化供应商选择器
 */
async function initProviderSelection(elements) {
    // 首次显示默认供应商
    await showProviderSettings('google');
    // 填充并绑定当前可见卡片中的选择器
    updateProviderSelectInVisibleCard();
}

/**
 * 显示指定供应商的设置区域
 */
async function showProviderSettings(providerId) {
    // 隐藏所有供应商设置
    const allProviderSettings = document.querySelectorAll('.provider-settings');
    allProviderSettings.forEach(setting => {
        setting.style.display = 'none';
    });

    // 显示选中的供应商设置
    let targetSettings = document.getElementById(`provider-settings-${providerId}`);

    // 如果设置区域不存在，创建它
    if (!targetSettings) {
        const provider = window.ProviderManager?.getProvider(providerId);
        if (provider) {
            console.log(`[Settings] Creating settings area for provider: ${providerId}`);
            await createAllProviderSettings();
            targetSettings = document.getElementById(`provider-settings-${providerId}`);
        }
    }

    if (targetSettings) {
        targetSettings.style.display = 'block';
        // 同步头部选择器的当前值
        updateProviderSelectInVisibleCard();
    } else {
        console.warn(`[Settings] Settings area not found for provider: ${providerId}`);
    }
}

/**
 * 加载供应商设置到 UI
 */
async function loadProviderSettingsToUI(elements) {
    if (!window.ModelManager?.instance) return;

    // 首先确保为所有供应商创建设置区域
    await createAllProviderSettings();

    const modelManager = window.ModelManager.instance;
    const providerIds = window.ProviderManager?.getProviderIds() || [];

    for (const providerId of providerIds) {
        const apiKey = modelManager.getProviderApiKey(providerId);
        const apiKeyInput = document.getElementById(`${providerId}-api-key`);

        if (apiKeyInput && apiKey) {
            apiKeyInput.value = apiKey;
        }
    }
}

/**
 * 检查是否有任何供应商已连接
 */
async function checkAnyProviderConnected() {
    if (!window.ModelManager?.instance) return false;

    const modelManager = window.ModelManager.instance;
    const providerIds = window.ProviderManager?.getProviderIds() || [];

    for (const providerId of providerIds) {
        if (modelManager.isProviderConfigured(providerId)) {
            return true;
        }
    }
    return false;
}

/**
 * 设置供应商事件监听器
 */
export function setupProviderEventListeners(state, elements, showToastCallback, updateConnectionIndicatorCallback) {
    // 使用事件委托来处理动态创建的元素
    const container = document.querySelector('.provider-settings-container');
    if (!container) return;

    // 防止重复绑定事件监听器
    if (container.dataset.eventListenersSetup === 'true') {
        console.log('[Settings] Provider event listeners already setup, skipping...');
        return;
    }
    container.dataset.eventListenersSetup = 'true';

    // API Key 可见性切换 - 使用事件委托
    container.addEventListener('click', (e) => {
        if (e.target.closest('.toggle-api-key-button')) {
            console.log('[Settings] Toggle API key button clicked via event delegation');
            const button = e.target.closest('.toggle-api-key-button');
            const targetId = button.getAttribute('data-target');
            const input = document.getElementById(targetId);
            const eyeIcon = button.querySelector('.eye-icon');
            const eyeSlashIcon = button.querySelector('.eye-slash-icon');

            console.log('[Settings] Target input:', targetId, input);
            console.log('[Settings] Eye icons:', eyeIcon, eyeSlashIcon);

            if (input && input.type === 'password') {
                input.type = 'text';
                eyeIcon.style.display = 'none';
                eyeSlashIcon.style.display = 'block';
                console.log('[Settings] Changed to text type');
            } else if (input) {
                input.type = 'password';
                eyeIcon.style.display = 'block';
                eyeSlashIcon.style.display = 'none';
                console.log('[Settings] Changed to password type');
            }
        }
    });

    // API Key 输入事件 - 使用事件委托
    container.addEventListener('blur', async (e) => {
        if (e.target.matches('[id$="-api-key"]')) {
            const input = e.target;
            const providerId = input.id.replace('-api-key', '');
            const apiKey = input.value.trim();

            if (window.ModelManager?.instance) {
                await window.ModelManager.instance.setProviderApiKey(providerId, apiKey);

                // 更新连接状态
                state.isConnected = await checkAnyProviderConnected();
                // 调用更新连接指示器的回调
                if (updateConnectionIndicatorCallback) {
                    updateConnectionIndicatorCallback();
                }
            }
        }
    }, true); // 使用捕获阶段

    // 测试连接按钮 - 使用事件委托
    container.addEventListener('click', async (e) => {
        if (e.target.closest('.test-api-key-btn')) {
            const button = e.target.closest('.test-api-key-btn');
            const providerId = button.getAttribute('data-provider');
            await handleTestApiKey(providerId, showToastCallback);
        }
    });

    // 发现模型按钮 - 使用事件委托
    container.addEventListener('click', async (e) => {
        if (e.target.closest('.discover-models-btn')) {
            const button = e.target.closest('.discover-models-btn');
            const providerId = button.getAttribute('data-provider');
            await handleDiscoverModelsForProvider(providerId, state, elements, showToastCallback);
        }
    });
}

/**
 * 处理 API Key 测试
 */
async function handleTestApiKey(providerId, showToastCallback) {
    const currentTranslations = getCurrentTranslations();

    if (!window.InfinPilotAPI?.testApiKey) {
        showToastCallback(_('modelManagerUnavailable', {}, currentTranslations), 'error');
        return;
    }

    if (!window.ModelManager?.instance) {
        showToastCallback(_('modelManagerUnavailable', {}, currentTranslations), 'error');
        return;
    }

    const modelManager = window.ModelManager.instance;
    const apiKey = modelManager.getProviderApiKey(providerId);

    if (!apiKey) {
        showToastCallback(_('apiKeyMissingError', {}, currentTranslations), 'error');
        return;
    }

    const testButton = document.querySelector(`.test-api-key-btn[data-provider="${providerId}"]`);
    if (!testButton) {
        console.error(`[Settings] Test button not found for provider: ${providerId}`);
        return;
    }

    const originalText = testButton.textContent;

    try {
        testButton.disabled = true;
        testButton.textContent = _('testingConnection', {}, currentTranslations);

        const result = await window.InfinPilotAPI.testApiKey(providerId, apiKey);

        if (result.success) {
            showToastCallback(result.message, 'success');

            // 只对Google供应商进行自动发现并添加默认模型
            if (providerId === 'google') {
                await autoDiscoverModelsAfterTest(providerId, showToastCallback);
            }
        } else {
            showToastCallback(result.message, 'error');
        }
    } catch (error) {
        console.error(`[Settings] Test API Key failed for ${providerId}:`, error);
        showToastCallback(_('connectionTestFailed', { error: error.message }, currentTranslations), 'error');
    } finally {
        if (testButton) {
            testButton.disabled = false;
            testButton.textContent = originalText;
        }
    }
}

/**
 * Gemini API测试成功后自动发现模型（仅限Google供应商）
 */
async function autoDiscoverModelsAfterTest(providerId, showToastCallback) {
    // 只处理Google供应商
    if (providerId !== 'google') {
        console.log(`[Settings] Auto-discovery is only enabled for Google provider, skipping ${providerId}`);
        return;
    }

    const currentTranslations = getCurrentTranslations();

    try {
        console.log(`[Settings] Auto-discovering Gemini models after successful API test`);

        // 检查是否已有Google供应商的模型
        const modelManager = window.ModelManager.instance;
        const existingGoogleModels = modelManager.getModelsByProvider('google', false); // false = 包括未激活的模型

        if (existingGoogleModels && existingGoogleModels.length > 0) {
            console.log(`[Settings] Google provider already has ${existingGoogleModels.length} models, skipping auto-discovery`);
            return;
        }

        console.log(`[Settings] No existing Google models found, proceeding with auto-discovery`);

        // 获取Gemini可用模型
        const discoveredModels = await window.InfinPilotAPI.fetchModels('google');

        if (!discoveredModels || discoveredModels.length === 0) {
            console.log(`[Settings] No Gemini models discovered`);
            return;
        }

        // 自动添加所有发现的Gemini模型
        const result = await modelManager.addDiscoveredModels(discoveredModels, discoveredModels.map(m => m.id));

        if (result.added > 0 || result.activated > 0) {
            console.log(`[Settings] Auto-added ${result.added} Gemini models and activated ${result.activated} models`);

            // 重新初始化模型选择器和卡片显示
            const state = window.state || {};
            const elements = {
                modelSelection: document.getElementById('model-selection'),
                chatModelSelection: document.getElementById('chat-model-selection')
            };
            await initModelSelection(state, elements);
            await updateModelCardsDisplay();

            // 广播模型更新事件
            modelManager.broadcastModelsUpdated();

            console.log(`[Settings] Successfully auto-discovered and added ${result.added} Gemini models`);
        }

    } catch (error) {
        console.warn(`[Settings] Gemini auto-discovery failed:`, error);
        // 静默失败，不显示错误提示，因为这是自动操作
    }
}

/**
 * 处理指定供应商的模型发现
 */
async function handleDiscoverModelsForProvider(providerId, state, elements, showToastCallback, uiButton = null) {
    const currentTranslations = getCurrentTranslations();

    if (!window.InfinPilotAPI?.fetchModels) {
        showToastCallback(_('modelManagerUnavailable', {}, currentTranslations), 'error');
        return;
    }

    if (!window.ModelManager?.instance) {
        showToastCallback(_('modelManagerUnavailable', {}, currentTranslations), 'error');
        return;
    }

    const modelManager = window.ModelManager.instance;
    const apiKey = modelManager.getProviderApiKey(providerId);

    if (!apiKey) {
        showToastCallback(_('apiKeyMissingError', {}, currentTranslations), 'error');
        return;
    }

    const discoverButton = uiButton || document.querySelector(`.discover-models-btn[data-provider="${providerId}"]`);
    const originalText = discoverButton ? discoverButton.textContent : '';

    // 恢复按钮状态的函数
    const restoreButtonState = () => {
        if (discoverButton) {
            discoverButton.disabled = false;
            discoverButton.textContent = originalText || _('discoverModels', {}, currentTranslations);
        }
    };

    try {
        if (discoverButton) {
            discoverButton.disabled = true;
            discoverButton.textContent = _('discoveringModels', {}, currentTranslations);
        }

        // 获取可用模型
        const discoveredModels = await window.InfinPilotAPI.fetchModels(providerId);

        if (!discoveredModels || discoveredModels.length === 0) {
            showToastCallback(_('noNewModelsFound', {}, currentTranslations), 'info');
            restoreButtonState();
            return;
        }

        // 使用 ModelManager 的方法获取可添加的模型（包括被停用的模型）
        const newModels = modelManager.getNewDiscoveredModels(discoveredModels, providerId);

        if (newModels.length === 0) {
            showToastCallback(_('noNewModelsFound', {}, currentTranslations), 'info');
            restoreButtonState();
            return;
        }

        // 显示模型选择对话框
        showModelSelectionDialog(newModels, currentTranslations, async (selectedModelIds) => {
            try {
                if (selectedModelIds.length > 0) {
                    // 使用 ModelManager 的批量添加方法
                    const result = await modelManager.addDiscoveredModels(discoveredModels, selectedModelIds);
                    const totalProcessed = result.added + result.activated;

                    if (totalProcessed > 0) {
                        // 重新初始化模型选择器和卡片显示
                        await initModelSelection(state, elements);
                        await updateModelCardsDisplay();

                        if (result.added > 0 && result.activated > 0) {
                            showToastCallback(_('modelsAddedAndReactivatedSuccess', { added: result.added, activated: result.activated }, currentTranslations), 'success');
                        } else if (result.added > 0) {
                            showToastCallback(_('modelsAddedSuccess', { count: result.added }, currentTranslations), 'success');
                        } else if (result.activated > 0) {
                            showToastCallback(_('modelsReactivatedSuccess', { count: result.activated }, currentTranslations), 'success');
                        }
                    } else {
                        showToastCallback(_('fetchModelsError', { error: 'Unknown error' }, currentTranslations), 'error');
                    }
                }
            } finally {
                // 确保在对话框关闭后恢复按钮状态
                restoreButtonState();
            }
        }, restoreButtonState); // 传递恢复函数作为取消回调

    } catch (error) {
        console.error(`[Settings] Discover models failed for ${providerId}:`, error);
        showToastCallback(_('fetchModelsError', { error: error.message }, currentTranslations), 'error');
        restoreButtonState();
    }
}

// === 手动添加模型功能 ===

/**
 * 显示手动添加模型对话框
 * @param {Object} currentTranslations - 当前翻译对象
 */
function showManualAddModelDialog(currentTranslations) {
    // 移除已存在的对话框
    const existingDialog = document.querySelector('.manual-add-model-dialog');
    if (existingDialog) {
        existingDialog.remove();
    }

    // 创建对话框
    const dialog = document.createElement('div');
    dialog.className = 'manual-add-model-dialog';
    dialog.innerHTML = `
        <div class="dialog-overlay">
            <div class="dialog-content">
                <div class="dialog-header">
                    <h3>${_('manualAddModelDialogTitle', {}, currentTranslations)}</h3>
                    <button type="button" class="close-btn" aria-label="${_('close', {}, currentTranslations)}">×</button>
                </div>
                <div class="dialog-body">
                    <div class="form-group">
                        <label for="manual-model-name">${_('manualAddModelName', {}, currentTranslations)} *</label>
                        <input type="text" id="manual-model-name" class="form-input"
                               placeholder="${_('manualAddModelNamePlaceholder', {}, currentTranslations)}"
                               autocomplete="off" required>
                    </div>
                    <div class="form-group">
                        <label for="manual-model-id">${_('manualAddModelId', {}, currentTranslations)} *</label>
                        <input type="text" id="manual-model-id" class="form-input"
                               placeholder="${_('manualAddModelIdPlaceholder', {}, currentTranslations)}"
                               autocomplete="off" required>
                    </div>
                </div>
                <div class="dialog-footer">
                    <div class="dialog-actions">
                        <button type="button" class="cancel-btn">${_('manualAddModelCancel', {}, currentTranslations)}</button>
                        <button type="button" class="confirm-btn" disabled>${_('manualAddModelConfirm', {}, currentTranslations)}</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    // 添加到页面
    document.body.appendChild(dialog);

    // 获取表单元素
    const nameInput = dialog.querySelector('#manual-model-name');
    const idInput = dialog.querySelector('#manual-model-id');
    const confirmBtn = dialog.querySelector('.confirm-btn');
    const cancelBtn = dialog.querySelector('.cancel-btn');
    const closeBtn = dialog.querySelector('.close-btn');

    // 表单验证函数
    const validateForm = () => {
        const name = nameInput.value.trim();
        const id = idInput.value.trim();
        const isValid = !!(name && id);
        confirmBtn.disabled = !isValid;
        return isValid;
    };

    // 添加输入事件监听器
    nameInput.addEventListener('input', validateForm);
    idInput.addEventListener('input', validateForm);
    // no provider select

    // 关闭对话框函数
    const closeDialog = () => {
        // 移除语言变化监听器
        document.removeEventListener('infinpilot:languageChanged', handleDialogLanguageChange);
        dialog.remove();
    };

    // 语言变化处理函数
    const handleDialogLanguageChange = (event) => {
        console.log('[Settings] Manual add dialog received language change event:', event.detail);
        const newLanguage = event.detail.newLanguage;
        const newTranslations = getCurrentTranslations();

        // 更新对话框中的文本
        updateManualAddDialogTranslations(dialog, newTranslations);
    };

    // 添加语言变化监听器
    document.addEventListener('infinpilot:languageChanged', handleDialogLanguageChange);

    // 添加事件监听器
    closeBtn.addEventListener('click', closeDialog);
    cancelBtn.addEventListener('click', closeDialog);

    // 点击背景关闭
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            closeDialog();
        }
    });

    // ESC 快捷关闭
    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            // 防止事件冒泡到主面板的 ESC 处理器
            e.preventDefault();
            e.stopPropagation();
            closeDialog();
            document.removeEventListener('keydown', onKeyDown, true);
        }
    };
    document.addEventListener('keydown', onKeyDown, true);

    // 确认添加
    confirmBtn.addEventListener('click', async () => {
        if (!validateForm()) return;

        const name = nameInput.value.trim();
        const id = idInput.value.trim();
        // 锚定到当前所选供应商
        let providerId = getCurrentVisibleProviderId() || '';
        if (!providerId) {
            const latestTranslations = getCurrentTranslations();
            if (window.showToastUI) window.showToastUI(latestTranslations.noProviderSelected || '请先选择供应商', 'error');
            return;
        }

        // 获取最新的翻译对象
        const latestTranslations = getCurrentTranslations();
        await handleManualAddModel(name, id, providerId, latestTranslations, closeDialog);
    });

    // 聚焦到第一个输入框
    setTimeout(() => nameInput.focus(), 100);
}

/**
 * 更新手动添加模型对话框的翻译
 * @param {HTMLElement} dialog - 对话框元素
 * @param {Object} translations - 翻译对象
 */
function updateManualAddDialogTranslations(dialog, translations) {
    if (!dialog || !translations) return;

    // 更新标题
    const title = dialog.querySelector('.dialog-header h3');
    if (title) {
        title.textContent = _('manualAddModelDialogTitle', {}, translations);
    }

    // 更新关闭按钮
    const closeBtn = dialog.querySelector('.close-btn');
    if (closeBtn) {
        closeBtn.setAttribute('aria-label', _('close', {}, translations));
    }

    // 更新表单标签
    const nameLabel = dialog.querySelector('label[for="manual-model-name"]');
    if (nameLabel) {
        nameLabel.textContent = _('manualAddModelName', {}, translations) + ' *';
    }

    const idLabel = dialog.querySelector('label[for="manual-model-id"]');
    if (idLabel) {
        idLabel.textContent = _('manualAddModelId', {}, translations) + ' *';
    }

    const providerLabel = dialog.querySelector('label[for="manual-model-provider"]');
    if (providerLabel) {
        providerLabel.textContent = _('manualAddModelProvider', {}, translations) + ' *';
    }

    // 更新输入框占位符
    const nameInput = dialog.querySelector('#manual-model-name');
    if (nameInput) {
        nameInput.placeholder = _('manualAddModelNamePlaceholder', {}, translations);
    }

    const idInput = dialog.querySelector('#manual-model-id');
    if (idInput) {
        idInput.placeholder = _('manualAddModelIdPlaceholder', {}, translations);
    }

    // 更新选择框占位符
    const providerSelect = dialog.querySelector('#manual-model-provider');
    if (providerSelect) {
        const placeholderOption = providerSelect.querySelector('option[value=""]');
        if (placeholderOption) {
            placeholderOption.textContent = _('manualAddModelProviderPlaceholder', {}, translations);
        }
    }

    // 更新按钮文本
    const cancelBtn = dialog.querySelector('.cancel-btn');
    if (cancelBtn) {
        cancelBtn.textContent = _('manualAddModelCancel', {}, translations);
    }

    const confirmBtn = dialog.querySelector('.confirm-btn');
    if (confirmBtn) {
        confirmBtn.textContent = _('manualAddModelConfirm', {}, translations);
    }
}

/**
 * 处理手动添加模型
 * @param {string} modelName - 模型名称
 * @param {string} modelId - 模型ID
 * @param {string} providerId - 供应商ID
 * @param {Object} currentTranslations - 当前翻译对象
 * @param {Function} closeDialog - 关闭对话框的函数
 */
async function handleManualAddModel(modelName, modelId, providerId, currentTranslations, closeDialog) {
    if (!window.ModelManager?.instance) {
        if (window.showToastUI) {
            window.showToastUI(_('manualAddModelError', {}, currentTranslations), 'error');
        }
        return;
    }

    const modelManager = window.ModelManager.instance;
    try { await modelManager.initialize(); } catch (_) {}

    try {
        // 检查模型是否已存在于管理列表（按供应商+ID）
        const existingModel = modelManager.getModelByKey(`${providerId}::${modelId}`);
        if (existingModel) {
            // 如果已存在于管理列表：
            // - 若未被选中，则直接激活并提示成功
            // - 若已被选中，则提示已在列表中
            const compositeKey = `${providerId}::${modelId}`;
            const alreadyActive = modelManager.isModelActive(compositeKey);
            if (!alreadyActive) {
                await modelManager.activateModel(compositeKey);
                await updateModelCardsDisplay();
                const state = window.state || {};
                const elements = {
                    modelSelection: document.getElementById('model-selection'),
                    chatModelSelection: document.getElementById('chat-model-selection')
                };
                await initModelSelection(state, elements);
                if (window.showToastUI) {
                    window.showToastUI(_('manualAddModelActivated', {}, currentTranslations) || '已选中该模型', 'success');
                }
                closeDialog();
            } else {
                if (window.showToastUI) {
                    window.showToastUI(_('manualAddModelAlreadySelected', {}, currentTranslations) || '该模型已在已选择列表中', 'info');
                }
                closeDialog();
            }
            return;
        }

        // 创建模型定义
        const modelDefinition = {
            id: modelId,
            displayName: modelName,
            apiModelName: modelId,
            providerId: providerId,
            params: null,
            isAlias: false,
            isDefault: false,
            canDelete: true,
            // 标记来源为手动添加，便于后续发现模型时过滤
            source: 'manual'
        };

        // 添加模型
        const success = await modelManager.addModel(modelDefinition);

        if (success) {
            // 激活模型
            await modelManager.activateModel(`${providerId}::${modelId}`);

            // 更新UI
            await updateModelCardsDisplay();

            // 重新初始化模型选择器
            const state = window.state || {};
            const elements = {
                modelSelection: document.getElementById('model-selection'),
                chatModelSelection: document.getElementById('chat-model-selection')
            };
            await initModelSelection(state, elements);

            // 显示成功消息
            if (window.showToastUI) {
                window.showToastUI(_('manualAddModelSuccess', {}, currentTranslations), 'success');
            }

            // 关闭对话框
            closeDialog();
        } else {
            if (window.showToastUI) {
                window.showToastUI(_('manualAddModelError', {}, currentTranslations), 'error');
            }
        }

    } catch (error) {
        console.error('[Settings] Error adding manual model:', error);
        if (window.showToastUI) {
            window.showToastUI(_('manualAddModelError', {}, currentTranslations), 'error');
        }
    }
}

// === 自定义提供商功能 ===

/**
 * 初始化自定义提供商模态框
 */
function initCustomProviderModal() {
    const modal = document.getElementById('custom-provider-modal');
    const closeBtn = modal?.querySelector('.custom-provider-close');
    const cancelBtn = document.getElementById('custom-provider-cancel');
    const saveBtn = document.getElementById('custom-provider-save');

    if (!modal) return;

    // 防止重复绑定事件监听器
    if (modal.dataset.eventListenersSetup === 'true') {
        console.log('[Settings] Custom provider modal event listeners already setup, skipping...');
        return;
    }
    modal.dataset.eventListenersSetup = 'true';

    // 通过事件委托处理“添加供应商”按钮（集成在卡片头部）
    const container = document.querySelector('.provider-settings-container');
    if (container) {
        container.addEventListener('click', (e) => {
            const btn = e.target.closest('.add-provider-btn');
            if (btn) {
                openCustomProviderModal();
            }
        });
    }

    // 关闭模态框
    const closeModal = () => {
        modal.classList.remove('show');
        clearCustomProviderForm();
    };

    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);

    // 点击背景关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });

    // 保存自定义提供商
    saveBtn?.addEventListener('click', async () => {
        await saveCustomProvider();
    });

    // 表单验证
    const form = modal.querySelector('.custom-provider-form');
    if (form) {
        form.addEventListener('input', validateCustomProviderForm);
    }
}

/**
 * 打开自定义提供商模态框
 */
function openCustomProviderModal() {
    const modal = document.getElementById('custom-provider-modal');
    if (!modal) return;

    clearCustomProviderForm();
    modal.classList.add('show');

    // 聚焦到第一个输入框
    const firstInput = modal.querySelector('input');
    if (firstInput) {
        setTimeout(() => firstInput.focus(), 100);
    }
}

/**
 * 清空自定义提供商表单
 */
function clearCustomProviderForm() {
    const modal = document.getElementById('custom-provider-modal');
    if (!modal) return;

    const inputs = modal.querySelectorAll('input');
    inputs.forEach(input => {
        input.value = '';
        input.classList.remove('error');
        input.disabled = false; // 重置禁用状态
    });

    // 清除所有提示文本
    const hints = modal.querySelectorAll('.form-hint');
    hints.forEach(hint => hint.remove());

    // 重置保存按钮
    const saveBtn = document.getElementById('custom-provider-save');
    if (saveBtn) {
        saveBtn.textContent = getCurrentTranslations().customProviderSave || '添加';
        delete saveBtn.dataset.editMode;
        delete saveBtn.dataset.editProviderId;
    }

    validateCustomProviderForm();
}

/**
 * 验证自定义提供商表单
 */
function validateCustomProviderForm() {
    const modal = document.getElementById('custom-provider-modal');
    const saveBtn = document.getElementById('custom-provider-save');
    if (!modal || !saveBtn) return;

    const baseUrlInput = document.getElementById('custom-provider-baseurl');
    const apiKeyInput = document.getElementById('custom-provider-apikey');

    const baseUrl = baseUrlInput?.value.trim();
    const apiKey = apiKeyInput?.value.trim();

    // 验证必填字段
    let isValid = true;

    if (!baseUrl) {
        isValid = false;
    } else {
        // 验证URL格式
        try {
            new URL(baseUrl);
            baseUrlInput.classList.remove('error');
        } catch (e) {
            isValid = false;
            baseUrlInput.classList.add('error');
        }
    }

    if (!apiKey) {
        isValid = false;
    }

    saveBtn.disabled = !isValid;
}

/**
 * 保存自定义提供商
 */
async function saveCustomProvider() {
    const modal = document.getElementById('custom-provider-modal');
    const saveBtn = document.getElementById('custom-provider-save');
    if (!modal || !saveBtn) return;

    const providerIdInput = document.getElementById('custom-provider-id');
    const baseUrlInput = document.getElementById('custom-provider-baseurl');
    const apiKeyInput = document.getElementById('custom-provider-apikey');

    const providerId = providerIdInput?.value.trim();
    const baseUrl = baseUrlInput?.value.trim();
    const apiKey = apiKeyInput?.value.trim();

    const isEditMode = saveBtn.dataset.editMode === 'true';
    const editProviderId = saveBtn.dataset.editProviderId;

    if (!baseUrl || !apiKey) {
        // 需要从全局获取showToast函数
        if (window.showToastUI) {
            window.showToastUI(getCurrentTranslations().customProviderError, 'error');
        }
        return;
    }

    // 禁用保存按钮
    saveBtn.disabled = true;
    saveBtn.textContent = getCurrentTranslations().loading || '保存中...';

    try {
        let result;

        if (isEditMode && editProviderId) {
            // 编辑模式：检查是否修改了Provider ID
            if (providerId && providerId !== editProviderId) {
                // Provider ID发生了变化，需要删除旧的并创建新的
                result = await updateCustomProviderWithNewId(editProviderId, {
                    id: providerId,
                    baseUrl: baseUrl,
                    apiKey: apiKey
                });
            } else {
                // Provider ID没有变化，只更新其他属性
                result = await updateCustomProvider(editProviderId, {
                    baseUrl: baseUrl,
                    apiKey: apiKey
                });
            }
        } else {
            // 添加模式：创建新提供商
            result = await window.ProviderManager.addCustomProvider({
                id: providerId,
                baseUrl: baseUrl,
                apiKey: apiKey
            });
        }

        if (result.success) {
            // 成功操作
            const successMessage = isEditMode ?
                getCurrentTranslations().customProviderUpdateSuccess :
                getCurrentTranslations().customProviderSuccess;

            if (window.showToastUI) {
                window.showToastUI(successMessage, 'success');
            }

            // 关闭模态框
            modal.classList.remove('show');
            clearCustomProviderForm();

            // 刷新供应商选择器并切换到相关提供商
            await refreshProviderSelection();

            // 选择相关提供商并填入API Key
            const targetProviderId = result.providerId || (isEditMode ? editProviderId : result.providerId);
            if (targetProviderId) {
                await showProviderSettings(targetProviderId);
                updateProviderSelectInVisibleCard();

                // 自动填入API Key
                setTimeout(() => {
                    const apiKeyInput = document.getElementById(`${targetProviderId}-api-key`);
                    if (apiKeyInput) {
                        apiKeyInput.value = apiKey;
                    }
                }, 100);
            }

        } else {
            // 显示错误信息
            let errorMessage = getCurrentTranslations().customProviderError;
            if (result.error === 'Provider ID already exists') {
                errorMessage = getCurrentTranslations().customProviderExists;
            } else if (result.error === 'Invalid URL format') {
                errorMessage = getCurrentTranslations().customProviderInvalidUrl;
            }
            if (window.showToastUI) {
                window.showToastUI(errorMessage, 'error');
            }
        }

    } catch (error) {
        console.error('[Settings] Error saving custom provider:', error);
        if (window.showToastUI) {
            window.showToastUI(getCurrentTranslations().customProviderError, 'error');
        }
    } finally {
        // 恢复保存按钮状态
        if (saveBtn) {
            saveBtn.disabled = false;
            const defaultText = isEditMode ?
                (getCurrentTranslations().customProviderEdit || '保存') :
                (getCurrentTranslations().customProviderSave || '添加');
            saveBtn.textContent = defaultText;
        }
    }
}

/**
 * 更新自定义提供商并更改ID
 */
async function updateCustomProviderWithNewId(oldProviderId, newProviderData) {
    try {
        // 检查新ID是否已存在
        const existingProvider = window.ProviderManager?.getProvider(newProviderData.id);
        if (existingProvider) {
            return { success: false, error: 'Provider ID already exists' };
        }

        // 删除旧的提供商
        const deleteSuccess = await window.ProviderManager.removeCustomProvider(oldProviderId);
        if (!deleteSuccess) {
            return { success: false, error: 'Failed to remove old provider' };
        }

        // 创建新的提供商
        const addResult = await window.ProviderManager.addCustomProvider(newProviderData);
        if (addResult.success) {
            console.log(`[Settings] Updated custom provider ID from ${oldProviderId} to ${newProviderData.id}`);
            return { success: true, providerId: newProviderData.id };
        } else {
            // 如果创建失败，尝试恢复旧的提供商（这里简化处理）
            console.error('[Settings] Failed to create new provider after deleting old one');
            return addResult;
        }

    } catch (error) {
        console.error('[Settings] Error updating custom provider with new ID:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 更新自定义提供商
 */
async function updateCustomProvider(providerId, updates) {
    try {
        const provider = window.ProviderManager?.getProvider(providerId);
        if (!provider || !provider.isCustom) {
            return { success: false, error: 'Provider not found or not custom' };
        }

        // 验证URL格式
        if (updates.baseUrl) {
            try {
                new URL(updates.baseUrl);
            } catch (e) {
                return { success: false, error: 'Invalid URL format' };
            }
        }

        // 更新提供商配置
        if (updates.baseUrl) {
            provider.apiHost = updates.baseUrl.replace(/\/$/, ''); // 移除末尾斜杠
        }

        // 更新API Key
        if (updates.apiKey && window.ModelManager?.instance) {
            await window.ModelManager.instance.setProviderSettings(providerId, {
                apiKey: updates.apiKey
            });
        }

        // 保存自定义提供商到存储
        await window.ProviderManager?.saveCustomProviders?.();

        console.log(`[Settings] Updated custom provider: ${providerId}`);
        return { success: true, providerId };

    } catch (error) {
        console.error('[Settings] Error updating custom provider:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 刷新供应商选择器
 */
async function refreshProviderSelection() {
    // 确保为新的自定义提供商创建设置区域
    await createAllProviderSettings();

    // 更新当前可见卡片中的选择器
    updateProviderSelectInVisibleCard();
}

/**
 * 为所有供应商创建设置区域（包括内置和自定义）
 */
async function createAllProviderSettings() {
    const container = document.querySelector('.provider-settings-container');
    if (!container) return;

    // 获取所有供应商（内置 + 自定义）
    const allProviders = window.ProviderManager?.getAllProviders() || {};

    Object.values(allProviders).forEach(provider => {
        // 检查是否已存在设置区域
        const existingSettings = document.getElementById(`provider-settings-${provider.id}`);
        if (existingSettings) return;

        // 创建设置区域
        const settingsDiv = createProviderSettingsElement(provider);
        container.appendChild(settingsDiv);
    });
}

/**
 * 为自定义提供商创建设置区域（保持向后兼容）
 */
async function createCustomProviderSettings() {
    // 直接调用创建所有供应商设置的函数
    await createAllProviderSettings();
}

/**
 * 获取供应商API Key链接文本
 */
function getProviderApiKeyLinkText(provider) {
    const linkTexts = {
        'google': 'Google AI Studio',
        'openai': 'OpenAI Platform',
        'anthropic': 'Anthropic Console',
        'siliconflow': 'SiliconFlow 控制台',
        'openrouter': 'OpenRouter 设置',
        'deepseek': 'DeepSeek 平台',
        'chatglm': '智谱AI 平台'
    };

    return linkTexts[provider.id] || provider.name;
}

/**
 * 创建提供商设置元素
 */
function createProviderSettingsElement(provider) {
    const settingsDiv = document.createElement('div');
    settingsDiv.id = `provider-settings-${provider.id}`;
    settingsDiv.className = 'provider-settings';
    settingsDiv.style.display = 'none';

    const currentTranslations = getCurrentTranslations();

    settingsDiv.innerHTML = `
        <div class="provider-header">
            <img src="../icons/${provider.icon}" alt="${provider.name}" class="provider-icon">
            <h3>${provider.name}</h3>
            <div class="provider-selection-container">
                <select class="provider-select setting-select" aria-label="Select Provider">
                    <!-- 选项由 JS 填充 -->
                </select>
                ${provider.isCustom ? `
                    <button class="edit-custom-provider-btn" data-provider="${provider.id}" title="${currentTranslations.customProviderEdit || '编辑提供商'}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M5.707 13.707a1 1 0 0 1-.39.242l-3 1a1 1 0 0 1-1.266-1.265l1-3a1 1 0 0 1 .242-.391L10.086 2.5a2 2 0 0 1 2.828 0l.586.586a2 2 0 0 1 0 2.828L5.707 13.707zM3 11l7.5-7.5 1 1L4 12l-1-1zm0 2.5l1-1L5.5 14l-1 1-1.5-1.5z"/>
                            <path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/>
                        </svg>
                    </button>
                    <button class="remove-custom-provider-btn" data-provider="${provider.id}" title="${currentTranslations.customProviderDelete || '删除提供商'}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                            <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
                        </svg>
                    </button>
                ` : ''}
                <button class="add-provider-btn" data-i18n="addProvider" data-i18n-title="addProvider" title="${currentTranslations.addProvider || '添加供应商'}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                        <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
                    </svg>
                    <span data-i18n="addProvider">${currentTranslations.addProvider || '添加'}</span>
                </button>
            </div>
        </div>
        <div class="setting-group">
            <label for="${provider.id}-api-key">API Key:</label>
                        <div class="api-key-row">
                <div class="api-key-input-wrapper">
                    <input type="password" id="${provider.id}-api-key" data-i18n-placeholder="providerApiKeyPlaceholder" placeholder="${currentTranslations.providerApiKeyPlaceholder}">
                    <button class="toggle-api-key-button" type="button" data-target="${provider.id}-api-key">
                        <svg class="eye-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.1 13.1 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.1 13.1 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.1 13.1 0 0 1 1.172 8z"/>
                            <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/>
                        </svg>
                        <svg class="eye-slash-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" style="display: none;">
                            <path d="M13.359 11.238C15.06 9.72 16 8 16 8s-3-5.5-8-5.5a7.028 7.028 0 0 0-2.79.588l.77.771A5.944 5.944 0 0 1 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.134 13.134 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755-.165.165-.337.328-.517.486l.708.709z"/>
                            <path d="M11.297 9.176a3.5 3.5 0 0 0-4.474-4.474l.823.823a2.5 2.5 0 0 1 2.829 2.829l.822.822zm-2.943 1.299.822.822a3.5 3.5 0 0 1-4.474-4.474l.823.823a2.5 2.5 0 0 0 2.829 2.829z"/>
                            <path d="M3.35 5.47c-.18.16-.353.322-.518.487A13.134 13.134 0 0 0 1.172 8l.195.288c.335.48.83 1.12 1.465 1.755C4.121 11.332 5.881 12.5 8 12.5c.716 0 1.39-.133 2.02-.36l.77.772A7.029 7.029 0 0 1 8 13.5C3 13.5 0 8 0 8s.939-1.721 2.641-3.238l.708.709zm10.296 8.884-12-12 .708-.708 12 12-.708.708z"/>
                        </svg>
                    </button>
                </div>
                <button class="test-api-key-btn" data-provider="${provider.id}" data-i18n="testConnection">${currentTranslations.testConnection}</button>
            </div>
            ${provider.apiKeyUrl ? `<p class="hint"><span data-i18n="getApiKeyHint">获取 API Key</span>: <a href="${provider.apiKeyUrl}" target="_blank" rel="noopener">${getProviderApiKeyLinkText(provider)}</a></p>` : ''}
            ${provider.isCustom && provider.apiHost ? `<p class="hint">Base URL: ${provider.apiHost}</p>` : ''}
        </div>
            
    `;

    // 注意：不在这里添加API Key切换按钮的事件监听器，因为已经通过事件委托在 setupProviderEventListeners 中处理了
    // 这样可以避免重复绑定事件监听器导致的问题

    // 添加自定义提供商按钮事件监听器
    if (provider.isCustom) {
        const editBtn = settingsDiv.querySelector('.edit-custom-provider-btn');
        const removeBtn = settingsDiv.querySelector('.remove-custom-provider-btn');

        if (editBtn) {
            editBtn.addEventListener('click', () => editCustomProvider(provider.id));
        }

        if (removeBtn) {
            removeBtn.addEventListener('click', () => showDeleteCustomProviderModal(provider.id));
        }
    }

    return settingsDiv;
}

/**
 * 编辑自定义提供商
 */
function editCustomProvider(providerId) {
    const provider = window.ProviderManager?.getProvider(providerId);
    if (!provider || !provider.isCustom) {
        console.error('[Settings] Cannot edit non-custom provider:', providerId);
        return;
    }

    // 获取当前API Key
    const apiKey = window.ModelManager?.instance?.getProviderApiKey(providerId) || '';

    // 打开模态框并填入当前值
    openCustomProviderModal();

    // 填入当前值
    const modal = document.getElementById('custom-provider-modal');
    if (modal) {
        const providerIdInput = document.getElementById('custom-provider-id');
        const baseUrlInput = document.getElementById('custom-provider-baseurl');
        const apiKeyInput = document.getElementById('custom-provider-apikey');
        const saveBtn = document.getElementById('custom-provider-save');

        if (providerIdInput) providerIdInput.value = provider.id;
        if (baseUrlInput) baseUrlInput.value = provider.apiHost;
        if (apiKeyInput) apiKeyInput.value = apiKey;

        // 更改保存按钮文本和功能
        if (saveBtn) {
            saveBtn.textContent = getCurrentTranslations().customProviderEdit || '保存';
            saveBtn.dataset.editMode = 'true';
            saveBtn.dataset.editProviderId = providerId;
        }

        // 在编辑模式下允许修改Provider ID
        if (providerIdInput) {
            providerIdInput.disabled = false;
        }
    }
}

/**
 * 显示删除自定义提供商的模态框
 */
function showDeleteCustomProviderModal(providerId) {
    const provider = window.ProviderManager?.getProvider(providerId);
    if (!provider) return;

    const currentTranslations = getCurrentTranslations();
    const confirmMessage = currentTranslations.customProviderDeleteConfirm?.replace('{name}', provider.name) ||
                          `确定要删除提供商 "${provider.name}" 吗？`;

    if (confirm(confirmMessage)) {
        removeCustomProvider(providerId);
    }
}

/**
 * 删除自定义提供商
 */
async function removeCustomProvider(providerId) {

    try {
        const success = await window.ProviderManager.removeCustomProvider(providerId);

        if (success) {
            // 移除设置区域
            const settingsElement = document.getElementById(`provider-settings-${providerId}`);
            if (settingsElement) {
                settingsElement.remove();
            }

            // 刷新供应商选择器
            await refreshProviderSelection();

            // 如果当前显示的是被删除的提供商，切换到默认提供商
            const currentVisible = getCurrentVisibleProviderId();
            if (currentVisible === providerId) {
                await showProviderSettings('google');
                updateProviderSelectInVisibleCard();
            }

            if (window.showToastUI) {
                const currentTranslations = getCurrentTranslations();
                window.showToastUI(currentTranslations.customProviderDeleteSuccess || '自定义提供商已删除', 'success');
            }
        } else {
            if (window.showToastUI) {
                const currentTranslations = getCurrentTranslations();
                window.showToastUI(currentTranslations.customProviderDeleteError || '删除提供商失败', 'error');
            }
        }
    } catch (error) {
        console.error('[Settings] Error removing custom provider:', error);
        if (window.showToastUI) {
            const currentTranslations = getCurrentTranslations();
            window.showToastUI(currentTranslations.customProviderDeleteError || '删除提供商失败', 'error');
        }
    }
}

// === 快捷操作设置相关函数 ===

/**
 * 初始化快捷操作设置界面
 */
export async function initQuickActionsSettings(elements, translations) {
    console.log('[Settings] Initializing quick actions settings...');

    // 快捷操作管理器应该已经在main.js中初始化了
    if (!window.QuickActionsManager) {
        console.error('[Settings] QuickActionsManager not available in global scope');
        return;
    }

    // 渲染快捷操作列表
    await renderQuickActionsList(translations);

    // 设置添加按钮事件
    const addBtn = document.getElementById('add-quick-action-btn');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            // 点击时获取当前翻译，确保语言切换后使用最新翻译
            showQuickActionDialog(null, getCurrentTranslations());
        });
    } else {
        console.error('[Settings] Add button not found');
    }

    // 设置导入按钮事件
    const importBtn = document.getElementById('import-quick-actions-btn');
    const importInput = document.getElementById('import-quick-actions-input');
    if (importBtn && importInput) {
        importBtn.addEventListener('click', () => {
            importInput.click();
        });

        importInput.addEventListener('change', (event) => {
            handleQuickActionsImport(event, translations);
        });
    } else {
        console.error('[Settings] Import button or input not found', { importBtn: !!importBtn, importInput: !!importInput });
    }

    // 设置导出按钮事件
    const exportBtn = document.getElementById('export-quick-actions-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            handleQuickActionsExport(translations);
        });
    } else {
        console.error('[Settings] Export button not found');
    }

    console.log('[Settings] Quick actions settings initialized');
}

/**
 * 渲染快捷操作列表
 */
export async function renderQuickActionsList(translations) {
    const container = document.getElementById('quick-actions-list');
    if (!container) {
        console.error('[Settings] Quick actions list container not found');
        return;
    }

    const actions = QuickActionsManager.getAllQuickActions();
    container.innerHTML = '';

    if (actions.length === 0) {
        container.innerHTML = `
            <div class="no-quick-actions">
                <p>${translations?.noQuickActions || '暂无快捷操作'}</p>
            </div>
        `;
        return;
    }

    actions.forEach(action => {
        const actionElement = createQuickActionElement(action, translations);
        container.appendChild(actionElement);
    });
}

/**
 * 创建快捷操作元素
 */
function createQuickActionElement(action, translations) {
    const element = document.createElement('div');
    element.className = 'quick-action-item';
    element.dataset.actionId = action.id;

    const pinTitle = action.pinned ? (translations?.unpinAction || '取消固定') : (translations?.pinAction || '固定到输入框');

    element.innerHTML = `
        <div class="quick-action-main">
            <div class="quick-action-name">${escapeHtml(action.name)}</div>
            <div class="quick-action-prompt">${escapeHtml(action.prompt.substring(0, 100))}${action.prompt.length > 100 ? '...' : ''}</div>
        </div>
        <div class="quick-action-controls">
            <button class="icon-btn pin-quick-action-btn ${action.pinned ? 'pinned' : ''}" title="${pinTitle}">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="pin-icon" viewBox="0 0 16 16">
                    <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224.5-.5.5s-.5-.224-.5-.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.176A4.502 4.502 0 0 1 5 6.931V2.5c-.104-.074-.228-.173-.354-.298C4.342 1.926 4 1.432 4 .75a.5.5 0 0 1 .146-.354z"/>
                </svg>
            </button>
            <button class="icon-btn edit-quick-action-btn" title="${translations?.editAction || '编辑'}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
            </button>
            <button class="icon-btn delete-quick-action-btn" title="${translations?.deleteAction || '删除'}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3,6 5,6 21,6"/>
                    <path d="m19,6v14a2,2 0 0,1 -2,2H7a2,2 0 0,1 -2,-2V6m3,0V4a2,2 0 0,1 2,-2h4a2,2 0 0,1 2,2v2"/>
                    <line x1="10" y1="11" x2="10" y2="17"/>
                    <line x1="14" y1="11" x2="14" y2="17"/>
                </svg>
            </button>
        </div>
    `;

    // 添加事件监听器
    const editBtn = element.querySelector('.edit-quick-action-btn');
    const deleteBtn = element.querySelector('.delete-quick-action-btn');
    const pinBtn = element.querySelector('.pin-quick-action-btn');

    if (editBtn) {
        editBtn.addEventListener('click', () => {
            showQuickActionDialog(action, getCurrentTranslations());
        });
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            showDeleteQuickActionDialog(action, getCurrentTranslations());
        });
    }

    if (pinBtn) {
        pinBtn.addEventListener('click', async () => {
            const newPinnedStatus = !action.pinned;
            const success = await QuickActionsManager.updateQuickAction(action.id, { pinned: newPinnedStatus });
            if (success) {
                action.pinned = newPinnedStatus; // Update local object state
                pinBtn.classList.toggle('pinned', newPinnedStatus);
                pinBtn.querySelector('.pin-icon').classList.toggle('pinned', newPinnedStatus);
                const translations = getCurrentTranslations();
                pinBtn.title = newPinnedStatus ? (translations?.unpinAction || '取消固定') : (translations?.pinAction || '固定到输入框');
                
                // Dispatch event to notify UI update
                document.dispatchEvent(new CustomEvent('infinpilot:pinnedActionsChanged'));
            }
        });
    }

    return element;
}

/**
 * 显示快捷操作编辑对话框
 */
function showQuickActionDialog(action, translations) {
    // 实时获取当前翻译，确保语言切换后的翻译是最新的
    const currentTranslations = getCurrentTranslations();
    const isEdit = !!action;
    const title = isEdit ? (currentTranslations?.editQuickAction || '编辑快捷操作') : (currentTranslations?.addQuickAction || '添加快捷操作');

    // 创建对话框
    const dialog = document.createElement('div');
    dialog.className = 'quick-action-dialog-overlay';
    dialog.innerHTML = `
        <div class="quick-action-dialog">
            <div class="quick-action-dialog-header">
                <h3>${title}</h3>
                <button class="quick-action-dialog-close">×</button>
            </div>
            <div class="quick-action-dialog-content">
                <div class="setting-group">
                    <label>${currentTranslations?.actionName || '操作名称'} *</label>
                    <input type="text" id="quick-action-name" value="${action ? escapeHtml(action.name) : ''}" placeholder="${currentTranslations?.actionNameRequired || '请输入操作名称'}">
                </div>

                <div class="setting-group">
                    <label>${currentTranslations?.actionPrompt || '提示词'} *</label>
                    <textarea id="quick-action-prompt" placeholder="${currentTranslations?.actionPromptRequired || '请输入提示词'}" rows="4">${action ? escapeHtml(action.prompt) : ''}</textarea>
                </div>
                <div class="setting-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="quick-action-ignore-assistant" ${action && action.ignoreAssistant ? 'checked' : ''}>
                        <span class="checkmark"></span>
                        ${currentTranslations?.ignoreAssistant || '忽略助手'}
                    </label>
                    <div class="setting-hint">${currentTranslations?.ignoreAssistantHint || '开启后，发送此快捷操作时不会附加助手的系统提示词'}</div>
                </div>
            </div>
            <div class="quick-action-dialog-footer">
                <button class="quick-action-dialog-cancel">${currentTranslations?.cancel || '取消'}</button>
                <button class="quick-action-dialog-save">${currentTranslations?.save || '保存'}</button>
            </div>
        </div>
    `;

    document.body.appendChild(dialog);

    // 设置事件监听器
    setupQuickActionDialogEvents(dialog, action, currentTranslations);

    // 聚焦名称输入框
    setTimeout(() => {
        const nameInput = dialog.querySelector('#quick-action-name');
        if (nameInput) nameInput.focus();
    }, 100);
}

/**
 * 设置快捷操作对话框事件
 */
function setupQuickActionDialogEvents(dialog, action, translations) {
    const cancelBtn = dialog.querySelector('.quick-action-dialog-cancel');
    const saveBtn = dialog.querySelector('.quick-action-dialog-save');
    const closeBtn = dialog.querySelector('.quick-action-dialog-close');

    const closeDialog = () => {
        dialog.remove();
    };

    // 关闭事件
    cancelBtn.addEventListener('click', closeDialog);
    closeBtn.addEventListener('click', closeDialog);

    // 点击遮罩关闭
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            closeDialog();
        }
    });

    // ESC键关闭
    const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
            closeDialog();
            document.removeEventListener('keydown', handleKeyDown);
        }
    };
    document.addEventListener('keydown', handleKeyDown);



    // 保存事件
    saveBtn.addEventListener('click', async () => {
        const nameInput = dialog.querySelector('#quick-action-name');
        const promptInput = dialog.querySelector('#quick-action-prompt');
        const ignoreAssistantInput = dialog.querySelector('#quick-action-ignore-assistant');

        const name = nameInput.value.trim();
        const prompt = promptInput.value.trim();
        const ignoreAssistant = ignoreAssistantInput.checked;

        // 验证输入
        if (!name) {
            nameInput.focus();
            return;
        }

        if (!prompt) {
            promptInput.focus();
            return;
        }

        // 保存数据
        const actionData = {
            name,
            prompt,
            ignoreAssistant
        };

        let success = false;
        if (action) {
            // 编辑模式
            success = await QuickActionsManager.updateQuickAction(action.id, actionData);
        } else {
            // 添加模式
            const newAction = await QuickActionsManager.addQuickAction(actionData);
            success = !!newAction;
        }

        if (success) {
            // 获取最新翻译
            const latestTranslations = getCurrentTranslations();
            await renderQuickActionsList(latestTranslations);
            closeDialog();

            // 刷新欢迎消息中的快捷操作
            if (window.refreshWelcomeMessageQuickActions) {
                await window.refreshWelcomeMessageQuickActions();
            }

            // 显示成功提示
            const message = action ? (latestTranslations?.actionUpdated || '快捷操作已更新') : (latestTranslations?.actionAdded || '快捷操作已添加');
            if (window.showToastUI) {
                window.showToastUI(message, 'success');
            }
        } else {
            // 获取最新翻译
            const latestTranslations = getCurrentTranslations();
            // 显示错误提示
            const message = action ? (latestTranslations?.actionUpdateFailed || '更新失败') : (latestTranslations?.actionAddFailed || '添加失败');
            if (window.showToastUI) {
                window.showToastUI(message, 'error');
            }
        }
    });
}

/**
 * 显示删除快捷操作确认对话框
 */
function showDeleteQuickActionDialog(action, translations) {
    // 实时获取当前翻译，确保语言切换后的翻译是最新的
    const currentTranslations = getCurrentTranslations();
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    // 构建确认消息，支持国际化
    const confirmMessage = currentTranslations?.confirmDeleteAction || '确定要删除这个快捷操作吗？';
    const finalMessage = confirmMessage.includes('{name}')
        ? confirmMessage.replace('{name}', `<strong>${escapeHtml(action.name)}</strong>`)
        : `确定要删除「<strong>${escapeHtml(action.name)}</strong>」这个快捷操作吗？`;

    overlay.innerHTML = `
        <div class="dialog-content">
            <h3>${currentTranslations?.deleteQuickAction || '删除'}</h3>
            <p>${finalMessage}</p>
            <div class="dialog-actions">
                <button class="dialog-cancel">${currentTranslations?.cancel || '取消'}</button>
                <button class="dialog-confirm" style="background-color: var(--error-color); color: white;">${currentTranslations?.delete || '删除'}</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const cancelBtn = overlay.querySelector('.dialog-cancel');
    const confirmBtn = overlay.querySelector('.dialog-confirm');

    const closeDialog = () => {
        overlay.remove();
    };

    cancelBtn.addEventListener('click', closeDialog);

    confirmBtn.addEventListener('click', async () => {
        const success = await QuickActionsManager.deleteQuickAction(action.id);

        if (success) {
            await renderQuickActionsList(currentTranslations);

            // 刷新欢迎消息中的快捷操作
            if (window.refreshWelcomeMessageQuickActions) {
                await window.refreshWelcomeMessageQuickActions();
            }

            const message = currentTranslations?.actionDeleted || '快捷操作已删除';
            if (window.showToastUI) {
                window.showToastUI(message, 'success');
            }
        } else {
            const message = currentTranslations?.actionDeleteFailed || '删除失败';
            if (window.showToastUI) {
                window.showToastUI(message, 'error');
            }
        }

        closeDialog();
    });

    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeDialog();
        }
    });
}

/**
 * 处理快捷操作导出
 */
function handleQuickActionsExport(translations) {
    try {
        const actions = QuickActionsManager.getAllQuickActions();
        if (actions.length === 0) {
            const message = translations?.noQuickActionsToExport || '没有快捷操作可以导出';
            if (window.showToastUI) {
                window.showToastUI(message, 'warning');
            }
            return;
        }

        const exportData = QuickActionsManager.exportQuickActions();

        // 创建下载链接
        const dataStr = JSON.stringify(exportData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);

        const link = document.createElement('a');
        link.href = url;
        link.download = `infinpilot-quick-actions-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        if (link && link.parentNode) {
            link.parentNode.removeChild(link);
        } else if (link && typeof link.remove === 'function') {
            link.remove();
        }
        URL.revokeObjectURL(url);

        const message = translations?.exportSuccess || '导出成功';
        if (window.showToastUI) {
            window.showToastUI(message, 'success');
        }

        console.log('[Settings] Quick actions exported successfully');
    } catch (error) {
        console.error('[Settings] Export failed:', error);
        const message = translations?.exportFailed || '导出失败';
        if (window.showToastUI) {
            window.showToastUI(message, 'error');
        }
    }
}

/**
 * 处理快捷操作导入
 */
function handleQuickActionsImport(event, translations) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const importData = JSON.parse(e.target.result);

            // 验证导入数据格式
            if (!importData.actions || !Array.isArray(importData.actions)) {
                throw new Error('Invalid file format');
            }

            // 检测重复并显示导入选项对话框
            showImportOptionsDialog(importData, translations);
        } catch (error) {
            console.error('[Settings] Import failed:', error);
            const message = translations?.importFailed || '导入失败：文件格式不正确';
            if (window.showToastUI) {
                window.showToastUI(message, 'error');
            }
        }
    };

    reader.readAsText(file);

    // 清空文件输入，允许重复选择同一文件
    event.target.value = '';
}

/**
 * 显示导入选项对话框
 */
function showImportOptionsDialog(importData, translations) {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    // 获取当前快捷操作
    const currentActions = QuickActionsManager.getAllQuickActions();
    const hasCurrentActions = currentActions.length > 0;

    // 检测重复的操作（按名称）
    const currentActionNames = new Set(currentActions.map(action => action.name));
    const duplicateActions = importData.actions.filter(action => currentActionNames.has(action.name));
    const newActions = importData.actions.filter(action => !currentActionNames.has(action.name));

    const hasDuplicates = duplicateActions.length > 0;
    const hasNewActions = newActions.length > 0;

    let messageText = '';
    if (hasDuplicates && hasNewActions) {
        messageText = `发现 ${duplicateActions.length} 个重复操作，${newActions.length} 个新操作`;
    } else if (hasDuplicates && !hasNewActions) {
        messageText = `发现 ${duplicateActions.length} 个重复操作`;
    } else {
        messageText = `发现 ${importData.actions.length} 个快捷操作`;
    }

    overlay.innerHTML = `
        <div class="dialog-content">
            <h3>${translations?.importQuickActions || '导入'}</h3>
            <p>${messageText}</p>
            ${hasDuplicates ? `
                <div class="duplicate-info">
                    <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: var(--spacing-sm);">
                        重复操作：${duplicateActions.map(action => action.name).join('、')}
                    </p>
                </div>
            ` : ''}
            ${hasCurrentActions ? `
                <div class="import-options">
                    <label class="radio-label">
                        <input type="radio" name="import-mode" value="merge" checked>
                        <span class="radio-mark"></span>
                        ${hasDuplicates ? '合并（跳过重复操作）' : '合并（保留现有操作）'}
                    </label>
                    <label class="radio-label">
                        <input type="radio" name="import-mode" value="replace">
                        <span class="radio-mark"></span>
                        ${hasDuplicates ? '替换（覆盖重复操作）' : '替换（删除现有操作）'}
                    </label>
                </div>
            ` : ''}
            <div class="dialog-actions">
                <button class="dialog-cancel cancel-btn">${translations?.cancel || '取消'}</button>
                <button class="dialog-confirm confirm-btn">${translations?.import || '导入'}</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const cancelBtn = overlay.querySelector('.dialog-cancel');
    const confirmBtn = overlay.querySelector('.dialog-confirm');

    const closeDialog = () => {
        overlay.remove();
    };

    cancelBtn.addEventListener('click', closeDialog);

    confirmBtn.addEventListener('click', async () => {
        // 如果没有现有操作，默认使用合并模式
        const selectedMode = hasCurrentActions ?
            (overlay.querySelector('input[name="import-mode"]:checked')?.value || 'merge') :
            'merge';

        try {
            const importedCount = await QuickActionsManager.importQuickActions(importData, selectedMode);

            if (importedCount > 0) {
                await renderQuickActionsList(translations);

                // 刷新欢迎消息中的快捷操作
                if (window.refreshWelcomeMessageQuickActions) {
                    await window.refreshWelcomeMessageQuickActions();
                }

                let message;
                if (selectedMode === 'replace' && hasDuplicates) {
                    message = `成功处理 ${importedCount} 个快捷操作`;
                } else {
                    message = translations?.importSuccess || '成功导入 {count} 个快捷操作'.replace('{count}', importedCount);
                }

                if (window.showToastUI) {
                    window.showToastUI(message, 'success');
                }
            } else {
                const message = hasDuplicates ? '所有操作都已存在，未导入新操作' : (translations?.importNoActions || '没有导入任何操作');
                if (window.showToastUI) {
                    window.showToastUI(message, 'warning');
                }
            }
        } catch (error) {
            console.error('[Settings] Import processing failed:', error);
            const message = translations?.importProcessFailed || '导入处理失败';
            if (window.showToastUI) {
                window.showToastUI(message, 'error');
            }
        }

        closeDialog();
    });

    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeDialog();
        }
    });
}

// === Vector DB Settings ===

/**
 * Initializes the Vector DB settings tab.
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {function} showToastCallback - Callback for showing toast messages
 * @param {function} getTranslationsCallback - Callback to get current translations
 */
async function initializeVectorDbSettings(state, elements, showToastCallback, getTranslationsCallback) {
    console.log('[Settings] Initializing Vector DB settings...');
    const container = document.getElementById('settings-vector-db');
    if (!container) {
        console.error('[Settings] Vector DB settings container not found');
        return;
    }

    try {
        await vectorDB.init();
    } catch (error) {
        console.error('Failed to initialize VectorDB:', error);
        showToastCallback(_('vectorDbFailedToInitialize', {}, getTranslationsCallback()), 'error');
        return;
    }

    let dbIdForImport = null;

    const render = async () => {
        const translations = getTranslationsCallback();
        container.innerHTML = `
            <div class="setting-group">
                <div class="setting-card">
                    <div class="setting-card-header">
                        <h3 class="setting-card-title">${_('vectorDbSettingsHeading', {}, translations)}</h3>
                    </div>
                    <p class="setting-card-description">${_('vectorDbDescription', {}, translations)}</p>
                    <div class="setting-card-content">
                            <div class="setting-row">
                                <label for="rag-min-score" class="setting-label">最小相关性阈值 (0~1)</label>
                                <input type="number" id="rag-min-score" class="setting-input" min="0" max="1" step="0.01" placeholder="0.35" />
                                <small class="setting-hint">当KB最高相关性低于该阈值时，不使用知识库增强</small>
                            </div>
                            <div class="setting-row">
                                <label class="setting-label">策略</label>
                                <div class="radio-group" id="rag-strategy-group">
                                    <label><input type="radio" name="rag-strategy" value="hybrid" checked> 混合（优先页面，可选使用KB）</label>
                                    <label><input type="radio" name="rag-strategy" value="kb_only"> 仅知识库（不建议）</label>
                                </div>
                                <small class="setting-hint">混合：若KB有用则补充，否则以页面为主；仅知识库：总是使用KB上下文</small>
                            </div>
                        <div id="vector-db-list" class="vector-db-list"></div>
                        <div class="setting-card-actions">
                            <input type="text" id="new-db-name" class="setting-input" placeholder="${_('vectorDbInputPlaceholder', {}, translations)}">
                            <button id="create-db-btn" class="setting-action-btn">${_('add', {}, translations)}</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        await renderDbList();
        setupEventListeners();
    };

    const renderDbList = async () => {
        const listContainer = document.getElementById('vector-db-list');
        if (!listContainer) return;

        const translations = getTranslationsCallback();
        const dbs = await vectorDB.getAllDBs();
        if (dbs.length === 0) {
            listContainer.innerHTML = `<p class="hint">${_('vectorDbEmpty', {}, translations)}</p>`;
            return;
        }

        listContainer.innerHTML = dbs.map(db => `
            <div class="vector-db-item" data-db-id="${db.id}">
                <span class="vector-db-name">${escapeHtml(db.name)}</span>
                <div class="vector-db-actions">
                    <button class="import-to-db-btn setting-action-btn" title="${_('vectorDbImportTitle', {}, translations)}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 1.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1-.708.708L8.5 2.707V11.5a.5.5 0 0 1-1 0V2.707L5.354 4.854a.5.5 0 1 1-.708-.708l3-3z"/></svg>
                    </button>
                    <button class="delete-db-btn setting-action-btn delete-btn" title="${_('vectorDbDeleteTitle', {}, translations)}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
                    </button>
                </div>
            </div>
        `).join('');
    };

    const setupEventListeners = () => {
        const ragMinScoreInput = document.getElementById('rag-min-score');
        const ragStrategyGroup = document.getElementById('rag-strategy-group');

        // Load saved settings
        browser.storage.sync.get('ragSettings').then((res) => {
            const cfg = res && res.ragSettings ? res.ragSettings : {};
            if (typeof cfg.minScore === 'number') ragMinScoreInput.value = cfg.minScore;
            const selected = (typeof cfg.strategy === 'string') ? cfg.strategy : 'hybrid';
            const rb = ragStrategyGroup.querySelector(`input[name="rag-strategy"][value="${selected}"]`);
            if (rb) rb.checked = true;
        }).catch(() => {});

        const saveRagSettings = () => {
            let minScore = parseFloat(ragMinScoreInput.value);
            if (isNaN(minScore)) minScore = 0.35;
            minScore = Math.min(1, Math.max(0, minScore));
            const strategy = (ragStrategyGroup.querySelector('input[name="rag-strategy"]:checked')?.value) || 'hybrid';
            browser.storage.sync.set({ ragSettings: { minScore, strategy } });
        };

        ragMinScoreInput.addEventListener('change', saveRagSettings);
        ragStrategyGroup.addEventListener('change', saveRagSettings);

        const createBtn = document.getElementById('create-db-btn');
        const newDbNameInput = document.getElementById('new-db-name');
        const listContainer = document.getElementById('vector-db-list');
        const fileInput = document.getElementById('import-to-db-input');

        if (!fileInput) {
            console.error('File input for DB import not found!');
            return;
        }

        createBtn.addEventListener('click', async () => {
            const name = newDbNameInput.value.trim();
            if (name) {
                try {
                    await vectorDB.createDB(name);
                    newDbNameInput.value = '';
                    await renderDbList();
                    showToastCallback(_('vectorDbCreated', {}, getTranslationsCallback()), 'success');
                } catch (error) {
                    showToastCallback(_('vectorDbCreateError', {}, getTranslationsCallback()), 'error');
                    console.error(error);
                }
            }
        });

        listContainer.addEventListener('click', async (e) => {
            const deleteBtn = e.target.closest('.delete-db-btn');
            const importBtn = e.target.closest('.import-to-db-btn');

            if (deleteBtn) {
                const dbItem = e.target.closest('.vector-db-item');
                const dbId = parseInt(dbItem.dataset.dbId, 10);
                if (confirm(_('vectorDbDeleteConfirm', {}, getTranslationsCallback()))) {
                    try {
                        await vectorDB.deleteDB(dbId);
                        await renderDbList();
                        showToastCallback(_('vectorDbDeleted', {}, getTranslationsCallback()), 'success');
                    } catch (error) {
                        showToastCallback(_('vectorDbDeleteError', {}, getTranslationsCallback()), 'error');
                        console.error(error);
                    }
                }
            } else if (importBtn) {
                const dbItem = e.target.closest('.vector-db-item');
                dbIdForImport = parseInt(dbItem.dataset.dbId, 10);
                fileInput.value = null;
                fileInput.click();
            }
        });

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file || dbIdForImport === null) {
                return;
            }

            const reader = new FileReader();
            reader.onload = async (event) => {
                const content = event.target.result;
                try {
                    showToastCallback(_('vectorDbImporting', { fileName: file.name }, getTranslationsCallback()), 'info');
                    await vectorDB.addDocument(dbIdForImport, content, file.name);
                    showToastCallback(_('vectorDbImported', { fileName: file.name }, getTranslationsCallback()), 'success');
                } catch (error) {
                    showToastCallback(_('vectorDbImportError', { error: error.message }, getTranslationsCallback()), 'error');
                    console.error(error);
                }
            };
            reader.onerror = () => {
                showToastCallback(_('vectorDbReadFileError', { error: reader.error }, getTranslationsCallback()), 'error');
            };
            reader.readAsText(file);

            dbIdForImport = null;
        });
    };

    await render();
}


// === Automation Settings ===
function setupAutomationSettingsUI(state, elements) {
    const container = document.getElementById('settings-automation');
    if (!container) return;

    const globalToggle = document.getElementById('automation-global-toggle');
    const toolsList = document.getElementById('automation-tools-list');
    const enableAllBtn = document.getElementById('automation-enable-all');
    const disableAllBtn = document.getElementById('automation-disable-all');

    // Expose catalog for other modules (optional)
    try { window.toolCatalog = toolCatalog; } catch (_) {}

    // Load current states
    browser.storage.sync.get(['automationEnabled', 'automationToolToggles']).then((res) => {
        const enabled = !!res.automationEnabled;
        const perTool = res.automationToolToggles || {};
        state.automationEnabled = enabled;
        if (globalToggle) {
            globalToggle.checked = enabled;
            globalToggle.addEventListener('change', async (e) => {
                const checked = e.target.checked;
                state.automationEnabled = checked;
                try { await browser.storage.sync.set({ automationEnabled: checked }); } catch (_) {}

                // Update the automation toggle button in chat input area
                const chatBtn = document.getElementById('automation-toggle-btn');
                if (chatBtn) {
                    if (checked) {
                        chatBtn.classList.add('automation-on');
                    } else {
                        chatBtn.classList.remove('automation-on');
                    }
                }

                // Update body class for automation mode
                document.body.classList.toggle('automation-mode', checked);

                if (window.showToastUI) {
                    const t = getCurrentTranslations();
                    window.showToastUI(checked ? _('automationToggleOn', {}, t) : _('automationToggleOff', {}, t), 'info');
                }
            });
        }

        // Render tool list
        if (toolsList) {
            renderAutomationToolsList(toolsList, perTool);
        }

        // Buttons
        if (enableAllBtn) enableAllBtn.addEventListener('click', async () => {
            const perToolNew = {};
            (window.toolCatalog || toolCatalog || []).forEach(t => perToolNew[t.name] = true);
            await browser.storage.sync.set({ automationToolToggles: perToolNew });
            renderAutomationToolsList(toolsList, perToolNew);
        });
        if (disableAllBtn) disableAllBtn.addEventListener('click', async () => {
            const perToolNew = {};
            (window.toolCatalog || toolCatalog || []).forEach(t => perToolNew[t.name] = false);
            await browser.storage.sync.set({ automationToolToggles: perToolNew });
            renderAutomationToolsList(toolsList, perToolNew);
        });

        // ===== Claude Agent SDK Configuration =====
        const sdkEndpointInput = document.getElementById('agent-sdk-endpoint');
        const sdkApiKeyInput = document.getElementById('agent-sdk-apikey');
        const sdkModelInput = document.getElementById('agent-sdk-model');
        const sdkPermissionSelect = document.getElementById('agent-sdk-permission');
        const sdkSaveBtn = document.getElementById('agent-sdk-save');
        const sdkTestBtn = document.getElementById('agent-sdk-test');

        // Load saved configuration
        browser.storage.sync.get(['agentSdkEndpoint', 'agentSdkApiKey', 'agentSdkModel', 'agentSdkPermission']).then((res) => {
            if (sdkEndpointInput) sdkEndpointInput.value = res.agentSdkEndpoint || '';
            if (sdkApiKeyInput) sdkApiKeyInput.value = res.agentSdkApiKey || '';
            if (sdkModelInput) sdkModelInput.value = res.agentSdkModel || 'claude-sonnet-4-5';
            if (sdkPermissionSelect) sdkPermissionSelect.value = res.agentSdkPermission || 'default';
        });

        // Save configuration
        if (sdkSaveBtn) {
            sdkSaveBtn.addEventListener('click', async () => {
                const endpoint = sdkEndpointInput?.value?.trim() || '';
                const apiKey = sdkApiKeyInput?.value?.trim() || '';
                const model = sdkModelInput?.value || 'claude-sonnet-4-5';
                const permission = sdkPermissionSelect?.value || 'default';

                await browser.storage.sync.set({
                    agentSdkEndpoint: endpoint,
                    agentSdkApiKey: apiKey,
                    agentSdkModel: model,
                    agentSdkPermission: permission
                });

                if (window.showToastUI) {
                    const t = getCurrentTranslations();
                    window.showToastUI(_('agentSdkSaved', {}, t) || '配置已保存', 'success');
                }
            });
        }

        // Test connection
        if (sdkTestBtn) {
            sdkTestBtn.addEventListener('click', async () => {
                if (window.showToastUI) {
                    const t = getCurrentTranslations();
                    window.showToastUI(_('agentSdkTesting', {}, t) || '正在测试连接...', 'info');
                }

                const endpoint = sdkEndpointInput?.value?.trim() || '';
                const apiKey = sdkApiKeyInput?.value?.trim() || '';
                const model = sdkModelInput?.value || 'claude-sonnet-4-5';

                // Test API connection
                try {
                    const testUrl = endpoint || 'https://api.anthropic.com';
                    const response = await runtimeFetch(`${testUrl}/v1/messages`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': apiKey,
                            'anthropic-version': '2023-06-01'
                        },
                        body: JSON.stringify({
                            model: model,
                            max_tokens: 10,
                            messages: [{ role: 'user', content: 'Hi' }]
                        })
                    });

                    if (response.ok) {
                        if (window.showToastUI) {
                            const t = getCurrentTranslations();
                            window.showToastUI(_('agentSdkTestSuccess', {}, t) || '连接成功!', 'success');
                        }
                    } else if (response.status === 401) {
                        if (window.showToastUI) {
                            const t = getCurrentTranslations();
                            window.showToastUI(_('agentSdkTestAuthFailed', {}, t) || '认证失败，请检查 API Key', 'error');
                        }
                    } else {
                        if (window.showToastUI) {
                            const t = getCurrentTranslations();
                            window.showToastUI(_('agentSdkTestFailed', {}, t) || `连接失败: ${response.status}`, 'error');
                        }
                    }
                } catch (error) {
                    if (window.showToastUI) {
                        const t = getCurrentTranslations();
                        window.showToastUI(_('agentSdkTestError', {}, t) || `连接错误: ${error.message}`, 'error');
                    }
                }
            });
        }
    });

    // Helper to render list with categories
    function renderAutomationToolsList(containerEl, perToolState) {
        if (!containerEl) return;
        containerEl.innerHTML = '';
        const tools = (window.toolCatalog || []);
        const t = getCurrentTranslations();

        // Category translations
        const categoryNames = {
            tabs: t.automationCategoryTabs || '标签页操作',
            page: t.automationCategoryPage || '页面操作',
            elements: t.automationCategoryElements || '元素操作',
            editor: t.automationCategoryEditor || '编辑器操作'
        };

        // Group tools by category
        const grouped = {};
        tools.forEach(tool => {
            const cat = tool.category || 'other';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(tool);
        });

        // Render by category
        Object.keys(grouped).forEach(category => {
            // Category header
            const categoryHeader = document.createElement('div');
            categoryHeader.className = 'automation-category-header';
            categoryHeader.textContent = categoryNames[category] || category;
            containerEl.appendChild(categoryHeader);

            // Tools in this category
            grouped[category].forEach(tool => {
                const row = document.createElement('div');
                row.className = 'setting-item automation-tool-item';
                const nameKey = `tool.${tool.name}.name`;
                const descKey = `tool.${tool.name}.desc`;
                const localizedName = _ (nameKey, {}, t);
                const localizedDesc = _ (descKey, {}, t);
                const finalName = localizedName && localizedName !== nameKey ? localizedName : (tool.displayName || tool.name);
                const translatedDesc = t[tool.description] || '';
                const finalDesc = translatedDesc || (localizedDesc && localizedDesc !== descKey ? localizedDesc : (tool.description || ''));
                row.innerHTML = `
                    <div class="setting-item-label">
                        <div class="setting-card-title">${finalName}</div>
                        <div class="setting-card-description">${finalDesc}</div>
                    </div>
                    <div class="setting-item-control">
                        <label class="switch">
                            <input type="checkbox" ${perToolState[tool.name] !== false ? 'checked' : ''} data-tool="${tool.name}">
                            <span class="slider round"></span>
                        </label>
                    </div>
                `;
                const checkbox = row.querySelector('input[type="checkbox"]');
                checkbox.addEventListener('change', async () => {
                    const name = checkbox.dataset.tool;
                    const newState = { ...perToolState, [name]: checkbox.checked };
                    await browser.storage.sync.set({ automationToolToggles: newState });
                });
                containerEl.appendChild(row);
            });
        });
    }
}

// 辅助函数：HTML转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// === Editor Appearance Settings ===

function initEditorAppearanceSettings() {
    const inputs = {
        editorBgColor: document.getElementById('editor-bg-color'),
        previewBgColor: document.getElementById('preview-bg-color'),
        cmGutterBg: document.getElementById('gutter-bg-color'),
        cmLinenumberColor: document.getElementById('linenumber-color'),
    };
    const resetBtn = document.getElementById('reset-editor-colors');
    const styleTagId = 'custom-editor-colors-style';

    let currentSettings = { light: {}, dark: {} };

    const generateCss = (settings) => {
        const { light = {}, dark = {} } = settings;
        const rootCss = light && Object.keys(light).length > 0 ?
            `:root {\n${Object.entries(light).map(([key, value]) => `    --${{
                editorBgColor: 'custom-editor-bg',
                previewBgColor: 'custom-preview-bg',
                cmGutterBg: 'cm-gutter-bg',
                cmLinenumberColor: 'cm-linenumber-color'
            }[key]}: ${value};`).join('\n')}\n}` : '';

        const darkCss = dark && Object.keys(dark).length > 0 ?
            `body.dark-mode {\n${Object.entries(dark).map(([key, value]) => `    --${{
                editorBgColor: 'custom-editor-bg',
                previewBgColor: 'custom-preview-bg',
                cmGutterBg: 'cm-gutter-bg',
                cmLinenumberColor: 'cm-linenumber-color'
            }[key]}: ${value};`).join('\n')}\n}` : '';

        return `${rootCss}\n\n${darkCss}`.trim();
    };

    const updateStyleTag = (settings) => {
        let styleTag = document.getElementById(styleTagId);
        const cssText = generateCss(settings);
        if (cssText) {
            if (!styleTag) {
                styleTag = document.createElement('style');
                styleTag.id = styleTagId;
                document.head.appendChild(styleTag);
            }
            styleTag.textContent = cssText;
        } else if (styleTag) {
            styleTag.remove();
        }
    };

    const updateColorInputs = () => {
        const isDark = document.body.classList.contains('dark-mode');
        const theme = isDark ? 'dark' : 'light';
        const themeSettings = currentSettings[theme] || {};
        const defaults = {
            editorBgColor: isDark ? '#282a36' : '#f0f8ff',
            previewBgColor: isDark ? '#282a36' : '#f0f8ff',
            cmGutterBg: isDark ? '#44475a' : '#f8f9fa',
            cmLinenumberColor: isDark ? '#6272a4' : '#6c757d'
        };

        for (const key in inputs) {
            if (inputs[key]) {
                inputs[key].value = themeSettings[key] || defaults[key];
            }
        }
    };

    browser.storage.sync.get('editorAppearanceColors').then(result => {
        currentSettings = result.editorAppearanceColors || { light: {}, dark: {} };
        updateStyleTag(currentSettings);
        updateColorInputs();
    });

    for (const key in inputs) {
        if (inputs[key]) {
            inputs[key].addEventListener('input', (e) => {
                const isDark = document.body.classList.contains('dark-mode');
                const theme = isDark ? 'dark' : 'light';
                if (!currentSettings[theme]) currentSettings[theme] = {};
                currentSettings[theme][key] = e.target.value;
                browser.storage.sync.set({ editorAppearanceColors: currentSettings });
                updateStyleTag(currentSettings);
            });
        }
    }

    const themeObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.attributeName === 'class') {
                updateColorInputs();
                break;
            }
        }
    });

    themeObserver.observe(document.body, { attributes: true });

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            currentSettings = { light: {}, dark: {} };
            browser.storage.sync.remove('editorAppearanceColors');
            updateStyleTag({});
            updateColorInputs();
            const currentTranslations = getCurrentTranslations();
            window.showToastUI(_('colorsResetSuccess', {}, currentTranslations), 'success');
        });
    }
}

async function initMcpSettings() {
    const generalSettings = document.getElementById('settings-general');
    if (!generalSettings) {
        return;
    }

    let host = document.getElementById('mcp-settings-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'mcp-settings-host';
        host.className = 'setting-group';
        generalSettings.appendChild(host);
    }

    host.innerHTML = `
        <div class="setting-card mcp-settings-card">
            <div class="setting-card-header">
                <div class="setting-card-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M8 3H5a2 2 0 0 0-2 2v3"></path>
                        <path d="M16 3h3a2 2 0 0 1 2 2v3"></path>
                        <path d="M8 21H5a2 2 0 0 1-2-2v-3"></path>
                        <path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>
                        <rect x="8" y="8" width="8" height="8" rx="1"></rect>
                    </svg>
                </div>
                <div>
                    <div class="setting-card-title">MCP 服务器</div>
                    <div class="setting-card-description">配置远程 MCP server，供 Agent 动态加载和调用工具。</div>
                </div>
            </div>
            <div class="setting-card-content">
                <div class="mcp-settings-grid">
                    <div class="setting-item">
                        <label>服务器</label>
                        <select id="mcp-server-select" class="setting-select"></select>
                    </div>
                    <div class="setting-item">
                        <label>传输</label>
                        <select id="mcp-transport" class="setting-select">
                            <option value="streamable-http">Streamable HTTP</option>
                            <option value="sse">SSE (兼容)</option>
                        </select>
                    </div>
                    <div class="setting-item">
                        <label>名称</label>
                        <input id="mcp-name" class="setting-input" type="text" placeholder="例如：本地知识库" />
                    </div>
                    <div class="setting-item">
                        <label>启用</label>
                        <select id="mcp-enabled" class="setting-select">
                            <option value="true">启用</option>
                            <option value="false">禁用</option>
                        </select>
                    </div>
                    <div class="setting-item mcp-grid-span-2">
                        <label>URL</label>
                        <input id="mcp-url" class="setting-input" type="text" placeholder="https://example.com/mcp" />
                    </div>
                    <div class="setting-item mcp-grid-span-2">
                        <label>Message URL（仅 SSE）</label>
                        <input id="mcp-message-url" class="setting-input" type="text" placeholder="https://example.com/messages" />
                    </div>
                    <div class="setting-item">
                        <label>认证方式</label>
                        <select id="mcp-auth-type" class="setting-select">
                            <option value="none">无</option>
                            <option value="bearer">Bearer Token</option>
                            <option value="api-key">API Key</option>
                            <option value="custom-header">自定义 Header</option>
                        </select>
                    </div>
                    <div class="setting-item">
                        <label>认证 Header</label>
                        <input id="mcp-auth-header" class="setting-input" type="text" placeholder="Authorization" />
                    </div>
                    <div class="setting-item mcp-grid-span-2">
                        <label>认证 Token</label>
                        <input id="mcp-auth-token" class="setting-input" type="password" placeholder="可留空" />
                    </div>
                </div>
                <div class="mcp-server-meta" id="mcp-server-meta">未选择 MCP 服务器</div>
                <div class="mcp-server-list" id="mcp-server-list"></div>
                <div class="setting-card-actions">
                    <button id="mcp-new-btn" class="setting-action-btn">新建</button>
                    <button id="mcp-save-btn" class="setting-action-btn">保存</button>
                    <button id="mcp-test-btn" class="setting-action-btn">测试连接</button>
                    <button id="mcp-refresh-tools-btn" class="setting-action-btn">刷新工具</button>
                    <button id="mcp-remove-btn" class="setting-action-btn delete-btn">删除</button>
                </div>
            </div>
        </div>
    `;

    const elements = {
        serverSelect: host.querySelector('#mcp-server-select'),
        transport: host.querySelector('#mcp-transport'),
        name: host.querySelector('#mcp-name'),
        enabled: host.querySelector('#mcp-enabled'),
        url: host.querySelector('#mcp-url'),
        messageUrl: host.querySelector('#mcp-message-url'),
        authType: host.querySelector('#mcp-auth-type'),
        authHeader: host.querySelector('#mcp-auth-header'),
        authToken: host.querySelector('#mcp-auth-token'),
        meta: host.querySelector('#mcp-server-meta'),
        serverList: host.querySelector('#mcp-server-list'),
        newBtn: host.querySelector('#mcp-new-btn'),
        saveBtn: host.querySelector('#mcp-save-btn'),
        testBtn: host.querySelector('#mcp-test-btn'),
        refreshBtn: host.querySelector('#mcp-refresh-tools-btn'),
        removeBtn: host.querySelector('#mcp-remove-btn')
    };

    const state = {
        selectedServerId: '',
        servers: []
    };

    const showToast = (message, type = 'info') => {
        if (window.showToastUI) {
            window.showToastUI(message, type);
        }
    };

    const readForm = () => ({
        id: state.selectedServerId || undefined,
        name: elements.name.value.trim(),
        transport: elements.transport.value,
        enabled: elements.enabled.value === 'true',
        url: elements.url.value.trim(),
        messageUrl: elements.messageUrl.value.trim(),
        authType: elements.authType.value,
        authHeaderName: elements.authHeader.value.trim(),
        authToken: elements.authToken.value
    });

    const applyServerToForm = (server) => {
        elements.transport.value = server?.transport || 'streamable-http';
        elements.name.value = server?.name || '';
        elements.enabled.value = server?.enabled === false ? 'false' : 'true';
        elements.url.value = server?.url || '';
        elements.messageUrl.value = server?.messageUrl || '';
        elements.authType.value = server?.authType || 'none';
        elements.authHeader.value = server?.authHeaderName || 'Authorization';
        elements.authToken.value = server?.authToken || '';
        if (server) {
            elements.meta.textContent = `已选择：${server.name} · ${server.transport} · ${server.enabled === false ? '禁用' : '启用'}`;
        } else {
            elements.meta.textContent = '新建 MCP 服务器';
        }
    };

    const renderServerOptions = () => {
        const options = ['<option value="">新建 MCP 服务器</option>'];
        for (const server of state.servers) {
            const suffix = server.enabled === false ? '（已禁用）' : '';
            options.push(`<option value="${escapeHtml(server.id)}">${escapeHtml(server.name)}${suffix}</option>`);
        }
        elements.serverSelect.innerHTML = options.join('');
        elements.serverSelect.value = state.selectedServerId || '';
    };

    const renderServerList = () => {
        if (!elements.serverList) {
            return;
        }
        if (!state.servers.length) {
            elements.serverList.innerHTML = '<div class="mcp-server-empty">当前还没有 MCP 服务器</div>';
            return;
        }
        elements.serverList.innerHTML = state.servers.map((server) => {
            const isActive = server.id === state.selectedServerId;
            const statusClass = server.connected ? 'connected' : (server.lastError ? 'error' : 'idle');
            const statusLabel = server.connected ? '在线' : (server.lastError ? '异常' : '未连接');
            const toolCount = Number.isFinite(server.toolCount) ? server.toolCount : 0;
            const errorText = server.lastError ? `<div class="mcp-server-error">${escapeHtml(server.lastError)}</div>` : '';
            return `
                <button type="button" class="mcp-server-item ${isActive ? 'active' : ''}" data-server-id="${escapeHtml(server.id)}">
                    <div class="mcp-server-item-head">
                        <span class="mcp-server-name">${escapeHtml(server.name)}</span>
                        <span class="mcp-server-status ${statusClass}">${statusLabel}</span>
                    </div>
                    <div class="mcp-server-item-meta">
                        <span>${escapeHtml(server.transport)}</span>
                        <span>${toolCount} 个工具</span>
                        <span>${server.enabled === false ? '已禁用' : '已启用'}</span>
                    </div>
                    ${errorText}
                </button>
            `;
        }).join('');

        elements.serverList.querySelectorAll('.mcp-server-item').forEach((button) => {
            button.addEventListener('click', () => {
                state.selectedServerId = button.dataset.serverId || '';
                elements.serverSelect.value = state.selectedServerId;
                const selectedServer = state.servers.find((server) => server.id === state.selectedServerId) || null;
                applyServerToForm(selectedServer);
                renderServerList();
            });
        });
    };

    const loadServers = async (keepSelected = true) => {
        const response = await browser.runtime.sendMessage({ action: 'mcp.listServers' });
        state.servers = response?.success && Array.isArray(response.data) ? response.data : [];
        if (!keepSelected || !state.servers.some((server) => server.id === state.selectedServerId)) {
            state.selectedServerId = '';
        }
        renderServerOptions();
        renderServerList();
        const selectedServer = state.servers.find((server) => server.id === state.selectedServerId) || null;
        applyServerToForm(selectedServer);
    };

    elements.serverSelect.addEventListener('change', () => {
        state.selectedServerId = elements.serverSelect.value;
        const selectedServer = state.servers.find((server) => server.id === state.selectedServerId) || null;
        applyServerToForm(selectedServer);
    });

    elements.newBtn.addEventListener('click', () => {
        state.selectedServerId = '';
        elements.serverSelect.value = '';
        applyServerToForm(null);
    });

    elements.saveBtn.addEventListener('click', async () => {
        const server = readForm();
        if (!server.name || !server.url) {
            showToast('MCP 服务器名称和 URL 不能为空', 'error');
            return;
        }
        if (server.transport === 'sse' && !server.messageUrl) {
            showToast('SSE 传输需要填写 Message URL', 'error');
            return;
        }
        const response = await browser.runtime.sendMessage({
            action: 'mcp.upsertServer',
            server
        });
        if (!response?.success) {
            showToast(response?.error || '保存 MCP 服务器失败', 'error');
            return;
        }
        state.selectedServerId = response.data.id;
        await loadServers(true);
        window.dispatchEvent(new CustomEvent('infinpilot:mcp-changed'));
        showToast('MCP 服务器已保存', 'success');
    });

    elements.testBtn.addEventListener('click', async () => {
        const server = readForm();
        if (!server.name || !server.url) {
            showToast('请先填写 MCP 服务器名称和 URL', 'error');
            return;
        }
        const response = await browser.runtime.sendMessage({
            action: 'mcp.testServer',
            server
        });
        if (!response?.success) {
            showToast(response?.error || 'MCP 测试失败', 'error');
            return;
        }
        const toolCount = response.data?.toolCount || 0;
        showToast(`MCP 测试成功，发现 ${toolCount} 个工具`, 'success');
    });

    elements.refreshBtn.addEventListener('click', async () => {
        const response = await browser.runtime.sendMessage({
            action: 'mcp.listTools',
            refresh: true
        });
        if (!response?.success) {
            showToast(response?.error || '刷新 MCP 工具失败', 'error');
            return;
        }
        await loadServers(true);
        window.dispatchEvent(new CustomEvent('infinpilot:mcp-changed'));
        showToast(`已刷新 MCP 工具，共 ${response.data.length} 个`, 'success');
    });

    elements.removeBtn.addEventListener('click', async () => {
        if (!state.selectedServerId) {
            showToast('当前没有选中的 MCP 服务器', 'error');
            return;
        }
        const response = await browser.runtime.sendMessage({
            action: 'mcp.removeServer',
            serverId: state.selectedServerId
        });
        if (!response?.success) {
            showToast(response?.error || '删除 MCP 服务器失败', 'error');
            return;
        }
        state.selectedServerId = '';
        await loadServers(false);
        window.dispatchEvent(new CustomEvent('infinpilot:mcp-changed'));
        showToast('MCP 服务器已删除', 'success');
    });

    await loadServers(false);
}

async function initMcpSettingsRuntime() {
    const automationSettings = document.getElementById('settings-automation');
    if (!automationSettings) {
        return;
    }

    let host = document.getElementById('mcp-settings-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'mcp-settings-host';
    }
    host.className = 'setting-card unified-settings-card agent-sdk-card mcp-settings-card';
    automationSettings.appendChild(host);

    host.innerHTML = `
        <div class="setting-card-header">
            <div>
                <div class="setting-card-title">MCP 服务</div>
                <div class="setting-card-description">配置远程 MCP 服务，支持 Streamable HTTP 和兼容模式 SSE。</div>
            </div>
            <div class="agent-sdk-status mcp-settings-status">
                <span class="status-dot"></span>
                <span class="status-text" id="mcp-server-meta">正在加载 MCP 状态...</span>
            </div>
        </div>
        <div class="setting-card-content">
            <div class="agent-sdk-grid mcp-settings-form-grid">
                <div class="setting-item full-width">
                    <label for="mcp-server-select">服务</label>
                    <select id="mcp-server-select" class="unified-select"></select>
                </div>
                <div class="setting-item">
                    <label for="mcp-transport">传输</label>
                    <select id="mcp-transport" class="unified-select">
                        <option value="streamable-http">Streamable HTTP</option>
                        <option value="sse">Legacy SSE</option>
                    </select>
                </div>
                <div class="setting-item">
                    <label for="mcp-enabled">状态</label>
                    <select id="mcp-enabled" class="unified-select">
                        <option value="true">启用</option>
                        <option value="false">禁用</option>
                    </select>
                </div>
                <div class="setting-item full-width">
                    <label for="mcp-name">名称</label>
                    <input id="mcp-name" class="unified-input" type="text" placeholder="例如：团队知识库" />
                </div>
                <div class="setting-item full-width">
                    <label for="mcp-url">URL</label>
                    <input id="mcp-url" class="unified-input" type="text" placeholder="https://example.com/mcp" />
                </div>
                <div class="setting-item full-width">
                    <label for="mcp-message-url">Message URL（仅 SSE）</label>
                    <input id="mcp-message-url" class="unified-input" type="text" placeholder="https://example.com/messages" />
                </div>
                <div class="setting-item">
                    <label for="mcp-auth-type">认证方式</label>
                    <select id="mcp-auth-type" class="unified-select">
                        <option value="none">无</option>
                        <option value="bearer">Bearer Token</option>
                        <option value="api-key">API Key</option>
                        <option value="custom-header">自定义 Header</option>
                    </select>
                </div>
                <div class="setting-item">
                    <label for="mcp-auth-header">认证 Header</label>
                    <input id="mcp-auth-header" class="unified-input" type="text" placeholder="Authorization" />
                </div>
                <div class="setting-item full-width">
                    <label for="mcp-auth-token">认证 Token</label>
                    <input id="mcp-auth-token" class="unified-input" type="password" placeholder="可留空" />
                </div>
            </div>
            <div class="mcp-server-list" id="mcp-server-list"></div>
            <div class="setting-card-actions">
                <button id="mcp-new-btn" class="unified-action-btn"><span>新建</span></button>
                <button id="mcp-save-btn" class="unified-action-btn primary"><span>保存</span></button>
                <button id="mcp-test-btn" class="unified-action-btn"><span>测试连接</span></button>
                <button id="mcp-refresh-tools-btn" class="unified-action-btn"><span>刷新目录</span></button>
                <button id="mcp-remove-btn" class="unified-action-btn"><span>删除</span></button>
            </div>
        </div>
    `;

    const elements = {
        serverSelect: host.querySelector('#mcp-server-select'),
        transport: host.querySelector('#mcp-transport'),
        name: host.querySelector('#mcp-name'),
        enabled: host.querySelector('#mcp-enabled'),
        url: host.querySelector('#mcp-url'),
        messageUrl: host.querySelector('#mcp-message-url'),
        authType: host.querySelector('#mcp-auth-type'),
        authHeader: host.querySelector('#mcp-auth-header'),
        authToken: host.querySelector('#mcp-auth-token'),
        meta: host.querySelector('#mcp-server-meta'),
        serverList: host.querySelector('#mcp-server-list'),
        newBtn: host.querySelector('#mcp-new-btn'),
        saveBtn: host.querySelector('#mcp-save-btn'),
        testBtn: host.querySelector('#mcp-test-btn'),
        refreshBtn: host.querySelector('#mcp-refresh-tools-btn'),
        removeBtn: host.querySelector('#mcp-remove-btn')
    };

    const state = {
        selectedServerId: '',
        servers: [],
        isDirty: false,
        suppressDirtyTracking: false,
        draft: null,
        summary: {
            toolCount: 0,
            resourceCount: 0,
            promptCount: 0
        }
    };

    const showToast = (message, type = 'info') => {
        if (window.showToastUI) {
            window.showToastUI(message, type);
        }
    };

    const readForm = () => ({
        id: state.selectedServerId || undefined,
        name: elements.name.value.trim(),
        transport: elements.transport.value,
        enabled: elements.enabled.value === 'true',
        url: elements.url.value.trim(),
        messageUrl: elements.messageUrl.value.trim(),
        authType: elements.authType.value,
        authHeaderName: elements.authHeader.value.trim(),
        authToken: elements.authToken.value
    });

    const syncDraftFromForm = () => {
        if (state.suppressDirtyTracking) {
            return;
        }
        state.draft = readForm();
        state.isDirty = true;
    };

    const updateMeta = (selectedServer = null) => {
        if (selectedServer) {
            const syncedText = selectedServer.lastSyncedAt
                ? `，上次同步 ${new Date(selectedServer.lastSyncedAt).toLocaleString()}`
                : '';
            elements.meta.textContent = `${selectedServer.name} · ${selectedServer.transport} · ${selectedServer.enabled === false ? '已禁用' : '已启用'} · 工具 ${selectedServer.toolCount || 0} · 资源 ${selectedServer.resourceCount || 0} · 提示词 ${selectedServer.promptCount || 0}${syncedText}`;
            return;
        }
        elements.meta.textContent = `已配置 ${state.servers.length} 个 MCP 服务，工具 ${state.summary.toolCount} 个，资源 ${state.summary.resourceCount} 条，提示词 ${state.summary.promptCount} 个`;
    };

    const applyServerToForm = (server) => {
        state.suppressDirtyTracking = true;
        elements.transport.value = server?.transport || 'streamable-http';
        elements.name.value = server?.name || '';
        elements.enabled.value = server?.enabled === false ? 'false' : 'true';
        elements.url.value = server?.url || '';
        elements.messageUrl.value = server?.messageUrl || '';
        elements.authType.value = server?.authType || 'none';
        elements.authHeader.value = server?.authHeaderName || 'Authorization';
        elements.authToken.value = server?.authToken || '';
        state.suppressDirtyTracking = false;
        state.draft = null;
        state.isDirty = false;
        updateMeta(server);
    };

    const applyDraftToForm = () => {
        if (!state.draft) {
            return;
        }
        state.suppressDirtyTracking = true;
        elements.transport.value = state.draft.transport || 'streamable-http';
        elements.name.value = state.draft.name || '';
        elements.enabled.value = state.draft.enabled === false ? 'false' : 'true';
        elements.url.value = state.draft.url || '';
        elements.messageUrl.value = state.draft.messageUrl || '';
        elements.authType.value = state.draft.authType || 'none';
        elements.authHeader.value = state.draft.authHeaderName || 'Authorization';
        elements.authToken.value = state.draft.authToken || '';
        state.suppressDirtyTracking = false;
    };

    const renderServerOptions = () => {
        const options = ['<option value="">新建 MCP 服务</option>'];
        for (const server of state.servers) {
            const suffix = server.enabled === false ? '（已禁用）' : '';
            options.push(`<option value="${escapeHtml(server.id)}">${escapeHtml(server.name)}${suffix}</option>`);
        }
        elements.serverSelect.innerHTML = options.join('');
        elements.serverSelect.value = state.selectedServerId || '';
    };

    const renderServerList = () => {
        if (!state.servers.length) {
            elements.serverList.innerHTML = '<div class="mcp-server-empty">当前还没有 MCP 服务</div>';
            return;
        }

        elements.serverList.innerHTML = state.servers.map((server) => {
            const isActive = server.id === state.selectedServerId;
            const statusClass = server.connected ? 'connected' : (server.lastError ? 'error' : 'idle');
            const statusLabel = server.connected ? '在线' : (server.lastError ? '异常' : '未连接');
            const errorText = server.lastError ? `<div class="mcp-server-error">${escapeHtml(server.lastError)}</div>` : '';
            return `
                <button type="button" class="mcp-server-item ${isActive ? 'active' : ''}" data-server-id="${escapeHtml(server.id)}">
                    <div class="mcp-server-item-head">
                        <span class="mcp-server-name">${escapeHtml(server.name)}</span>
                        <span class="mcp-server-status ${statusClass}">${statusLabel}</span>
                    </div>
                    <div class="mcp-server-item-meta">
                        <span>${escapeHtml(server.transport)}</span>
                        <span>工具 ${server.toolCount || 0}</span>
                        <span>资源 ${server.resourceCount || 0}</span>
                        <span>提示词 ${server.promptCount || 0}</span>
                        <span>${server.enabled === false ? '已禁用' : '已启用'}</span>
                    </div>
                    ${errorText}
                </button>
            `;
        }).join('');

        elements.serverList.querySelectorAll('.mcp-server-item').forEach((button) => {
            button.addEventListener('click', () => {
                state.selectedServerId = button.dataset.serverId || '';
                elements.serverSelect.value = state.selectedServerId;
                const selectedServer = state.servers.find((server) => server.id === state.selectedServerId) || null;
                applyServerToForm(selectedServer);
                renderServerList();
            });
        });
    };

    const loadServers = async (keepSelected = true) => {
        const response = await browser.runtime.sendMessage({ action: 'mcp.getState' });
        const payload = response?.success ? (response.data || {}) : {};
        state.servers = Array.isArray(payload.servers) ? payload.servers : [];
        state.summary.toolCount = Number.isFinite(payload.toolCount) ? payload.toolCount : 0;
        state.summary.resourceCount = Number.isFinite(payload.resourceCount) ? payload.resourceCount : 0;
        state.summary.promptCount = Number.isFinite(payload.promptCount) ? payload.promptCount : 0;
        if (!keepSelected || !state.servers.some((server) => server.id === state.selectedServerId)) {
            state.selectedServerId = '';
        }
        renderServerOptions();
        renderServerList();
        const selectedServer = state.servers.find((server) => server.id === state.selectedServerId) || null;
        if (state.isDirty && state.draft) {
            applyDraftToForm();
            updateMeta(selectedServer);
        } else {
            applyServerToForm(selectedServer);
        }
    };

    [
        elements.transport,
        elements.name,
        elements.enabled,
        elements.url,
        elements.messageUrl,
        elements.authType,
        elements.authHeader,
        elements.authToken
    ].forEach((field) => {
        field.addEventListener('input', syncDraftFromForm);
        field.addEventListener('change', syncDraftFromForm);
    });

    elements.serverSelect.addEventListener('change', () => {
        state.selectedServerId = elements.serverSelect.value;
        const selectedServer = state.servers.find((server) => server.id === state.selectedServerId) || null;
        applyServerToForm(selectedServer);
    });

    elements.newBtn.addEventListener('click', () => {
        state.selectedServerId = '';
        elements.serverSelect.value = '';
        applyServerToForm(null);
    });

    elements.saveBtn.addEventListener('click', async () => {
        const server = readForm();
        if (!server.name || !server.url) {
            showToast('MCP 服务名称和 URL 不能为空', 'error');
            return;
        }
        if (server.transport === 'sse' && !server.messageUrl) {
            showToast('SSE 传输需要填写 Message URL', 'error');
            return;
        }
        const response = await browser.runtime.sendMessage({
            action: 'mcp.upsertServer',
            server
        });
        if (!response?.success) {
            showToast(response?.error || '保存 MCP 服务失败', 'error');
            return;
        }
        state.selectedServerId = response.data.id;
        state.draft = null;
        state.isDirty = false;
        await loadServers(true);
        window.dispatchEvent(new CustomEvent('infinpilot:mcp-changed'));
        showToast('MCP 服务已保存', 'success');
    });

    elements.testBtn.addEventListener('click', async () => {
        const server = readForm();
        if (!server.name || !server.url) {
            showToast('请先填写 MCP 服务名称和 URL', 'error');
            return;
        }
        const response = await browser.runtime.sendMessage({
            action: 'mcp.testServer',
            server
        });
        if (!response?.success) {
            showToast(response?.error || 'MCP 连接测试失败', 'error');
            return;
        }
        await loadServers(true);
        showToast(`测试成功，发现 ${response.data?.toolCount || 0} 个工具、${response.data?.resourceCount || 0} 条资源、${response.data?.promptCount || 0} 个提示词`, 'success');
    });

    elements.refreshBtn.addEventListener('click', async () => {
        const response = await browser.runtime.sendMessage({
            action: 'mcp.listTools',
            refresh: true
        });
        if (!response?.success) {
            showToast(response?.error || '刷新 MCP 目录失败', 'error');
            return;
        }
        await browser.runtime.sendMessage({ action: 'mcp.listResources', refresh: true });
        await browser.runtime.sendMessage({ action: 'mcp.listPrompts', refresh: true });
        await loadServers(true);
        window.dispatchEvent(new CustomEvent('infinpilot:mcp-changed'));
        showToast(`目录已刷新，共 ${Array.isArray(response.data) ? response.data.length : 0} 个远程工具`, 'success');
    });

    elements.removeBtn.addEventListener('click', async () => {
        if (!state.selectedServerId) {
            showToast('当前没有选中的 MCP 服务', 'error');
            return;
        }
        const response = await browser.runtime.sendMessage({
            action: 'mcp.removeServer',
            serverId: state.selectedServerId
        });
        if (!response?.success) {
            showToast(response?.error || '删除 MCP 服务失败', 'error');
            return;
        }
        state.selectedServerId = '';
        state.draft = null;
        state.isDirty = false;
        await loadServers(false);
        window.dispatchEvent(new CustomEvent('infinpilot:mcp-changed'));
        showToast('MCP 服务已删除', 'success');
    });

    if (host.__mcpRefreshTimer) {
        clearInterval(host.__mcpRefreshTimer);
    }
    host.__mcpRefreshTimer = setInterval(() => {
        if (!document.hidden) {
            void loadServers(true);
        }
    }, 15000);

    window.addEventListener('infinpilot:mcp-changed', () => {
        void loadServers(true);
    });

    await loadServers(false);
}


// =================================================================
// User Account & Authentication
// =================================================================

/**
 * Initializes the User Account section in the settings.
 */
async function initUserAccount() {
    const accountContentEl = document.getElementById('user-account-content');
    if (!accountContentEl) {
        console.warn('[Settings] User account content element not found.');
        return;
    }

    try {
        const result = await browser.storage.local.get('userProfile');
        if (result.userProfile && result.userProfile.email) {
            renderLoggedInState(result.userProfile, accountContentEl);
        } else {
            renderLoggedOutState(accountContentEl);
        }
    } catch (error) {
        console.error('[Settings] Error loading user profile:', error);
        renderLoggedOutState(accountContentEl);
    }
}

/**
 * Renders the UI for a logged-in user.
 * @param {object} user - The user profile object.
 * @param {HTMLElement} container - The container element for the user account content.
 */
function renderLoggedInState(user, container) {
    const translations = getCurrentTranslations();
    container.innerHTML = `
        <div class="user-profile">
            <img src="${user.picture || '../magic.png'}" alt="User Avatar" class="user-avatar">
            <div class="user-details">
                <div class="user-name">${escapeHtml(user.name)}</div>
                <div class="user-email">${escapeHtml(user.email)}</div>
            </div>
        </div>
        <div class="setting-card-actions">
            <button id="logout-button" class="setting-action-btn delete-btn">
                ${_('logoutButton', {}, translations)}
            </button>
        </div>
    `;

    document.getElementById('logout-button').addEventListener('click', handleLogout);
}

/**
 * Renders the UI for a logged-out user.
 * @param {HTMLElement} container - The container element for the user account content.
 */
function renderLoggedOutState(container) {
    const translations = getCurrentTranslations();
    container.innerHTML = `
        <p class="setting-card-description">${_('loginDescription', {}, translations)}</p>
        <div class="setting-card-actions">
            <button id="google-login-button" class="setting-action-btn">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right: 8px;"><path fill-rule="evenodd" clip-rule="evenodd" d="M17.64 9.20455C17.64 8.56636 17.5827 7.95273 17.4764 7.36364H9V10.845h4.84364C13.6377 12.2273 12.5577 13.2714 11.1264 14.0932V16.2182H13.5682C14.9909 14.9386 16.0718 13.2273 16.8286 11.25H17.64V9.20455Z" fill="#4285F4"/><path fill-rule="evenodd" clip-rule="evenodd" d="M9 18C11.43 18 13.4673 17.1941 14.9909 15.9068L12.5573 14.0932C11.7455 14.6318 10.5655 15 9 15C6.65364 15 4.67182 13.4391 3.96455 11.475H1.42091V13.6C2.72182 16.0932 5.62818 18 9 18Z" fill="#34A853"/><path fill-rule="evenodd" clip-rule="evenodd" d="M3.96455 11.475C3.78455 10.9659 3.68182 10.4341 3.68182 9.88636C3.68182 9.33864 3.78455 8.80682 3.96455 8.29773V6.17273H1.42091C0.519545 7.84318 0 9.81682 0 12C0 14.1832 0.519545 16.1568 1.42091 17.8273L3.96455 15.525V11.475Z" fill="#FBBC05"/><path fill-rule="evenodd" clip-rule="evenodd" d="M9 3.68182C10.2255 3.68182 11.2864 4.125 12.1045 4.90682L15.0555 1.95682C13.4673 0.743182 11.43 0 9 0C5.62818 0 2.72182 1.90682 1.42091 4.37273L3.96455 6.49773C4.67182 4.53409 6.65364 3.68182 9 3.68182Z" fill="#EA4335"/></svg>
                ${_('loginWithGoogle', {}, translations)}
            </button>
        </div>
    `;

    document.getElementById('google-login-button').addEventListener('click', handleGoogleLogin);
}

/**
 * Handles the Google login process.
 */
function handleGoogleLogin() {
    const loginButton = document.getElementById('google-login-button');
    const translations = getCurrentTranslations();
    
    if (loginButton) {
        loginButton.disabled = true;
        loginButton.textContent = _('loggingIn', {}, translations);
    }

    browser.runtime.sendMessage({ action: "startGoogleAuth" }, async (response) => {
        if (browser.runtime.lastError) {
            console.error('[Settings] Login failed:', browser.runtime.lastError);
            if (window.showToastUI) window.showToastUI(_('loginError', { error: browser.runtime.lastError.message }, translations), 'error');
            renderLoggedOutState(document.getElementById('user-account-content')); // Restore button
            return;
        }

        if (response && response.success) {
            try {
                await browser.storage.local.set({ userProfile: response.user });
                if (window.showToastUI) window.showToastUI(_('loginSuccess', {}, translations), 'success');
                renderLoggedInState(response.user, document.getElementById('user-account-content'));
            } catch (error) {
                console.error('[Settings] Failed to save user profile:', error);
                if (window.showToastUI) window.showToastUI(_('loginError', { error: 'Failed to save profile.' }, translations), 'error');
                renderLoggedOutState(document.getElementById('user-account-content'));
            }
        } else {
            console.error('[Settings] Login failed:', response.error);
            if (window.showToastUI) window.showToastUI(_('loginError', { error: response.error }, translations), 'error');
            renderLoggedOutState(document.getElementById('user-account-content')); // Restore button
        }
    });
}

/**
 * Handles the logout process.
 */
async function handleLogout() {
    const translations = getCurrentTranslations();
    try {
        await browser.storage.local.remove('userProfile');
        // Also remove the token from the identity cache
        try {
            const tokenInfo = await browser.identity.getAuthToken({ interactive: false });
            if (tokenInfo && tokenInfo.token) {
                await browser.identity.removeCachedAuthToken({ token: tokenInfo.token });
            }
        } catch (e) {
            // This might fail if the user is already de-authorized, which is fine.
            console.warn('[Settings] Could not remove cached auth token during logout:', e.message);
        }
        if (window.showToastUI) window.showToastUI(_('logoutSuccess', {}, translations), 'success');
        renderLoggedOutState(document.getElementById('user-account-content'));
    } catch (error) {
        console.error('[Settings] Logout failed:', error);
        if (window.showToastUI) window.showToastUI(_('logoutError', { error: error.message }, translations), 'error');
    }
}

/**
 * Handles user profile changes
 * @param {object} state - Global state reference
 * @param {object} elements - DOM elements reference
 * @param {function} showToastCallback - Callback for showing toast messages
 * @param {object} currentTranslations - Current translations object
 */
export function handleUserProfileChange(state, elements, showToastCallback, currentTranslations) {
    const userName = elements.userNameInput.value.trim();
    const userAvatarFile = elements.userAvatarInput.files[0];

    state.userName = userName;

    // Save username to sync storage
    browser.storage.sync.set({ userName: userName }, () => {
        if (browser.runtime.lastError) {
            console.error("Error saving user name:", browser.runtime.lastError);
            showToastCallback(_('saveFailedToast', { error: browser.runtime.lastError.message }, currentTranslations), 'error');
        } else {
            console.log(`User name saved: ${userName}`);
            showToastCallback(_('userProfileSaved', {}, currentTranslations), 'success');
        }
    });

    const saveAvatar = (avatarData) => {
        state.userAvatar = avatarData;
        browser.storage.local.set({ userAvatar: avatarData }, () => {
            if (browser.runtime.lastError) {
                console.error("Error saving user avatar:", browser.runtime.lastError);
                showToastCallback(_('saveFailedToast', { error: browser.runtime.lastError.message }, currentTranslations), 'error');
            } else {
                console.log(`User avatar saved.`);
                const avatarPreview = document.getElementById('user-avatar-preview');
                if (avatarPreview) {
                    avatarPreview.src = avatarData;
                }
            }
        });
    };

    if (userAvatarFile) {
        const reader = new FileReader();
        reader.onload = (event) => {
            saveAvatar(event.target.result);
        };
        reader.readAsDataURL(userAvatarFile);
    } else {
        // If only the username is changed, no need to re-save the avatar
        // as it's already in local storage.
    }
}

function formatMcpServerSyncText(server) {
    if (!server?.lastSyncedAt) {
        return '尚未同步';
    }
    try {
        return `上次同步 ${new Date(server.lastSyncedAt).toLocaleString()}`;
    } catch (error) {
        return '上次同步时间未知';
    }
}

function buildEnhancedMcpServerListHtml(servers, selectedServerId) {
    if (!Array.isArray(servers) || servers.length === 0) {
        return '<div class="mcp-server-empty">当前还没有 MCP 服务</div>';
    }

    const escape = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    return servers.map((server) => {
        const isActive = server.id === selectedServerId;
        const statusClass = server.connected ? 'connected' : (server.lastError ? 'error' : 'idle');
        const statusLabel = server.connected ? '在线' : (server.lastError ? '异常' : '未连接');
        const syncText = formatMcpServerSyncText(server);
        const errorText = server.lastError
            ? `<div class="mcp-server-error">${escape(server.lastError)}</div>`
            : '';

        return `
            <button type="button" class="mcp-server-item ${isActive ? 'active' : ''}" data-server-id="${escape(server.id)}">
                <div class="mcp-server-item-head">
                    <span class="mcp-server-name">${escape(server.name)}</span>
                    <span class="mcp-server-status ${statusClass}">${statusLabel}</span>
                </div>
                <div class="mcp-server-item-meta">
                    <span>${escape(server.transport)}</span>
                    <span>工具 ${server.toolCount || 0}</span>
                    <span>资源 ${server.resourceCount || 0}</span>
                    <span>提示词 ${server.promptCount || 0}</span>
                    <span>${server.enabled === false ? '已禁用' : '已启用'}</span>
                </div>
                <div class="mcp-server-sync">${escape(syncText)}</div>
                ${errorText}
            </button>
        `;
    }).join('');
}

function buildEnhancedMcpMetaText(servers, selectedServerId, summary) {
    const selectedServer = Array.isArray(servers)
        ? servers.find((server) => server.id === selectedServerId)
        : null;

    if (selectedServer) {
        return [
            selectedServer.name,
            selectedServer.transport,
            selectedServer.enabled === false ? '已禁用' : '已启用',
            `工具 ${selectedServer.toolCount || 0}`,
            `资源 ${selectedServer.resourceCount || 0}`,
            `提示词 ${selectedServer.promptCount || 0}`,
            formatMcpServerSyncText(selectedServer)
        ].join(' · ');
    }

    return `已配置 ${Array.isArray(servers) ? servers.length : 0} 个 MCP 服务，工具 ${summary?.toolCount || 0} 个，资源 ${summary?.resourceCount || 0} 条，提示词 ${summary?.promptCount || 0} 个`;
}

async function refreshEnhancedMcpSettingsUi() {
    const host = document.getElementById('mcp-settings-host');
    if (!host) {
        return;
    }

    const serverList = host.querySelector('#mcp-server-list');
    const serverSelect = host.querySelector('#mcp-server-select');
    const meta = host.querySelector('#mcp-server-meta');
    if (!serverList || !serverSelect || !meta) {
        return;
    }

    const response = await browser.runtime.sendMessage({ action: 'mcp.getState' });
    if (!response?.success) {
        return;
    }

    const payload = response.data || {};
    const servers = Array.isArray(payload.servers) ? payload.servers : [];
    const selectedServerId = serverSelect.value || '';

    serverList.innerHTML = buildEnhancedMcpServerListHtml(servers, selectedServerId);
    meta.textContent = buildEnhancedMcpMetaText(servers, selectedServerId, payload);

    serverList.querySelectorAll('.mcp-server-item[data-server-id]').forEach((button) => {
        button.addEventListener('click', () => {
            serverSelect.value = button.dataset.serverId || '';
            serverSelect.dispatchEvent(new Event('change', { bubbles: true }));
            void refreshEnhancedMcpSettingsUi();
        });
    });
}

function enhanceMcpSettingsRuntime() {
    const host = document.getElementById('mcp-settings-host');
    if (!host || host.__mcpEnhancedRuntimeBound) {
        return;
    }

    host.__mcpEnhancedRuntimeBound = true;

    const refresh = () => {
        void refreshEnhancedMcpSettingsUi();
    };

    const serverSelect = host.querySelector('#mcp-server-select');
    const refreshBtn = host.querySelector('#mcp-refresh-tools-btn');
    const testBtn = host.querySelector('#mcp-test-btn');
    const saveBtn = host.querySelector('#mcp-save-btn');
    const removeBtn = host.querySelector('#mcp-remove-btn');

    serverSelect?.addEventListener('change', refresh);
    refreshBtn?.addEventListener('click', () => setTimeout(refresh, 150));
    testBtn?.addEventListener('click', () => setTimeout(refresh, 150));
    saveBtn?.addEventListener('click', () => setTimeout(refresh, 150));
    removeBtn?.addEventListener('click', () => setTimeout(refresh, 150));
    window.addEventListener('infinpilot:mcp-changed', refresh);

    if (host.__mcpEnhancedRefreshTimer) {
        clearInterval(host.__mcpEnhancedRefreshTimer);
    }
    host.__mcpEnhancedRefreshTimer = setInterval(() => {
        if (!document.hidden) {
            refresh();
        }
    }, 10000);

    refresh();
}

const initMcpSettingsRuntimeBase = initMcpSettingsRuntime;
initMcpSettingsRuntime = async function initMcpSettingsRuntimeEnhanced(...args) {
    await initMcpSettingsRuntimeBase(...args);
    enhanceMcpSettingsRuntime();
};
