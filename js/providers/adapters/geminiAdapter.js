/**
 * InfinPilot - Gemini API 适配器
 *
 * 处理 Google Gemini API 的请求格式转换和响应解析
 */

// 导入统一代理请求工具
import { makeProxyRequest } from '../../utils/proxyRequest.js';
import { getCurrentTranslations } from '../../utils/i18n.js';

// 从统一 i18n 工具获取翻译对象

/**
 * Gemini API 适配器
 * @param {Object} modelConfig - 模型配置 {apiModelName, params, providerId}
 * @param {Object} provider - 供应商配置
 * @param {Object} providerSettings - 供应商设置 {apiKey, apiHost}
 * @param {Array} messages - 标准化消息数组
 * @param {Function} streamCallback - 流式输出回调
 * @param {Object} options - 调用选项
 */
export async function geminiAdapter(modelConfig, provider, providerSettings, messages, streamCallback, options = {}) {
    const { apiKey } = providerSettings;
    const apiHost = providerSettings.apiHost || provider.apiHost;
    const { apiModelName, params } = modelConfig;
    
    // 转换消息格式为 Gemini 格式
    const contents = convertMessagesToGeminiFormat(messages);

    // Gemini API 要求 `contents` 字段为非空数组。
    // 在发送请求前增加此校验，可防止因传入空消息而导致的 API 错误。
    if (!contents || contents.length === 0) {
        // 如果没有有效内容可发送，则不应调用 API。
        // 这可能发生在输入 `messages` 数组为空，或只包含转换后为 null 的消息时。
        console.error('[GeminiAdapter] Aborting API call: `contents` array is empty. Input messages:', messages);
        throw new Error('Cannot call Gemini API with empty contents. Please provide at least one valid message.');
    }
    
    // 构建请求体
    const requestBody = {
        contents,
        generationConfig: {
            temperature: options.temperature || 0.7
        }
    };

    // 只有当用户明确设置了maxTokens且大于0时才添加该参数
    if (options.maxTokens && parseInt(options.maxTokens) > 0) {
        requestBody.generationConfig.maxOutputTokens = parseInt(options.maxTokens);
    }
    
    // 应用模型特定参数
    if (params?.generationConfig) {
        Object.assign(requestBody.generationConfig, params.generationConfig);
    }

    // Add tools if they exist in options
    if (options.tools) {
        const dict = (typeof getCurrentTranslations === 'function') ? getCurrentTranslations() : null;
        requestBody.tools = [{
            functionDeclarations: options.tools.map(tool => ({
                name: tool.name,
                description: (dict && dict[tool.description]) || tool.description,
                parameters: tool.inputSchema
            }))
        }];
    }
    
    // 添加系统指令（如果有）
    if (options.systemPrompt) {
        requestBody.systemInstruction = {
            parts: [{ text: options.systemPrompt }]
        };
    }
    
    // 构建 API URL
    const endpoint = `${apiHost}/v1beta/models/${apiModelName}:streamGenerateContent?key=${apiKey}&alt=sse`;
    
    try {
        const response = await makeProxyRequest(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: options.signal
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini API error: ${response.status} ${errorText}`);
        }
        
        // 处理流式响应
        return await processGeminiStreamResponse(response, streamCallback);
        
    } catch (error) {
        // 检查是否是用户主动中断的请求
        if (error.name === 'AbortError' || error instanceof DOMException) {
            console.log('[GeminiAdapter] Request aborted by user');
            // 重新抛出 AbortError，让上层处理
            const abortError = new Error('Request aborted');
            abortError.name = 'AbortError';
            throw abortError;
        }

        console.error('[GeminiAdapter] API call failed:', error);
        throw error;
    }
}

/**
 * 转换标准消息格式为 Gemini 格式
 * @param {Array} messages - 标准消息数组
 * @returns {Array} Gemini 格式的 contents 数组
 */
function convertMessagesToGeminiFormat(messages) {
    return messages.map(message => {
        if (message.role === 'tool') {
            // Pass tool responses through directly
            return {
                role: 'tool',
                parts: message.parts
            };
        }

        const role = message.role === 'assistant' ? 'model' : 'user';
        
        // Handle text content, ensuring it's not undefined
        const parts = message.content ? [{ text: message.content }] : [];
        
        // Handle images (if any)
        if (message.images && message.images.length > 0) {
            message.images.forEach(image => {
                parts.push({
                    inlineData: {
                        mimeType: image.mimeType,
                        data: image.dataUrl.split(',')[1] // Remove data:image/...;base64, prefix
                    }
                });
            });
        }
        
        // Ensure parts is not empty
        if (parts.length === 0) {
            // If there's no content and no images, we might need a default empty text part
            // depending on API requirements, but for now, we can skip the message
            // or return a part with empty text if the API requires it.
            // Let's assume we can't send a message with empty parts.
            return null;
        }

        return { role, parts };
    }).filter(Boolean); // Filter out any null messages
}

/**
 * 处理 Gemini 流式响应
 * @param {Response} response - Fetch 响应对象
 * @param {Function} streamCallback - 流式输出回调
 */
async function processGeminiStreamResponse(response, streamCallback) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedText = '';
    let toolCalls = []; // Changed from functionCalls to toolCalls

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const jsonStr = line.slice(6).trim();
                    if (jsonStr === '[DONE]') {
                        if (streamCallback) streamCallback('', true);
                        return { text: accumulatedText, toolCalls }; // Changed from functionCalls
                    }
                    if (!jsonStr) continue;

                    try {
                        const data = JSON.parse(jsonStr);
                        const parts = data.candidates?.[0]?.content?.parts;
                        if (!parts || !Array.isArray(parts)) continue;

                        for (const part of parts) {
                            if (part.text) {
                                let textToStream = part.text;
                                const toolCodeRegex = /<tool_code>([\s\S]*?)<\/tool_code>/g;
                                let match;

                                while ((match = toolCodeRegex.exec(part.text)) !== null) {
                                    const toolCodeContent = match[1].trim();
                                    textToStream = textToStream.replace(match[0], ''); // Remove the tool_code block

                                    try {
                                        const functionCallMatch = toolCodeContent.match(/^([a-zA-Z0-9_]+)\s*\(([\s\S]*)\)\s*$/);

                                        if (functionCallMatch) {
                                            const functionName = functionCallMatch[1];
                                            const argsString = functionCallMatch[2].trim();
                                            const args = argsString ? JSON.parse(argsString) : {};

                                            toolCalls.push({
                                                name: functionName,
                                                args: args
                                            });
                                        } else {
                                            console.warn('[GeminiAdapter] Could not parse tool code format:', toolCodeContent);
                                        }
                                    } catch (e) {
                                        console.error('[GeminiAdapter] Error parsing tool code arguments JSON:', e, 'Arguments string:', functionCallMatch ? functionCallMatch[2] : 'N/A');
                                    }
                                }

                                if (textToStream) {
                                    accumulatedText += textToStream;
                                    if (streamCallback) streamCallback(textToStream, false);
                                }
                            } else if (part.functionCall) {
                                if (part.functionCall.name && part.functionCall.args) {
                                    toolCalls.push(part.functionCall); // Changed from functionCalls
                                } else {
                                    console.warn('Ignoring malformed functionCall from API:', part.functionCall);
                                }
                            }
                        }
                    } catch (parseError) {
                        if (jsonStr.length > 10) {
                            console.debug('[GeminiAdapter] Failed to parse SSE data:', parseError.message, 'Data:', jsonStr.substring(0, 100));
                        }
                    }
                }
            }
        }

        if (buffer.trim()) {
            const line = buffer.trim();
            if (line.startsWith('data: ')) {
                const jsonStr = line.slice(6).trim();
                if (jsonStr && jsonStr !== '[DONE]') {
                    try {
                        const data = JSON.parse(jsonStr);
                        const part = data.candidates?.[0]?.content?.parts?.[0];
                        if (part?.text) {
                            const cleanedText = part.text.replace(/<tool_code>([\s\S]*?)<\/tool_code>/g, '');
                            if (cleanedText) {
                                accumulatedText += cleanedText;
                                if (streamCallback) streamCallback(cleanedText, false);
                            }
                        } else if (part?.functionCall) {
                            if (part.functionCall.name && part.functionCall.args) {
                                toolCalls.push(part.functionCall); // Changed from functionCalls
                            } else {
                                console.warn('Ignoring malformed functionCall from API:', part.functionCall);
                            }
                        }
                    } catch (parseError) {
                        console.debug('[GeminiAdapter] Failed to parse final SSE data:', parseError.message);
                    }
                }
            }
        }

        if (streamCallback) streamCallback('', true);
        return { text: accumulatedText, toolCalls }; // Changed from functionCalls
    } finally {
        reader.releaseLock();
    }
}

/**
 * 获取 Gemini 可用模型列表
 * @param {Object} provider - 供应商配置
 * @param {Object} providerSettings - 供应商设置
 * @returns {Promise<Array>} 模型列表
 */
export async function fetchGeminiModels(provider, providerSettings) {
    const { apiKey } = providerSettings;
    const apiHost = providerSettings.apiHost || provider.apiHost;
    
    try {
        const response = await makeProxyRequest(`${apiHost}/v1beta/models?key=${apiKey}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) {
            const currentTranslations = getCurrentTranslations();
            const errorMessage = currentTranslations['httpErrorGeneric']?.replace('{status}', response.status) || `HTTP error! status: ${response.status}`;
            throw new Error(errorMessage);
        }
        
        const data = await response.json();
        
        // 过滤出生成模型
        const generativeModels = data.models?.filter(model =>
            model.supportedGenerationMethods?.includes('generateContent')
        ) || [];
        
        // 转换为标准格式
        return generativeModels.map(model => {
            const modelName = model.name.replace('models/', '');
            return {
                id: modelName,
                displayName: model.displayName || modelName,
                apiModelName: modelName,
                providerId: provider.id,
                params: null,
                isAlias: false,
                isDefault: false,
                canDelete: true,
                description: model.description || '',
                inputTokenLimit: model.inputTokenLimit || null,
                outputTokenLimit: model.outputTokenLimit || null,
                supportedGenerationMethods: model.supportedGenerationMethods || []
            };
        });
        
    } catch (error) {
        console.error('[GeminiAdapter] Failed to fetch models:', error);
        throw error;
    }
}

