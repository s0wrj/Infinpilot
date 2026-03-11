function createStepId(index) {
  return `workflow-step-${index + 1}`;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const FOREGROUND_STEP_TYPES = new Set([
  'recording_replay',
  'prompt_input',
  'manual_action',
  'collective_research'
]);

const FOREGROUND_TOOL_NAMES = new Set([
  'browser_navigate',
  'browser_open_url',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_reload_tab',
  'browser_get_dom',
  'browser_get_visible_text',
  'browser_click',
  'browser_fill_input',
  'browser_press_key',
  'browser_wait',
  'browser_scroll',
  'browser_screenshot'
]);

const NON_TEMPLATE_TOOL_NAMES = new Set([
  'invoke_sub_agent',
  'invoke_sub_agents'
]);

const NON_TEMPLATE_PROJECT_ACTIONS = new Set([
  'get_current_project',
  'list_projects',
  'list_items',
  'list_templates',
  'get_template',
  'run_template',
  'resume_run',
  'list_runs',
  'list_public_resources',
  'list_resource_bundles',
  'get_public_resource',
  'get_resource_bundle',
  'save_last_task_as_template'
]);

function createPromptKey(index) {
  return `runtime_input_${index + 1}`;
}

function normalizePromptMode(step) {
  const mode = String(step?.promptMode || '').trim().toLowerCase();
  if (mode) {
    return mode;
  }
  if (step?.type === 'select') {
    return 'select';
  }
  return 'text';
}

function buildPromptRequirement(step, index) {
  const promptKey = typeof step?.promptKey === 'string' && step.promptKey.trim()
    ? step.promptKey.trim()
    : createPromptKey(index);
  const promptMode = normalizePromptMode(step);
  const label = typeof step?.label === 'string' && step.label.trim()
    ? step.label.trim()
    : (typeof step?.promptLabel === 'string' && step.promptLabel.trim()
      ? step.promptLabel.trim()
      : `运行时输入 ${index + 1}`);

  return {
    key: promptKey,
    label,
    mode: promptMode,
    selector: typeof step?.selector === 'string' ? step.selector : '',
    frameId: typeof step?.frameId === 'number' ? step.frameId : 0,
    secret: step?.secret === true || promptMode === 'password',
    required: step?.required !== false,
    instructions: typeof step?.instructions === 'string' ? step.instructions : '',
    accept: typeof step?.accept === 'string' ? step.accept : '',
    multiple: step?.multiple === true,
    sampleValue: typeof step?.value === 'string' ? step.value : ''
  };
}

function buildManualRequirement(step, index) {
  const promptKey = typeof step?.promptKey === 'string' && step.promptKey.trim()
    ? step.promptKey.trim()
    : `manual_step_${index + 1}`;
  const label = typeof step?.label === 'string' && step.label.trim()
    ? step.label.trim()
    : (typeof step?.promptLabel === 'string' && step.promptLabel.trim()
      ? step.promptLabel.trim()
      : `手动步骤 ${index + 1}`);

  return {
    key: promptKey,
    label,
    mode: typeof step?.actionKind === 'string' && step.actionKind.trim() ? step.actionKind.trim() : 'manual',
    selector: typeof step?.selector === 'string' ? step.selector : '',
    frameId: typeof step?.frameId === 'number' ? step.frameId : 0,
    required: true,
    instructions: typeof step?.instructions === 'string' && step.instructions.trim()
      ? step.instructions.trim()
      : label
  };
}

function buildInputSchema(recordingSteps) {
  const fields = [];
  recordingSteps.forEach((step, index) => {
    if (step?.type === 'prompt_input') {
      fields.push(buildPromptRequirement(step, index));
    }
    if (step?.type === 'manual_action') {
      fields.push(buildManualRequirement(step, index));
    }
  });
  return { fields };
}

function flushReplaySegment(segments, segmentSteps) {
  if (!segmentSteps.length) {
    return;
  }
  const index = segments.length;
  segments.push({
    id: createStepId(index),
    type: 'recording_replay',
    label: `回放步骤 ${index + 1}`,
    payload: {
      steps: segmentSteps.map((step) => ({ ...step }))
    }
  });
}

function splitRecordingIntoWorkflowSteps(recordingSteps) {
  const workflowSteps = [];
  let replayBuffer = [];

  recordingSteps.forEach((step, index) => {
    if (step?.type === 'prompt_input') {
      flushReplaySegment(workflowSteps, replayBuffer);
      replayBuffer = [];
      const prompt = buildPromptRequirement(step, index);
      workflowSteps.push({
        id: createStepId(workflowSteps.length),
        type: 'prompt_input',
        label: prompt.label,
        payload: prompt
      });
      return;
    }

    if (step?.type === 'manual_action') {
      flushReplaySegment(workflowSteps, replayBuffer);
      replayBuffer = [];
      const manual = buildManualRequirement(step, index);
      workflowSteps.push({
        id: createStepId(workflowSteps.length),
        type: 'manual_action',
        label: manual.label,
        payload: manual
      });
      return;
    }

    replayBuffer.push({ ...step });
  });

  flushReplaySegment(workflowSteps, replayBuffer);
  return workflowSteps;
}

function sanitizeToolInput(input) {
  if (!input || typeof input !== 'object') {
    return {};
  }
  return JSON.parse(JSON.stringify(input));
}

function buildDefaultTemplateNameFromTrace(trace) {
  const source = typeof trace?.userMessage === 'string' && trace.userMessage.trim()
    ? trace.userMessage.trim()
    : '自动化任务';
  const compact = source.replace(/\s+/g, ' ').slice(0, 30);
  return compact ? `${compact} 模板` : '自动化任务模板';
}

function isTemplateEligibleToolCall(call) {
  if (!call?.toolName || NON_TEMPLATE_TOOL_NAMES.has(call.toolName)) {
    return false;
  }
  if (call.toolName === 'browser_project') {
    const action = String(call.toolInput?.action || '').trim();
    return action && !NON_TEMPLATE_PROJECT_ACTIONS.has(action);
  }
  return true;
}

function isForegroundToolCall(call) {
  if (!call?.toolName) {
    return false;
  }
  if (FOREGROUND_TOOL_NAMES.has(call.toolName)) {
    return true;
  }
  if (call.toolName !== 'browser_project') {
    return false;
  }
  const action = String(call.toolInput?.action || '').trim();
  return [
    'capture_page',
    'extract_pattern',
    'extract_article',
    'extract_table',
    'extract_faq',
    'extract_product',
    'extract_timeline'
  ].includes(action);
}

function buildBrowserToolSequenceStep(toolCalls, index = 0) {
  return {
    id: createStepId(index),
    type: 'browser_tool_sequence',
    label: `工具序列 ${index + 1}`,
    payload: {
      toolCalls: toolCalls.map((call) => ({
        toolName: call.toolName,
        toolInput: sanitizeToolInput(call.toolInput)
      }))
    }
  };
}

function buildCollectiveTopicRequirement(defaultTopic = '') {
  return {
    key: 'topic',
    label: '研究主题',
    mode: 'text',
    required: true,
    selector: '',
    frameId: 0,
    secret: false,
    instructions: '执行模板时要研究的主题。',
    accept: '',
    multiple: false,
    sampleValue: defaultTopic
  };
}

function buildCollectiveResearchStep(record, index = 0) {
  const snapshot = record?.content?.snapshot || (record?.type === 'collective_session' ? record.content : null);
  const defaultTopic = snapshot?.topic || record?.content?.topic || record?.title || '群体研究';
  return {
    id: createStepId(index),
    type: 'collective_research',
    label: '群体研究',
    payload: {
      topicKey: 'topic',
      defaultTopic,
      roles: [],
      context: '',
      executionMode: 'foreground'
    }
  };
}

export function buildTemplateFromRecording(recordingItem, options = {}) {
  const steps = Array.isArray(recordingItem?.content) ? recordingItem.content.map((step) => ({ ...step })) : [];
  const name = typeof options.name === 'string' && options.name.trim()
    ? options.name.trim()
    : `${recordingItem?.title || '页面录制'}模板`;

  return {
    projectId: options.projectId || recordingItem?.projectId || '',
    name,
    description: typeof options.description === 'string'
      ? options.description
      : `由录制“${recordingItem?.title || '页面录制'}”生成的任务模板`,
    sourceType: 'automation_recording',
    sourceItemId: recordingItem?.id || '',
    inputSchema: buildInputSchema(steps),
    steps: splitRecordingIntoWorkflowSteps(steps),
    executionMode: 'foreground',
    allowedTools: ['recorder.replay', 'recorder.resume'],
    outputTargets: ['project_item:workflow_result'],
    retryPolicy: {
      maxAttempts: 1
    }
  };
}

export function buildTemplateFromExecutionTrace(trace, options = {}) {
  const rawToolCalls = Array.isArray(trace?.toolCalls) ? trace.toolCalls : [];
  const successfulCalls = rawToolCalls
    .filter((call) => call?.success)
    .filter(isTemplateEligibleToolCall)
    .map((call) => ({
      toolName: call.toolName,
      toolInput: sanitizeToolInput(call.toolInput)
    }));

  return {
    projectId: options.projectId || trace?.projectId || '',
    name: typeof options.name === 'string' && options.name.trim()
      ? options.name.trim()
      : buildDefaultTemplateNameFromTrace(trace),
    description: typeof options.description === 'string'
      ? options.description
      : `由成功任务“${trace?.userMessage || '自动化任务'}”提炼出的工具序列模板`,
    sourceType: 'automation_trace',
    sourceItemId: trace?.id || '',
    inputSchema: { fields: [] },
    steps: successfulCalls.length ? [buildBrowserToolSequenceStep(successfulCalls)] : [],
    executionMode: detectExecutionModeFromToolCalls(successfulCalls),
    allowedTools: Array.from(new Set(successfulCalls.map((call) => call.toolName))),
    outputTargets: ['project_item:workflow_result'],
    retryPolicy: {
      maxAttempts: 1
    }
  };
}

export function buildTemplateFromCollectiveRecord(record, options = {}) {
  const snapshot = record?.content?.snapshot || (record?.type === 'collective_session' ? record.content : null);
  const defaultTopic = snapshot?.topic || record?.content?.topic || record?.title || '群体研究';

  return {
    projectId: options.projectId || record?.projectId || '',
    name: typeof options.name === 'string' && options.name.trim()
      ? options.name.trim()
      : `${defaultTopic} 模板`,
    description: typeof options.description === 'string'
      ? options.description
      : '复用群体研究角色协作方式，对新的研究主题执行结构化协作研究。',
    sourceType: record?.type || 'collective_research_result',
    sourceItemId: record?.id || '',
    inputSchema: {
      fields: [buildCollectiveTopicRequirement(defaultTopic)]
    },
    steps: [buildCollectiveResearchStep(record)],
    executionMode: 'foreground',
    allowedTools: ['collective_research'],
    outputTargets: ['project_item:workflow_result'],
    retryPolicy: {
      maxAttempts: 1
    }
  };
}

export function detectExecutionModeFromToolCalls(toolCalls = []) {
  return toolCalls.some(isForegroundToolCall) ? 'foreground' : 'parallel';
}

export function detectTemplateExecutionMode(template) {
  const declaredMode = String(template?.executionMode || '').trim().toLowerCase();
  if (declaredMode === 'foreground' || declaredMode === 'parallel') {
    return declaredMode;
  }

  const steps = Array.isArray(template?.steps) ? template.steps : [];
  if (steps.some((step) => FOREGROUND_STEP_TYPES.has(step?.type))) {
    return 'foreground';
  }

  if (steps.some((step) =>
    step?.type === 'browser_tool_sequence' &&
    detectExecutionModeFromToolCalls(step?.payload?.toolCalls || []) === 'foreground'
  )) {
    return 'foreground';
  }

  return 'parallel';
}

async function defaultReplayRecording(steps) {
  return browser.runtime.sendMessage({
    action: 'recorder.replay',
    steps
  });
}

async function defaultExecuteBrowserTool(toolName, toolInput, executionContext = null) {
  if (typeof window !== 'undefined' && typeof window.executeBrowserTool === 'function') {
    return window.executeBrowserTool(toolName, toolInput, executionContext);
  }
  throw new Error(`No browser tool executor available for ${toolName}`);
}

async function defaultExecuteCollectiveResearch(payload, input, executionContext = null) {
  if (typeof window !== 'undefined' && typeof window.runCollectiveResearchWorkflow === 'function') {
    return window.runCollectiveResearchWorkflow({
      ...payload,
      topic: typeof input?.[payload?.topicKey || 'topic'] === 'string' && input[payload?.topicKey || 'topic'].trim()
        ? input[payload?.topicKey || 'topic'].trim()
        : payload?.defaultTopic || '',
      executionContext
    });
  }
  throw new Error('No collective research executor available');
}

function collectMissingRequirement(requirement, input) {
  const rawValue = input?.[requirement.key];
  if (requirement.mode === 'file_upload' || requirement.mode === 'manual') {
    const isSatisfied = rawValue === true || rawValue === 'done' || rawValue === 'confirmed';
    return isSatisfied ? null : requirement;
  }

  if (Array.isArray(rawValue)) {
    return rawValue.length > 0 ? null : requirement;
  }

  if (rawValue === undefined || rawValue === null) {
    return requirement;
  }

  if (typeof rawValue === 'string' && !rawValue.trim()) {
    return requirement;
  }

  return null;
}

function buildReplayStepFromPrompt(payload, input) {
  const rawValue = input?.[payload.key];
  const frameId = typeof payload.frameId === 'number' ? payload.frameId : 0;
  const selector = payload.selector || '';
  const common = {
    selector,
    frameId
  };

  if (payload.mode === 'select') {
    return {
      ...common,
      type: 'select',
      value: String(rawValue)
    };
  }

  return {
    ...common,
    type: 'input',
    value: Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue)
  };
}

