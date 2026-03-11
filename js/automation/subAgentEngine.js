// Deep Research - Sub Agent Engine
// 负责执行主 Agent 调用的子任务

try {
(function() {
    console.log('[SubAgentEngine] Script started loading...');

    // 信号量类 - 控制并发请求数量
    class Semaphore {
        constructor(concurrency) {
            this.concurrency = concurrency;
            this.running = 0;
            this.queue = [];
        }

        async acquire() {
            if (this.running < this.concurrency) {
                this.running++;
                return Promise.resolve();
            }

            return new Promise(resolve => {
                this.queue.push(resolve);
            });
        }

        release() {
            this.running--;
            if (this.queue.length > 0) {
                this.running++;
                const resolve = this.queue.shift();
                resolve();
            }
        }
    }

    class SubAgentEngine {
        constructor(availableTools, apiConfig, callbacks = {}) {
            this.availableTools = availableTools;
            this.endpoint = apiConfig.endpoint;
            this.apiKey = apiConfig.apiKey;
            this.model = apiConfig.model;
            this.sessions = new Map();

            // 不再使用共享 semaphore，每个 agent 独立执行
            // this.apiSemaphore = new Semaphore(10);

            // 回调函数：用于 UI 渲染和状态隔离
            this.onToolCall = callbacks.onToolCall || null;        // 工具调用时触发 (toolName, toolInput, toolId)
            this.onToolResult = callbacks.onToolResult || null;    // 工具结果返回时触发 (toolId, result)
            this.onSubAgentStart = callbacks.onSubAgentStart || null; // subAgent 开始时触发 (agentName, task)
            this.onSubAgentComplete = callbacks.onSubAgentComplete || null; // subAgent 完成时触发 (agentName, result)
            this.getIsolatedTab = callbacks.getIsolatedTab || null; // 获取隔离的浏览器标签页
            // 跟踪每个 subAgent 打开的标签页
            this.currentSubAgentTabs = []; // 当前 subAgent 打开的标签页
        }

        // 为每个 subAgent 创建独立的 API 客户端实例
        createAgentAPI() {
            return {
                endpoint: this.endpoint,
                apiKey: this.apiKey,
                model: this.model
            };
        }

        // 为每个 agent 创建独立的 semaphore
        createAgentSemaphore() {
            return new Semaphore(1); // 每个 agent 最多 1 个并发请求
        }

        // 获取工具描述列表
        createExecutionContext(index, config = null) {
            return {
                executionId: `subagent_${Date.now()}_${index}`,
                agentIndex: index,
                agentName: config?.agent_name || '',
                taskText: config?.task || '',
                currentTabId: null,
                tabStates: {},
                createdTabIds: [],
                adoptedTabIds: [],
                preserveTabIds: [],
                lastInteractedTabId: null,
                hasInteractiveBrowserActions: false,
                shouldPreserveCurrentTab: false,
                keepCollectiveSessionAlive: false,
                browserActionCount: 0,
                createdAt: Date.now()
            };
        }

        shouldPreserveTabs(executionContext, finalResult = null) {
            if (!executionContext) {
                return false;
            }
            if (executionContext.shouldPreserveCurrentTab || (executionContext.preserveTabIds || []).length > 0) {
                return true;
            }
            const combinedText = [
                executionContext.taskText || '',
                finalResult?.summary || '',
                finalResult?.findings || '',
                finalResult?.error || '',
                finalResult?.status || ''
            ].join(' ').toLowerCase();
            const keepKeywords = [
                'keep',
                'continue',
                'manual',
                'review',
                'inspect',
                'login',
                'otp',
                'password',
                'user',
                '保留',
                '继续',
                '手动',
                '查看',
                '登录',
                '验证码',
                '用户'
            ];
            return executionContext.hasInteractiveBrowserActions
                && keepKeywords.some((keyword) => combinedText.includes(keyword));
        }

        getToolDescriptions(tools) {
            // 如果没有传递 tools 参数，直接返回空字符串
            // 防止 fallback 到所有工具
            if (!tools || !Array.isArray(tools)) {
                console.error('[SubAgentEngine] ERROR: getToolDescriptions called without tools parameter!');
                return '- (无可用工具)';
            }
            console.log('[SubAgentEngine] getToolDescriptions - using tools count:', tools.length);
            return tools.map(tool =>
                `- ${tool.name}: ${tool.description}`
            ).join('\n');
        }

        // 过滤可用工具
        filterTools(visibleToolNames) {
            // 始终禁止 sub-agents 使用这些工具来创建更多 sub-agents
            const blockedTools = ['invoke_sub_agents', 'invoke_sub_agent'];
            let filtered = this.availableTools;

            // 首先过滤可见工具
            if (visibleToolNames && visibleToolNames.length > 0) {
                filtered = filtered.filter(tool => visibleToolNames.includes(tool.name));
            }

            // 移除被阻止的工具（防止 sub-agents 递归创建更多 agents）
            filtered = filtered.filter(tool => !blockedTools.includes(tool.name));

            console.log('[SubAgentEngine] Filtered tools:', {
                originalCount: this.availableTools.length,
                afterFilter: filtered.length,
                visibleTools: visibleToolNames,
                blockedTools: blockedTools
            });

            return filtered;
        }

        // 构建 Sub Agent System Prompt
        buildSubAgentSystemPrompt(agentName, context, filteredTools) {
            console.log('[SubAgentEngine] buildSubAgentSystemPrompt - filteredTools count:', filteredTools?.length);
            console.log('[SubAgentEngine] buildSubAgentSystemPrompt - filteredTools names:', filteredTools?.map(t => t.name));

            return `你是 ${agentName}，一个专业的子任务执行 Agent。

${context ? `上下文信息：\n${context}\n` : ''}

你的任务是按照主 Agent 分配的任务描述执行工作。
使用分配给你的工具完成任务，并在完成后汇报结果。

## 可用工具（只限于这些）：
${this.getToolDescriptions(filteredTools)}

## 重要约束
- 只能使用上述列表中的工具
- 你必须使用工具来收集信息，不能只是口头说要做什么
- **在使用完工具并获得结果后，你必须立即输出结果格式，不要继续调用更多工具**
- 不要在输出结果之前说"让我继续搜索"之类的话

## 输出格式（必须遵守）
完成信息收集后，请立即按以下格式输出结果，不要添加任何其他内容：
[SUB_AGENT_RESULT]
{
  "status": "success",
  "findings": "你发现的关键信息（详细描述）",
  "sources": ["使用的来源 URL"],
  "summary": "简要总结（不超过50字）"
}
[/SUB_AGENT_RESULT]

注意：一旦你收集到了足够的信息，必须立即输出上述格式的结果，不要再调用更多工具！`;
        }

        // 解析 Sub Agent 结果
        parseSubAgentResult(text) {
            const regex = /\[SUB_AGENT_RESULT\]([\s\S]*?)\[\/SUB_AGENT_RESULT\]/;
            const match = text.match(regex);
            if (match) {
                try {
                    return JSON.parse(match[1]);
                } catch (e) {
                    console.warn('[SubAgentEngine] Failed to parse result JSON:', e);
                    return { status: 'unknown', findings: text, summary: '解析失败' };
                }
            }
            // 如果没有找到标记格式，尝试返回整个文本
            return { status: 'success', findings: text, sources: [], summary: text.slice(0, 200) };
        }

        // 执行单个 Sub Agent
        // executionContext: 用于并行执行时的状态隔离（包含 isolatedTabId）
        // agentIndex: 当前 agent 的索引（用于日志区分）
        async executeSubAgent(config, mainAgentMessages, executionContext = null, agentIndex = 0) {
            const { agent_name, task, visible_tools, context } = config;
            const startTime = Date.now();

            console.log(`[SubAgentEngine][${startTime}] >>> Starting sub agent[${agentIndex}]:`, agent_name);

            // 初始化当前 subAgent 的标签页列表
            if (executionContext) {
                executionContext.agentIndex = agentIndex;
                executionContext.agentName = agent_name;
                executionContext.taskText = task || '';
            } else {
                this.currentSubAgentTabs = [];
            }

            // 触发 subAgent 开始回调（传递 agentIndex 用于区分同名 agent）
            if (this.onSubAgentStart) {
                try {
                    this.onSubAgentStart(agent_name, task, agentIndex);
                } catch (e) {
                    console.warn('[SubAgentEngine] onSubAgentStart callback error:', e);
                }
            }

            // 1. 过滤工具
            const filteredTools = this.filterTools(visible_tools);

            if (filteredTools.length === 0) {
                // 触发完成回调
                if (this.onSubAgentComplete) {
                    try {
                        this.onSubAgentComplete(agent_name, { status: 'failed', error: '没有可用的工具' }, agentIndex);
                    } catch (e) {
                        console.warn('[SubAgentEngine] onSubAgentComplete callback error:', e);
                    }
                }
                return {
                    agent_name,
                    status: 'failed',
                    error: '没有可用的工具',
                    findings: '',
                    sources: [],
                    summary: '工具列表为空'
                };
            }

            // 2. 构建 Sub Agent 消息
            // 确保消息格式正确
            const messages = [
                {
                    role: 'system',
                    content: this.buildSubAgentSystemPrompt(agent_name, context, filteredTools)
                },
                ...mainAgentMessages.slice(-4), // 只取最近几条历史消息，避免上下文过长
                { role: 'user', content: task }
            ];

            console.log('[SubAgentEngine] Messages:', JSON.stringify(messages, null, 2));

            // 3. 执行 Agent 循环（传递 executionContext 以确保并行隔离）
            // 为每个 subAgent 创建独立的 API 客户端实例，避免浏览器连接池限制
            const agentAPI = this.createAgentAPI();
            let result = null;
            let finalResult = null;
            try {
                result = await this.runAgentLoop(messages, filteredTools, agent_name, executionContext, agentAPI, agentIndex);
                const parsed = this.parseSubAgentResult(result.text);

                finalResult = {
                    agent_name,
                    status: parsed.status || 'success',
                    findings: parsed.findings || result.text,
                    sources: parsed.sources || [],
                    summary: parsed.summary || result.text.slice(0, 200),
                    rawResponse: result.text
                };

                // 触发完成回调
                if (this.onSubAgentComplete) {
                    try {
                        this.onSubAgentComplete(agent_name, finalResult, agentIndex);
                    } catch (e) {
                        console.warn('[SubAgentEngine] onSubAgentComplete callback error:', e);
                    }
                }

                return finalResult;
            } catch (error) {
                console.error('[SubAgentEngine] Sub agent execution error:', error);
                finalResult = {
                    agent_name,
                    status: 'failed',
                    error: error.message,
                    findings: '',
                    sources: [],
                    summary: '执行失败: ' + error.message
                };

                // 触发完成回调
                if (this.onSubAgentComplete) {
                    try {
                        this.onSubAgentComplete(agent_name, finalResult, agentIndex);
                    } catch (e) {
                        console.warn('[SubAgentEngine] onSubAgentComplete callback error:', e);
                    }
                }

                return finalResult;
            } finally {
                // 清理：关闭当前 subAgent 打开的所有标签页（除了隔离标签页）
                await this.closeSubAgentTabs(executionContext, finalResult);
            }
        }

        // 关闭当前 subAgent 打开的所有标签页
        async closeSubAgentTabs(executionContext = null, finalResult = null) {
            if (!executionContext) {
                const tabsToClose = this.currentSubAgentTabs.filter(tabId => tabId);
                console.log('[SubAgentEngine] Closing legacy subAgent tabs:', tabsToClose);
                for (const tabId of tabsToClose) {
                    try {
                        if (browser && browser.tabs) {
                            await browser.tabs.remove(tabId);
                        }
                    } catch (e) {
                        console.warn('[SubAgentEngine] Failed to close legacy tab:', tabId, e);
                    }
                }
                this.currentSubAgentTabs = [];
                return;
            }

            if (executionContext.keepCollectiveSessionAlive === true) {
                return;
            }

            const createdTabIds = Array.isArray(executionContext.createdTabIds) ? executionContext.createdTabIds.filter(Boolean) : [];
            const tabsToKeep = new Set(Array.isArray(executionContext.preserveTabIds) ? executionContext.preserveTabIds : []);
            if (this.shouldPreserveTabs(executionContext, finalResult)) {
                const keepTabId = executionContext.currentTabId || executionContext.lastInteractedTabId;
                if (keepTabId) {
                    tabsToKeep.add(keepTabId);
                }
            }

            const tabsToClose = createdTabIds.filter((tabId) => !tabsToKeep.has(tabId));
            console.log('[SubAgentEngine] Closing subAgent tabs:', tabsToClose, 'keeping:', Array.from(tabsToKeep));

            for (const tabId of tabsToClose) {
                try {
                    if (browser && browser.tabs) {
                        await browser.tabs.remove(tabId);
                        console.log('[SubAgentEngine] Closed tab:', tabId);
                    }
                } catch (e) {
                    console.warn('[SubAgentEngine] Failed to close tab:', tabId, e);
                }
            }

            executionContext.createdTabIds = createdTabIds.filter((tabId) => tabsToKeep.has(tabId));
            executionContext.preserveTabIds = Array.from(tabsToKeep);
        }

        // 记录 subAgent 打开的标签页
        trackSubAgentTab(tabId, executionContext = null, metadata = {}) {
            if (!tabId) {
                return;
            }
            if (!executionContext) {
                if (!this.currentSubAgentTabs.includes(tabId)) {
                    this.currentSubAgentTabs.push(tabId);
                    console.log('[SubAgentEngine] Tracked legacy subAgent tab:', tabId, 'Total:', this.currentSubAgentTabs.length);
                }
                return;
            }

            executionContext.tabStates = executionContext.tabStates || {};
            executionContext.createdTabIds = Array.isArray(executionContext.createdTabIds) ? executionContext.createdTabIds : [];
            executionContext.adoptedTabIds = Array.isArray(executionContext.adoptedTabIds) ? executionContext.adoptedTabIds : [];
            executionContext.preserveTabIds = Array.isArray(executionContext.preserveTabIds) ? executionContext.preserveTabIds : [];

            const currentState = executionContext.tabStates[tabId] || {
                tabId,
                createdBySubAgent: false,
                adopted: false,
                keepOpen: false,
                interacted: false,
                lastUsedAt: 0
            };
            const nextState = {
                ...currentState,
                ...metadata,
                tabId,
                createdBySubAgent: currentState.createdBySubAgent || metadata.createdBySubAgent === true,
                adopted: currentState.adopted || metadata.adopted === true,
                keepOpen: currentState.keepOpen || metadata.keepOpen === true,
                interacted: currentState.interacted || metadata.interacted === true,
                lastUsedAt: Date.now()
            };
            executionContext.tabStates[tabId] = nextState;

            if (nextState.createdBySubAgent && !executionContext.createdTabIds.includes(tabId)) {
                executionContext.createdTabIds.push(tabId);
            }
            if (nextState.adopted && !executionContext.adoptedTabIds.includes(tabId)) {
                executionContext.adoptedTabIds.push(tabId);
            }
            if (nextState.keepOpen && !executionContext.preserveTabIds.includes(tabId)) {
                executionContext.preserveTabIds.push(tabId);
            }
            if (metadata.setCurrent === true || !executionContext.currentTabId) {
                executionContext.currentTabId = tabId;
            }
            if (nextState.interacted) {
                executionContext.lastInteractedTabId = tabId;
                executionContext.hasInteractiveBrowserActions = true;
            }
            console.log('[SubAgentEngine] Tracked subAgent tab:', tabId, 'context:', executionContext.executionId);
        }

        // 并行执行多个 Sub Agents
        // 执行单个 agent 的辅助方法
        async executeSingleAgent(config, mainAgentMessages, context) {
            return this.executeSubAgent(config, mainAgentMessages, context);
        }

        // 按依赖顺序执行 agents
        async executeSubAgentsByDependency(agents, mainAgentMessages) {
            const startTime = Date.now();
            console.log('[SubAgentEngine] ===== EXECUTION WITH DEPENDENCIES =====', agents.length, 'sub agents');

            // 分析每个 agent 的依赖
            agents.forEach((a, i) => {
                console.log(`[SubAgentEngine] Agent ${i}: ${a.task?.substring(0, 30)}... depends_on:`, a.depends_on);
            });

            // 为每个 subAgent 创建独立的执行上下文
            const executionContexts = new Map();

            // 为每个 subAgent 创建执行上下文
            const createExecutionContext = async (index) => {
                const executionId = `subagent_${Date.now()}_${index}`;
                let isolatedTabId = null;

                try {
                    if (browser && browser.tabs) {
                        const tab = await browser.tabs.create({
                            url: 'about:blank',
                            active: false
                        });
                        isolatedTabId = tab.id;
                        console.log(`[SubAgentEngine][${Date.now() - startTime}ms] Created isolated tab:`, isolatedTabId, 'for', executionId);
                    }
                } catch (e) {
                    console.warn('[SubAgentEngine] Failed to create isolated tab:', e);
                }

                return { executionId, isolatedTabId, createdAt: Date.now() };
            };

            // 创建所有执行上下文
            for (let i = 0; i < agents.length; i++) {
                const ctx = this.createExecutionContext(i, agents[i]);
                executionContexts.set(i, ctx);
            }

            // 跟踪每个 agent 的状态和结果
            const agentResults = new Map();
            const completedAgents = new Set();

            // 递归执行函数 - 支持依赖
            const executeWithDependencies = async (agentIndex) => {
                if (completedAgents.has(agentIndex)) {
                    return agentResults.get(agentIndex);
                }

                const agent = agents[agentIndex];
                const dependencies = agent.depends_on || [];

                // 先执行所有依赖
                for (const depIndex of dependencies) {
                    if (depIndex < agents.length && !completedAgents.has(depIndex)) {
                        console.log(`[SubAgentEngine][${Date.now() - startTime}ms] Agent ${agentIndex} waiting for dependency: ${depIndex}`);
                        await executeWithDependencies(depIndex);
                    }
                }

                // 检查依赖是否都已完成
                for (const depIndex of dependencies) {
                    if (!completedAgents.has(depIndex)) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }

                // 构建依赖结果摘要，传递给当前 agent
                let dependencyContext = '';
                if (dependencies.length > 0) {
                    dependencyContext = '\n\n## 依赖任务已完成的结果：\n';
                    for (const depIndex of dependencies) {
                        const depResult = agentResults.get(depIndex);
                        const depAgent = agents[depIndex];
                        if (depResult) {
                            dependencyContext += `\n【任务 ${depIndex + 1}】${depAgent?.task?.substring(0, 50)}...\n`;
                            dependencyContext += `结果：${depResult.summary || depResult.findings?.substring(0, 200) || '无结果'}\n`;
                            dependencyContext += `来源：${(depResult.sources || []).join(', ')}\n`;
                        }
                    }
                }

                // 执行当前 agent（合并依赖结果到 context）
                const context = executionContexts.get(agentIndex);
                const agentConfig = {
                    ...agent,
                    // 如果有依赖结果，合并到 context 中
                    context: (agent.context || '') + dependencyContext
                };

                console.log(`[SubAgentEngine][${Date.now() - startTime}ms] >>> Executing agent ${agentIndex}: ${agent.task?.substring(0, 30)}... (depends on: ${dependencies.join(', ')})`);

                const result = await this.executeSingleAgent(agentConfig, mainAgentMessages, context);
                completedAgents.add(agentIndex);
                agentResults.set(agentIndex, result);

                return result;
            };

            // 检查是否有依赖关系
            const hasDependencies = agents.some(a => a.depends_on && a.depends_on.length > 0);

            let results;
            if (hasDependencies) {
                // 有依赖，按依赖顺序执行
                console.log('[SubAgentEngine] Executing with dependency ordering...');
                results = [];
                for (let i = 0; i < agents.length; i++) {
                    const result = await executeWithDependencies(i);
                    results.push(result);
                }
            } else {
                // 无依赖，全部并行执行
                console.log('[SubAgentEngine] No dependencies - executing all in parallel...');
                const executionPromises = agents.map((config, index) => {
                    const context = executionContexts.get(index);
                    return this.executeSingleAgent(config, mainAgentMessages, context).then(result => {
                        console.log(`[SubAgentEngine][${Date.now() - startTime}ms] >>> Agent ${index} completed`);
                        return result;
                    });
                });
                results = await Promise.all(executionPromises);
            }

            // 清理标签页
            for (const [index, context] of executionContexts) {
                if (context.isolatedTabId) {
                    try {
                        await browser.tabs.remove(context.isolatedTabId);
                    } catch (e) {
                        console.warn('[SubAgentEngine] Failed to close isolated tab:', e);
                    }
                }
            }

            console.log(`[SubAgentEngine][${Date.now() - startTime}ms] ===== ALL AGENTS COMPLETED =====`);
            return results;
        }

        async executeSubAgentsParallel(agents, mainAgentMessages) {
            const startTime = Date.now();
            console.log('[SubAgentEngine] ===== PARALLEL EXECUTION START =====', agents.length, 'sub agents');
            agents.forEach((a, i) => console.log(`[SubAgentEngine] Agent ${i}:`, a.agent_name, 'depends_on:', a.depends_on));

            // 检查是否有依赖关系
            const hasDependencies = agents.some(a => a.depends_on && a.depends_on.length > 0);

            if (hasDependencies) {
                console.log('[SubAgentEngine] Using dependency-based execution...');
                return this.executeSubAgentsByDependency(agents, mainAgentMessages);
            }

            // 无依赖，全部并行执行
            // 为每个 subAgent 创建独立的执行上下文
            const executionContexts = new Map();

            // 为每个 subAgent 创建执行上下文（独立的浏览器标签页）
            const createExecutionContext = async (index) => {
                const executionId = `subagent_${Date.now()}_${index}`;
                let isolatedTabId = null;

                // 创建独立的浏览器标签页（用于需要浏览器上下文的工具）
                try {
                    if (browser && browser.tabs) {
                        const tab = await browser.tabs.create({
                            url: 'about:blank',
                            active: false
                        });
                        isolatedTabId = tab.id;
                        console.log(`[SubAgentEngine][${Date.now() - startTime}ms] Created isolated tab:`, isolatedTabId, 'for', executionId);
                    }
                } catch (e) {
                    console.warn('[SubAgentEngine] Failed to create isolated tab:', e);
                }

                return {
                    executionId,
                    isolatedTabId,
                    createdAt: Date.now()
                };
            };

            console.log(`[SubAgentEngine][${Date.now() - startTime}ms] Creating execution contexts...`);

            // 为每个 agent 创建执行上下文
            const contextPromises = agents.map((config, index) => Promise.resolve(this.createExecutionContext(index, config)));
            const contexts = await Promise.all(contextPromises);

            console.log(`[SubAgentEngine][${Date.now() - startTime}ms] All contexts created, starting parallel execution...`);

            // 将执行上下文存储到 Map 中
            contexts.forEach((ctx, index) => {
                executionContexts.set(index, ctx);
            });

            // 执行 subAgents，传递执行上下文 - 使用 Promise.all 并行执行
            console.log(`[SubAgentEngine][${Date.now() - startTime}ms] >>> DISPATCHING all agents in parallel...`);
            
            const dispatchTime = Date.now();
            const executionPromises = agents.map((config, index) => {
                const context = executionContexts.get(index);
                const agentId = context.executionId;
                // 立即打印日志显示已经开始
                console.log(`[SubAgentEngine][${dispatchTime - startTime}ms] >>> Agent[${index}] ${config.agent_name} (${agentId}) DISPATCHED at ${Date.now() - dispatchTime}ms after dispatch`);
                // 捕获执行时间
                return this.executeSubAgent(config, mainAgentMessages, context, index).then(result => {
                    console.log(`[SubAgentEngine][${Date.now() - startTime}ms] >>> Agent[${index}] ${config.agent_name} (${agentId}) COMPLETED`);
                    return result;
                });
            });

            console.log(`[SubAgentEngine][${Date.now() - startTime}ms] All ${agents.length} agents dispatched with Promise.all, waiting for all to complete...`);

            const startParallel = Date.now();
            const results = await Promise.all(executionPromises);
            const parallelTime = Date.now() - startParallel;

            console.log(`[SubAgentEngine][${Date.now() - startTime}ms] Promise.all resolved in ${parallelTime}ms`);

            console.log(`[SubAgentEngine][${Date.now() - startTime}ms] ===== ALL AGENTS COMPLETED =====`);

            // 清理：关闭为 subAgents 创建的独立标签页
            for (const [index, context] of executionContexts) {
                if (context.isolatedTabId) {
                    try {
                        await browser.tabs.remove(context.isolatedTabId);
                        console.log('[SubAgentEngine] Closed isolated tab:', context.isolatedTabId);
                    } catch (e) {
                        console.warn('[SubAgentEngine] Failed to close isolated tab:', e);
                    }
                }
            }

            return results;
        }

        // Agent 执行循环
        // agentAPI: 每个 subAgent 独立的 API 配置
        // agentIndex: 用于日志区分
        async runAgentLoopLegacy(messages, tools, agentName, executionContext, agentAPI, agentIndex = 0) {
            const maxIterations = 50;
            let iterations = 0;
            let currentMessages = [...messages];
            let finalText = '';
            const agentId = executionContext?.executionId || 'unknown';

            // 使用独立的 API 配置
            const endpoint = agentAPI.endpoint;
            const apiKey = agentAPI.apiKey;
            const model = agentAPI.model;

            console.log(`[SubAgentEngine][${Date.now()}] >>> Agent[${agentIndex}] "${agentName}" (${agentId}) ENTERED runAgentLoop with independent API`);

            // 不使用信号量限制，允许完全并行调用 API
            // const agentSemaphore = new Semaphore(1);

            while (iterations < maxIterations) {
                iterations++;
                const loopStartTime = Date.now();

                console.log(`[SubAgentEngine][${loopStartTime}] Agent[${agentIndex}] "${agentName}" (${agentId}) - API Request START (iteration ${iterations}):`, {
                    messagesCount: currentMessages.length,
                    toolsCount: tools.length
                });

                const requestBody = {
                    model: model,
                    max_tokens: 4096,
                    messages: currentMessages,
                    tools: tools
                };

                const apiRequestStart = Date.now();
                console.log(`[SubAgentEngine][${apiRequestStart}] >>> ${agentId} sending API request (iteration ${iterations})`);

                let response;
                try {
                    response = await fetch(`${endpoint}/v1/messages`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': apiKey,
                            'anthropic-version': '2023-06-01'
                        },
                        body: JSON.stringify(requestBody)
                    });

                    const apiResponseTime = Date.now();
                    console.log(`[SubAgentEngine][${apiResponseTime}] <<< ${agentId} received API response after ${apiResponseTime - apiRequestStart}ms`);

                    if (!response.ok) {
                        const errorText = await response.text();
                        console.error('[SubAgentEngine] API Error:', response.status, errorText);
                        throw new Error(`API error: ${response.status} - ${errorText}`);
                    }
                } catch (e) {
                    console.error('[SubAgentEngine] API request failed:', e);
                    throw e;
                }

                const data = await response.json();
                console.log('[SubAgentEngine] API Response:', JSON.stringify(data));
                const content = data.content || [];

                // 首先触发所有工具调用回调（不等待执行完成）
                const toolCalls = [];
                for (const block of content) {
                    if (block.type === 'text') {
                        finalText += block.text;
                        currentMessages.push({ role: 'assistant', content: block.text });
                    } else if (block.type === 'tool_use') {
                        // Sub Agent 调用工具 - 收集但不立即执行
                        const toolName = block.name;
                        const toolInput = block.input;
                        const toolId = block.id;

                        console.log(`[SubAgentEngine][${Date.now()}] Agent "${agentName}" calling tool:`, toolName, 'id:', toolId);

                        toolCalls.push({ toolName, toolInput, toolId, block });
                    }
                }

                // 如果有工具调用，使用 Promise.all 并行执行它们
                if (toolCalls.length > 0) {
                    // 触发所有工具调用的回调（UI渲染）
                    for (const tc of toolCalls) {
                        if (this.onToolCall) {
                            try {
                                this.onToolCall(tc.toolName, tc.toolInput, tc.toolId, agentIndex);
                            } catch (e) {
                                console.warn('[SubAgentEngine] onToolCall callback error:', e);
                            }
                        }
                    }

                    // 并行执行所有工具
                    const toolExecutionStart = Date.now();
                    console.log(`[SubAgentEngine][${toolExecutionStart}] Agent "${agentName}" executing ${toolCalls.length} tools in PARALLEL`);
                    const toolResults = await Promise.all(
                        toolCalls.map(async (tc, idx) => {
                            const individualStart = Date.now();
                            let toolResult;
                            if (window.executeBrowserTool) {
                                toolResult = await window.executeBrowserTool(tc.toolName, tc.toolInput, executionContext);
                            } else {
                                toolResult = { error: '工具执行函数未定义' };
                            }
                            console.log(`[SubAgentEngine][${Date.now()}] Agent "${agentName}" tool ${idx + 1}/${toolCalls.length} (${tc.toolName}) completed in ${Date.now() - individualStart}ms`);
                            return { toolId: tc.toolId, toolResult, block: tc.block };
                        })
                    );
                    console.log(`[SubAgentEngine][${Date.now()}] Agent "${agentName}" all ${toolCalls.length} tools completed in ${Date.now() - toolExecutionStart}ms (PARALLEL)`);

                    // 触发所有工具结果回调
                    for (const tr of toolResults) {
                        if (this.onToolResult) {
                            try {
                                this.onToolResult(tr.toolId, tr.toolResult, agentIndex);
                            } catch (e) {
                                console.warn('[SubAgentEngine] onToolResult callback error:', e);
                            }
                        }

                        // 将工具结果添加到消息
                        const toolResultContent = typeof tr.toolResult === 'string'
                            ? tr.toolResult
                            : JSON.stringify(tr.toolResult);

                        const assistantMessage = {
                            role: 'assistant',
                            content: [tr.block]
                        };
                        currentMessages.push(assistantMessage);

                        const toolResultMessage = {
                            role: 'user',
                            content: [
                                {
                                    type: 'tool_result',
                                    tool_use_id: tr.block.id,
                                    content: toolResultContent
                                }
                            ]
                        };

                        console.log('[SubAgentEngine] Adding tool result message:', JSON.stringify(toolResultMessage));
                        currentMessages.push(toolResultMessage);
                    }
                }

                // 检查是否需要继续
                const stopReason = data.stop_reason;
                if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
                    break;
                }
            }

            return { text: finalText, iterations };
        }

        async runAgentLoop(messages, tools, agentName, executionContext, agentAPI, agentIndex = 0) {
            const maxIterations = 50;
            let iterations = 0;
            let currentMessages = [...messages];
            let finalText = '';
            const agentId = executionContext?.executionId || 'unknown';
            const endpoint = agentAPI.endpoint;
            const apiKey = agentAPI.apiKey;
            const model = agentAPI.model;

            console.log(`[SubAgentEngine][${Date.now()}] >>> Agent[${agentIndex}] "${agentName}" (${agentId}) ENTERED runAgentLoop with ordered tool execution`);

            while (iterations < maxIterations) {
                iterations++;
                const loopStartTime = Date.now();

                console.log(`[SubAgentEngine][${loopStartTime}] Agent[${agentIndex}] "${agentName}" (${agentId}) - API Request START (iteration ${iterations}):`, {
                    messagesCount: currentMessages.length,
                    toolsCount: tools.length
                });

                const requestBody = {
                    model,
                    max_tokens: 4096,
                    messages: currentMessages,
                    tools
                };

                const apiRequestStart = Date.now();
                console.log(`[SubAgentEngine][${apiRequestStart}] >>> ${agentId} sending API request (iteration ${iterations})`);

                let response;
                try {
                    response = await fetch(`${endpoint}/v1/messages`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': apiKey,
                            'anthropic-version': '2023-06-01'
                        },
                        body: JSON.stringify(requestBody)
                    });

                    const apiResponseTime = Date.now();
                    console.log(`[SubAgentEngine][${apiResponseTime}] <<< ${agentId} received API response after ${apiResponseTime - apiRequestStart}ms`);

                    if (!response.ok) {
                        const errorText = await response.text();
                        console.error('[SubAgentEngine] API Error:', response.status, errorText);
                        throw new Error(`API error: ${response.status} - ${errorText}`);
                    }
                } catch (e) {
                    console.error('[SubAgentEngine] API request failed:', e);
                    throw e;
                }

                const data = await response.json();
                console.log('[SubAgentEngine] API Response:', JSON.stringify(data));
                const content = data.content || [];
                const toolCalls = [];

                for (const block of content) {
                    if (block.type === 'text') {
                        finalText += block.text;
                        currentMessages.push({ role: 'assistant', content: block.text });
                    } else if (block.type === 'tool_use') {
                        const toolName = block.name;
                        const toolInput = block.input;
                        const toolId = block.id;
                        console.log(`[SubAgentEngine][${Date.now()}] Agent "${agentName}" calling tool:`, toolName, 'id:', toolId);
                        toolCalls.push({ toolName, toolInput, toolId, block });
                    }
                }

                if (toolCalls.length > 0) {
                    for (const tc of toolCalls) {
                        if (this.onToolCall) {
                            try {
                                this.onToolCall(tc.toolName, tc.toolInput, tc.toolId, agentIndex);
                            } catch (e) {
                                console.warn('[SubAgentEngine] onToolCall callback error:', e);
                            }
                        }
                    }

                    const toolExecutionStart = Date.now();
                    console.log(`[SubAgentEngine][${toolExecutionStart}] Agent "${agentName}" executing ${toolCalls.length} tools in SEQUENCE`);
                    const toolResults = [];

                    for (let idx = 0; idx < toolCalls.length; idx++) {
                        const tc = toolCalls[idx];
                        const individualStart = Date.now();
                        let toolResult;
                        if (window.executeBrowserTool) {
                            toolResult = await window.executeBrowserTool(tc.toolName, tc.toolInput, executionContext);
                        } else {
                            toolResult = { error: '工具执行函数未定义' };
                        }
                        console.log(`[SubAgentEngine][${Date.now()}] Agent "${agentName}" tool ${idx + 1}/${toolCalls.length} (${tc.toolName}) completed in ${Date.now() - individualStart}ms`);
                        toolResults.push({ toolId: tc.toolId, toolResult, block: tc.block });
                    }

                    console.log(`[SubAgentEngine][${Date.now()}] Agent "${agentName}" all ${toolCalls.length} tools completed in ${Date.now() - toolExecutionStart}ms (SEQUENCE)`);

                    for (const tr of toolResults) {
                        if (this.onToolResult) {
                            try {
                                this.onToolResult(tr.toolId, tr.toolResult, agentIndex);
                            } catch (e) {
                                console.warn('[SubAgentEngine] onToolResult callback error:', e);
                            }
                        }

                        const toolResultContent = typeof tr.toolResult === 'string'
                            ? tr.toolResult
                            : JSON.stringify(tr.toolResult);

                        currentMessages.push({
                            role: 'assistant',
                            content: [tr.block]
                        });

                        const toolResultMessage = {
                            role: 'user',
                            content: [
                                {
                                    type: 'tool_result',
                                    tool_use_id: tr.block.id,
                                    content: toolResultContent
                                }
                            ]
                        };

                        console.log('[SubAgentEngine] Adding tool result message:', JSON.stringify(toolResultMessage));
                        currentMessages.push(toolResultMessage);
                    }
                }

                const stopReason = data.stop_reason;
                if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
                    break;
                }
            }

            return { text: finalText, iterations };
        }
    }

    // 导出到全局
    SubAgentEngine.prototype.buildCollectiveAgentPrompt = function(role, mission, blackboardSnapshot, filteredTools, sharedContext = '') {
        const blackboardLines = (blackboardSnapshot?.entries || [])
            .slice(-10)
            .map((entry) => `[${entry.entryType}] ${entry.role}: ${entry.content}`)
            .join('\n');

        return `你现在是群体研究模式中的一名研究员。

## 你的角色
- 名称：${role?.name || '研究员'}
- 职责：${role?.description || '围绕主题进行协作研究'}

${sharedContext ? `## 共享上下文\n${sharedContext}\n` : ''}

## 当前黑板
${blackboardLines || '黑板还没有内容，请先贡献第一条高价值信息。'}

## 本轮任务
${mission}

## 可用工具
${this.getToolDescriptions(filteredTools)}

## 规则
- 先阅读黑板，再决定这轮最值得推进的动作。
- 如果需要调用工具，请在拿到足够信息后结束，不要无限继续调用。
- 输出必须严格使用下面的结构化格式。

## 输出格式
[COLLECTIVE_ACTION]
{
  "action": "post_note",
  "entryType": "evidence",
  "content": "你的核心贡献",
  "references": [],
  "relatedEntryIds": [],
  "nextRequest": null,
  "shouldContinue": null,
  "shouldConclude": null,
  "teamPlan": [],
  "finalReport": ""
}
[/COLLECTIVE_ACTION]`;
    };

    function decodeCollectiveStringValue(value) {
        return String(value || '')
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\\\/g, '\\')
            .trim();
    }

    function extractCollectiveBracketValue(raw, key, openChar, closeChar) {
        const keyPattern = new RegExp(`"${key}"\\s*:\\s*\\${openChar}`);
        const keyMatch = raw.match(keyPattern);
        if (!keyMatch || keyMatch.index == null) {
            return null;
        }
        const start = raw.indexOf(openChar, keyMatch.index);
        if (start < 0) {
            return null;
        }
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < raw.length; i += 1) {
            const char = raw[i];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === openChar) {
                depth += 1;
            } else if (char === closeChar) {
                depth -= 1;
                if (depth === 0) {
                    return raw.slice(start, i + 1);
                }
            }
        }
        return null;
    }

    function parseRelaxedCollectiveAgentAction(rawText) {
        const raw = typeof rawText === 'string' ? rawText : '';
        const stringUntilField = (key, nextKey) => {
            const pattern = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)",\\s*"${nextKey}"`, 'm');
            const match = raw.match(pattern);
            return match ? decodeCollectiveStringValue(match[1]) : '';
        };
        const plainString = (key) => {
            const pattern = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'm');
            const match = raw.match(pattern);
            return match ? decodeCollectiveStringValue(match[1]) : '';
        };
        const booleanField = (key) => {
            const match = raw.match(new RegExp(`"${key}"\\s*:\\s*(true|false|null)`, 'm'));
            if (!match) {
                return null;
            }
            if (match[1] === 'true') return true;
            if (match[1] === 'false') return false;
            return null;
        };
        const arrayField = (key) => {
            const block = extractCollectiveBracketValue(raw, key, '[', ']');
            if (!block) {
                return [];
            }
            try {
                const parsed = JSON.parse(block);
                return Array.isArray(parsed) ? parsed : [];
            } catch (_) {
                return [];
            }
        };

        const parsed = {
            action: plainString('action') || 'post_note',
            entryType: plainString('entryType') || 'claim',
            content: stringUntilField('content', 'references') || '',
            references: arrayField('references').filter(Boolean),
            relatedEntryIds: arrayField('relatedEntryIds').filter(Boolean),
            nextRequest: stringUntilField('nextRequest', 'shouldContinue') || plainString('nextRequest') || null,
            confidence: null,
            shouldContinue: booleanField('shouldContinue'),
            shouldConclude: booleanField('shouldConclude'),
            rationale: stringUntilField('rationale', 'finalReport') || plainString('rationale') || '',
            finalReport: stringUntilField('finalReport', 'teamPlan') || plainString('finalReport') || '',
            teamPlan: arrayField('teamPlan').filter((entry) => entry && typeof entry === 'object')
        };

        if (parsed.content || parsed.teamPlan.length > 0 || parsed.action !== 'post_note') {
            return parsed;
        }
        return null;
    }

    SubAgentEngine.prototype.parseCollectiveAgentAction = function(text) {
        const regex = /\[COLLECTIVE_ACTION\]([\s\S]*?)\[\/COLLECTIVE_ACTION\]/;
        const match = typeof text === 'string' ? text.match(regex) : null;
        if (match) {
            try {
                const parsed = JSON.parse(match[1]);
                return {
                    action: typeof parsed.action === 'string' ? parsed.action : 'post_note',
                    entryType: typeof parsed.entryType === 'string' ? parsed.entryType : 'claim',
                    content: typeof parsed.content === 'string' ? parsed.content : text,
                    references: Array.isArray(parsed.references) ? parsed.references.filter(Boolean) : [],
                    relatedEntryIds: Array.isArray(parsed.relatedEntryIds) ? parsed.relatedEntryIds.filter(Boolean) : [],
                    nextRequest: typeof parsed.nextRequest === 'string' ? parsed.nextRequest : null,
                    confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : null,
                    shouldContinue: typeof parsed.shouldContinue === 'boolean' ? parsed.shouldContinue : null,
                    shouldConclude: typeof parsed.shouldConclude === 'boolean' ? parsed.shouldConclude : null,
                    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
                    finalReport: typeof parsed.finalReport === 'string' ? parsed.finalReport : '',
                    teamPlan: Array.isArray(parsed.teamPlan) ? parsed.teamPlan.filter((entry) => entry && typeof entry === 'object') : []
                };
            } catch (e) {
                console.warn('[SubAgentEngine] Failed to parse collective action JSON:', e);
                const relaxed = parseRelaxedCollectiveAgentAction(match[1]);
                if (relaxed) {
                    return relaxed;
                }
            }
        }

        return {
            action: 'post_note',
            entryType: 'claim',
            content: typeof text === 'string' ? text.replace(regex, '$1').trim() : '',
            references: [],
            relatedEntryIds: [],
            nextRequest: null,
            confidence: null,
            shouldContinue: null,
            shouldConclude: null,
            rationale: '',
            finalReport: '',
            teamPlan: []
        };
    };

    SubAgentEngine.prototype.executeCollectiveAgent = async function(config, mainAgentMessages = [], executionContext = null, agentIndex = 0) {
        const role = config?.role || {};
        const agentName = role.name || config?.agent_name || `Collective Agent ${agentIndex + 1}`;
        const mission = config?.mission || config?.task || '';
        const phase = config?.phase || '';
        const visibleTools = Array.isArray(config?.visible_tools) ? config.visible_tools : [];
        const sharedContext = config?.sharedContext || '';
        const blackboardSnapshot = config?.blackboardSnapshot || null;

        if (executionContext) {
            executionContext.agentIndex = agentIndex;
            executionContext.agentName = agentName;
            executionContext.taskText = mission;
            executionContext.keepCollectiveSessionAlive = true;
        }

            if (this.onSubAgentStart) {
                try {
                    this.onSubAgentStart(agentName, mission, agentIndex, { phase, roleId: role.id || null });
                } catch (e) {
                    console.warn('[SubAgentEngine] onSubAgentStart callback error:', e);
                }
            }

        const filteredTools = this.filterTools(visibleTools);
        const messages = [
            {
                role: 'system',
                content: this.buildCollectiveAgentPrompt(role, mission, blackboardSnapshot, filteredTools, sharedContext)
            },
            ...mainAgentMessages.slice(-2),
            { role: 'user', content: mission }
        ];

        const agentAPI = this.createAgentAPI();
        let finalResult = null;
        try {
            const result = await this.runAgentLoop(messages, filteredTools, agentName, executionContext, agentAPI, agentIndex);
            const parsed = this.parseCollectiveAgentAction(result.text);
            finalResult = {
                agent_name: agentName,
                roleId: role.id || null,
                __collectivePhase: phase,
                status: 'success',
                actionData: parsed,
                findings: parsed.content || result.text,
                sources: parsed.references || [],
                summary: (parsed.content || result.text || '').slice(0, 200),
                rawResponse: result.text
            };

            if (this.onSubAgentComplete) {
                try {
                    this.onSubAgentComplete(agentName, finalResult, agentIndex, { phase, roleId: role.id || null });
                } catch (e) {
                    console.warn('[SubAgentEngine] onSubAgentComplete callback error:', e);
                }
            }

            return finalResult;
        } catch (error) {
            console.error('[SubAgentEngine] Collective agent execution error:', error);
            finalResult = {
                agent_name: agentName,
                roleId: role.id || null,
                __collectivePhase: phase,
                status: 'failed',
                error: error.message,
                actionData: {
                    action: 'post_note',
                    entryType: role.defaultEntryType || 'claim',
                    content: `${agentName} 执行失败：${error.message}`,
                    references: [],
                    relatedEntryIds: [],
                    nextRequest: null
                },
                findings: '',
                sources: [],
                summary: `执行失败: ${error.message}`
            };

            if (this.onSubAgentComplete) {
                try {
                    this.onSubAgentComplete(agentName, finalResult, agentIndex, { phase, roleId: role.id || null });
                } catch (e) {
                    console.warn('[SubAgentEngine] onSubAgentComplete callback error:', e);
                }
            }

            return finalResult;
        } finally {
            await this.closeSubAgentTabs(executionContext, finalResult);
        }
    };

    SubAgentEngine.prototype.buildCollectiveAgentPrompt = function(role, mission, blackboardSnapshot, filteredTools, sharedContext = '') {
        const blackboardLines = (blackboardSnapshot?.entries || [])
            .slice(-10)
            .map((entry) => `[${entry.entryType}] ${entry.role}: ${entry.content}`)
            .join('\n');

        return `你现在是群体研究模式中的一名研究员。
## 你的角色
- 名称：${role?.name || '研究员'}
- 职责：${role?.description || '围绕主题进行协作研究'}
${role?.style ? `- 风格：${role.style}` : ''}

${sharedContext ? `## 共享上下文\n${sharedContext}\n` : ''}

## 当前黑板
${blackboardLines || '黑板还没有内容，请先贡献第一条高价值信息。'}

## 本轮任务
${mission}

## 可用工具
${this.getToolDescriptions(filteredTools)}

## 规则
- 先阅读黑板，再决定这轮最值得推进的动作。
- 如果需要调用工具，请在拿到足够信息后结束，不要无限继续调用。
- 优先输出可复用、可验证、可接力的信息。
- 输出必须严格使用下面的结构化格式。

## 输出格式
[COLLECTIVE_ACTION]
{
  "action": "post_note",
  "entryType": "evidence",
  "content": "你的核心贡献",
  "references": [],
  "relatedEntryIds": [],
  "nextRequest": null,
  "shouldContinue": null,
  "shouldConclude": null,
  "teamPlan": [],
  "finalReport": ""
}
[/COLLECTIVE_ACTION]`;
    };

    SubAgentEngine.prototype.buildCollectiveAgentPrompt = function(role, mission, blackboardSnapshot, filteredTools, sharedContext = '') {
        const workBoardLines = (blackboardSnapshot?.workBoard?.entries || blackboardSnapshot?.entries || [])
            .slice(-10)
            .map((entry) => `[${entry.entryType}] ${entry.role}: ${entry.content}`)
            .join('\n');
        const chatBoardLines = (blackboardSnapshot?.chatBoard?.entries || [])
            .slice(-10)
            .map((entry) => `[${entry.role}] ${entry.content}`)
            .join('\n');

        return `你现在是群体研究模式中的一名研究员。
## 你的角色
- 名称：${role?.name || '研究员'}
- 职责：${role?.description || '围绕主题进行协作研究'}
${role?.style ? `- 风格：${role.style}` : ''}

${sharedContext ? `## 共享上下文\n${sharedContext}\n` : ''}

## 工作黑板
${workBoardLines || '工作黑板还没有内容，请先贡献第一条高价值信息。'}

## 聊天室
${chatBoardLines || '聊天室还没有新消息，请关注其他 agent 的动态。'}

## 本轮任务
${mission}

## 可用工具
${this.getToolDescriptions(filteredTools)}

## 规则
- 先阅读工作黑板和聊天室，再决定这一轮最值得推进的动作。
- 你和其他 agent 会持续保持连接，所以要关注别人刚刚发布的新内容。
- 如果需要调用工具，请在拿到足够信息后结束，不要无限继续调用。
- 优先输出可复用、可验证、可接力的信息。
- 输出必须严格使用下面的结构化格式。
## 输出格式
[COLLECTIVE_ACTION]
{
  "action": "post_note",
  "entryType": "evidence",
  "content": "你的核心贡献",
  "references": [],
  "relatedEntryIds": [],
  "nextRequest": null,
  "shouldContinue": null,
  "shouldConclude": null,
  "teamPlan": [],
  "finalReport": ""
}
[/COLLECTIVE_ACTION]`;
    };

    SubAgentEngine.prototype.buildCollectiveAgentPrompt = function(role, mission, blackboardSnapshot, filteredTools, sharedContext = '') {
        const workBoardLines = (blackboardSnapshot?.workBoard?.entries || blackboardSnapshot?.entries || [])
            .slice(-10)
            .map((entry) => `[${entry.entryType}] ${entry.role}: ${entry.content}`)
            .join('\n');
        const chatBoardLines = (blackboardSnapshot?.chatBoard?.entries || [])
            .slice(-10)
            .map((entry) => `[${entry.role}] ${entry.content}`)
            .join('\n');

        return `你现在是群体研究模式中的一名研究员。
## 你的角色
- 名称：${role?.name || '研究员'}
- 职责：${role?.description || '围绕主题进行协作研究'}
${role?.style ? `- 风格：${role.style}` : ''}

${sharedContext ? `## 共享上下文\n${sharedContext}\n` : ''}

## 工作黑板
${workBoardLines || '工作黑板还没有内容，请先贡献第一条高价值信息。'}

## 聊天室
${chatBoardLines || '聊天室还没有新消息，请关注其他 agent 的动态。'}

## 本轮任务
${mission}

## 可用工具
${this.getToolDescriptions(filteredTools)}

## 规则
- 你和其他 agent 会持续保持连接，必须持续参考聊天室和工作黑板的最新内容。
- 如果你只是想点评、追问、提醒、请求别人补证，优先使用 entryType="reflection"，这样内容只会进入聊天室。
- 如果你要提交正式工作结果、证据、待办、争议、结论，再使用 evidence / claim / todo / challenge / draft / decision 等工作黑板类型。
- 如果需要调用工具，请在拿到足够信息后结束，不要无限继续调用。
- 如果你是前台研究员，涉及 active 标签页的动作必须等待调度器串行安排。
- 输出必须严格使用下面的结构化格式。
## 输出格式
[COLLECTIVE_ACTION]
{
  "action": "post_note",
  "entryType": "evidence",
  "content": "你的核心贡献或聊天内容",
  "references": [],
  "relatedEntryIds": [],
  "nextRequest": null,
  "shouldContinue": null,
  "shouldConclude": null,
  "teamPlan": [],
  "finalReport": ""
}
[/COLLECTIVE_ACTION]`;
    };

    window.DeepResearch = window.DeepResearch || {};
    window.DeepResearch.SubAgentEngine = SubAgentEngine;
    console.log('[SubAgentEngine] Loaded and exported to window.DeepResearch.SubAgentEngine');
})();
} catch (e) {
    console.error('[SubAgentEngine] ERROR loading script:', e);
}
