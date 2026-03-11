function buildRecordingKey(recording) {
  return `${recording?.title || ''}::${recording?.startedAt || ''}::${recording?.endedAt || ''}`;
}

function normalizeRecordingCandidate(recording, source = 'session') {
  return {
    id: recording?.id || '',
    source,
    title: recording?.title || '页面录制',
    url: recording?.sourceUrl || recording?.url || '',
    startedAt: recording?.startedAt || 0,
    endedAt: recording?.endedAt || 0,
    steps: Array.isArray(recording?.content)
      ? recording.content
      : (Array.isArray(recording?.steps) ? recording.steps : [])
  };
}

function safeShowToast(showToast, message, type = 'info') {
  if (typeof showToast === 'function') {
    showToast(message, type);
  }
}

function createRecorderMenu(anchor) {
  let menu = document.getElementById('toolbar-recorder-menu');
  if (!menu) {
    menu = document.createElement('details');
    menu.id = 'toolbar-recorder-menu';
    menu.className = 'toolbar-menu';
    menu.innerHTML = `
      <summary class="toolbar-menu-toggle" title="录制" aria-label="录制">
        <span class="toolbar-menu-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2"></circle>
            <circle cx="8" cy="8" r="2.5" fill="currentColor"></circle>
          </svg>
        </span>
        <span class="toolbar-menu-label">录制</span>
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

export function initAutomationRecorder({
  toolbarSelector = '.chat-input-toolbar',
  showToast,
  ensureCurrentProjectSelection,
  projectService,
  syncProjectState,
  reorderToolbar
}) {
  const state = {
    recording: false,
    latestRecording: null,
    buttons: {}
  };

  function createButton(id, title, icon, label) {
    let button = document.getElementById(id);
    if (button) {
      return button;
    }
    button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = 'icon-btn recorder-toolbar-btn toolbar-menu-action';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = `${icon}<span class="toolbar-menu-action-label">${label}</span>`;
    return button;
  }

  function ensureButtons() {
    const toolbar = document.querySelector(toolbarSelector);
    const anchor = document.getElementById('toolbar-project-menu')
      || document.getElementById('toolbar-automation-group')
      || document.getElementById('fetch-page-content')
      || document.getElementById('automation-toggle-btn');
    if (!toolbar || !anchor) {
      return null;
    }

    const panel = createRecorderMenu(anchor).querySelector('.toolbar-menu-panel');
    const defs = [
      {
        key: 'toggle',
        id: 'automation-recorder-toggle',
        title: '开始或停止录制',
        label: '开始/停止录制',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/><path d="M0 8a8 8 0 1 0 16 0A8 8 0 0 0 0 8zm8-7a7 7 0 1 1 0 14A7 7 0 0 1 8 1z"/></svg>'
      },
      {
        key: 'replay',
        id: 'automation-recorder-replay',
        title: '选择录制回放',
        label: '选择录制回放',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M11.596 8.697 6.363 11.73c-.54.313-1.363-.066-1.363-.697V4.967c0-.63.823-1.01 1.363-.696l5.233 3.033c.54.313.54 1.08 0 1.393z"/><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM1 8a7 7 0 1 0 14 0A7 7 0 0 0 1 8z"/></svg>'
      },
      {
        key: 'save',
        id: 'automation-recorder-save',
        title: '保存录制到项目',
        label: '保存录制到项目',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M2.5 1A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-8.793a1.5 1.5 0 0 0-.44-1.06l-2.207-2.207A1.5 1.5 0 0 0 11.793 1H2.5zm0 1h8.793a.5.5 0 0 1 .354.146l2.207 2.207a.5.5 0 0 1 .146.354V13.5a.5.5 0 0 1-.5.5H13V9.5A1.5 1.5 0 0 0 11.5 8h-7A1.5 1.5 0 0 0 3 9.5V14h-.5a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5zM4 14V9.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5V14H4z"/></svg>'
      }
    ];

    defs.forEach((definition) => {
      const button = createButton(definition.id, definition.title, definition.icon, definition.label);
      if (button.parentElement !== panel) {
        panel.appendChild(button);
      }
      state.buttons[definition.key] = button;
    });

    if (typeof reorderToolbar === 'function') {
      reorderToolbar();
    }

    return panel;
  }

  async function sendRecorderMessage(action, extra = {}) {
    try {
      const response = await browser.runtime.sendMessage({ action, ...extra });
      return response || { success: false, error: '后台没有返回结果' };
    } catch (error) {
      console.warn(`[recorder] ${action} failed:`, error);
      return {
        success: false,
        error: error?.message || '录制器后台暂时不可用'
      };
    }
  }

  async function refreshStatus() {
    try {
      ensureButtons();
      const response = await sendRecorderMessage('recorder.getStatus');
      if (response?.success) {
        state.recording = Boolean(response.isRecording);
        state.latestRecording = response.lastRecording || state.latestRecording;
      }
      render();
    } catch (error) {
      console.warn('[recorder] refreshStatus failed:', error);
    }
  }

  function render() {
    const toggle = state.buttons.toggle;
    const replay = state.buttons.replay;
    const save = state.buttons.save;
    if (!toggle || !replay || !save) {
      return;
    }

    toggle.classList.toggle('is-recording', state.recording);
    toggle.title = state.recording ? '停止录制' : '开始录制';
    toggle.setAttribute('aria-label', toggle.title);

    const hasRecording = Boolean(state.latestRecording?.steps?.length);
    replay.disabled = state.recording && !hasRecording;
    save.disabled = !hasRecording || state.recording;
  }

  async function toggleRecording() {
    try {
      if (state.recording) {
        const response = await sendRecorderMessage('recorder.stop');
        if (!response?.success) {
          throw new Error(response?.error || '停止录制失败');
        }
        state.recording = false;
        state.latestRecording = response.recording || null;
        safeShowToast(showToast, `录制已停止，共 ${state.latestRecording?.steps?.length || 0} 步`, 'success');
      } else {
        const response = await sendRecorderMessage('recorder.start');
        if (!response?.success) {
          throw new Error(response?.error || '开始录制失败');
        }
        state.recording = true;
        safeShowToast(showToast, '页面录制已开始', 'info');
      }
    } catch (error) {
      safeShowToast(showToast, error?.message || '录制操作失败', 'error');
    }
    render();
  }

  async function prepareReplaySteps(steps) {
    const prepared = [];
    for (const step of steps || []) {
      if (step?.type === 'prompt_input') {
        const label = step.promptLabel || step.label || '请输入运行时内容';
        const value = window.prompt(label, step.sampleValue || step.value || '');
        if (value === null) {
          throw new Error('已取消运行时输入');
        }
        prepared.push({
          ...step,
          type: step.promptMode === 'select' ? 'select' : 'input',
          value
        });
        continue;
      }

      if (step?.type === 'manual_action') {
        const confirmed = window.confirm(step.instructions || step.promptLabel || '请先完成页面上的手动操作，再继续回放。');
        if (!confirmed) {
          throw new Error('已取消手动步骤');
        }
        continue;
      }

      prepared.push(step);
    }
    return prepared;
  }

  async function getReplayCandidates() {
    const candidates = [];
    const seen = new Set();

    if (state.latestRecording?.steps?.length) {
      const latestCandidate = normalizeRecordingCandidate(state.latestRecording, 'session');
      candidates.push(latestCandidate);
      seen.add(buildRecordingKey(latestCandidate));
    }

    try {
      const currentProject = await projectService.getCurrentProject();
      if (currentProject?.id) {
        const items = await projectService.listProjectItems(currentProject.id);
        items
          .filter((item) => item.type === 'automation_recording')
          .forEach((item) => {
            const candidate = normalizeRecordingCandidate(item, 'project');
            const key = buildRecordingKey(candidate);
            if (!candidate.steps.length || seen.has(key)) {
              return;
            }
            seen.add(key);
            candidates.push(candidate);
          });
      }
    } catch (error) {
      console.warn('[recorder] Failed to load project recordings:', error);
    }

    return candidates;
  }

  async function chooseReplayRecording() {
    const candidates = await getReplayCandidates();
    if (candidates.length === 0) {
      safeShowToast(showToast, '当前没有可回放的录制记录', 'warning');
      return null;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

    const lines = candidates.map((candidate, index) => {
      const scope = candidate.source === 'session' ? '当前会话' : '项目记录';
      const time = candidate.startedAt ? new Date(candidate.startedAt).toLocaleString() : '';
      return `${index + 1}. [${scope}] ${candidate.title}（${candidate.steps.length} 步） ${time}`.trim();
    });
    const answer = window.prompt(`请选择要回放的录制编号：\n${lines.join('\n')}`, '1');
    if (answer === null) {
      return null;
    }
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      throw new Error('无效的录制编号');
    }
    return candidates[index];
  }

  async function replayRecording() {
    try {
      const selectedRecording = await chooseReplayRecording();
      if (!selectedRecording) {
        return;
      }
      const steps = await prepareReplaySteps(selectedRecording.steps);
      const response = await sendRecorderMessage('recorder.replay', { steps });
      if (!response?.success) {
        throw new Error(response?.error || '回放失败');
      }
      safeShowToast(showToast, `开始回放：${selectedRecording.title}`, 'success');
    } catch (error) {
      safeShowToast(showToast, error?.message || '录制回放失败', 'error');
    }
  }

  async function saveRecording() {
    try {
      if (!state.latestRecording?.steps?.length) {
        safeShowToast(showToast, '当前没有可保存的录制', 'warning');
        return;
      }

      const projectId = await ensureCurrentProjectSelection('保存录制');
      if (!projectId) {
        return;
      }

      const promptCount = state.latestRecording.steps.filter((step) =>
        step?.type === 'prompt_input' || step?.type === 'manual_action'
      ).length;
      const title = state.latestRecording.title || `页面录制 ${new Date().toLocaleString()}`;
      await projectService.addProjectItem({
        projectId,
        type: 'automation_recording',
        title,
        sourceUrl: state.latestRecording.url || '',
        content: state.latestRecording.steps,
        meta: {
          startedAt: state.latestRecording.startedAt,
          endedAt: state.latestRecording.endedAt,
          stepCount: state.latestRecording.steps.length,
          promptCount
        }
      });
      await syncProjectState();
      safeShowToast(showToast, `已保存录制：${title}`, 'success');
    } catch (error) {
      safeShowToast(showToast, error?.message || '保存录制失败', 'error');
    }
  }

  function bind() {
    ensureButtons();
    const { toggle, replay, save } = state.buttons;

    if (toggle && !toggle.dataset.bound) {
      toggle.addEventListener('click', toggleRecording);
      toggle.dataset.bound = 'true';
    }
    if (replay && !replay.dataset.bound) {
      replay.addEventListener('click', replayRecording);
      replay.dataset.bound = 'true';
    }
    if (save && !save.dataset.bound) {
      save.addEventListener('click', saveRecording);
      save.dataset.bound = 'true';
    }
  }

  try {
    bind();
    void refreshStatus();
  } catch (error) {
    console.error('[recorder] init failed:', error);
    safeShowToast(showToast, error?.message || '录制器初始化失败', 'error');
  }

  return {
    refreshStatus
  };
}