export async function runWorkflowTemplate(
  template,
  {
    input = {},
    replayRecording = defaultReplayRecording,
    executeBrowserTool = defaultExecuteBrowserTool,
    executeCollectiveResearch = defaultExecuteCollectiveResearch,
    startStepIndex = 0,
    executionContext = null
  } = {}
) {
  const stepLogs = [];

  for (let index = startStepIndex; index < (template?.steps || []).length; index += 1) {
    const step = template.steps[index];
    const startedAt = Date.now();

    try {
      if (step.type === 'recording_replay') {
        const replayResult = await replayRecording(step.payload?.steps || []);
        if (!replayResult?.success) {
          throw new Error(replayResult?.error || '录制回放失败');
        }

        stepLogs.push({
          id: step.id || createStepId(index),
          type: step.type,
          label: step.label || `步骤 ${index + 1}`,
          status: 'success',
          startedAt,
          endedAt: Date.now(),
          output: {
            stepCount: replayResult.stepCount || step.payload?.steps?.length || 0
          }
        });
        continue;
      }

      if (step.type === 'browser_tool_sequence') {
        const toolCalls = Array.isArray(step.payload?.toolCalls) ? step.payload.toolCalls : [];
        const toolResults = [];

        for (const toolCall of toolCalls) {
          const toolResult = await executeBrowserTool(
            toolCall.toolName,
            toolCall.toolInput || {},
            executionContext
          );
          if (!toolResult?.success && toolResult?.error) {
            throw new Error(toolResult.error);
          }
          toolResults.push({
            toolName: toolCall.toolName,
            success: toolResult?.success !== false,
            message: toolResult?.message || '',
            error: toolResult?.error || ''
          });
        }

        stepLogs.push({
          id: step.id || createStepId(index),
          type: step.type,
          label: step.label || `步骤 ${index + 1}`,
          status: 'success',
          startedAt,
          endedAt: Date.now(),
          output: {
            toolCount: toolCalls.length,
            toolResults
          }
        });
        continue;
      }

      if (step.type === 'collective_research') {
        const payload = step.payload || {};
        const topicRequirement = buildCollectiveTopicRequirement(payload.defaultTopic || '');
        const topicKey = payload.topicKey || topicRequirement.key;
        const topicValue = typeof input?.[topicKey] === 'string' && input[topicKey].trim()
          ? input[topicKey].trim()
          : (payload.defaultTopic || '');

        if (!topicValue) {
          stepLogs.push({
            id: step.id || createStepId(index),
            type: step.type,
            label: step.label || `步骤 ${index + 1}`,
            status: 'needs_input',
            startedAt,
            endedAt: Date.now(),
            output: {
              requiredInput: topicRequirement
            }
          });
          return {
            status: 'needs_input',
            input,
            steps: stepLogs,
            outputs: {
              pendingStepIndex: index,
              requiredInputs: [topicRequirement]
            },
            error: ''
          };
        }

        const collectiveResult = await executeCollectiveResearch({
          ...payload,
          topic: topicValue
        }, input, executionContext);
        if (!collectiveResult?.success) {
          throw new Error(collectiveResult?.error || '群体研究执行失败');
        }

        stepLogs.push({
          id: step.id || createStepId(index),
          type: step.type,
          label: step.label || `步骤 ${index + 1}`,
          status: 'success',
          startedAt,
          endedAt: Date.now(),
          output: {
            topic: collectiveResult.topic || topicValue,
            roundsCompleted: collectiveResult.roundsCompleted || 0,
            finalReport: collectiveResult.finalReport || '',
            resultItemId: collectiveResult.resultItemId || '',
            saved: collectiveResult.saved === true
          }
        });
        continue;
      }

      if (step.type === 'prompt_input') {
        const requirement = step.payload || buildPromptRequirement({}, index);
        const missing = collectMissingRequirement(requirement, input);
        if (missing) {
          stepLogs.push({
            id: step.id || createStepId(index),
            type: step.type,
            label: step.label || requirement.label || `步骤 ${index + 1}`,
            status: 'needs_input',
            startedAt,
            endedAt: Date.now(),
            output: {
              requiredInput: missing
            }
          });
          return {
            status: 'needs_input',
            input,
            steps: stepLogs,
            outputs: {
              pendingStepIndex: index,
              requiredInputs: [missing]
            },
            error: ''
          };
        }

        const replayStep = buildReplayStepFromPrompt(requirement, input);
        const replayResult = await replayRecording([replayStep]);
        if (!replayResult?.success) {
          throw new Error(replayResult?.error || '运行时输入执行失败');
        }

        stepLogs.push({
          id: step.id || createStepId(index),
          type: step.type,
          label: step.label || requirement.label || `步骤 ${index + 1}`,
          status: 'success',
          startedAt,
          endedAt: Date.now(),
          output: {
            inputKey: requirement.key,
            mode: requirement.mode
          }
        });
        continue;
      }

      if (step.type === 'manual_action') {
        const requirement = step.payload || buildManualRequirement({}, index);
        const missing = collectMissingRequirement(requirement, input);
        if (missing) {
          stepLogs.push({
            id: step.id || createStepId(index),
            type: step.type,
            label: step.label || requirement.label || `步骤 ${index + 1}`,
            status: 'needs_input',
            startedAt,
            endedAt: Date.now(),
            output: {
              requiredInput: missing
            }
          });
          return {
            status: 'needs_input',
            input,
            steps: stepLogs,
            outputs: {
              pendingStepIndex: index,
              requiredInputs: [missing]
            },
            error: ''
          };
        }

        stepLogs.push({
          id: step.id || createStepId(index),
          type: step.type,
          label: step.label || requirement.label || `步骤 ${index + 1}`,
          status: 'success',
          startedAt,
          endedAt: Date.now(),
          output: {
            inputKey: requirement.key,
            mode: requirement.mode
          }
        });
        continue;
      }

      throw new Error(`Unsupported workflow step type: ${step.type || 'unknown'}`);
    } catch (error) {
      stepLogs.push({
        id: step.id || createStepId(index),
        type: step.type,
        label: step.label || `步骤 ${index + 1}`,
        status: 'failed',
        startedAt,
        endedAt: Date.now(),
        error: error?.message || String(error)
      });

      return {
        status: 'failed',
        input,
        steps: stepLogs,
        outputs: null,
        error: error?.message || String(error)
      };
    }
  }

  return {
    status: 'success',
    input,
    steps: stepLogs,
    outputs: {
      completedSteps: stepLogs.length
    },
    error: ''
  };
}

export default {
  buildTemplateFromRecording,
  buildTemplateFromExecutionTrace,
  buildTemplateFromCollectiveRecord,
  detectExecutionModeFromToolCalls,
  detectTemplateExecutionMode,
  runWorkflowTemplate
};
