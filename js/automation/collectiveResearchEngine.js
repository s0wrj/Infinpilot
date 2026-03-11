import { generateUniqueId } from '../utils.js';
import BlackboardStore from './blackboardStore.js';
import CollectiveScheduler from './collectiveScheduler.js';
import { buildCollectiveRoleFromPlan, getCollectivePlanningCommittee, getCollectiveSupportRoles } from './agentRoleLibrary.js';
import { normalizeCollectiveAction, toBlackboardEntry } from './collectiveProtocol.js';
import { applyCollectiveToolPolicy } from './toolCatalog.js';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeSafetyCap(value, fallback = 8) {
  return Number.isFinite(value) && value > 0 ? Math.max(2, Math.floor(value)) : fallback;
}

function dedupeByName(members = []) {
  const seen = new Set();
  return members.filter((member) => {
    const key = String(member?.name || '').trim().toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function summarizeMemberNames(members = []) {
  if (!Array.isArray(members) || members.length === 0) {
    return '未组建研究组';
  }
  return members.map((member) => member.name).join('、');
}

function buildBoardSummary(board, limit = 12) {
  if (!board) {
    return '';
  }
  return board.summarizeForPrompt(limit);
}

export default class CollectiveResearchEngine {
  constructor({ tools = [], apiConfig = {}, subAgentEngine = null, callbacks = {} } = {}) {
    this.tools = tools;
    this.apiConfig = apiConfig;
    this.subAgentEngine = subAgentEngine;
    this.callbacks = callbacks;
    this.safetyCycleCap = normalizeSafetyCap(callbacks.maxCycles, 8);
    this.scheduler = new CollectiveScheduler();
    this.sessionId = null;
    this.topic = '';
    this.sharedContext = '';
    this.stopped = false;
    this.phase = 'idle';
    this.currentRound = 0;
    this.executionCursor = 0;
    this.currentRoles = [];
    this.decisionCommittee = [];
    this.teamPlan = null;
    this.workBoard = null;
    this.chatBoard = null;
    this.agentRoster = [];
    this.agentExecutionContexts = new Map();
    this.pendingNoticesByRole = new Map();
    this.latestConclusion = '';
  }

  setTools(tools = []) {
    this.tools = Array.isArray(tools) ? clone(tools) : [];
    if (this.subAgentEngine) {
      this.subAgentEngine.availableTools = this.tools;
    }
  }

  initializeBoards(topic) {
    this.workBoard = new BlackboardStore({
      sessionId: this.sessionId,
      topic
    });
    this.chatBoard = new BlackboardStore({
      sessionId: `${this.sessionId}_chat`,
      topic: ''
    });
    this.chatBoard.addEntry({
      role: 'system',
      entryType: 'reflection',
      action: 'post_note',
      content: `研究聊天室已启动：${topic}`,
      references: [],
      metadata: {
        phase: 'system'
      }
    });
  }

  async startSession({ topic, context = '', roles = [] } = {}) {
    this.sessionId = generateUniqueId();
    this.topic = topic || '群体研究';
    this.sharedContext = context || '';
    this.scheduler = new CollectiveScheduler();
    this.stopped = false;
    this.phase = 'planning';
    this.currentRound = 0;
    this.executionCursor = 0;
    this.agentExecutionContexts = new Map();
    this.pendingNoticesByRole = new Map();
    this.decisionCommittee = getCollectivePlanningCommittee();
    this.currentRoles = Array.isArray(roles) ? clone(roles) : [];
    this.teamPlan = this.currentRoles.length > 0
      ? { members: clone(this.currentRoles), summary: '沿用已有研究组', source: 'preset' }
      : null;
    this.initializeBoards(this.topic);
    if (this.teamPlan) {
      this.workBoard.setTeamPlan(this.teamPlan, { source: 'preset' });
    }
    this.refreshAgentRoster();
    this.callbacks.onSessionStart?.(this.getSnapshot());
    this.callbacks.onBlackboardUpdate?.(null, this.getSnapshot());
    return this.getSnapshot();
  }

  async resumeSession({ snapshot, context = '' } = {}) {
    if (!snapshot) {
      throw new Error('缺少可恢复的群体研究快照');
    }

    this.sessionId = snapshot.sessionId || generateUniqueId();
    this.topic = snapshot.topic || '群体研究';
    this.sharedContext = context || '';
    this.scheduler = new CollectiveScheduler();
    this.stopped = false;
    this.phase = snapshot.phase || 'planning';
    this.currentRound = Number.isFinite(snapshot.currentRound) ? snapshot.currentRound : 0;
    this.executionCursor = 0;
    this.agentExecutionContexts = new Map();
    this.pendingNoticesByRole = new Map();
    this.decisionCommittee = Array.isArray(snapshot.decisionCommittee) && snapshot.decisionCommittee.length > 0
      ? clone(snapshot.decisionCommittee)
      : getCollectivePlanningCommittee();
    this.currentRoles = Array.isArray(snapshot.roles) ? clone(snapshot.roles) : [];
    this.teamPlan = snapshot.teamPlan ? clone(snapshot.teamPlan) : null;
    this.workBoard = BlackboardStore.fromSnapshot(snapshot.workBoard || snapshot.blackboard || {
      sessionId: this.sessionId,
      topic: this.topic
    });
    this.chatBoard = BlackboardStore.fromSnapshot(snapshot.chatBoard || {
      sessionId: `${this.sessionId}_chat`,
      topic: ''
    });
    this.latestConclusion = typeof snapshot.latestConclusion === 'string' ? snapshot.latestConclusion : '';
    this.refreshAgentRoster();
    this.callbacks.onSessionStart?.(this.getSnapshot());
    this.callbacks.onBlackboardUpdate?.(null, this.getSnapshot());
    return this.getSnapshot();
  }

  refreshAgentRoster() {
    const roster = [];
    const appendGroup = (roles, group) => {
      for (const role of roles || []) {
        const existing = roster.find((entry) => entry.id === role.id);
        if (existing) {
          existing.group = group;
          existing.connected = true;
          continue;
        }
        roster.push({
          id: role.id,
          name: role.name,
          description: role.description || '',
          group,
          connected: true,
          executionMode: role.executionMode || 'parallel',
          coordinationMode: role.coordinationMode || 'parallel'
        });
      }
    };

    appendGroup(this.decisionCommittee, 'decision');
    appendGroup(this.currentRoles, 'research');
    this.agentRoster = roster;
  }

  getWorkSummary(limit = 14) {
    return buildBoardSummary(this.workBoard, limit);
  }

  getChatSummary(limit = 10) {
    return buildBoardSummary(this.chatBoard, limit);
  }

  buildCommitteeMission(member, stage = 'planning') {
    const workSummary = this.getWorkSummary(16);
    const chatSummary = this.getChatSummary(10);
    const existingMembers = summarizeMemberNames(this.currentRoles);
    const stagePrompt = stage === 'planning'
      ? [
          '当前任务：决策并组建研究组。',
          '先拆解主题，再判断需要多少研究成员以及每个成员做什么。',
          'teamPlan 里的成员除了 name/description/mission 外，还可以指定 executionMode 和 coordinationMode。',
          '如果某个成员必须串行依赖前一个结果，请把 coordinationMode 设为 sequential。',
          '如果某个成员可以并行推进，请把 coordinationMode 设为 parallel。',
          '请优先输出 action=propose_team，并在 teamPlan 中给出完整成员定义。'
        ]
      : [
          '当前任务：观察研究进展并判断是否继续。',
          '你能看到聊天室和工作黑板上的所有内容，请根据最新信息调整计划。',
          '如果需要继续研究，请输出 shouldContinue=true；如果需要新增或替换成员，也可以附带新的 teamPlan。',
          '如果已经足以收束，请输出 action=propose_conclusion，并设置 shouldConclude=true。'
        ];

    return [
      `研究主题：${this.topic}`,
      `当前阶段：${stage === 'planning' ? '组建研究组' : '复盘与收束'}`,
      `你是：${member.name}`,
      `职责：${member.description}`,
      `当前研究组：${existingMembers}`,
      this.sharedContext ? `共享上下文：\n${this.sharedContext}` : '',
      workSummary ? `工作黑板：\n${workSummary}` : '工作黑板目前还没有足够内容。',
      chatSummary ? `聊天室：\n${chatSummary}` : '',
      stagePrompt.join('\n'),
      [
        '输出必须使用 [COLLECTIVE_ACTION] JSON [/COLLECTIVE_ACTION]。',
        '如果你在调整计划，请让 content 清楚描述为什么要这样调整。'
      ].join('\n')
    ].filter(Boolean).join('\n\n');
  }

  buildRoleMission(role, roundNumber) {
    const workSummary = this.getWorkSummary(18);
    const chatSummary = this.getChatSummary(10);
    const teamSummary = this.teamPlan?.summary || summarizeMemberNames(this.currentRoles);
    return [
      `研究主题：${this.topic}`,
      `当前协作轮次：第 ${roundNumber} 次协作`,
      `研究组概览：${teamSummary}`,
      `你的职责：${role.name}`,
      `角色说明：${role.description}`,
      `本轮重点：${role.missionHint || role.mission || role.description}`,
      this.sharedContext ? `共享上下文：\n${this.sharedContext}` : '',
      workSummary ? `工作黑板：\n${workSummary}` : '工作黑板为空，请先补充关键工作结果。',
      chatSummary ? `聊天室：\n${chatSummary}` : '',
      [
        '你能看到其他所有 agent 在两个黑板上的最新内容。',
        '如果别人的结果影响了你的任务，请在自己的输出里接着推进，不要重复。',
        '输出必须使用 [COLLECTIVE_ACTION] JSON [/COLLECTIVE_ACTION]。'
      ].join('\n')
    ].filter(Boolean).join('\n\n');
  }

  buildFallbackTeamPlan() {
    return {
      source: 'fallback',
      summary: '决策组未能收敛，采用最小可用研究组继续推进。',
      members: [
        buildCollectiveRoleFromPlan({
          name: '网页证据员',
          description: '补充关键页面证据与出处。',
          missionHint: '寻找一手证据和可引用来源。',
          defaultEntryType: 'evidence',
          executionMode: 'foreground',
          coordinationMode: 'sequential'
        }, 0),
        buildCollectiveRoleFromPlan({
          name: '事实核验员',
          description: '核验关键说法，指出不确定项。',
          missionHint: '检查主要结论是否可靠。',
          defaultEntryType: 'claim',
          executionMode: 'parallel',
          coordinationMode: 'parallel'
        }, 1),
        buildCollectiveRoleFromPlan({
          name: '综合撰稿员',
          description: '整理已有结果，形成中间报告。',
          missionHint: '整合已有黑板结果，形成可交付草稿。',
          defaultEntryType: 'draft',
          executionMode: 'parallel',
          coordinationMode: 'parallel',
          visibleTools: ['browser_project', 'browser_mcp', 'browser_editor']
        }, 2)
      ]
    };
  }

  deriveTeamPlan(taskResults = []) {
    const proposedMembers = [];
    const summaries = [];

    for (const taskResult of taskResults) {
      const action = normalizeCollectiveAction(taskResult?.action);
      if (action.teamPlan.length > 0) {
        proposedMembers.push(...action.teamPlan);
      }
      if (action.content) {
        summaries.push(action.content);
      }
    }

    const normalizedMembers = dedupeByName(proposedMembers)
      .slice(0, 6)
      .map((member, index) => buildCollectiveRoleFromPlan(member, index));

    if (normalizedMembers.length === 0) {
      return this.currentRoles.length > 0
        ? {
            source: 'existing',
            summary: '延续现有研究组继续推进。',
            members: clone(this.currentRoles)
          }
        : this.buildFallbackTeamPlan();
    }

    return {
      source: 'committee',
      summary: summaries.slice(-3).join('；') || `研究组由 ${normalizedMembers.length} 名成员组成`,
      members: normalizedMembers
    };
  }

  broadcastMessage(roleName, content, metadata = {}) {
    if (!content) {
      return null;
    }
    const message = this.chatBoard.addEntry({
      role: roleName,
      action: 'post_note',
      entryType: 'reflection',
      content,
      references: [],
      round: Number.isFinite(metadata.round) ? metadata.round : this.currentRound,
      metadata
    });
    this.callbacks.onBroadcast?.(message, this.getSnapshot());
    return message;
  }

  applyTeamPlan(teamPlan) {
    if (!teamPlan || !Array.isArray(teamPlan.members) || teamPlan.members.length === 0) {
      return;
    }
    this.currentRoles = clone(teamPlan.members);
    this.teamPlan = {
      members: clone(teamPlan.members),
      summary: teamPlan.summary || `研究组：${summarizeMemberNames(teamPlan.members)}`,
      source: teamPlan.source || 'committee'
    };
    this.workBoard.setTeamPlan(this.teamPlan, {
      cycle: this.currentRound,
      source: this.teamPlan.source
    });
    this.workBoard.addDecision({
      role: '决策组',
      content: `研究组已更新：${summarizeMemberNames(this.currentRoles)}`,
      metadata: {
        phase: 'team-plan'
      }
    });
    this.broadcastMessage('决策组', `研究组更新：${summarizeMemberNames(this.currentRoles)}`, {
      phase: 'team-plan',
      source: this.teamPlan.source
    });
    this.refreshAgentRoster();
    this.callbacks.onBlackboardUpdate?.(null, this.getSnapshot(), {
      action: 'propose_team',
      teamPlan: clone(this.currentRoles)
    });
  }

  async executeSequentialTask(taskId) {
    const executed = await this.scheduler.executeTask(taskId, (task) => this.executeRoleTask(task));
    return executed?.result || null;
  }

  async runTaskBatch(taskInputs = []) {
    const queuedTasks = taskInputs.map((taskInput) => {
      const roleDescriptor = taskInput.roleDescriptor || null;
      return this.scheduler.enqueueTask({
        ...taskInput,
        roleDescriptor
      });
    });

    const results = [];
    const parallelBuffer = [];

    const flushParallel = async () => {
      if (parallelBuffer.length === 0) {
        return;
      }
      const settled = await Promise.allSettled(
        parallelBuffer.splice(0).map((task) => this.scheduler.executeTask(task.id, (entry) => this.executeRoleTask(entry)))
      );
      for (const item of settled) {
        if (item.status === 'fulfilled' && item.value?.result) {
          results.push(item.value.result);
        }
      }
    };

    for (const task of queuedTasks) {
      if (this.stopped) {
        break;
      }
      const coordinationMode = task.roleDescriptor?.coordinationMode || 'parallel';
      const shouldRunSequentially = task.executionMode === 'foreground' || coordinationMode === 'sequential';
      if (shouldRunSequentially) {
        await flushParallel();
        const result = await this.executeSequentialTask(task.id);
        if (result) {
          results.push(result);
        }
      } else {
        parallelBuffer.push(task);
      }
    }

    await flushParallel();
    return results;
  }

  async ensureTeamPlan() {
    if (this.currentRoles.length > 0) {
      this.refreshAgentRoster();
      return;
    }

    this.phase = 'planning';
    const planningResults = await this.runTaskBatch(
      this.decisionCommittee.map((member, index) => ({
        roleId: member.id,
        roleName: member.name,
        roleDescriptor: member,
        mission: this.buildCommitteeMission(member, 'planning'),
        round: this.currentRound,
        phase: 'planning',
        agentIndex: this.executionCursor + index,
        executionMode: member.executionMode || 'parallel'
      }))
    );
    this.executionCursor += this.decisionCommittee.length;
    const teamPlan = this.deriveTeamPlan(planningResults);
    this.applyTeamPlan(teamPlan);
  }

  hasSufficientEvidence() {
    const entries = this.workBoard?.entries || [];
    const evidenceCount = entries.filter((entry) => entry.entryType === 'evidence').length;
    const claimCount = entries.filter((entry) => entry.entryType === 'claim').length;
    return evidenceCount >= 2 && claimCount >= 1;
  }

  async reviewResearchState() {
    this.phase = 'review';
    const reviewResults = await this.runTaskBatch(
      this.decisionCommittee.map((member, index) => ({
        roleId: member.id,
        roleName: member.name,
        roleDescriptor: member,
        mission: this.buildCommitteeMission(member, 'review'),
        round: this.currentRound,
        phase: 'review',
        agentIndex: this.executionCursor + index,
        executionMode: member.executionMode || 'parallel'
      }))
    );
    this.executionCursor += this.decisionCommittee.length;

    const hasExplicitPlan = reviewResults.some((taskResult) => Array.isArray(taskResult?.action?.teamPlan) && taskResult.action.teamPlan.length > 0);
    if (hasExplicitPlan) {
      this.applyTeamPlan(this.deriveTeamPlan(reviewResults));
    }

    const continueVotes = reviewResults.filter((taskResult) => taskResult?.action?.shouldContinue === true).length;
    const concludeVotes = reviewResults.filter((taskResult) => {
      const action = taskResult?.action || {};
      return action.shouldConclude === true || action.action === 'propose_conclusion';
    }).length;
    const pendingTodos = this.workBoard.getPendingEntries('todo', 6).length;
    const recentChallenges = this.workBoard.getPendingEntries('challenge', 6).length;
    const hasDraft = Boolean(this.workBoard?.draft?.content);
    const evidenceEnough = this.hasSufficientEvidence();

    if (concludeVotes >= 2 || ((concludeVotes >= 1 || hasDraft) && evidenceEnough && pendingTodos === 0 && recentChallenges === 0)) {
      this.latestConclusion = '决策组认为材料已经足以收束。';
      this.broadcastMessage('决策组', this.latestConclusion, {
        phase: 'review',
        shouldConclude: true
      });
      return {
        shouldContinue: false,
        reason: this.latestConclusion
      };
    }

    if (this.currentRound >= this.safetyCycleCap) {
      const reason = '已达到内部安全上限，进入报告收束阶段。';
      this.workBoard.addDecision({
        role: 'system',
        content: reason,
        metadata: {
          phase: 'review'
        }
      });
      this.broadcastMessage('system', reason, {
        phase: 'review',
        shouldConclude: true
      });
      this.latestConclusion = reason;
      return {
        shouldContinue: false,
        reason
      };
    }

    const reason = pendingTodos > 0 || recentChallenges > 0
      ? '决策组认为仍有待办或争议，需要继续研究。'
      : '决策组建议继续推进。';
    this.latestConclusion = reason;
    this.broadcastMessage('决策组', reason, {
      phase: 'review',
      shouldContinue: true
    });
    return {
      shouldContinue: continueVotes > 0 || pendingTodos > 0 || recentChallenges > 0 || !evidenceEnough,
      reason
    };
  }

  async runResearchCycle() {
    if (this.stopped) {
      return { shouldContinue: false, reason: '研究已停止' };
    }

    this.currentRound += 1;
    this.phase = 'research';
    this.callbacks.onRoundStart?.(this.currentRound, this.getSnapshot());

    const activeRoles = this.currentRoles.length > 0 ? this.currentRoles : this.buildFallbackTeamPlan().members;
    const taskResults = await this.runTaskBatch(
      activeRoles.map((role, index) => ({
        roleId: role.id,
        roleName: role.name,
        roleDescriptor: role,
        mission: this.buildRoleMission(role, this.currentRound),
        round: this.currentRound,
        phase: 'research',
        agentIndex: this.executionCursor + index,
        executionMode: role.executionMode || 'parallel'
      }))
    );
    this.executionCursor += activeRoles.length;

    if (!this.stopped && taskResults.length === 0) {
      const reason = '本轮没有产生有效研究结果，将尝试直接收束。';
      this.workBoard.addDecision({
        role: 'system',
        content: reason,
        metadata: { phase: 'research' }
      });
      this.broadcastMessage('system', reason, { phase: 'research' });
      return { shouldContinue: false, reason };
    }

    return this.reviewResearchState();
  }

  async ensureFinalDraft() {
    if (this.workBoard?.draft?.content) {
      return this.workBoard.draft.content;
    }

    const synthesizer = buildCollectiveRoleFromPlan({
      name: '报告整合员',
      description: '综合当前工作黑板和聊天室，输出最终研究报告。',
      missionHint: '整合已有证据、观点和风险，形成最终报告。',
      defaultEntryType: 'draft',
      executionMode: 'parallel',
      coordinationMode: 'sequential',
      visibleTools: ['browser_project', 'browser_mcp', 'browser_editor']
    }, this.currentRoles.length);

    const synthesisResults = await this.runTaskBatch([{
      roleId: synthesizer.id,
      roleName: synthesizer.name,
      roleDescriptor: synthesizer,
      mission: [
        `研究主题：${this.topic}`,
        '请基于工作黑板与聊天室里的内容输出最终研究报告。',
        '报告应包含：结论、关键证据、仍需谨慎的争议点、后续建议。',
        '输出 action=merge_draft 或 entryType=draft。'
      ].join('\n\n'),
      round: this.currentRound,
      phase: 'synthesis',
      agentIndex: this.executionCursor,
      executionMode: 'parallel'
    }]);
    this.executionCursor += 1;

    const action = synthesisResults[0]?.action;
    if (action?.finalReport || action?.content) {
      this.workBoard.setDraft(action.finalReport || action.content, {
        role: synthesizer.name,
        relatedEntryIds: action.relatedEntryIds || [],
        phase: 'synthesis'
      });
    }

    return this.workBoard?.draft?.content || this.buildFinalReport();
  }

  async executeRoleTask(task) {
    const role = clone(task.roleDescriptor || this.currentRoles.find((entry) => entry.id === task.roleId) || this.decisionCommittee.find((entry) => entry.id === task.roleId));
    if (!role) {
      throw new Error(`Unknown collective role: ${task.roleId}`);
    }

    const snapshotBefore = this.getSnapshot();
    this.callbacks.onRoleStart?.(role, task, snapshotBefore);

    let executionContext = null;
    if (typeof this.subAgentEngine?.createExecutionContext === 'function') {
      executionContext = this.agentExecutionContexts.get(role.id) || null;
      if (!executionContext) {
        executionContext = this.subAgentEngine.createExecutionContext(
          Number.isFinite(task.agentIndex) ? task.agentIndex : this.executionCursor,
          {
            agent_name: role.name,
            task: task.mission
          }
        );
        executionContext.keepCollectiveSessionAlive = true;
        executionContext.shouldPreserveCurrentTab = true;
        this.agentExecutionContexts.set(role.id, executionContext);
      } else {
        executionContext.agentIndex = Number.isFinite(task.agentIndex) ? task.agentIndex : executionContext.agentIndex;
        executionContext.agentName = role.name;
        executionContext.taskText = task.mission;
        executionContext.keepCollectiveSessionAlive = true;
      }
      executionContext.forceForeground = role.executionMode === 'foreground';
    }

    let result;
    if (typeof this.subAgentEngine?.executeCollectiveAgent === 'function') {
      result = await this.subAgentEngine.executeCollectiveAgent({
        role,
        mission: task.mission,
        sharedContext: this.sharedContext,
        blackboardSnapshot: {
          workBoard: this.workBoard.getSnapshot(),
          chatBoard: this.chatBoard.getSnapshot(),
          entries: this.workBoard.entries
        },
        visible_tools: applyCollectiveToolPolicy(role, this.tools).map((tool) => tool.name)
      }, [], executionContext, Number.isFinite(task.agentIndex) ? task.agentIndex : this.executionCursor);
    } else {
      result = {
        status: 'success',
        actionData: {
          action: 'post_note',
          entryType: role.defaultEntryType || 'claim',
          content: `${role.name} 已完成本轮任务。`,
          references: []
        }
      };
    }

    const action = normalizeCollectiveAction(result?.actionData, {
      action: 'post_note',
      entryType: role.defaultEntryType || 'claim',
      content: result?.summary || result?.findings || `${role.name} 完成了一轮分析。`,
      references: result?.sources || []
    });

    const shouldWriteOnlyToChat = action.entryType === 'reflection' && action.action === 'post_note';
    const entry = shouldWriteOnlyToChat
      ? null
      : this.workBoard.addEntry(toBlackboardEntry(action, {
        role: role.name,
        round: task.round,
        metadata: {
          phase: task.phase,
          mission: task.mission
        }
      }));

    if (
      action.entryType === 'decision' ||
      action.action === 'claim_complete' ||
      action.action === 'propose_team' ||
      action.action === 'propose_conclusion'
    ) {
      this.workBoard.addDecision({
        role: role.name,
        content: action.content,
        relatedEntryIds: action.relatedEntryIds,
        metadata: {
          phase: task.phase,
          shouldContinue: action.shouldContinue,
          shouldConclude: action.shouldConclude
        }
      });
    }

    if (action.entryType === 'draft' || action.action === 'merge_draft' || action.finalReport) {
      this.workBoard.setDraft(action.finalReport || action.content, {
        role: role.name,
        relatedEntryIds: action.relatedEntryIds,
        phase: task.phase
      });
    }

    if (action.action === 'propose_team' && action.teamPlan.length > 0) {
      this.broadcastMessage(role.name, `${role.name} 提交了新的研究组方案。`, {
        phase: task.phase,
        teamPlan: clone(action.teamPlan)
      });
    } else {
      this.broadcastMessage(role.name, action.rationale || action.content || `${role.name} 发布了一条更新。`, {
        phase: task.phase,
        entryType: action.entryType,
        relatedEntryIds: action.relatedEntryIds,
        shouldContinue: action.shouldContinue,
        shouldConclude: action.shouldConclude
      });
    }

    const snapshotAfter = this.getSnapshot();
    if (!shouldWriteOnlyToChat) {
      this.callbacks.onBlackboardUpdate?.(entry, snapshotAfter, action, role);
    }
    this.callbacks.onRoleComplete?.(role, action, result, snapshotAfter);
    return { role, action, result, entry };
  }

  buildFinalReport() {
    const snapshot = this.workBoard?.getSnapshot();
    if (!snapshot) {
      return '';
    }

    if (snapshot.draft?.content) {
      return snapshot.draft.content;
    }

    const decisions = snapshot.decisions.map((item) => `- ${item.content}`).join('\n');
    const evidence = snapshot.entries
      .filter((entry) => entry.entryType === 'evidence')
      .slice(-6)
      .map((entry) => `- ${entry.content}`)
      .join('\n');
    const challenges = snapshot.entries
      .filter((entry) => entry.entryType === 'challenge')
      .slice(-4)
      .map((entry) => `- ${entry.content}`)
      .join('\n');

    return [
      `主题：${this.topic}`,
      decisions ? `结论：\n${decisions}` : '',
      evidence ? `关键证据：\n${evidence}` : '',
      challenges ? `争议与风险：\n${challenges}` : ''
    ].filter(Boolean).join('\n\n');
  }

  async runUntilSettled() {
    await this.ensureTeamPlan();

    this.stopped = false;
    let continuation = { shouldContinue: true, reason: '' };
    while (!this.stopped) {
      continuation = await this.runResearchCycle();
      if (!continuation.shouldContinue) {
        break;
      }
    }

    const finalReport = await this.ensureFinalDraft();
    this.phase = this.stopped ? 'stopped' : 'paused';

    const result = {
      sessionId: this.sessionId,
      topic: this.topic,
      roundsCompleted: this.currentRound,
      finalReport,
      reason: continuation.reason,
      snapshot: this.getSnapshot()
    };
    this.callbacks.onSessionComplete?.(result, this.getSnapshot());
    return result;
  }

  stopSession() {
    this.stopped = true;
    this.phase = 'stopped';
    this.broadcastMessage('system', '研究已由用户手动结束。', {
      phase: 'stopped'
    });
    for (const context of this.agentExecutionContexts.values()) {
      context.keepCollectiveSessionAlive = false;
      void this.subAgentEngine?.closeSubAgentTabs?.(context, { status: 'stopped' });
    }
    this.agentExecutionContexts.clear();
    this.callbacks.onSessionStopped?.(this.getSnapshot());
  }

  getSnapshot() {
    return clone({
      sessionId: this.sessionId,
      topic: this.topic,
      currentRound: this.currentRound,
      maxRounds: null,
      phase: this.phase,
      roles: this.currentRoles,
      decisionCommittee: this.decisionCommittee,
      teamPlan: this.teamPlan,
      blackboard: this.workBoard?.getSnapshot() || null,
      workBoard: this.workBoard?.getSnapshot() || null,
      chatBoard: this.chatBoard?.getSnapshot() || null,
      scheduler: this.scheduler.getSnapshot(),
      agentRoster: this.agentRoster,
      latestConclusion: this.latestConclusion,
      status: this.stopped ? 'stopped' : 'paused'
    });
  }
}

CollectiveResearchEngine.prototype.buildCommitteeMission = function buildCommitteeMissionOverride(member, stage = 'planning') {
  const workSummary = this.getWorkSummary(16);
  const chatSummary = this.getChatSummary(10);
  const existingMembers = summarizeMemberNames(this.currentRoles);
  const planningPrompt = [
    '当前任务：先讨论并拆解研究主题，再决定研究组如何组建。',
    '请判断需要多少研究员、每个研究员负责什么、哪些工作可以并行、哪些必须串行。',
    'teamPlan 里的每个成员都可以指定 name、description、mission、missionHint、visibleTools、executionMode、coordinationMode。',
    '任何需要在当前 active 标签页点击、输入、切页、导航或模板回放的研究员，必须设置 executionMode=foreground，并同时设置 coordinationMode=sequential。',
    '只有不需要前台浏览器交互的研究员，才允许保持 parallel。',
    '优先输出 action=propose_team，并给出完整 teamPlan。'
  ];
  const reviewPrompt = [
    '当前任务：根据聊天室和工作黑板的最新内容，判断研究是继续推进、改组研究组，还是可以收束。',
    '如果需要继续研究，请输出 shouldContinue=true；如果需要新增或替换成员，也可以附带新的 teamPlan。',
    '如果已经足够收束，请输出 action=propose_conclusion，并设置 shouldConclude=true。',
    '如果新的计划里包含前台网页操作角色，仍然必须把这些成员标记为 foreground + sequential。'
  ];

  return [
    `研究主题：${this.topic}`,
    `当前阶段：${stage === 'planning' ? '组建研究组' : '复盘与收束'}`,
    `你是：${member.name}`,
    `职责：${member.description}`,
    `当前研究组：${existingMembers}`,
    this.sharedContext ? `共享上下文：\n${this.sharedContext}` : '',
    workSummary ? `工作黑板：\n${workSummary}` : '工作黑板目前还没有足够内容。',
    chatSummary ? `聊天室：\n${chatSummary}` : '聊天室目前还没有新的讨论。',
    (stage === 'planning' ? planningPrompt : reviewPrompt).join('\n'),
    [
      '输出必须使用 [COLLECTIVE_ACTION] JSON [/COLLECTIVE_ACTION]。',
      '如果你在调整计划，请在 content 或 rationale 里明确说明为什么要这样调整。'
    ].join('\n')
  ].filter(Boolean).join('\n\n');
};

CollectiveResearchEngine.prototype.buildRoleMission = function buildRoleMissionOverride(role, roundNumber) {
  const workSummary = this.getWorkSummary(18);
  const chatSummary = this.getChatSummary(10);
  const teamSummary = this.teamPlan?.summary || summarizeMemberNames(this.currentRoles);
  return [
    `研究主题：${this.topic}`,
    `当前协作轮次：第 ${roundNumber} 次协作`,
    `研究组概览：${teamSummary}`,
    `你的角色：${role.name}`,
    `角色说明：${role.description}`,
    `本轮重点：${role.missionHint || role.mission || role.description}`,
    this.sharedContext ? `共享上下文：\n${this.sharedContext}` : '',
    workSummary ? `工作黑板：\n${workSummary}` : '工作黑板为空，请先补充关键工作结果。',
    chatSummary ? `聊天室：\n${chatSummary}` : '聊天室还没有新消息。',
    [
      '你能看到其他所有 agent 在聊天室和工作黑板上的最新内容。',
      '你的主任务不是闲聊，而是推进研究：优先查找外部信息、补证、核验、整理，并把正式结果写入工作黑板。',
      '除非当前任务明确要求聊天室反馈，否则不要把 entryType="reflection" 当成这一轮的主产出。',
      '如果别人的结果影响了你的任务，请接着推进，不要重复劳动。',
      role.executionMode === 'foreground'
        ? '你被标记为前台研究员。涉及 active 标签页的操作必须串行执行，等待调度器安排，不要假设自己能与其他前台研究员并发点击或输入。'
        : '如果你不需要前台网页交互，就优先并行推进自己的研究任务。',
      '输出必须使用 [COLLECTIVE_ACTION] JSON [/COLLECTIVE_ACTION]。'
    ].join('\n')
  ].filter(Boolean).join('\n\n');
};

CollectiveResearchEngine.prototype.getRoleDescriptorById = function getRoleDescriptorById(roleId) {
  return clone(
    this.currentRoles.find((entry) => entry.id === roleId)
    || this.decisionCommittee.find((entry) => entry.id === roleId)
    || null
  );
};

CollectiveResearchEngine.prototype.getLatestRoleStatus = function getLatestRoleStatus(roleId) {
  const tasks = Array.isArray(this.scheduler?.tasks) ? this.scheduler.tasks : [];
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    if (tasks[index]?.roleId === roleId && tasks[index]?.phase !== 'chat-review') {
      return tasks[index].status || 'idle';
    }
  }
  return 'idle';
};

CollectiveResearchEngine.prototype.enqueuePendingNotice = function enqueuePendingNotice(roleId, notice) {
  if (!roleId || !notice) {
    return;
  }
  const queue = this.pendingNoticesByRole.get(roleId) || [];
  queue.push(clone(notice));
  this.pendingNoticesByRole.set(roleId, queue.slice(-8));
};

CollectiveResearchEngine.prototype.getWorkEntryById = function getWorkEntryById(entryId) {
  if (!entryId) {
    return null;
  }
  return clone((this.workBoard?.entries || []).find((entry) => entry.id === entryId) || null);
};

CollectiveResearchEngine.prototype.buildNoticeResultDigest = function buildNoticeResultDigest(notices = []) {
  const latestNotices = (Array.isArray(notices) ? notices : []).slice(-3);
  return latestNotices.map((notice, index) => {
    const sourceEntryId = notice?.metadata?.sourceEntryId || notice?.sourceEntryId || null;
    const sourceEntry = this.getWorkEntryById(sourceEntryId);
    if (!sourceEntry) {
      return `${index + 1}. ${notice?.content || '有新的工作黑板结果，请阅读后反馈。'}`;
    }
    const entryType = sourceEntry.entryType || 'note';
    const roleName = sourceEntry.role || '未知成员';
    const content = String(sourceEntry.content || '').trim().slice(0, 400);
    return [
      `${index + 1}. ${roleName} 的新结果`,
      `类型：${entryType}`,
      `内容：${content || '（内容为空）'}`
    ].join('\n');
  }).join('\n\n');
};

CollectiveResearchEngine.prototype.buildBroadcastNotice = function buildBroadcastNotice(role, action, entry, task, overrideMessage = '') {
  const entryLabelMap = {
    question: '问题',
    claim: '观点',
    evidence: '研究结果',
    challenge: '争议',
    todo: '待办',
    draft: '草稿',
    decision: '决策',
    team_plan: '组队方案',
    reflection: '聊天消息'
  };
  const label = entryLabelMap[action.entryType] || '研究结果';
  const content = overrideMessage || `${role.name} 在工作黑板新增了${label}，请查看后反馈。`;
  return this.broadcastMessage(role.name, content, {
    phase: task.phase,
    entryType: action.entryType,
    sourceRoleId: role.id,
    sourceEntryId: entry?.id || null,
    isWorkResultNotice: true
  });
};

CollectiveResearchEngine.prototype.buildChatReactionMission = function buildChatReactionMission(role, notices = []) {
  const latestNotices = (Array.isArray(notices) ? notices : []).slice(-3);
  const workSummary = this.getWorkSummary(10);
  const chatSummary = this.getChatSummary(12);
  const noticeSummary = latestNotices.map((notice, index) => (
    `${index + 1}. ${notice.content || '有新的研究结果广播'}`
  )).join('\n');
  const resultDigest = this.buildNoticeResultDigest(latestNotices);
  return [
    `研究主题：${this.topic}`,
    `你的角色：${role.name}`,
    '当前任务：阅读聊天室广播里提到的新工作结果，然后在聊天室自由交流。',
    '你的反馈可以是点评、质疑、补充、追问、提醒风险，或者告诉别人你接下来准备做什么。',
    '如果你认为自己之前已经完成的任务并不完善，需要重新启动补充，请设置 shouldContinue=true，并在 content 中明确说出需要补什么。',
    noticeSummary ? `本次需要响应的广播：\n${noticeSummary}` : '',
    resultDigest ? `本次广播对应的工作黑板结果：\n${resultDigest}` : '',
    workSummary ? `工作黑板摘要：\n${workSummary}` : '',
    chatSummary ? `聊天室摘要：\n${chatSummary}` : '',
    '请优先输出 entryType="reflection" 的反馈内容；只有在你要提交正式工作结果时，才改用黑板条目类型。'
  ].filter(Boolean).join('\n\n');
};

CollectiveResearchEngine.prototype.runChatReactionPass = async function runChatReactionPass(notice, excludeRoleId = '') {
  const allRoles = [...this.decisionCommittee, ...this.currentRoles];
  const immediateReactions = [];
  const auditor = (this.supportRoles || []).find((role) => role.id === 'support-auditor');

  for (const role of allRoles) {
    if (!role?.id || role.id === excludeRoleId) {
      continue;
    }
    const status = this.getLatestRoleStatus(role.id);
    if (status === 'running') {
      this.enqueuePendingNotice(role.id, notice);
      this.broadcastMessage(role.name, `${role.name} 已看到新的工作黑板更新，当前步骤结束后会回来反馈。`, {
        phase: 'chat-review-pending',
        entryType: 'reflection',
        sourceRoleId: role.id,
        sourceEntryId: notice?.metadata?.sourceEntryId || null,
        isReactionPending: true
      });
      continue;
    }
    if (!['queued', 'done', 'paused_waiting_input', 'failed'].includes(status)) {
      continue;
    }
    immediateReactions.push(this.executeRoleTask({
      roleId: role.id,
      roleName: role.name,
      roleDescriptor: role,
      mission: this.buildChatReactionMission(role, [notice]),
      round: this.currentRound,
      phase: 'chat-review',
      agentIndex: this.executionCursor++,
      executionMode: 'parallel'
    }));
  }

  if (immediateReactions.length > 0) {
    await Promise.allSettled(immediateReactions);
  }

  if (auditor && notice?.metadata?.isWorkResultNotice) {
    const auditorStatus = this.getLatestRoleStatus(auditor.id);
    if (auditorStatus === 'running') {
      this.enqueuePendingNotice(auditor.id, notice);
    } else {
      await this.executeRoleTask({
        roleId: auditor.id,
        roleName: auditor.name,
        roleDescriptor: auditor,
        mission: this.buildAuditMissionFromNotice(auditor, notice),
        round: this.currentRound,
        phase: 'support-audit',
        agentIndex: this.executionCursor++,
        executionMode: 'parallel'
      });
    }
  }
};

CollectiveResearchEngine.prototype.flushPendingReactionsForRole = async function flushPendingReactionsForRole(roleId) {
  const notices = this.pendingNoticesByRole.get(roleId) || [];
  if (notices.length === 0) {
    return null;
  }
  this.pendingNoticesByRole.delete(roleId);
  const role = this.getRoleDescriptorById(roleId);
  if (!role) {
    return null;
  }

  if (role.id === 'support-auditor') {
    let latestResult = null;
    for (const notice of notices) {
      latestResult = await this.executeRoleTask({
        roleId: role.id,
        roleName: role.name,
        roleDescriptor: role,
        mission: this.buildAuditMissionFromNotice(role, notice),
        round: this.currentRound,
        phase: 'support-audit',
        agentIndex: this.executionCursor++,
        executionMode: 'parallel'
      });
    }
    return latestResult;
  }

  const review = await this.executeRoleTask({
    roleId: role.id,
    roleName: role.name,
    roleDescriptor: role,
    mission: this.buildChatReactionMission(role, notices),
    round: this.currentRound,
    phase: 'chat-review',
    agentIndex: this.executionCursor++,
    executionMode: 'parallel'
  });

  if (review?.action?.shouldContinue === true) {
    return this.executeRoleTask({
      roleId: role.id,
      roleName: role.name,
      roleDescriptor: role,
      mission: `${role.missionHint || role.mission || role.description}\n\n补充要求：请根据聊天室里提到的缺口，重新审视并补强你之前的工作。`,
      round: this.currentRound,
      phase: 'rework',
      agentIndex: this.executionCursor++,
      executionMode: role.executionMode || 'parallel'
    });
  }

  return review;
};

function looksLikeIndependentParallelTask(role = {}) {
  const text = [
    role.name,
    role.description,
    role.mission,
    role.missionHint
  ].filter(Boolean).join(' ').toLowerCase();
  const researchLike = /调研|研究|搜索|搜集|收集|查找|查证|分析|对比|资料|文献|research|search|collect|analy|evidence/.test(text);
  const synthesisLike = /整合|汇总|综合|收束|撰写|总结|合并|基于其他|等待前置|接力|synth|merge|summary|report|writer/.test(text);
  return researchLike && !synthesisLike;
}

CollectiveResearchEngine.prototype.runTaskBatch = async function runTaskBatchOverride(taskInputs = []) {
  const queuedTasks = taskInputs.map((taskInput) => {
    const roleDescriptor = taskInput.roleDescriptor || null;
    return this.scheduler.enqueueTask({
      ...taskInput,
      roleDescriptor
    });
  });

  const results = [];
  const parallelBuffer = [];

  const flushParallel = async () => {
    if (parallelBuffer.length === 0) {
      return;
    }
    const settled = await Promise.allSettled(
      parallelBuffer.splice(0).map((task) => this.scheduler.executeTask(task.id, (entry) => this.executeRoleTask(entry)))
    );
    for (const item of settled) {
      if (item.status === 'fulfilled' && item.value?.result) {
        results.push(item.value.result);
      }
    }
  };

  for (const task of queuedTasks) {
    if (this.stopped) {
      break;
    }
    const coordinationMode = task.roleDescriptor?.coordinationMode || 'parallel';
    const forceParallel = task.executionMode !== 'foreground' && looksLikeIndependentParallelTask(task.roleDescriptor || task);
    const shouldRunSequentially = task.executionMode === 'foreground' || (!forceParallel && coordinationMode === 'sequential');
    if (shouldRunSequentially) {
      await flushParallel();
      const result = await this.executeSequentialTask(task.id);
      if (result) {
        results.push(result);
      }
    } else {
      parallelBuffer.push(task);
    }
  }

  await flushParallel();
  return results;
};

CollectiveResearchEngine.prototype.executeRoleTask = async function executeRoleTaskOverride(task) {
  const role = this.getRoleDescriptorById(task.roleId) || clone(task.roleDescriptor);
  if (!role) {
    throw new Error(`Unknown collective role: ${task.roleId}`);
  }

  const snapshotBefore = this.getSnapshot();
  this.callbacks.onRoleStart?.(role, task, snapshotBefore);

  let executionContext = null;
  if (typeof this.subAgentEngine?.createExecutionContext === 'function') {
    executionContext = this.agentExecutionContexts.get(role.id) || null;
    if (!executionContext) {
      executionContext = this.subAgentEngine.createExecutionContext(
        Number.isFinite(task.agentIndex) ? task.agentIndex : this.executionCursor,
        {
          agent_name: role.name,
          task: task.mission
        }
      );
      executionContext.keepCollectiveSessionAlive = true;
      executionContext.shouldPreserveCurrentTab = true;
      this.agentExecutionContexts.set(role.id, executionContext);
    } else {
      executionContext.agentIndex = Number.isFinite(task.agentIndex) ? task.agentIndex : executionContext.agentIndex;
      executionContext.agentName = role.name;
      executionContext.taskText = task.mission;
      executionContext.keepCollectiveSessionAlive = true;
    }
    executionContext.forceForeground = role.executionMode === 'foreground';
  }

  let result;
  if (typeof this.subAgentEngine?.executeCollectiveAgent === 'function') {
    const visibleTools = task.phase === 'chat-review'
      ? []
      : applyCollectiveToolPolicy(role, this.tools).map((tool) => tool.name);
    result = await this.subAgentEngine.executeCollectiveAgent({
      role,
      mission: task.mission,
      sharedContext: this.sharedContext,
      blackboardSnapshot: {
        workBoard: this.workBoard.getSnapshot(),
        chatBoard: this.chatBoard.getSnapshot(),
        entries: this.workBoard.entries
      },
      visible_tools: visibleTools
    }, [], executionContext, Number.isFinite(task.agentIndex) ? task.agentIndex : this.executionCursor);
  } else {
    result = {
      status: 'success',
      actionData: {
        action: 'post_note',
        entryType: role.defaultEntryType || 'claim',
        content: `${role.name} 完成了一次协作。`,
        references: []
      }
    };
  }

  const fallbackAction = task.phase === 'chat-review'
    ? {
        action: 'post_note',
        entryType: 'reflection',
        content: result?.summary || result?.findings || `${role.name} 已阅读最新广播并给出反馈。`,
        references: result?.sources || []
      }
    : {
        action: 'post_note',
        entryType: role.defaultEntryType || 'claim',
        content: result?.summary || result?.findings || `${role.name} 完成了一轮分析。`,
        references: result?.sources || []
      };

  const action = normalizeCollectiveAction(result?.actionData, fallbackAction);
  const shouldWriteOnlyToChat = task.phase === 'chat-review' || (action.entryType === 'reflection' && action.action === 'post_note');
  const entry = shouldWriteOnlyToChat
    ? null
    : this.workBoard.addEntry(toBlackboardEntry(action, {
      role: role.name,
      round: task.round,
      metadata: {
        phase: task.phase,
        mission: task.mission
      }
    }));

  if (
    !shouldWriteOnlyToChat && (
      action.entryType === 'decision'
      || action.action === 'claim_complete'
      || action.action === 'propose_team'
      || action.action === 'propose_conclusion'
    )
  ) {
    this.workBoard.addDecision({
      role: role.name,
      content: action.content,
      relatedEntryIds: action.relatedEntryIds,
      metadata: {
        phase: task.phase,
        shouldContinue: action.shouldContinue,
        shouldConclude: action.shouldConclude
      }
    });
  }

  if (!shouldWriteOnlyToChat && (action.entryType === 'draft' || action.action === 'merge_draft' || action.finalReport)) {
    this.workBoard.setDraft(action.finalReport || action.content, {
      role: role.name,
      relatedEntryIds: action.relatedEntryIds,
      phase: task.phase
    });
  }

  let broadcastNotice = null;
  if (action.action === 'propose_team' && action.teamPlan.length > 0) {
    broadcastNotice = this.buildBroadcastNotice(role, action, entry, task, `${role.name} 在工作黑板提交了新的研究组方案，请查看。`);
  } else if (shouldWriteOnlyToChat) {
    broadcastNotice = this.broadcastMessage(role.name, action.content || action.rationale || `${role.name} 在聊天室发出了一条消息。`, {
      phase: task.phase,
      entryType: 'reflection',
      relatedEntryIds: action.relatedEntryIds,
      sourceRoleId: role.id
    });
  } else {
    broadcastNotice = this.buildBroadcastNotice(role, action, entry, task);
  }

  const snapshotAfter = this.getSnapshot();
  if (!shouldWriteOnlyToChat) {
    this.callbacks.onBlackboardUpdate?.(entry, snapshotAfter, action, role);
  }
  this.callbacks.onRoleComplete?.(role, action, result, snapshotAfter);

  if (broadcastNotice && !shouldWriteOnlyToChat) {
    await this.runChatReactionPass(broadcastNotice, role.id);
  }
  if (task.phase !== 'chat-review' && task.phase !== 'rework') {
    await this.flushPendingReactionsForRole(role.id);
  }

  return { role, action, result, entry };
};

function collectiveRoleGroup(roleId = '') {
  if (String(roleId).startsWith('committee-')) {
    return 'decision';
  }
  if (String(roleId).startsWith('support-')) {
    return 'support';
  }
  return 'research';
}

function shouldForceWorkOutput(task = {}, role = {}) {
  if (task.phase === 'chat-review') {
    return false;
  }
  if (task.phase === 'support-monitor') {
    return false;
  }
  if (task.phase === 'support-audit') {
    return true;
  }
  if (task.phase === 'synthesis') {
    return true;
  }
  return collectiveRoleGroup(role.id) !== 'support';
}

function buildFallbackWorkAction(action, role, task, result) {
  const defaultEntryType = task.phase === 'planning' || task.phase === 'review'
    ? 'decision'
    : (task.phase === 'synthesis' || role.defaultEntryType === 'draft' ? 'draft' : (role.defaultEntryType || 'claim'));
  return normalizeCollectiveAction(action, {
    action: task.phase === 'synthesis' ? 'merge_draft' : 'post_note',
    entryType: defaultEntryType,
    content: result?.summary || result?.findings || action?.content || `${role.name} 产出了一条新的研究结果。`,
    references: result?.sources || action?.references || []
  });
}

function shouldSkipChatReviewForRole(role = {}) {
  return collectiveRoleGroup(role.id) === 'support';
}

CollectiveResearchEngine.prototype.startSession = async function startSessionOverride({ topic, context = '', roles = [] } = {}) {
  this.sessionId = generateUniqueId();
  this.topic = topic || '群体研究';
  this.sharedContext = context || '';
  this.scheduler = new CollectiveScheduler();
  this.stopped = false;
  this.phase = 'planning';
  this.currentRound = 0;
  this.executionCursor = 0;
  this.agentExecutionContexts = new Map();
  this.pendingNoticesByRole = new Map();
  this.decisionCommittee = getCollectivePlanningCommittee();
  this.supportRoles = getCollectiveSupportRoles();
  this.currentRoles = Array.isArray(roles) ? clone(roles) : [];
  this.teamPlan = this.currentRoles.length > 0
    ? { members: clone(this.currentRoles), summary: '沿用已有研究组', source: 'preset' }
    : null;
  this.initializeBoards(this.topic);
  if (this.teamPlan) {
    this.workBoard.setTeamPlan(this.teamPlan, { source: 'preset' });
  }
  this.refreshAgentRoster();
  this.callbacks.onSessionStart?.(this.getSnapshot());
  this.callbacks.onBlackboardUpdate?.(null, this.getSnapshot());
  return this.getSnapshot();
};

CollectiveResearchEngine.prototype.resumeSession = async function resumeSessionOverride({ snapshot, context = '' } = {}) {
  if (!snapshot) {
    throw new Error('缺少可恢复的群体研究快照');
  }

  this.sessionId = snapshot.sessionId || generateUniqueId();
  this.topic = snapshot.topic || '群体研究';
  this.sharedContext = context || '';
  this.scheduler = new CollectiveScheduler();
  this.stopped = false;
  this.phase = snapshot.phase || 'planning';
  this.currentRound = Number.isFinite(snapshot.currentRound) ? snapshot.currentRound : 0;
  this.executionCursor = 0;
  this.agentExecutionContexts = new Map();
  this.pendingNoticesByRole = new Map();
  this.decisionCommittee = Array.isArray(snapshot.decisionCommittee) && snapshot.decisionCommittee.length > 0
    ? clone(snapshot.decisionCommittee)
    : getCollectivePlanningCommittee();
  this.supportRoles = Array.isArray(snapshot.supportRoles) && snapshot.supportRoles.length > 0
    ? clone(snapshot.supportRoles)
    : getCollectiveSupportRoles();
  this.currentRoles = Array.isArray(snapshot.roles) ? clone(snapshot.roles) : [];
  this.teamPlan = snapshot.teamPlan ? clone(snapshot.teamPlan) : null;
  this.workBoard = BlackboardStore.fromSnapshot(snapshot.workBoard || snapshot.blackboard || {
    sessionId: this.sessionId,
    topic: this.topic
  });
  this.chatBoard = BlackboardStore.fromSnapshot(snapshot.chatBoard || {
    sessionId: `${this.sessionId}_chat`,
    topic: ''
  });
  this.latestConclusion = typeof snapshot.latestConclusion === 'string' ? snapshot.latestConclusion : '';
  this.refreshAgentRoster();
  this.callbacks.onSessionStart?.(this.getSnapshot());
  this.callbacks.onBlackboardUpdate?.(null, this.getSnapshot());
  return this.getSnapshot();
};

CollectiveResearchEngine.prototype.refreshAgentRoster = function refreshAgentRosterOverride() {
  const roster = [];
  const appendGroup = (roles, group) => {
    for (const role of roles || []) {
      const existing = roster.find((entry) => entry.id === role.id);
      if (existing) {
        existing.group = group;
        existing.connected = true;
        continue;
      }
      roster.push({
        id: role.id,
        name: role.name,
        description: role.description || '',
        group,
        connected: true,
        executionMode: role.executionMode || 'parallel',
        coordinationMode: role.coordinationMode || 'parallel'
      });
    }
  };

  appendGroup(this.decisionCommittee, 'decision');
  appendGroup(this.supportRoles || [], 'support');
  appendGroup(this.currentRoles, 'research');
  this.agentRoster = roster;
};

CollectiveResearchEngine.prototype.getRoleDescriptorById = function getRoleDescriptorByIdOverride(roleId) {
  return clone(
    this.currentRoles.find((entry) => entry.id === roleId)
    || (this.supportRoles || []).find((entry) => entry.id === roleId)
    || this.decisionCommittee.find((entry) => entry.id === roleId)
    || null
  );
};

CollectiveResearchEngine.prototype.getSnapshot = function getSnapshotOverride() {
  return clone({
    sessionId: this.sessionId,
    topic: this.topic,
    currentRound: this.currentRound,
    maxRounds: null,
    phase: this.phase,
    roles: this.currentRoles,
    supportRoles: this.supportRoles || [],
    decisionCommittee: this.decisionCommittee,
    teamPlan: this.teamPlan,
    blackboard: this.workBoard?.getSnapshot() || null,
    workBoard: this.workBoard?.getSnapshot() || null,
    chatBoard: this.chatBoard?.getSnapshot() || null,
    scheduler: this.scheduler.getSnapshot(),
    agentRoster: this.agentRoster,
    latestConclusion: this.latestConclusion,
    status: this.stopped ? 'stopped' : 'paused'
  });
};

CollectiveResearchEngine.prototype.buildSupportMission = function buildSupportMission(role, stage = 'support') {
  const workSummary = this.getWorkSummary(18);
  const chatSummary = this.getChatSummary(18);
  const evidenceCount = (this.workBoard?.entries || []).filter((entry) => entry.entryType === 'evidence').length;
  const recentWorkEntries = (this.workBoard?.entries || []).slice(-8);
  const recentChatEntries = (this.chatBoard?.entries || []).slice(-12);
  const focusPrompt = role.id === 'support-monitor'
    ? [
        '当前任务：只观察研究是否真正推进，不参与普通聊天，也不响应普通广播。',
        '如果最近一段时间里大家主要在聊天室空谈，但工作黑板没有新的外部信息、证据、分析或待办推进，请在聊天室直接下达命令，明确要求对应研究员回到任务、去查找外部信息并把结果写回黑板。',
        '如果当前推进正常，不要为了刷存在感发言；只有在发现停滞时才发出命令。'
      ]
    : role.id === 'support-auditor'
      ? [
          '当前任务：每当工作黑板出现新的研究产出后，立即审查这条产出和相关聊天上下文。',
          '如果你认为这次黑板产出不够好、不够深入、证据不足、推理跳步或结论空泛，请在工作黑板写 challenge 或 todo，明确要求相关研究员重做、补证或继续深入。',
          '如果这次产出足够好，可以简短记录一条审查通过结论。'
        ]
      : [
          '当前任务：从头到尾持续阅读黑板和聊天室，但不要参与普通聊天。',
          '只有在决策组和审查结果都支持收束时，才编写最终研究报告。',
          '报告必须综合黑板产出和聊天室中的关键协作信息。'
        ];

  return [
    `研究主题：${this.topic}`,
    `你的角色：${role.name}`,
    `角色说明：${role.description}`,
    `当前阶段：${stage}`,
    `当前证据数：${evidenceCount}`,
    workSummary ? `工作黑板摘要：\n${workSummary}` : '工作黑板还没有有效内容。',
    chatSummary ? `聊天室摘要：\n${chatSummary}` : '聊天室还没有有效消息。',
    recentWorkEntries.length > 0 ? `最近工作黑板条目：\n${recentWorkEntries.map((entry) => `- [${entry.entryType}] ${entry.role}: ${entry.content}`).join('\n')}` : '',
    recentChatEntries.length > 0 ? `最近聊天室消息：\n${recentChatEntries.map((entry) => `- ${entry.role}: ${entry.content}`).join('\n')}` : '',
    focusPrompt.join('\n'),
    '输出必须使用 [COLLECTIVE_ACTION] JSON [/COLLECTIVE_ACTION]。'
  ].filter(Boolean).join('\n\n');
};

CollectiveResearchEngine.prototype.shouldRunMonitorPass = function shouldRunMonitorPass() {
  const supportNames = new Set((this.supportRoles || []).map((role) => role.name));
  const workEntries = (this.workBoard?.entries || []).filter((entry) => {
    const roleId = String(entry.metadata?.roleId || '');
    return !String(entry.role || '').startsWith('system')
      && !supportNames.has(entry.role)
      && !roleId.startsWith('support-')
      && entry.entryType !== 'team_plan';
  });
  const chatEntries = (this.chatBoard?.entries || []).filter((entry) => entry.role !== 'system');
  const recentWork = workEntries.slice(-3);
  const recentChat = chatEntries.slice(-6);
  if (recentChat.length < 3) {
    return false;
  }
  if (recentWork.length === 0) {
    return true;
  }
  const lastWorkAt = Math.max(...recentWork.map((entry) => Number(entry.createdAt) || 0));
  const lastChatAt = Math.max(...recentChat.map((entry) => Number(entry.createdAt) || 0));
  return lastChatAt > lastWorkAt;
};

CollectiveResearchEngine.prototype.runOversightPass = async function runOversightPass() {
  const supportRoles = Array.isArray(this.supportRoles) ? this.supportRoles.filter((role) => role.id === 'support-monitor') : [];
  if (supportRoles.length === 0 || this.stopped || !this.shouldRunMonitorPass()) {
    return [];
  }
  const results = await this.runTaskBatch(
    supportRoles.map((role, index) => ({
      roleId: role.id,
      roleName: role.name,
      roleDescriptor: role,
      mission: this.buildSupportMission(role, 'oversight'),
      round: this.currentRound,
      phase: role.id === 'support-monitor' ? 'support-monitor' : 'support-audit',
      agentIndex: this.executionCursor + index,
      executionMode: role.executionMode || 'parallel'
    }))
  );
  this.executionCursor += supportRoles.length;
  return results;
};

CollectiveResearchEngine.prototype.buildAuditMissionFromNotice = function buildAuditMissionFromNotice(role, notice) {
  const sourceEntryId = notice?.metadata?.sourceEntryId || notice?.sourceEntryId || null;
  const sourceEntry = this.getWorkEntryById(sourceEntryId);
  const workSummary = this.getWorkSummary(12);
  const chatSummary = this.getChatSummary(12);
  return [
    `研究主题：${this.topic}`,
    `你的角色：${role.name}`,
    '当前任务：审查刚刚广播的这条工作黑板新产出，并判断是否需要质疑、补证或重做。',
    notice?.content ? `广播提示：${notice.content}` : '',
    sourceEntry ? [
      '本次需要审查的黑板条目：',
      `角色：${sourceEntry.role || '未知成员'}`,
      `类型：${sourceEntry.entryType || 'note'}`,
      `内容：${sourceEntry.content || ''}`
    ].join('\n') : '未找到对应黑板条目，请结合当前黑板摘要和聊天室摘要进行审查。',
    workSummary ? `工作黑板摘要：\n${workSummary}` : '',
    chatSummary ? `聊天室摘要：\n${chatSummary}` : '',
    '如果你认为这次产出不够好、不够深入、证据不足或推理跳步，请输出 challenge 或 todo，并明确要求相关研究员继续研究或重做。',
    '如果这次产出足够好，也可以输出一条简短的 challenge-free 审查结论。',
    '输出必须使用 [COLLECTIVE_ACTION] JSON [/COLLECTIVE_ACTION]。'
  ].filter(Boolean).join('\n\n');
};

CollectiveResearchEngine.prototype.reviewResearchState = async function reviewResearchStateOverride() {
  this.phase = 'review';
  const reviewResults = await this.runTaskBatch(
    this.decisionCommittee.map((member, index) => ({
      roleId: member.id,
      roleName: member.name,
      roleDescriptor: member,
      mission: this.buildCommitteeMission(member, 'review'),
      round: this.currentRound,
      phase: 'review',
      agentIndex: this.executionCursor + index,
      executionMode: member.executionMode || 'parallel'
    }))
  );
  this.executionCursor += this.decisionCommittee.length;

  const hasExplicitPlan = reviewResults.some((taskResult) => Array.isArray(taskResult?.action?.teamPlan) && taskResult.action.teamPlan.length > 0);
  if (hasExplicitPlan) {
    this.applyTeamPlan(this.deriveTeamPlan(reviewResults));
  }

  const continueVotes = reviewResults.filter((taskResult) => taskResult?.action?.shouldContinue === true).length;
  const concludeVotes = reviewResults.filter((taskResult) => {
    const action = taskResult?.action || {};
    return action.shouldConclude === true || action.action === 'propose_conclusion';
  }).length;
  const pendingTodos = this.workBoard.getPendingEntries('todo', 8).length;
  const recentChallenges = this.workBoard.getPendingEntries('challenge', 8).length;
  const hasDraft = Boolean(this.workBoard?.draft?.content);
  const evidenceEnough = this.hasSufficientEvidence();

  if (concludeVotes >= 2 || ((concludeVotes >= 1 || hasDraft) && evidenceEnough && pendingTodos === 0 && recentChallenges === 0)) {
    this.latestConclusion = '决策组认为材料已经足以收束。';
    this.broadcastMessage('决策组', this.latestConclusion, {
      phase: 'review',
      shouldConclude: true
    });
    return {
      shouldContinue: false,
      reason: this.latestConclusion
    };
  }

  if (this.currentRound >= this.safetyCycleCap) {
    const reason = '已达到内部安全上限，进入报告收束阶段。';
    this.workBoard.addDecision({
      role: 'system',
      content: reason,
      metadata: { phase: 'review' }
    });
    this.broadcastMessage('system', reason, {
      phase: 'review',
      shouldConclude: true
    });
    this.latestConclusion = reason;
    return {
      shouldContinue: false,
      reason
    };
  }

  const reason = pendingTodos > 0 || recentChallenges > 0
    ? '决策组认为仍有待办或争议，需要继续研究。'
    : '决策组建议继续推进。';
  this.latestConclusion = reason;
  this.broadcastMessage('决策组', reason, {
    phase: 'review',
    shouldContinue: true
  });
  return {
    shouldContinue: continueVotes > 0 || pendingTodos > 0 || recentChallenges > 0 || !evidenceEnough,
    reason
  };
};

CollectiveResearchEngine.prototype.runResearchCycle = async function runResearchCycleOverride() {
  if (this.stopped) {
    return { shouldContinue: false, reason: '研究已停止' };
  }

  this.currentRound += 1;
  this.phase = 'research';
  this.callbacks.onRoundStart?.(this.currentRound, this.getSnapshot());

  const activeRoles = this.currentRoles.length > 0 ? this.currentRoles : this.buildFallbackTeamPlan().members;
  const taskResults = await this.runTaskBatch(
    activeRoles.map((role, index) => ({
      roleId: role.id,
      roleName: role.name,
      roleDescriptor: role,
      mission: this.buildRoleMission(role, this.currentRound),
      round: this.currentRound,
      phase: 'research',
      agentIndex: this.executionCursor + index,
      executionMode: role.executionMode || 'parallel'
    }))
  );
  this.executionCursor += activeRoles.length;

  if (!this.stopped && taskResults.length === 0) {
    const reason = '本轮没有产生有效研究结果，将尝试直接收束。';
    this.workBoard.addDecision({
      role: 'system',
      content: reason,
      metadata: { phase: 'research' }
    });
    this.broadcastMessage('system', reason, { phase: 'research' });
    return { shouldContinue: false, reason };
  }

  await this.runOversightPass();
  return this.reviewResearchState();
};

CollectiveResearchEngine.prototype.ensureFinalDraft = async function ensureFinalDraftOverride() {
  const reporter = (this.supportRoles || []).find((role) => role.id === 'support-reporter')
    || buildCollectiveRoleFromPlan({
      id: 'support-reporter',
      name: '报告研究员',
      description: '综合当前工作黑板和聊天室，输出最终研究报告。',
      missionHint: '整合证据、讨论、争议与结论，形成最终报告。',
      defaultEntryType: 'draft',
      executionMode: 'parallel',
      coordinationMode: 'sequential',
      visibleTools: ['browser_project', 'browser_mcp', 'browser_editor']
    }, this.currentRoles.length + 1);

  const synthesisResults = await this.runTaskBatch([{
    roleId: reporter.id,
    roleName: reporter.name,
    roleDescriptor: reporter,
    mission: this.buildSupportMission(reporter, 'final-report'),
    round: this.currentRound,
    phase: 'synthesis',
    agentIndex: this.executionCursor,
    executionMode: reporter.executionMode || 'parallel'
  }]);
  this.executionCursor += 1;

  const action = synthesisResults[0]?.action;
  if (action?.finalReport || action?.content) {
    this.workBoard.setDraft(action.finalReport || action.content, {
      role: reporter.name,
      relatedEntryIds: action.relatedEntryIds || [],
      phase: 'synthesis'
    });
  }

  return this.workBoard?.draft?.content || this.buildFinalReport();
};

CollectiveResearchEngine.prototype.executeRoleTask = async function executeRoleTaskOverrideV2(task) {
  const role = this.getRoleDescriptorById(task.roleId) || clone(task.roleDescriptor);
  if (!role) {
    throw new Error(`Unknown collective role: ${task.roleId}`);
  }

  const snapshotBefore = this.getSnapshot();
  this.callbacks.onRoleStart?.(role, task, snapshotBefore);

  let executionContext = null;
  if (typeof this.subAgentEngine?.createExecutionContext === 'function') {
    executionContext = this.agentExecutionContexts.get(role.id) || null;
    if (!executionContext) {
      executionContext = this.subAgentEngine.createExecutionContext(
        Number.isFinite(task.agentIndex) ? task.agentIndex : this.executionCursor,
        {
          agent_name: role.name,
          task: task.mission
        }
      );
      executionContext.keepCollectiveSessionAlive = true;
      executionContext.shouldPreserveCurrentTab = true;
      this.agentExecutionContexts.set(role.id, executionContext);
    } else {
      executionContext.agentIndex = Number.isFinite(task.agentIndex) ? task.agentIndex : executionContext.agentIndex;
      executionContext.agentName = role.name;
      executionContext.taskText = task.mission;
      executionContext.keepCollectiveSessionAlive = true;
    }
    executionContext.forceForeground = role.executionMode === 'foreground';
    executionContext.collectivePhase = task.phase;
  }

  let result;
  if (typeof this.subAgentEngine?.executeCollectiveAgent === 'function') {
    const visibleTools = task.phase === 'chat-review'
      ? []
      : applyCollectiveToolPolicy(role, this.tools).map((tool) => tool.name);
    result = await this.subAgentEngine.executeCollectiveAgent({
      role,
      mission: task.mission,
      phase: task.phase,
      sharedContext: this.sharedContext,
      blackboardSnapshot: {
        workBoard: this.workBoard.getSnapshot(),
        chatBoard: this.chatBoard.getSnapshot(),
        entries: this.workBoard.entries
      },
      visible_tools: visibleTools
    }, [], executionContext, Number.isFinite(task.agentIndex) ? task.agentIndex : this.executionCursor);
  } else {
    result = {
      status: 'success',
      actionData: {
        action: task.phase === 'synthesis' ? 'merge_draft' : 'post_note',
        entryType: role.defaultEntryType || 'claim',
        content: `${role.name} 产出了一条新的研究结果。`,
        references: []
      }
    };
  }

  result.__collectivePhase = task.phase;
  result.__collectiveRoleId = role.id;
  result.__collectiveRoleGroup = collectiveRoleGroup(role.id);

  let action = buildFallbackWorkAction(result?.actionData, role, task, result);
  if (task.phase === 'support-monitor') {
    action = normalizeCollectiveAction({
      ...action,
      action: 'post_note',
      entryType: 'reflection',
      references: action.references || []
    }, action);
  }
  if (shouldForceWorkOutput(task, role) && action.entryType === 'reflection' && action.action === 'post_note') {
    action = buildFallbackWorkAction({
      ...action,
      entryType: role.defaultEntryType || (task.phase === 'synthesis' ? 'draft' : 'claim')
    }, role, task, result);
  }

  const shouldWriteOnlyToChat = task.phase === 'chat-review'
    || task.phase === 'support-monitor'
    || (!shouldForceWorkOutput(task, role) && action.entryType === 'reflection' && action.action === 'post_note');

  const entry = shouldWriteOnlyToChat
    ? null
    : this.workBoard.addEntry(toBlackboardEntry(action, {
      role: role.name,
      round: task.round,
      metadata: {
        phase: task.phase,
        mission: task.mission
      }
    }));

  if (
    !shouldWriteOnlyToChat && (
      action.entryType === 'decision'
      || action.action === 'claim_complete'
      || action.action === 'propose_team'
      || action.action === 'propose_conclusion'
    )
  ) {
    this.workBoard.addDecision({
      role: role.name,
      content: action.content,
      relatedEntryIds: action.relatedEntryIds,
      metadata: {
        phase: task.phase,
        shouldContinue: action.shouldContinue,
        shouldConclude: action.shouldConclude
      }
    });
  }

  if (!shouldWriteOnlyToChat && (task.phase === 'synthesis' || action.entryType === 'draft' || action.action === 'merge_draft' || action.finalReport)) {
    this.workBoard.setDraft(action.finalReport || action.content, {
      role: role.name,
      relatedEntryIds: action.relatedEntryIds,
      phase: task.phase
    });
  }

  let broadcastNotice = null;
  if (action.action === 'propose_team' && action.teamPlan.length > 0) {
    broadcastNotice = this.buildBroadcastNotice(role, action, entry, task, `${role.name} 在工作黑板提交了新的研究组方案，请查看。`);
  } else if (shouldWriteOnlyToChat) {
    broadcastNotice = this.broadcastMessage(role.name, action.content || action.rationale || `${role.name} 在聊天室发出了一条消息。`, {
      phase: task.phase,
      entryType: 'reflection',
      relatedEntryIds: action.relatedEntryIds,
      sourceRoleId: role.id
    });
  } else {
    broadcastNotice = this.buildBroadcastNotice(role, action, entry, task);
  }

  const snapshotAfter = this.getSnapshot();
  if (!shouldWriteOnlyToChat) {
    this.callbacks.onBlackboardUpdate?.(entry, snapshotAfter, action, role);
  }
  this.callbacks.onRoleComplete?.(role, action, result, snapshotAfter);

  if (broadcastNotice && !shouldWriteOnlyToChat && !shouldSkipChatReviewForRole(role)) {
    await this.runChatReactionPass(broadcastNotice, role.id);
  }
  if (task.phase !== 'chat-review' && task.phase !== 'rework' && !shouldSkipChatReviewForRole(role)) {
    await this.flushPendingReactionsForRole(role.id);
  }

  return { role, action, result, entry };
};

function uniqueCollectiveRoleIds(roleIds = []) {
  return Array.from(new Set(
    (Array.isArray(roleIds) ? roleIds : [])
      .map((roleId) => String(roleId || '').trim())
      .filter(Boolean)
  ));
}

function looksLikeSynthesisAudienceCandidate(role = {}) {
  const text = [
    role.name,
    role.description,
    role.mission,
    role.missionHint
  ].filter(Boolean).join(' ').toLowerCase();
  return /整合|汇总|总结|收束|报告|draft|merge|summary|report|writer|synth/.test(text);
}

CollectiveResearchEngine.prototype.getAllCollectiveRoleDescriptors = function getAllCollectiveRoleDescriptors() {
  return [
    ...(Array.isArray(this.decisionCommittee) ? this.decisionCommittee : []),
    ...(Array.isArray(this.supportRoles) ? this.supportRoles : []),
    ...(Array.isArray(this.currentRoles) ? this.currentRoles : [])
  ].filter(Boolean);
};

CollectiveResearchEngine.prototype.getRoleNameById = function getRoleNameById(roleId) {
  if (!roleId) {
    return '';
  }
  return this.getAllCollectiveRoleDescriptors().find((role) => role.id === roleId)?.name || '';
};

CollectiveResearchEngine.prototype.resolveDirectedAudienceRoleIds = function resolveDirectedAudienceRoleIds(roleIds = []) {
  const availableIds = new Set(this.getAllCollectiveRoleDescriptors().map((role) => role.id));
  return uniqueCollectiveRoleIds(roleIds).filter((roleId) => availableIds.has(roleId));
};

CollectiveResearchEngine.prototype.getEntryAuthorRoleId = function getEntryAuthorRoleId(entryOrId) {
  const entry = typeof entryOrId === 'string' ? this.getWorkEntryById(entryOrId) : entryOrId;
  if (!entry) {
    return '';
  }
  if (entry.metadata?.roleId) {
    return String(entry.metadata.roleId);
  }
  return this.getAllCollectiveRoleDescriptors().find((role) => role.name === entry.role)?.id || '';
};

CollectiveResearchEngine.prototype.collectAudienceRoleIdsForTask = function collectAudienceRoleIdsForTask(role, action = {}, entry = null, task = {}) {
  const addRole = (bucket, roleId) => {
    if (roleId && roleId !== role.id) {
      bucket.add(roleId);
    }
  };

  const audience = new Set();
  const committeeIds = (this.decisionCommittee || []).map((member) => member.id);
  const auditorId = (this.supportRoles || []).find((member) => member.id === 'support-auditor')?.id || '';
  const reporterId = (this.supportRoles || []).find((member) => member.id === 'support-reporter')?.id || '';
  const sourceRoleId = task.notice?.metadata?.sourceRoleId || task.notice?.metadata?.replyToRoleId || '';
  const relatedRoleIds = (action.relatedEntryIds || [])
    .map((entryId) => this.getEntryAuthorRoleId(entryId))
    .filter(Boolean);

  if (task.phase === 'synthesis' || role.id === 'support-reporter') {
    this.getAllCollectiveRoleDescriptors().forEach((member) => addRole(audience, member.id));
    return this.resolveDirectedAudienceRoleIds([...audience]);
  }

  if (role.id === 'support-monitor') {
    const monitorTargets = Array.isArray(task.commandTargetRoleIds) && task.commandTargetRoleIds.length > 0
      ? task.commandTargetRoleIds
      : (this.currentRoles || []).map((member) => member.id);
    monitorTargets.forEach((roleId) => addRole(audience, roleId));
    committeeIds.forEach((roleId) => addRole(audience, roleId));
    return this.resolveDirectedAudienceRoleIds([...audience]);
  }

  if (role.id === 'support-auditor') {
    addRole(audience, sourceRoleId);
    committeeIds.forEach((roleId) => addRole(audience, roleId));
    return this.resolveDirectedAudienceRoleIds([...audience]);
  }

  if (task.phase === 'chat-review') {
    addRole(audience, sourceRoleId);
    addRole(audience, task.replyToRoleId || '');
    return this.resolveDirectedAudienceRoleIds([...audience]);
  }

  if (task.phase === 'rework') {
    addRole(audience, sourceRoleId);
    addRole(audience, auditorId);
    committeeIds.forEach((roleId) => addRole(audience, roleId));
    return this.resolveDirectedAudienceRoleIds([...audience]);
  }

  if (action.action === 'propose_team' || action.action === 'propose_conclusion' || action.entryType === 'decision') {
    return [];
  }

  committeeIds.forEach((roleId) => addRole(audience, roleId));
  addRole(audience, auditorId);
  if (reporterId && ['evidence', 'claim', 'draft', 'todo', 'challenge'].includes(action.entryType)) {
    addRole(audience, reporterId);
  }
  relatedRoleIds.forEach((roleId) => addRole(audience, roleId));

  if (action.entryType === 'evidence' || action.entryType === 'claim') {
    (this.currentRoles || [])
      .filter((member) => looksLikeSynthesisAudienceCandidate(member))
      .forEach((member) => addRole(audience, member.id));
  }

  return this.resolveDirectedAudienceRoleIds([...audience]);
};

CollectiveResearchEngine.prototype.broadcastMessage = function broadcastMessageOverride(roleName, content, metadata = {}) {
  if (!content) {
    return null;
  }

  const audienceRoleIds = this.resolveDirectedAudienceRoleIds(
    metadata.audienceRoleIds || metadata.targetRoleIds || []
  );
  const audienceRoleNames = audienceRoleIds
    .map((roleId) => this.getRoleNameById(roleId))
    .filter(Boolean);

  const message = this.chatBoard.addEntry({
    role: roleName,
    action: 'post_note',
    entryType: 'reflection',
    content,
    references: [],
    round: Number.isFinite(metadata.round) ? metadata.round : this.currentRound,
    metadata: {
      ...metadata,
      audienceRoleIds,
      audienceRoleNames,
      isDirected: audienceRoleIds.length > 0,
      conversationId: metadata.conversationId || metadata.sourceEntryId || generateUniqueId()
    }
  });
  this.callbacks.onBroadcast?.(message, this.getSnapshot());
  return message;
};

CollectiveResearchEngine.prototype.buildBroadcastNotice = function buildBroadcastNoticeOverride(role, action, entry, task, overrideMessage = '') {
  const entryLabelMap = {
    question: '问题',
    claim: '观点',
    evidence: '研究结果',
    challenge: '质疑',
    todo: '待办',
    draft: '草稿',
    decision: '决策',
    team_plan: '组队方案',
    reflection: '聊天消息'
  };
  const label = entryLabelMap[action.entryType] || '研究结果';
  const audienceRoleIds = this.collectAudienceRoleIdsForTask(role, action, entry, task);
  const content = overrideMessage || `${role.name} 在工作黑板新增了${label}，请相关成员查看后反馈。`;
  return this.broadcastMessage(role.name, content, {
    phase: task.phase,
    entryType: action.entryType,
    sourceRoleId: role.id,
    sourceEntryId: entry?.id || null,
    replyToRoleId: role.id,
    isWorkResultNotice: true,
    audienceRoleIds,
    relatedEntryIds: action.relatedEntryIds || []
  });
};

CollectiveResearchEngine.prototype.buildChatReactionMission = function buildChatReactionMissionOverride(role, notices = []) {
  const latestNotices = (Array.isArray(notices) ? notices : []).slice(-3);
  const workSummary = this.getWorkSummary(10);
  const chatSummary = this.getChatSummary(12);
  const noticeSummary = latestNotices.map((notice, index) => {
    const senderName = this.getRoleNameById(notice?.metadata?.sourceRoleId) || notice?.role || '未知成员';
    const directedAudience = Array.isArray(notice?.metadata?.audienceRoleNames) && notice.metadata.audienceRoleNames.length > 0
      ? `；定向给：${notice.metadata.audienceRoleNames.join('、')}`
      : '';
    return `${index + 1}. ${senderName} 的广播：${notice?.content || '有新的工作黑板结果'}${directedAudience}`;
  }).join('\n');
  const resultDigest = this.buildNoticeResultDigest(latestNotices);
  const replyTargets = uniqueCollectiveRoleIds(
    latestNotices.map((notice) => notice?.metadata?.sourceRoleId || notice?.metadata?.replyToRoleId || '')
  ).map((roleId) => this.getRoleNameById(roleId)).filter(Boolean);

  return [
    `研究主题：${this.topic}`,
    `你的角色：${role.name}`,
    '当前任务：阅读定向广播对应的工作结果，然后在聊天室给出定向反馈。',
    replyTargets.length > 0 ? `这次反馈主要回复给：${replyTargets.join('、')}` : '',
    '如果你觉得只靠现有黑板内容还不足以反馈，可以直接使用工具去查找补充信息，再回来回复。',
    '如果你判断某条结果还不够完善、需要重做或补证，可以在反馈里明确指出，并把 shouldContinue 设为 true。',
    noticeSummary ? `本次需要响应的广播：\n${noticeSummary}` : '',
    resultDigest ? `广播对应的工作黑板结果：\n${resultDigest}` : '',
    workSummary ? `工作黑板摘要：\n${workSummary}` : '',
    chatSummary ? `聊天室摘要：\n${chatSummary}` : '',
    '优先输出 entryType="reflection" 的聊天室反馈；只有你真的形成新的正式工作结果时，才改用工作黑板条目类型。'
  ].filter(Boolean).join('\n\n');
};

CollectiveResearchEngine.prototype.runChatReactionPass = async function runChatReactionPassOverride(notice, excludeRoleId = '') {
  const allRoles = [...this.decisionCommittee, ...this.currentRoles];
  const immediateReactions = [];
  const auditor = (this.supportRoles || []).find((role) => role.id === 'support-auditor');
  const targetedAudience = this.resolveDirectedAudienceRoleIds(notice?.metadata?.audienceRoleIds || []);

  const shouldNotifyRole = (role) => {
    if (!role?.id || role.id === excludeRoleId) {
      return false;
    }
    if (targetedAudience.length > 0) {
      return targetedAudience.includes(role.id);
    }
    return true;
  };

  for (const role of allRoles) {
    if (!shouldNotifyRole(role)) {
      continue;
    }
    const status = this.getLatestRoleStatus(role.id);
    if (status === 'running') {
      this.enqueuePendingNotice(role.id, notice);
      this.broadcastMessage(role.name, `${role.name} 已收到广播，当前步骤结束后会查看黑板并反馈。`, {
        phase: 'chat-review-pending',
        entryType: 'reflection',
        sourceRoleId: role.id,
        sourceEntryId: notice?.metadata?.sourceEntryId || null,
        replyToRoleId: notice?.metadata?.sourceRoleId || '',
        audienceRoleIds: [notice?.metadata?.sourceRoleId].filter(Boolean),
        isReactionPending: true
      });
      continue;
    }
    if (!['queued', 'done', 'paused_waiting_input', 'failed', 'idle'].includes(status)) {
      continue;
    }
    immediateReactions.push(this.executeRoleTask({
      roleId: role.id,
      roleName: role.name,
      roleDescriptor: role,
      mission: this.buildChatReactionMission(role, [notice]),
      notices: [notice],
      notice,
      replyToRoleId: notice?.metadata?.sourceRoleId || '',
      round: this.currentRound,
      phase: 'chat-review',
      agentIndex: this.executionCursor++,
      executionMode: 'parallel'
    }));
  }

  if (immediateReactions.length > 0) {
    await Promise.allSettled(immediateReactions);
  }

  if (auditor && notice?.metadata?.isWorkResultNotice && (targetedAudience.length === 0 || targetedAudience.includes(auditor.id))) {
    const auditorStatus = this.getLatestRoleStatus(auditor.id);
    if (auditorStatus === 'running') {
      this.enqueuePendingNotice(auditor.id, notice);
    } else {
      await this.executeRoleTask({
        roleId: auditor.id,
        roleName: auditor.name,
        roleDescriptor: auditor,
        mission: this.buildAuditMissionFromNotice(auditor, notice),
        notice,
        notices: [notice],
        round: this.currentRound,
        phase: 'support-audit',
        agentIndex: this.executionCursor++,
        executionMode: 'parallel'
      });
    }
  }
};

CollectiveResearchEngine.prototype.flushPendingReactionsForRole = async function flushPendingReactionsForRoleOverride(roleId) {
  const notices = this.pendingNoticesByRole.get(roleId) || [];
  if (notices.length === 0) {
    return null;
  }
  this.pendingNoticesByRole.delete(roleId);
  const role = this.getRoleDescriptorById(roleId);
  if (!role) {
    return null;
  }

  if (role.id === 'support-auditor') {
    let latestResult = null;
    for (const notice of notices) {
      latestResult = await this.executeRoleTask({
        roleId: role.id,
        roleName: role.name,
        roleDescriptor: role,
        mission: this.buildAuditMissionFromNotice(role, notice),
        notice,
        notices: [notice],
        round: this.currentRound,
        phase: 'support-audit',
        agentIndex: this.executionCursor++,
        executionMode: 'parallel'
      });
    }
    return latestResult;
  }

  const latestNotice = notices[notices.length - 1] || null;
  const review = await this.executeRoleTask({
    roleId: role.id,
    roleName: role.name,
    roleDescriptor: role,
    mission: this.buildChatReactionMission(role, notices),
    notices,
    notice: latestNotice,
    replyToRoleId: latestNotice?.metadata?.sourceRoleId || '',
    round: this.currentRound,
    phase: 'chat-review',
    agentIndex: this.executionCursor++,
    executionMode: 'parallel'
  });

  if (review?.action?.shouldContinue === true) {
    return this.executeRoleTask({
      roleId: role.id,
      roleName: role.name,
      roleDescriptor: role,
      mission: `${role.missionHint || role.mission || role.description}\n\n补充要求：请根据刚收到的定向反馈，补做外部搜索、补证或重做，并把新的正式结果写回工作黑板。`,
      notice: latestNotice,
      notices,
      replyToRoleId: latestNotice?.metadata?.sourceRoleId || '',
      round: this.currentRound,
      phase: 'rework',
      agentIndex: this.executionCursor++,
      executionMode: role.executionMode || 'parallel'
    });
  }

  return review;
};

CollectiveResearchEngine.prototype.executeRoleTask = async function executeRoleTaskOverrideV3(task) {
  const role = this.getRoleDescriptorById(task.roleId) || clone(task.roleDescriptor);
  if (!role) {
    throw new Error(`Unknown collective role: ${task.roleId}`);
  }

  const snapshotBefore = this.getSnapshot();
  this.callbacks.onRoleStart?.(role, task, snapshotBefore);

  let executionContext = null;
  if (typeof this.subAgentEngine?.createExecutionContext === 'function') {
    executionContext = this.agentExecutionContexts.get(role.id) || null;
    if (!executionContext) {
      executionContext = this.subAgentEngine.createExecutionContext(
        Number.isFinite(task.agentIndex) ? task.agentIndex : this.executionCursor,
        {
          agent_name: role.name,
          task: task.mission
        }
      );
      executionContext.keepCollectiveSessionAlive = true;
      executionContext.shouldPreserveCurrentTab = true;
      this.agentExecutionContexts.set(role.id, executionContext);
    } else {
      executionContext.agentIndex = Number.isFinite(task.agentIndex) ? task.agentIndex : executionContext.agentIndex;
      executionContext.agentName = role.name;
      executionContext.taskText = task.mission;
      executionContext.keepCollectiveSessionAlive = true;
    }
    executionContext.forceForeground = role.executionMode === 'foreground';
    executionContext.collectivePhase = task.phase;
  }

  let result;
  if (typeof this.subAgentEngine?.executeCollectiveAgent === 'function') {
    const visibleTools = applyCollectiveToolPolicy(role, this.tools).map((tool) => tool.name);
    result = await this.subAgentEngine.executeCollectiveAgent({
      role,
      mission: task.mission,
      phase: task.phase,
      notices: clone(task.notices || []),
      sharedContext: this.sharedContext,
      blackboardSnapshot: {
        workBoard: this.workBoard.getSnapshot(),
        chatBoard: this.chatBoard.getSnapshot(),
        entries: this.workBoard.entries
      },
      visible_tools: visibleTools
    }, [], executionContext, Number.isFinite(task.agentIndex) ? task.agentIndex : this.executionCursor);
  } else {
    result = {
      status: 'success',
      actionData: {
        action: task.phase === 'synthesis' ? 'merge_draft' : 'post_note',
        entryType: role.defaultEntryType || 'claim',
        content: `${role.name} 产出了一条新的研究结果。`,
        references: []
      }
    };
  }

  result.__collectivePhase = task.phase;
  result.__collectiveRoleId = role.id;
  result.__collectiveRoleGroup = collectiveRoleGroup(role.id);

  let action = buildFallbackWorkAction(result?.actionData, role, task, result);
  if (task.phase === 'support-monitor') {
    action = normalizeCollectiveAction({
      ...action,
      action: 'post_note',
      entryType: 'reflection',
      references: action.references || []
    }, action);
  }
  if (shouldForceWorkOutput(task, role) && action.entryType === 'reflection' && action.action === 'post_note') {
    action = buildFallbackWorkAction({
      ...action,
      entryType: role.defaultEntryType || (task.phase === 'synthesis' ? 'draft' : 'claim')
    }, role, task, result);
  }

  const shouldWriteOnlyToChat = task.phase === 'chat-review'
    || task.phase === 'support-monitor'
    || (!shouldForceWorkOutput(task, role) && action.entryType === 'reflection' && action.action === 'post_note');

  const entry = shouldWriteOnlyToChat
    ? null
    : this.workBoard.addEntry(toBlackboardEntry(action, {
      role: role.name,
      round: task.round,
      metadata: {
        phase: task.phase,
        mission: task.mission,
        roleId: role.id,
        replyToRoleId: task.replyToRoleId || task.notice?.metadata?.sourceRoleId || '',
        replyToEntryId: task.notice?.metadata?.sourceEntryId || '',
        reviewedEntryId: task.notice?.metadata?.sourceEntryId || ''
      }
    }));

  if (
    !shouldWriteOnlyToChat && (
      action.entryType === 'decision'
      || action.action === 'claim_complete'
      || action.action === 'propose_team'
      || action.action === 'propose_conclusion'
    )
  ) {
    this.workBoard.addDecision({
      role: role.name,
      content: action.content,
      relatedEntryIds: action.relatedEntryIds,
      metadata: {
        phase: task.phase,
        roleId: role.id,
        shouldContinue: action.shouldContinue,
        shouldConclude: action.shouldConclude
      }
    });
  }

  if (!shouldWriteOnlyToChat && (task.phase === 'synthesis' || action.entryType === 'draft' || action.action === 'merge_draft' || action.finalReport)) {
    this.workBoard.setDraft(action.finalReport || action.content, {
      role: role.name,
      relatedEntryIds: action.relatedEntryIds,
      phase: task.phase,
      roleId: role.id
    });
  }

  let broadcastNotice = null;
  if (action.action === 'propose_team' && action.teamPlan.length > 0) {
    broadcastNotice = this.buildBroadcastNotice(role, action, entry, task, `${role.name} 在工作黑板提交了新的研究组方案，请相关成员查看。`);
  } else if (shouldWriteOnlyToChat) {
    broadcastNotice = this.broadcastMessage(role.name, action.content || action.rationale || `${role.name} 在聊天室发出了一条消息。`, {
      phase: task.phase,
      entryType: 'reflection',
      relatedEntryIds: action.relatedEntryIds,
      sourceRoleId: role.id,
      sourceEntryId: task.notice?.metadata?.sourceEntryId || null,
      replyToRoleId: task.replyToRoleId || task.notice?.metadata?.sourceRoleId || '',
      audienceRoleIds: this.collectAudienceRoleIdsForTask(role, action, entry, task)
    });
  } else {
    broadcastNotice = this.buildBroadcastNotice(role, action, entry, task);
  }

  const snapshotAfter = this.getSnapshot();
  if (!shouldWriteOnlyToChat) {
    this.callbacks.onBlackboardUpdate?.(entry, snapshotAfter, action, role);
  }
  this.callbacks.onRoleComplete?.(role, action, result, snapshotAfter);

  if (broadcastNotice && !shouldWriteOnlyToChat && !shouldSkipChatReviewForRole(role)) {
    await this.runChatReactionPass(broadcastNotice, role.id);
  }
  if (task.phase !== 'chat-review' && task.phase !== 'rework' && !shouldSkipChatReviewForRole(role)) {
    await this.flushPendingReactionsForRole(role.id);
  }

  return { role, action, result, entry };
};

const previousCollectiveBuildSupportMission = CollectiveResearchEngine.prototype.buildSupportMission;

CollectiveResearchEngine.prototype.buildSupportMission = function buildSupportMissionOverrideV4(role, stage = 'support') {
  if (role?.id === 'support-reporter' && stage === 'final-report') {
    const workSummary = this.getWorkSummary(24);
    const chatSummary = this.getChatSummary(24);
    const decisions = (this.workBoard?.decisions || []).slice(-10);
    const evidence = (this.workBoard?.entries || []).filter((entry) => entry.entryType === 'evidence').slice(-12);
    const challenges = (this.workBoard?.entries || []).filter((entry) => entry.entryType === 'challenge').slice(-8);
    const todos = (this.workBoard?.entries || []).filter((entry) => entry.entryType === 'todo').slice(-8);

    return [
      `研究主题：${this.topic}`,
      `你的角色：${role.name}`,
      '当前任务：你不参与普通聊天，只负责在研究接近收束时，综合工作黑板和聊天室内容，撰写一份详尽、正式、可交付的最终研究报告。',
      '报告必须明显长于普通摘要，不能只给简短结论。请至少覆盖：研究背景、问题拆解、关键发现、证据链、争议与反例、协作过程中的重要调整、风险与局限、后续建议。',
      '如果黑板里已经有 draft，可以吸收它，但不要机械重复；要把黑板条目、聊天室反馈和决策过程整合成一篇完整报告。',
      '优先使用 Markdown 结构化输出，至少包含二级标题和成体系的小节。',
      decisions.length > 0 ? `关键决策：\n${decisions.map((item) => `- ${item.content}`).join('\n')}` : '',
      evidence.length > 0 ? `关键证据：\n${evidence.map((item) => `- ${item.role}: ${item.content}`).join('\n')}` : '',
      challenges.length > 0 ? `主要争议：\n${challenges.map((item) => `- ${item.role}: ${item.content}`).join('\n')}` : '',
      todos.length > 0 ? `尚未闭合的待办：\n${todos.map((item) => `- ${item.role}: ${item.content}`).join('\n')}` : '',
      workSummary ? `工作黑板摘要：\n${workSummary}` : '',
      chatSummary ? `聊天室摘要：\n${chatSummary}` : '',
      '输出要求：请优先输出 action=merge_draft 或 entryType=draft，并把完整报告放进 finalReport；content 里给出简短摘要即可。'
    ].filter(Boolean).join('\n\n');
  }

  return previousCollectiveBuildSupportMission.call(this, role, stage);
};
