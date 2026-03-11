import {
  createId,
  loadProjectState,
  normalizeProject,
  normalizeProjectItem,
  normalizePublicResource,
  normalizeProjectRun,
  normalizeResourceBundle,
  normalizeProjectTemplate,
  saveProjectState
} from './projectStore.js';
import executionScheduler from './automation/executionScheduler.js';
import {
  buildTemplateFromCollectiveRecord,
  buildTemplateFromExecutionTrace,
  buildTemplateFromRecording,
  detectTemplateExecutionMode,
  runWorkflowTemplate
} from './automation/workflowEngine.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortByUpdatedAtDesc(items) {
  return [...items].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function cloneTemplatePayload(template) {
  return {
    name: template.name,
    description: template.description,
    sourceType: template.sourceType,
    sourceItemId: template.sourceItemId,
    inputSchema: clone(template.inputSchema || {}),
    steps: clone(template.steps || []),
    allowedTools: clone(template.allowedTools || []),
    outputTargets: clone(template.outputTargets || []),
    retryPolicy: clone(template.retryPolicy || { maxAttempts: 1 }),
    executionMode: template.executionMode || detectTemplateExecutionMode(template)
  };
}

function cloneItemPayload(item) {
  return {
    type: item.type,
    title: item.title,
    sourceUrl: item.sourceUrl,
    sourceTabId: item.sourceTabId,
    content: clone(item.content),
    meta: clone(item.meta || {})
  };
}

function findProjectResource(state, entityType, resourceId) {
  if (entityType === 'template') {
    return state.projectTemplates.find((item) => item.id === resourceId) || null;
  }
  return state.projectItems.find((item) => item.id === resourceId) || null;
}