/**
 * 测试 Gemini API Key 有效性
 * @param {Object} provider - 供应商配置
 * @param {Object} providerSettings - 供应商设置
 * @param {string} testModel - 测试用的模型名称
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testGeminiApiKey(provider, providerSettings, testModel = 'gemini-2.5-flash') {
    const { apiKey } = providerSettings;
    const apiHost = providerSettings.apiHost || provider.apiHost;

    // 确保 testModel 不为 null 或 undefined
    const actualTestModel = testModel || 'gemini-2.5-flash';

    try {
        const requestBody = {
            contents: [{
                parts: [{ text: 'Hello' }]
            }],
            generationConfig: {
                maxOutputTokens: 10
            }
        };
        
        const response = await makeProxyRequest(`${apiHost}/v1beta/models/${actualTestModel}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        if (response.ok) {
            // 获取当前翻译
            const currentTranslations = getCurrentTranslations();
            const message = currentTranslations['connectionTestSuccess'] || 'Connection established! API Key verified.';
            return { success: true, message };
        } else {
            const currentTranslations = getCurrentTranslations();
            const error = await response.json().catch(() => ({ error: { message: currentTranslations['httpErrorGeneric']?.replace('{status}', response.status) || `HTTP error ${response.status}` } }));
            const errorMessage = error.error?.message || currentTranslations['httpErrorGeneric']?.replace('{status}', response.status) || `HTTP error ${response.status}`;

            if (errorMessage.includes('API key not valid')) {
                return { success: false, message: currentTranslations['apiKeyNotValidError'] || 'Connection failed: API key not valid. Please check your key.' };
            }
            return { success: false, message: currentTranslations['connectionFailedGeneric']?.replace('{error}', errorMessage) || `Connection failed: ${errorMessage}` };
        }
    } catch (error) {
        console.error('[GeminiAdapter] API test error:', error);
        const currentTranslations = getCurrentTranslations();
        return { success: false, message: currentTranslations['connectionFailedGeneric']?.replace('{error}', error.message) || `Connection failed: ${error.message}` };
    }
}
