function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export const DEFAULT_VISIBLE_TOOLS = [
  'browser_get_current_tab',
  'browser_get_visible_text',
  'browser_get_dom',
  'browser_click',
  'browser_fill_input',
  'browser_press_key',
  'browser_scroll',
  'browser_navigate',
  'browser_open_url',
  'browser_switch_tab',
  'browser_screenshot',
  'browser_project',
  'browser_mcp',
  'scraping_get',
  'scraping_current_page',
  'scraping_extract_structured'
];

export const WRITING_VISIBLE_TOOLS = [
  'browser_project',
  'browser_mcp',
  'browser_editor'
];

export const PLANNING_VISIBLE_TOOLS = [
  ...DEFAULT_VISIBLE_TOOLS,
  'browser_list_tabs',
  'browser_wait',
  'browser_bookmarks',
  'browser_history',
  'browser_windows',
  'browser_editor'
];

const FOREGROUND_HINT_TOOLS = new Set([
  'browser_navigate',
  'browser_open_url',
  'browser_switch_tab',
  'browser_click',
  'browser_fill_input',
  'browser_press_key',
  'browser_scroll',
  'browser_screenshot',
  'browser_reload_tab',
  'browser_bookmarks',
  'browser_history',
  'browser_windows'
]);

function slugify(value, fallback = 'role') {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function missionText(plan = {}) {
  return [
    plan.name,
    plan.description,
    plan.mission,
    plan.missionHint,
    plan.style
  ].filter(Boolean).join(' ').toLowerCase();
}

function looksLikeResearch(plan = {}) {
  const text = missionText(plan);
  return /调研|研究|搜索|搜集|收集|查找|查证|分析|对比|资料|文献|research|search|collect|analy|evidence/.test(text);
}

function looksLikeSynthesis(plan = {}) {
  const text = missionText(plan);
  return /整合|汇总|综合|收束|撰写|总结|合并|基于其他|等待前置|接力|报告|report|summary|writer|merge|synth/.test(text);
}

function looksLikeMonitoring(plan = {}) {
  const text = missionText(plan);
  return /监控|监督|观察|盯住|monitor|watch/.test(text);
}

function looksLikeAudit(plan = {}) {
  const text = missionText(plan);
  return /审查|质疑|挑战|挑刺|复核|audit|review|critic|challenge/.test(text);
}

function looksLikeForeground(plan = {}) {
  const text = missionText(plan);
  return /active|foreground|前台|标签页|点击|输入|切页|导航|网页操作|回放|录制/.test(text);
}

function normalizeCollectiveVisibleTools(plan = {}, entryType = 'claim') {
  const requested = Array.isArray(plan.visibleTools) ? plan.visibleTools.filter(Boolean) : [];
  if (requested.length === 0) {
    if (entryType === 'draft') {
      return WRITING_VISIBLE_TOOLS;
    }
    if (looksLikeMonitoring(plan) || looksLikeAudit(plan)) {
      return [...DEFAULT_VISIBLE_TOOLS, 'browser_editor'];
    }
    return DEFAULT_VISIBLE_TOOLS;
  }

  if (looksLikeSynthesis(plan)) {
    return Array.from(new Set([...requested, ...WRITING_VISIBLE_TOOLS]));
  }

  const hasResearchCapability = requested.some((tool) =>
    DEFAULT_VISIBLE_TOOLS.includes(tool)
    || FOREGROUND_HINT_TOOLS.has(tool)
    || String(tool).startsWith('scraping_')
  );

  if (looksLikeResearch(plan) && (!hasResearchCapability || (requested.length === 1 && requested[0] === 'browser_project'))) {
    return DEFAULT_VISIBLE_TOOLS;
  }

  return requested;
}

function normalizeCollectiveExecutionMode(plan = {}) {
  return plan.executionMode === 'foreground' || looksLikeForeground(plan) ? 'foreground' : 'parallel';
}

function normalizeCollectiveCoordinationMode(plan = {}, executionMode = 'parallel') {
  if (executionMode === 'foreground') {
    return 'sequential';
  }
  if (looksLikeSynthesis(plan)) {
    return 'sequential';
  }
  if (looksLikeMonitoring(plan) || looksLikeAudit(plan) || looksLikeResearch(plan)) {
    return 'parallel';
  }
  return plan.coordinationMode === 'sequential' ? 'sequential' : 'parallel';
}

export const DEFAULT_COLLECTIVE_ROLES = [
  {
    id: 'web-evidence',
    name: '网页证据研究员',
    description: '补充一手证据和可引用来源。',
    mission: '查找当前主题最关键的直接证据与来源。',
    missionHint: '优先寻找能推进研究的新证据，不重复已有材料。',
    style: '快速、具体、偏证据',
    forbiddenActions: ['merge_draft'],
    defaultEntryType: 'evidence',
    executionMode: 'parallel',
    coordinationMode: 'parallel',
    visibleTools: DEFAULT_VISIBLE_TOOLS
  },
  {
    id: 'fact-checker',
    name: '事实核验研究员',
    description: '核验关键说法与证据之间是否一致，指出不确定项。',
    mission: '核验主要观点和证据是否可靠。',
    missionHint: '优先处理最关键的结论，明确哪些内容仍需补证。',
    style: '谨慎、严格、重引用',
    forbiddenActions: ['merge_draft'],
    defaultEntryType: 'claim',
    executionMode: 'parallel',
    coordinationMode: 'parallel',
    visibleTools: DEFAULT_VISIBLE_TOOLS
  },
  {
    id: 'synthesizer',
    name: '综合撰稿研究员',
    description: '整合黑板结果，形成可交付研究结论。',
    mission: '在材料足够时整合为研究报告。',
    missionHint: '整理证据、结论和风险，形成清晰报告。',
    style: '清晰、克制、可交付',
    forbiddenActions: ['browser_click', 'browser_fill_input'],
    defaultEntryType: 'draft',
    executionMode: 'parallel',
    coordinationMode: 'sequential',
    visibleTools: WRITING_VISIBLE_TOOLS
  }
];

export const COLLECTIVE_PLANNING_COMMITTEE = [
  {
    id: 'committee-scope',
    name: '范围决策员',
    description: '拆解主题并判断研究组应如何组建。',
    mission: '先把问题拆清楚，再定义最小但有效的研究组。',
    missionHint: '输出研究拆解与建议招募的成员清单。',
    style: '结构化、强调边界',
    forbiddenActions: ['merge_draft'],
    defaultEntryType: 'decision',
    executionMode: 'parallel',
    coordinationMode: 'parallel',
    visibleTools: PLANNING_VISIBLE_TOOLS
  },
  {
    id: 'committee-method',
    name: '方法决策员',
    description: '判断子问题该如何研究，哪些工作需要前台浏览器，哪些可并行。',
    mission: '设计研究方法、工具策略和协作方式。',
    missionHint: '明确每个成员做什么、用什么工具、是否需要前台资源。',
    style: '强调方法、效率和资源分配',
    forbiddenActions: ['merge_draft'],
    defaultEntryType: 'decision',
    executionMode: 'parallel',
    coordinationMode: 'parallel',
    visibleTools: PLANNING_VISIBLE_TOOLS
  },
  {
    id: 'committee-qa',
    name: '收束决策员',
    description: '判断当前研究是否足够，以及还缺哪些关键材料。',
    mission: '决定继续研究还是可以收束成报告。',
    missionHint: '重点判断是否还要追加研究，还是已经可以收束。',
    style: '审慎、收束导向',
    forbiddenActions: ['merge_draft'],
    defaultEntryType: 'decision',
    executionMode: 'parallel',
    coordinationMode: 'parallel',
    visibleTools: PLANNING_VISIBLE_TOOLS
  }
];

export const COLLECTIVE_SUPPORT_ROLES = [
  {
    id: 'support-monitor',
    name: '监控研究员',
    description: '只观察聊天室和工作黑板，不参与普通聊天；一旦发现研究组空谈不推进，就强制要求回到任务或查找外部信息。',
    mission: '监控研究是否真正推进，尤其关注最近是否缺少工作黑板产出。',
    missionHint: '如果发现大家只在聊天室空谈、没有新的黑板结果，就发出明确指令让相应研究员去找外部信息并回写黑板。',
    style: '严格、直接、盯进展',
    forbiddenActions: ['merge_draft'],
    defaultEntryType: 'todo',
    executionMode: 'parallel',
    coordinationMode: 'parallel',
    visibleTools: [...DEFAULT_VISIBLE_TOOLS, 'browser_editor']
  },
  {
    id: 'support-auditor',
    name: '审查研究员',
    description: '只观察聊天室和工作黑板；当研究不够深入、证据不够扎实时，发出质疑并要求重做或深入。',
    mission: '审查黑板结果和聊天内容的质量，识别浅尝辄止、证据薄弱、逻辑跳步的问题。',
    missionHint: '如果工作结果不够好，就在黑板上提出 challenge 或 todo，明确要求谁重做、补证或深入。',
    style: '挑剔、严格、重质量',
    forbiddenActions: ['merge_draft'],
    defaultEntryType: 'challenge',
    executionMode: 'parallel',
    coordinationMode: 'parallel',
    visibleTools: [...DEFAULT_VISIBLE_TOOLS, 'browser_editor']
  },
  {
    id: 'support-reporter',
    name: '报告研究员',
    description: '从研究开始到结束只持续阅读黑板和聊天室，不参与普通聊天；只有在允许收束时才撰写最终报告。',
    mission: '在研究成熟后，综合黑板产出与聊天室协作内容，编写最终研究报告。',
    missionHint: '不要参与普通聊天，不要抢前期任务；只在允许收束时输出最终报告。',
    style: '冷静、系统、可交付',
    forbiddenActions: ['browser_click', 'browser_fill_input'],
    defaultEntryType: 'draft',
    executionMode: 'parallel',
    coordinationMode: 'sequential',
    visibleTools: WRITING_VISIBLE_TOOLS
  }
];

export function getDefaultCollectiveRoles() {
  return clone(DEFAULT_COLLECTIVE_ROLES);
}

export function getCollectivePlanningCommittee() {
  return clone(COLLECTIVE_PLANNING_COMMITTEE);
}

export function getCollectiveSupportRoles() {
  return clone(COLLECTIVE_SUPPORT_ROLES);
}

export function getCollectiveRoleById(roleId) {
  const library = [
    ...DEFAULT_COLLECTIVE_ROLES,
    ...COLLECTIVE_PLANNING_COMMITTEE,
    ...COLLECTIVE_SUPPORT_ROLES
  ];
  return clone(library.find((role) => role.id === roleId) || null);
}

export function buildCollectiveRoleFromPlan(plan = {}, index = 0) {
  const baseName = typeof plan.name === 'string' && plan.name.trim()
    ? plan.name.trim()
    : `研究成员 ${index + 1}`;
  const entryType = typeof plan.defaultEntryType === 'string' && plan.defaultEntryType.trim()
    ? plan.defaultEntryType.trim()
    : 'claim';
  const visibleTools = normalizeCollectiveVisibleTools(plan, entryType);
  const executionMode = normalizeCollectiveExecutionMode(plan);
  const coordinationMode = normalizeCollectiveCoordinationMode(plan, executionMode);

  return {
    id: typeof plan.id === 'string' && plan.id.trim()
      ? plan.id.trim()
      : `dynamic-${slugify(baseName, `member-${index + 1}`)}-${index + 1}`,
    name: baseName,
    description: typeof plan.description === 'string' && plan.description.trim()
      ? plan.description.trim()
      : '围绕主题承担一个清晰的子任务，并把结果写回黑板。',
    mission: typeof plan.mission === 'string' ? plan.mission.trim() : '',
    missionHint: typeof plan.missionHint === 'string' && plan.missionHint.trim()
      ? plan.missionHint.trim()
      : (typeof plan.mission === 'string' && plan.mission.trim()
        ? plan.mission.trim()
        : '围绕自己的子任务推进研究。'),
    style: typeof plan.style === 'string' ? plan.style.trim() : '',
    forbiddenActions: Array.isArray(plan.forbiddenActions) ? plan.forbiddenActions.filter(Boolean) : [],
    defaultEntryType: entryType,
    executionMode,
    coordinationMode,
    visibleTools
  };
}
