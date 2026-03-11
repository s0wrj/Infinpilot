const STORAGE_KEYS = {
  projects: 'infinpilot-projects',
  projectItems: 'infinpilot-project-items',
  projectTemplates: 'infinpilot-project-templates',
  projectRuns: 'infinpilot-project-runs',
  publicResources: 'infinpilot-public-resources',
  resourceBundles: 'infinpilot-resource-bundles',
  currentProjectId: 'infinpilot-current-project-id'
};

function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${random}`;
}

function normalizeTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function cloneObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : fallback;
}

function cloneArray(value) {
  return Array.isArray(value) ? value.map((item) => (item && typeof item === 'object' ? { ...item } : item)) : [];
}

function normalizeProject(project) {
  const now = Date.now();
  return {
    id: typeof project?.id === 'string' && project.id.trim() ? project.id : createId('project'),
    name: typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : '默认项目',
    description: typeof project?.description === 'string' ? project.description : '',
    status: project?.status === 'archived' ? 'archived' : 'active',
    defaultTemplateIds: Array.isArray(project?.defaultTemplateIds) ? project.defaultTemplateIds.filter(Boolean) : [],
    settings: cloneObject(project?.settings),
    createdAt: normalizeTimestamp(project?.createdAt ?? now),
    updatedAt: normalizeTimestamp(project?.updatedAt ?? now)
  };
}

function normalizeProjectItem(item) {
  const now = Date.now();
  return {
    id: typeof item?.id === 'string' && item.id.trim() ? item.id : createId('project-item'),
    projectId: typeof item?.projectId === 'string' ? item.projectId : '',
    type: typeof item?.type === 'string' && item.type.trim() ? item.type.trim() : 'note',
    title: typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : '未命名资源',
    sourceUrl: typeof item?.sourceUrl === 'string' ? item.sourceUrl : '',
    sourceTabId: typeof item?.sourceTabId === 'number' ? item.sourceTabId : null,
    content: item?.content ?? null,
    meta: cloneObject(item?.meta),
    createdAt: normalizeTimestamp(item?.createdAt ?? now),
    updatedAt: normalizeTimestamp(item?.updatedAt ?? now)
  };
}

function normalizeProjectTemplate(template) {
  const now = Date.now();
  const executionMode = String(template?.executionMode || '').trim().toLowerCase();
  return {
    id: typeof template?.id === 'string' && template.id.trim() ? template.id : createId('project-template'),
    projectId: typeof template?.projectId === 'string' ? template.projectId : '',
    name: typeof template?.name === 'string' && template.name.trim() ? template.name.trim() : '未命名模板',
    description: typeof template?.description === 'string' ? template.description : '',
    sourceType: typeof template?.sourceType === 'string' ? template.sourceType : '',
    sourceItemId: typeof template?.sourceItemId === 'string' ? template.sourceItemId : '',
    inputSchema: cloneObject(template?.inputSchema),
    steps: cloneArray(template?.steps),
    allowedTools: Array.isArray(template?.allowedTools) ? template.allowedTools.filter(Boolean) : [],
    outputTargets: Array.isArray(template?.outputTargets) ? template.outputTargets.filter(Boolean) : [],
    retryPolicy: cloneObject(template?.retryPolicy, { maxAttempts: 1 }),
    executionMode: executionMode === 'parallel' ? 'parallel' : 'foreground',
    createdAt: normalizeTimestamp(template?.createdAt ?? now),
    updatedAt: normalizeTimestamp(template?.updatedAt ?? now)
  };
}

function normalizeProjectRun(run) {
  const now = Date.now();
  return {
    id: typeof run?.id === 'string' && run.id.trim() ? run.id : createId('project-run'),
    projectId: typeof run?.projectId === 'string' ? run.projectId : '',
    templateId: typeof run?.templateId === 'string' ? run.templateId : '',
    status: ['pending', 'running', 'success', 'failed', 'needs_input'].includes(run?.status) ? run.status : 'pending',
    input: run?.input ?? null,
    steps: cloneArray(run?.steps),
    outputs: run?.outputs ?? null,
    error: typeof run?.error === 'string' ? run.error : '',
    startedAt: normalizeTimestamp(run?.startedAt ?? now),
    endedAt: run?.endedAt == null ? null : normalizeTimestamp(run.endedAt),
    createdAt: normalizeTimestamp(run?.createdAt ?? now),
    updatedAt: normalizeTimestamp(run?.updatedAt ?? now)
  };
}

function normalizePublicResource(resource) {
  const now = Date.now();
  const entityType = resource?.entityType === 'template' ? 'template' : 'item';
  const executionMode = String(resource?.executionMode || '').trim().toLowerCase();
  return {
    id: typeof resource?.id === 'string' && resource.id.trim() ? resource.id : createId('public-resource'),
    entityType,
    sourceProjectId: typeof resource?.sourceProjectId === 'string' ? resource.sourceProjectId : '',
    sourceResourceId: typeof resource?.sourceResourceId === 'string' ? resource.sourceResourceId : '',
    type: typeof resource?.type === 'string' && resource.type.trim() ? resource.type.trim() : 'note',
    title: typeof resource?.title === 'string' && resource.title.trim()
      ? resource.title.trim()
      : entityType === 'template'
        ? '未命名模板'
        : '未命名资源',
    sourceUrl: typeof resource?.sourceUrl === 'string' ? resource.sourceUrl : '',
    content: resource?.content ?? null,
    meta: cloneObject(resource?.meta),
    name: typeof resource?.name === 'string' ? resource.name : '',
    description: typeof resource?.description === 'string' ? resource.description : '',
    sourceType: typeof resource?.sourceType === 'string' ? resource.sourceType : '',
    sourceItemId: typeof resource?.sourceItemId === 'string' ? resource.sourceItemId : '',
    inputSchema: cloneObject(resource?.inputSchema),
    steps: cloneArray(resource?.steps),
    allowedTools: Array.isArray(resource?.allowedTools) ? resource.allowedTools.filter(Boolean) : [],
    outputTargets: Array.isArray(resource?.outputTargets) ? resource.outputTargets.filter(Boolean) : [],
    retryPolicy: cloneObject(resource?.retryPolicy, { maxAttempts: 1 }),
    executionMode: executionMode === 'parallel' ? 'parallel' : 'foreground',
    createdAt: normalizeTimestamp(resource?.createdAt ?? now),
    updatedAt: normalizeTimestamp(resource?.updatedAt ?? now)
  };
}

function normalizeResourceBundle(bundle) {
  const now = Date.now();
  return {
    id: typeof bundle?.id === 'string' && bundle.id.trim() ? bundle.id : createId('resource-bundle'),
    name: typeof bundle?.name === 'string' && bundle.name.trim() ? bundle.name.trim() : '未命名资源包',
    description: typeof bundle?.description === 'string' ? bundle.description : '',
    resourceIds: Array.isArray(bundle?.resourceIds) ? bundle.resourceIds.filter(Boolean) : [],
    createdAt: normalizeTimestamp(bundle?.createdAt ?? now),
    updatedAt: normalizeTimestamp(bundle?.updatedAt ?? now)
  };
}

function createDefaultProject() {
  return normalizeProject({
    id: createId('project'),
    name: '默认项目',
    description: '用于承接当前聊天、编辑器文件和自动化产物'
  });
}

function normalizeProjectState(rawState = {}) {
  const projects = (Array.isArray(rawState.projects) ? rawState.projects : []).map(normalizeProject);
  if (projects.length === 0) {
    projects.push(createDefaultProject());
  }

  const validProjectIds = new Set(projects.map((project) => project.id));
  const projectItems = (Array.isArray(rawState.projectItems) ? rawState.projectItems : [])
    .map(normalizeProjectItem)
    .filter((item) => validProjectIds.has(item.projectId));
  const projectTemplates = (Array.isArray(rawState.projectTemplates) ? rawState.projectTemplates : [])
    .map(normalizeProjectTemplate)
    .filter((template) => validProjectIds.has(template.projectId));
  const validTemplateIds = new Set(projectTemplates.map((template) => template.id));
  const projectRuns = (Array.isArray(rawState.projectRuns) ? rawState.projectRuns : [])
    .map(normalizeProjectRun)
    .filter((run) => validProjectIds.has(run.projectId))
    .filter((run) => !run.templateId || validTemplateIds.has(run.templateId));

  const publicResources = (Array.isArray(rawState.publicResources) ? rawState.publicResources : [])
    .map(normalizePublicResource);
  const validPublicResourceIds = new Set(publicResources.map((resource) => resource.id));
  const resourceBundles = (Array.isArray(rawState.resourceBundles) ? rawState.resourceBundles : [])
    .map(normalizeResourceBundle)
    .map((bundle) => ({
      ...bundle,
      resourceIds: bundle.resourceIds.filter((resourceId) => validPublicResourceIds.has(resourceId))
    }));

  const requestedCurrentProjectId = typeof rawState.currentProjectId === 'string' ? rawState.currentProjectId : '';
  const currentProjectId = validProjectIds.has(requestedCurrentProjectId) ? requestedCurrentProjectId : projects[0].id;

  const sortByUpdated = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  projects.sort(sortByUpdated);
  projectItems.sort(sortByUpdated);
  projectTemplates.sort(sortByUpdated);
  projectRuns.sort(sortByUpdated);
  publicResources.sort(sortByUpdated);
  resourceBundles.sort(sortByUpdated);

  return {
    projects,
    projectItems,
    projectTemplates,
    projectRuns,
    publicResources,
    resourceBundles,
    currentProjectId
  };
}

async function loadProjectState() {
  const stored = await browser.storage.local.get([
    STORAGE_KEYS.projects,
    STORAGE_KEYS.projectItems,
    STORAGE_KEYS.projectTemplates,
    STORAGE_KEYS.projectRuns,
    STORAGE_KEYS.publicResources,
    STORAGE_KEYS.resourceBundles,
    STORAGE_KEYS.currentProjectId
  ]);

  return normalizeProjectState({
    projects: stored[STORAGE_KEYS.projects],
    projectItems: stored[STORAGE_KEYS.projectItems],
    projectTemplates: stored[STORAGE_KEYS.projectTemplates],
    projectRuns: stored[STORAGE_KEYS.projectRuns],
    publicResources: stored[STORAGE_KEYS.publicResources],
    resourceBundles: stored[STORAGE_KEYS.resourceBundles],
    currentProjectId: stored[STORAGE_KEYS.currentProjectId]
  });
}

async function saveProjectState(state) {
  const normalized = normalizeProjectState(state);
  await browser.storage.local.set({
    [STORAGE_KEYS.projects]: normalized.projects,
    [STORAGE_KEYS.projectItems]: normalized.projectItems,
    [STORAGE_KEYS.projectTemplates]: normalized.projectTemplates,
    [STORAGE_KEYS.projectRuns]: normalized.projectRuns,
    [STORAGE_KEYS.publicResources]: normalized.publicResources,
    [STORAGE_KEYS.resourceBundles]: normalized.resourceBundles,
    [STORAGE_KEYS.currentProjectId]: normalized.currentProjectId
  });
  return normalized;
}

export {
  STORAGE_KEYS,
  createId,
  loadProjectState,
  normalizeProject,
  normalizeProjectItem,
  normalizeProjectTemplate,
  normalizeProjectRun,
  normalizePublicResource,
  normalizeResourceBundle,
  normalizeProjectState,
  saveProjectState
};

export default {
  STORAGE_KEYS,
  createId,
  loadProjectState,
  normalizeProject,
  normalizeProjectItem,
  normalizeProjectTemplate,
  normalizeProjectRun,
  normalizePublicResource,
  normalizeResourceBundle,
  normalizeProjectState,
  saveProjectState
};