function buildPublicResourceSnapshot(record, entityType) {
  if (entityType === 'template') {
    return normalizePublicResource({
      entityType: 'template',
      sourceProjectId: record.projectId,
      sourceResourceId: record.id,
      title: record.name,
      name: record.name,
      description: record.description,
      sourceType: record.sourceType,
      sourceItemId: record.sourceItemId,
      inputSchema: clone(record.inputSchema || {}),
      steps: clone(record.steps || []),
      allowedTools: clone(record.allowedTools || []),
      outputTargets: clone(record.outputTargets || []),
      retryPolicy: clone(record.retryPolicy || { maxAttempts: 1 }),
      executionMode: record.executionMode || detectTemplateExecutionMode(record),
      meta: {
        templateId: record.id
      },
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  return normalizePublicResource({
    entityType: 'item',
    sourceProjectId: record.projectId,
    sourceResourceId: record.id,
    type: record.type,
    title: record.title,
    sourceUrl: record.sourceUrl,
    content: clone(record.content),
    meta: clone(record.meta || {}),
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}

class ProjectService extends EventTarget {
  constructor() {
    super();
    this.state = null;
    this.initializingPromise = null;
  }

  async initialize() {
    if (this.state) {
      return clone(this.state);
    }
    if (!this.initializingPromise) {
      this.initializingPromise = loadProjectState()
        .then((state) => {
          this.state = state;
          this.initializingPromise = null;
          this.dispatchStateEvents();
          return clone(this.state);
        })
        .catch((error) => {
          this.initializingPromise = null;
          throw error;
        });
    }
    return this.initializingPromise;
  }

  async getSnapshot() {
    await this.initialize();
    return clone(this.state);
  }

  async withState(mutator) {
    await this.initialize();
    const draft = clone(this.state);
    const result = await mutator(draft);
    this.state = await saveProjectState(draft);
    this.dispatchStateEvents();
    return result;
  }

  dispatchStateEvents() {
    const detail = {
      currentProjectId: this.state?.currentProjectId || null,
      currentProject: this.getCurrentProjectSync(),
      projects: this.getProjectsSync(),
      summary: this.getProjectSummarySync()
    };
    const eventNames = [
      'infinpilot:project-changed',
      'infinpilot:projects-updated',
      'infinpilot:project-items-updated'
    ];
    eventNames.forEach((eventName) => {
      document.dispatchEvent(new CustomEvent(eventName, { detail }));
    });
  }

  getProjectsSync() {
    return this.state ? clone(sortByUpdatedAtDesc(this.state.projects)) : [];
  }

  getCurrentProjectSync() {
    if (!this.state) {
      return null;
    }
    const project = this.state.projects.find((item) => item.id === this.state.currentProjectId) || null;
    return project ? clone(project) : null;
  }

  getProjectItemsSync(projectId = null) {
    if (!this.state) {
      return [];
    }
    const targetProjectId = projectId || this.state.currentProjectId;
    return clone(sortByUpdatedAtDesc(this.state.projectItems.filter((item) => item.projectId === targetProjectId)));
  }

  getProjectTemplatesSync(projectId = null) {
    if (!this.state) {
      return [];
    }
    const targetProjectId = projectId || this.state.currentProjectId;
    return clone(sortByUpdatedAtDesc(this.state.projectTemplates.filter((item) => item.projectId === targetProjectId)));
  }

  getProjectRunsSync(projectId = null, limit = 10) {
    if (!this.state) {
      return [];
    }
    const targetProjectId = projectId || this.state.currentProjectId;
    return clone(sortByUpdatedAtDesc(this.state.projectRuns.filter((item) => item.projectId === targetProjectId))).slice(0, limit);
  }

  getPublicResourcesSync() {
    if (!this.state) {
      return [];
    }
    return clone(sortByUpdatedAtDesc(this.state.publicResources || []));
  }

  getResourceBundlesSync() {
    if (!this.state) {
      return [];
    }
    return clone(sortByUpdatedAtDesc(this.state.resourceBundles || []));
  }

  getProjectSummarySync(projectId = null, limit = 6) {
    const project = projectId
      ? (this.state?.projects.find((item) => item.id === projectId) || null)
      : this.getCurrentProjectSync();
    if (!project) {
      return null;
    }

    const items = this.getProjectItemsSync(project.id);
    const typeCounts = {};
    items.forEach((item) => {
      typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
    });

    return {
      project,
      itemCount: items.length,
      typeCounts,
      recentItems: items.slice(0, limit)
    };
  }

  async listProjects() {
    await this.initialize();
    return this.getProjectsSync();
  }

  async getCurrentProject() {
    await this.initialize();
    return this.getCurrentProjectSync();
  }

  async getCurrentProjectId() {
    await this.initialize();
    return this.state.currentProjectId;
  }

  async listProjectItems(projectId = null) {
    await this.initialize();
    return this.getProjectItemsSync(projectId);
  }

  async listProjectTemplates(projectId = null) {
    await this.initialize();
    return this.getProjectTemplatesSync(projectId);
  }

  async listProjectRuns(projectId = null, limit = 10) {
    await this.initialize();
    return this.getProjectRunsSync(projectId, limit);
  }

  async listPublicResources() {
    await this.initialize();
    return this.getPublicResourcesSync();
  }

  async listResourceBundles() {
    await this.initialize();
    return this.getResourceBundlesSync();
  }

  async getPublicResource(publicResourceId) {
    await this.initialize();
    const resource = this.state.publicResources.find((item) => item.id === publicResourceId) || null;
    return resource ? clone(resource) : null;
  }

  async getResourceBundle(bundleId) {
    await this.initialize();
    const bundle = this.state.resourceBundles.find((item) => item.id === bundleId) || null;
    return bundle ? clone(bundle) : null;
  }

  async getProjectTemplate(templateId) {
    await this.initialize();
    const template = this.state.projectTemplates.find((item) => item.id === templateId) || null;
    return template ? clone(template) : null;
  }

  async getProjectRun(runId) {
    await this.initialize();
    const run = this.state.projectRuns.find((item) => item.id === runId) || null;
    return run ? clone(run) : null;
  }

  async getProjectSummary(projectId = null, limit = 6) {
    await this.initialize();
    return this.getProjectSummarySync(projectId, limit);
  }

  async createProject(name, description = '') {
    const nextName = typeof name === 'string' && name.trim() ? name.trim() : '新项目';
    const timestamp = Date.now();
    const project = normalizeProject({
      id: createId('project'),
      name: nextName,
      description,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await this.withState((state) => {
      state.projects.unshift(project);
      state.currentProjectId = project.id;
    });

    return clone(project);
  }

  async renameProject(projectId, name) {
    const nextName = typeof name === 'string' ? name.trim() : '';
    if (!nextName) {
      return { success: false, error: '项目名称不能为空' };
    }

    let updatedProject = null;
    await this.withState((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return;
      }
      project.name = nextName;
      project.updatedAt = Date.now();
      updatedProject = clone(project);
    });

    if (!updatedProject) {
      return { success: false, error: '项目不存在' };
    }
    return { success: true, project: updatedProject };
  }

  async switchProject(projectId) {
    let switchedProject = null;
    await this.withState((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      if (!project) {
        return;
      }
      state.currentProjectId = project.id;
      project.updatedAt = Date.now();
      switchedProject = clone(project);
    });

    if (!switchedProject) {
      return { success: false, error: '项目不存在' };
    }
    return { success: true, project: switchedProject };
  }

  async deleteProject(projectId) {
    let deleted = false;
    await this.withState((state) => {
      if (state.projects.length <= 1) {
        return;
      }
      const nextProjects = state.projects.filter((item) => item.id !== projectId);
      if (nextProjects.length === state.projects.length) {
        return;
      }
      deleted = true;
      state.projects = nextProjects;
      state.projectItems = state.projectItems.filter((item) => item.projectId !== projectId);
      state.projectTemplates = state.projectTemplates.filter((item) => item.projectId !== projectId);
      state.projectRuns = state.projectRuns.filter((item) => item.projectId !== projectId);
      if (state.currentProjectId === projectId) {
        state.currentProjectId = nextProjects[0]?.id || null;
      }
    });

    if (!deleted) {
      return { success: false, error: '无法删除项目' };
    }
    return { success: true };
  }

  async addProjectItem(itemInput) {
    const item = normalizeProjectItem({
      ...itemInput,
      projectId: itemInput?.projectId || (await this.getCurrentProjectId())
    });

    await this.withState((state) => {
      const project = state.projects.find((entry) => entry.id === item.projectId);
      if (!project) {
        throw new Error('项目不存在');
      }
      project.updatedAt = Date.now();
      state.projectItems.unshift(item);
    });

    return clone(item);
  }

  async saveCollectiveSession(projectId, sessionSnapshot) {
    const targetProjectId = projectId || (await this.getCurrentProjectId());
    const topic = sessionSnapshot?.topic || '群体研究会话';
    const sessionItem = await this.addProjectItem({
      projectId: targetProjectId,
      type: 'collective_session',
      title: `${topic} · 会话`,
      content: sessionSnapshot
    });
    const blackboardItem = await this.addProjectItem({
      projectId: targetProjectId,
      type: 'collective_blackboard',
      title: `${topic} · 黑板`,
      content: sessionSnapshot?.blackboard || {}
    });
    const reportItem = await this.addProjectItem({
      projectId: targetProjectId,
      type: 'collective_report',
      title: `${topic} · 报告`,
      content: {
        topic,
        roundsCompleted: sessionSnapshot?.currentRound ?? sessionSnapshot?.roundsCompleted ?? null,
        finalReport: sessionSnapshot?.finalReport || sessionSnapshot?.blackboard?.draft?.content || ''
      }
    });

    return {
      success: true,
      sessionItem,
      blackboardItem,
      reportItem
    };
  }

  async saveCollectiveReport(projectId, report) {
    const targetProjectId = projectId || (await this.getCurrentProjectId());
    const item = await this.addProjectItem({
      projectId: targetProjectId,
      type: 'collective_report',
      title: report?.topic ? `${report.topic} · 报告` : '群体研究报告',
      content: report
    });
    return { success: true, item };
  }

  async createProjectTemplate(templateInput) {
    const targetProjectId = templateInput?.projectId || (await this.getCurrentProjectId());
    const timestamp = Date.now();
    const template = normalizeProjectTemplate({
      ...templateInput,
      executionMode: templateInput?.executionMode || detectTemplateExecutionMode(templateInput),
      projectId: targetProjectId,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await this.withState((state) => {
      const project = state.projects.find((entry) => entry.id === template.projectId);
      if (!project) {
        throw new Error('项目不存在');
      }
      project.updatedAt = timestamp;
      state.projectTemplates.unshift(template);
    });

    return clone(template);
  }

  async createTemplateFromRecording(recordingItem, options = {}) {
    if (!recordingItem || recordingItem.type !== 'automation_recording') {
      return { success: false, error: '只能从录制素材生成模板' };
    }

    const projectId = options.projectId || recordingItem.projectId || (await this.getCurrentProjectId());
    const templateInput = buildTemplateFromRecording(recordingItem, {
      projectId,
      name: options.name,
      description: options.description
    });
    const template = await this.createProjectTemplate(templateInput);
    return { success: true, template };
  }

  async createTemplateFromCollectiveRecord(record, options = {}) {
    if (!record || !['collective_research_result', 'collective_session', 'collective_report'].includes(record.type)) {
      return { success: false, error: '只能从群体研究素材生成模板' };
    }

    const projectId = options.projectId || record.projectId || (await this.getCurrentProjectId());
    const templateInput = buildTemplateFromCollectiveRecord(record, {
      projectId,
      name: options.name,
      description: options.description
    });
    const template = await this.createProjectTemplate(templateInput);
    return { success: true, template };
  }

  async createTemplateFromExecutionTrace(trace, options = {}) {
    const projectId = options.projectId || trace?.projectId || (await this.getCurrentProjectId());
    const templateInput = buildTemplateFromExecutionTrace(trace, {
      projectId,
      name: options.name,
      description: options.description
    });

    if (!Array.isArray(templateInput.steps) || templateInput.steps.length === 0) {
      return { success: false, error: '没有可保存为模板的成功步骤' };
    }

    const template = await this.createProjectTemplate(templateInput);
    return { success: true, template };
  }

  async executeProjectTemplate(templateId, input = {}) {
    await this.initialize();
    const template = this.state.projectTemplates.find((item) => item.id === templateId);
    if (!template) {
      return { success: false, error: '模板不存在' };
    }

    const executionMode = detectTemplateExecutionMode(template);
    const now = Date.now();
    const run = normalizeProjectRun({
      id: createId('project-run'),
      projectId: template.projectId,
      templateId: template.id,
      status: 'running',
      input,
      steps: [],
      outputs: null,
      error: '',
      startedAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now
    });

    await this.withState((state) => {
      const project = state.projects.find((entry) => entry.id === template.projectId);
      if (!project) {
        throw new Error('项目不存在');
      }
      project.updatedAt = now;
      state.projectRuns.unshift(run);
    });

    const executeRun = async () => {
      const execution = await runWorkflowTemplate(template, {
        input,
        executeBrowserTool: typeof window !== 'undefined' && typeof window.executeBrowserTool === 'function'
          ? window.executeBrowserTool
          : undefined,
        executeCollectiveResearch: typeof window !== 'undefined' && typeof window.runCollectiveResearchWorkflow === 'function'
          ? window.runCollectiveResearchWorkflow
          : undefined
      });
      return this.finalizeProjectRun(run.id, template, execution, input, executionMode);
    };

    if (executionMode === 'foreground') {
      return executionScheduler.runForeground({
        source: 'project-template',
        templateId: template.id,
        templateName: template.name,
        runId: run.id
      }, executeRun);
    }

    return executeRun();
  }

  async resumeProjectRun(runId, inputPatch = {}) {
    await this.initialize();
    const existingRun = this.state.projectRuns.find((item) => item.id === runId);
    if (!existingRun) {
      return { success: false, error: '运行记录不存在' };
    }
    if (existingRun.status !== 'needs_input') {
      return { success: false, error: '当前运行不处于等待输入状态' };
    }

    const template = this.state.projectTemplates.find((item) => item.id === existingRun.templateId);
    if (!template) {
      return { success: false, error: '模板不存在' };
    }

    const executionMode = detectTemplateExecutionMode(template);
    const mergedInput = {
      ...(existingRun.input && typeof existingRun.input === 'object' ? existingRun.input : {}),
      ...(inputPatch && typeof inputPatch === 'object' ? inputPatch : {})
    };
    const resumedAt = Date.now();

    await this.withState((state) => {
      const targetRun = state.projectRuns.find((entry) => entry.id === existingRun.id);
      if (!targetRun) {
        throw new Error('运行记录不存在');
      }
      targetRun.status = 'running';
      targetRun.input = mergedInput;
      targetRun.updatedAt = resumedAt;
      targetRun.error = '';

      const project = state.projects.find((entry) => entry.id === existingRun.projectId);
      if (project) {
        project.updatedAt = resumedAt;
      }
    });

    const startStepIndex = typeof existingRun.outputs?.pendingStepIndex === 'number'
      ? existingRun.outputs.pendingStepIndex
      : 0;
    const executeRun = async () => {
      const execution = await runWorkflowTemplate(template, {
        input: mergedInput,
        startStepIndex,
        executeBrowserTool: typeof window !== 'undefined' && typeof window.executeBrowserTool === 'function'
          ? window.executeBrowserTool
          : undefined,
        executeCollectiveResearch: typeof window !== 'undefined' && typeof window.runCollectiveResearchWorkflow === 'function'
          ? window.runCollectiveResearchWorkflow
          : undefined
      });
      const previousLogs = Array.isArray(existingRun.steps)
        ? existingRun.steps.slice(0, startStepIndex)
        : [];

      return this.finalizeProjectRun(existingRun.id, template, {
        ...execution,
        input: mergedInput,
        steps: [...previousLogs, ...(execution.steps || [])]
      }, mergedInput, executionMode);
    };

    if (executionMode === 'foreground') {
      return executionScheduler.runForeground({
        source: 'project-template-resume',
        templateId: template.id,
        templateName: template.name,
        runId: existingRun.id
      }, executeRun);
    }

    return executeRun();
  }

  async finalizeProjectRun(runId, template, execution, input, executionMode = detectTemplateExecutionMode(template)) {
    const endedAt = Date.now();
    let nextRun = null;
    let workflowResultItem = null;

    await this.withState((state) => {
      const targetRun = state.projectRuns.find((entry) => entry.id === runId);
      if (!targetRun) {
        throw new Error('运行记录不存在');
      }

      targetRun.status = execution.status;
      targetRun.input = input;
      targetRun.steps = execution.steps || [];
      targetRun.outputs = {
        ...(execution.outputs ?? {}),
        executionMode
      };
      targetRun.error = execution.error || '';
      targetRun.endedAt = endedAt;
      targetRun.updatedAt = endedAt;
      nextRun = clone(targetRun);

      const project = state.projects.find((entry) => entry.id === template.projectId);
      if (project) {
        project.updatedAt = endedAt;
      }

      const meta = {
        templateId: template.id,
        templateName: template.name,
        executionMode,
        runId,
        error: execution.error || '',
        steps: execution.steps || [],
        requiredInputs: execution.outputs?.requiredInputs || [],
        pendingStepIndex: execution.outputs?.pendingStepIndex ?? null
      };
      const existingItem = state.projectItems.find((item) =>
        item.type === 'workflow_result' &&
        item.meta?.runId === runId
      );

      if (existingItem) {
        existingItem.title = `${template.name} 运行 ${new Date(endedAt).toLocaleString()}`;
        existingItem.content = {
          status: execution.status,
          outputs: {
            ...(execution.outputs ?? {}),
            executionMode
          }
        };
        existingItem.meta = meta;
        existingItem.updatedAt = endedAt;
        workflowResultItem = clone(existingItem);
        return;
      }

      const resultItem = normalizeProjectItem({
        projectId: template.projectId,
        type: 'workflow_result',
        title: `${template.name} 运行 ${new Date(endedAt).toLocaleString()}`,
        content: {
          status: execution.status,
          outputs: {
            ...(execution.outputs ?? {}),
            executionMode
          }
        },
        meta,
        createdAt: endedAt,
        updatedAt: endedAt
      });

      state.projectItems.unshift(resultItem);
      workflowResultItem = clone(resultItem);
    });

    return {
      success: execution.status === 'success',
      run: {
        ...nextRun,
        templateName: template.name,
        executionMode
      },
      item: workflowResultItem,
      requiredInputs: execution.outputs?.requiredInputs || [],
      error: execution.error || ''
    };
  }

  async addEditorFileReference(file, projectId = null) {
    if (!file?.id) {
      return { success: false, error: '文件不存在' };
    }

    const targetProjectId = projectId || (await this.getCurrentProjectId());
    let resultItem = null;

    await this.withState((state) => {
      const project = state.projects.find((entry) => entry.id === targetProjectId);
      if (!project) {
        throw new Error('项目不存在');
      }

      const existing = state.projectItems.find((item) =>
        item.projectId === targetProjectId &&
        item.type === 'editor_file_ref' &&
        item.meta?.fileId === file.id
      );

      const timestamp = Date.now();
      project.updatedAt = timestamp;

      if (existing) {
        existing.title = file.name;
        existing.meta = {
          ...existing.meta,
          fileId: file.id,
          fileName: file.name,
          fileType: file.type,
          parentId: file.parentId ?? null
        };
        existing.content = {
          fileId: file.id,
          fileType: file.type,
          parentId: file.parentId ?? null
        };
        existing.updatedAt = timestamp;
        resultItem = clone(existing);
        return;
      }

      const newItem = normalizeProjectItem({
        projectId: targetProjectId,
        type: 'editor_file_ref',
        title: file.name,
        content: {
          fileId: file.id,
          fileType: file.type,
          parentId: file.parentId ?? null
        },
        meta: {
          fileId: file.id,
          fileName: file.name,
          fileType: file.type,
          parentId: file.parentId ?? null
        },
        createdAt: timestamp,
        updatedAt: timestamp
      });

      state.projectItems.unshift(newItem);
      resultItem = clone(newItem);
    });

    return { success: true, item: resultItem };
  }

  async syncEditorFileReference(file) {
    if (!file?.id) {
      return { success: false, error: '文件不存在' };
    }

    let updatedCount = 0;
    await this.withState((state) => {
      const matchingItems = state.projectItems.filter((item) =>
        item.type === 'editor_file_ref' &&
        item.meta?.fileId === file.id
      );
      if (matchingItems.length === 0) {
        return;
      }

      const timestamp = Date.now();
      matchingItems.forEach((item) => {
        item.title = file.name;
        item.content = {
          fileId: file.id,
          fileType: file.type,
          parentId: file.parentId ?? null
        };
        item.meta = {
          ...item.meta,
          fileId: file.id,
          fileName: file.name,
          fileType: file.type,
          parentId: file.parentId ?? null
        };
        item.updatedAt = timestamp;
      });

      const touchedProjects = new Set(matchingItems.map((item) => item.projectId));
      state.projects.forEach((project) => {
        if (touchedProjects.has(project.id)) {
          project.updatedAt = timestamp;
        }
      });

      updatedCount = matchingItems.length;
    });

    return { success: true, updatedCount };
  }

  async removeEditorFileReferences(fileIds) {
    const targetFileIds = Array.isArray(fileIds) ? fileIds.filter(Boolean) : [];
    if (targetFileIds.length === 0) {
      return { success: true, removedCount: 0 };
    }

    let removedCount = 0;
    await this.withState((state) => {
      const removedItems = state.projectItems.filter((item) =>
        item.type === 'editor_file_ref' &&
        targetFileIds.includes(item.meta?.fileId)
      );
      if (removedItems.length === 0) {
        return;
      }

      const touchedProjects = new Set(removedItems.map((item) => item.projectId));
      state.projectItems = state.projectItems.filter((item) =>
        !(item.type === 'editor_file_ref' && targetFileIds.includes(item.meta?.fileId))
      );
      const timestamp = Date.now();
      state.projects.forEach((project) => {
        if (touchedProjects.has(project.id)) {
          project.updatedAt = timestamp;
        }
      });
      removedCount = removedItems.length;
    });

    return { success: true, removedCount };
  }

  async isEditorFileAttached(fileId, projectId = null) {
    const targetProjectId = projectId || (await this.getCurrentProjectId());
    const items = await this.listProjectItems(targetProjectId);
    return items.some((item) => item.type === 'editor_file_ref' && item.meta?.fileId === fileId);
  }

  async createProject(name, description = '', options = {}) {
    const nextName = typeof name === 'string' && name.trim() ? name.trim() : '新项目';
    const timestamp = Date.now();
    const project = normalizeProject({
      id: createId('project'),
      name: nextName,
      description,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await this.withState((state) => {
      state.projects.unshift(project);
      state.currentProjectId = project.id;

      const selectedResourceIds = new Set([
        ...(Array.isArray(options?.publicResourceIds) ? options.publicResourceIds.filter(Boolean) : []),
        ...((Array.isArray(options?.bundleIds) ? options.bundleIds : [])
          .map((bundleId) => state.resourceBundles.find((bundle) => bundle.id === bundleId))
          .filter(Boolean)
          .flatMap((bundle) => bundle.resourceIds))
      ]);

      Array.from(selectedResourceIds)
        .map((resourceId) => state.publicResources.find((resource) => resource.id === resourceId))
        .filter(Boolean)
        .forEach((resource) => {
          if (resource.entityType === 'template') {
            state.projectTemplates.unshift(normalizeProjectTemplate({
              ...cloneTemplatePayload(resource),
              projectId: project.id,
              createdAt: timestamp,
              updatedAt: timestamp
            }));
            return;
          }

          state.projectItems.unshift(normalizeProjectItem({
            ...cloneItemPayload(resource),
            projectId: project.id,
            createdAt: timestamp,
            updatedAt: timestamp
          }));
        });
    });

    return clone(project);
  }

  async isResourcePublic(entityType, resourceId) {
    await this.initialize();
    return this.state.publicResources.some((resource) =>
      resource.entityType === entityType && resource.sourceResourceId === resourceId
    );
  }

  async setResourcePublic(entityType, resourceId, isPublic = true) {
    let result = null;
    await this.withState((state) => {
      const existingIndex = state.publicResources.findIndex((resource) =>
        resource.entityType === entityType && resource.sourceResourceId === resourceId
      );

      if (!isPublic) {
        if (existingIndex >= 0) {
          result = clone(state.publicResources[existingIndex]);
          state.publicResources.splice(existingIndex, 1);
          state.resourceBundles = state.resourceBundles.map((bundle) => ({
            ...bundle,
            resourceIds: bundle.resourceIds.filter((id) => id !== result.id),
            updatedAt: Date.now()
          }));
        }
        return;
      }

      const source = findProjectResource(state, entityType, resourceId);
      if (!source) {
        throw new Error('资源不存在');
      }

      const snapshot = buildPublicResourceSnapshot(source, entityType);
      if (existingIndex >= 0) {
        snapshot.id = state.publicResources[existingIndex].id;
        snapshot.createdAt = state.publicResources[existingIndex].createdAt;
        state.publicResources[existingIndex] = snapshot;
      } else {
        state.publicResources.unshift(snapshot);
      }
      result = clone(snapshot);
    });

    return {
      success: true,
      publicResource: result
    };
  }

  async removePublicResource(publicResourceId) {
    let removed = null;
    await this.withState((state) => {
      const index = state.publicResources.findIndex((resource) => resource.id === publicResourceId);
      if (index < 0) {
        return;
      }
      removed = clone(state.publicResources[index]);
      state.publicResources.splice(index, 1);
      state.resourceBundles = state.resourceBundles.map((bundle) => ({
        ...bundle,
        resourceIds: bundle.resourceIds.filter((id) => id !== publicResourceId),
        updatedAt: Date.now()
      }));
    });

    if (!removed) {
      return { success: false, error: '公共资源不存在' };
    }
    return { success: true, resource: removed };
  }

  async createResourceBundle(name, resourceIds = [], description = '') {
    const nextName = typeof name === 'string' && name.trim() ? name.trim() : '未命名资源包';
    const nextResourceIds = Array.isArray(resourceIds) ? Array.from(new Set(resourceIds.filter(Boolean))) : [];
    if (nextResourceIds.length === 0) {
      return { success: false, error: '至少选择一个公共资源' };
    }

    const timestamp = Date.now();
    const bundle = normalizeResourceBundle({
      name: nextName,
      description,
      resourceIds: nextResourceIds,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await this.withState((state) => {
      const validIds = new Set(state.publicResources.map((resource) => resource.id));
      bundle.resourceIds = bundle.resourceIds.filter((id) => validIds.has(id));
      if (bundle.resourceIds.length === 0) {
        throw new Error('所选公共资源不存在');
      }
      state.resourceBundles.unshift(bundle);
    });

    return { success: true, bundle: clone(bundle) };
  }

  async deleteResourceBundle(bundleId) {
    let removed = null;
    await this.withState((state) => {
      const index = state.resourceBundles.findIndex((bundle) => bundle.id === bundleId);
      if (index < 0) {
        return;
      }
      removed = clone(state.resourceBundles[index]);
      state.resourceBundles.splice(index, 1);
    });

    if (!removed) {
      return { success: false, error: '资源包不存在' };
    }
    return { success: true, bundle: removed };
  }

  async copyResourceToProject(entityType, resourceId, targetProjectId) {
    let created = null;
    await this.withState((state) => {
      const targetProject = state.projects.find((project) => project.id === targetProjectId);
      const source = findProjectResource(state, entityType, resourceId);
      if (!targetProject || !source) {
        throw new Error('目标项目或资源不存在');
      }
      const timestamp = Date.now();
      targetProject.updatedAt = timestamp;

      if (entityType === 'template') {
        const template = normalizeProjectTemplate({
          ...cloneTemplatePayload(source),
          projectId: targetProjectId,
          createdAt: timestamp,
          updatedAt: timestamp
        });
        state.projectTemplates.unshift(template);
        created = clone(template);
        return;
      }

      const item = normalizeProjectItem({
        ...cloneItemPayload(source),
        projectId: targetProjectId,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      state.projectItems.unshift(item);
      created = clone(item);
    });

    return { success: true, resource: created };
  }

  async moveResourceToProject(entityType, resourceId, targetProjectId) {
    let moved = null;
    await this.withState((state) => {
      const targetProject = state.projects.find((project) => project.id === targetProjectId);
      const source = findProjectResource(state, entityType, resourceId);
      if (!targetProject || !source) {
        throw new Error('目标项目或资源不存在');
      }
      const timestamp = Date.now();
      targetProject.updatedAt = timestamp;
      const sourceProject = state.projects.find((project) => project.id === source.projectId);
      if (sourceProject) {
        sourceProject.updatedAt = timestamp;
      }
      source.projectId = targetProjectId;
      source.updatedAt = timestamp;
      moved = clone(source);
    });

    return { success: true, resource: moved };
  }

  async deleteProjectResource(entityType, resourceId) {
    let deleted = false;
    await this.withState((state) => {
      const timestamp = Date.now();
      if (entityType === 'template') {
        const template = state.projectTemplates.find((item) => item.id === resourceId);
        if (!template) {
          return;
        }
        state.projectTemplates = state.projectTemplates.filter((item) => item.id !== resourceId);
        state.projectRuns = state.projectRuns.filter((run) => run.templateId !== resourceId);
        const project = state.projects.find((item) => item.id === template.projectId);
        if (project) {
          project.updatedAt = timestamp;
        }
        deleted = true;
        return;
      }

      const item = state.projectItems.find((entry) => entry.id === resourceId);
      if (!item) {
        return;
      }
      state.projectItems = state.projectItems.filter((entry) => entry.id !== resourceId);
      const project = state.projects.find((entry) => entry.id === item.projectId);
      if (project) {
        project.updatedAt = timestamp;
      }
      deleted = true;
    });

    if (!deleted) {
      return { success: false, error: '资源不存在' };
    }
    return { success: true };
  }

  async buildPromptContext(projectId = null) {
    const summary = await this.getProjectSummary(projectId, 5);
    if (!summary?.project) {
      return '';
    }

    const lines = [
      `当前项目：${summary.project.name}`,
      summary.project.description ? `项目描述：${summary.project.description}` : null,
      `项目素材数：${summary.itemCount}`,
      summary.recentItems.length > 0 ? '最近素材：' : null,
      ...summary.recentItems.map((item) => `- [${item.type}] ${item.title}`)
    ].filter(Boolean);

    return lines.join('\n');
  }
}

const projectService = new ProjectService();

if (typeof window !== 'undefined') {
  window.InfinPilotProjects = projectService;
}

export default projectService;
