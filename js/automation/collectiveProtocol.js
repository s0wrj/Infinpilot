const ACTION_BLOCK_REGEX = /\[COLLECTIVE_ACTION\]([\s\S]*?)\[\/COLLECTIVE_ACTION\]/i;

export const COLLECTIVE_ACTION_TYPES = [
  'post_note',
  'request_evidence',
  'challenge_claim',
  'claim_complete',
  'handoff_task',
  'propose_outline',
  'merge_draft',
  'propose_team',
  'propose_conclusion'
];

export const COLLECTIVE_ENTRY_TYPES = [
  'question',
  'claim',
  'evidence',
  'challenge',
  'todo',
  'draft',
  'decision',
  'team_plan',
  'reflection'
];

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeTeamPlan(teamPlan) {
  if (!Array.isArray(teamPlan)) {
    return [];
  }

  return teamPlan
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      description: typeof entry.description === 'string' ? entry.description.trim() : '',
      mission: typeof entry.mission === 'string' ? entry.mission.trim() : '',
      missionHint: typeof entry.missionHint === 'string' ? entry.missionHint.trim() : '',
      defaultEntryType: typeof entry.defaultEntryType === 'string' ? entry.defaultEntryType.trim() : 'claim',
      executionMode: entry.executionMode === 'foreground' ? 'foreground' : 'parallel',
      coordinationMode: entry.coordinationMode === 'sequential' ? 'sequential' : 'parallel',
      visibleTools: Array.isArray(entry.visibleTools) ? entry.visibleTools.filter(Boolean) : [],
      forbiddenActions: Array.isArray(entry.forbiddenActions) ? entry.forbiddenActions.filter(Boolean) : [],
      style: typeof entry.style === 'string' ? entry.style.trim() : ''
    }))
    .filter((entry) => entry.name && (entry.description || entry.mission || entry.missionHint));
}

export function normalizeCollectiveAction(input = {}, fallback = {}) {
  const action = {
    action: typeof input.action === 'string' ? input.action.trim() : (fallback.action || 'post_note'),
    entryType: typeof input.entryType === 'string' ? input.entryType.trim() : (fallback.entryType || 'claim'),
    content: typeof input.content === 'string' ? input.content.trim() : (fallback.content || ''),
    references: Array.isArray(input.references) ? input.references.filter(Boolean) : (fallback.references || []),
    relatedEntryIds: Array.isArray(input.relatedEntryIds) ? input.relatedEntryIds.filter(Boolean) : (fallback.relatedEntryIds || []),
    nextRequest: typeof input.nextRequest === 'string' ? input.nextRequest.trim() : (fallback.nextRequest || null),
    confidence: Number.isFinite(input.confidence) ? input.confidence : (fallback.confidence || null),
    shouldContinue: typeof input.shouldContinue === 'boolean' ? input.shouldContinue : (typeof fallback.shouldContinue === 'boolean' ? fallback.shouldContinue : null),
    shouldConclude: typeof input.shouldConclude === 'boolean' ? input.shouldConclude : (typeof fallback.shouldConclude === 'boolean' ? fallback.shouldConclude : null),
    teamPlan: normalizeTeamPlan(input.teamPlan ?? fallback.teamPlan),
    rationale: typeof input.rationale === 'string' ? input.rationale.trim() : (fallback.rationale || ''),
    finalReport: typeof input.finalReport === 'string' ? input.finalReport.trim() : (fallback.finalReport || '')
  };

  if (!COLLECTIVE_ACTION_TYPES.includes(action.action)) {
    action.action = fallback.action || 'post_note';
  }
  if (!COLLECTIVE_ENTRY_TYPES.includes(action.entryType)) {
    action.entryType = fallback.entryType || 'claim';
  }
  return action;
}

export function validateCollectiveAction(input = {}) {
  const normalized = normalizeCollectiveAction(input);
  return {
    valid: Boolean(normalized.content || normalized.teamPlan.length > 0 || normalized.finalReport),
    action: normalized,
    errors: normalized.content || normalized.teamPlan.length > 0 || normalized.finalReport
      ? []
      : ['content, teamPlan, or finalReport is required']
  };
}

export function toBlackboardEntry(action, extras = {}) {
  const normalized = normalizeCollectiveAction(action);
  return {
    role: extras.role || 'unknown',
    action: normalized.action,
    entryType: normalized.entryType,
    content: normalized.content,
    references: normalized.references,
    relatedEntryIds: normalized.relatedEntryIds,
    round: Number.isFinite(extras.round) ? extras.round : null,
    metadata: {
      confidence: normalized.confidence,
      nextRequest: normalized.nextRequest,
      shouldContinue: normalized.shouldContinue,
      shouldConclude: normalized.shouldConclude,
      teamPlan: clone(normalized.teamPlan),
      rationale: normalized.rationale,
      finalReport: normalized.finalReport,
      ...(extras.metadata || {})
    }
  };
}

export function parseCollectiveActionBlock(text, fallback = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return normalizeCollectiveAction({}, fallback);
  }

  const match = text.match(ACTION_BLOCK_REGEX);
  if (!match) {
    return normalizeCollectiveAction({ content: text }, fallback);
  }

  try {
    return normalizeCollectiveAction(JSON.parse(match[1]), fallback);
  } catch (error) {
    console.warn('[CollectiveProtocol] Failed to parse collective action block:', error);
    return normalizeCollectiveAction({ content: text }, fallback);
  }
}

export function buildCollectiveActionPreview(action) {
  const normalized = normalizeCollectiveAction(action);
  if (normalized.teamPlan.length > 0) {
    return `[team] ${normalized.teamPlan.map((entry) => entry.name).join(', ')}`;
  }
  return `[${normalized.entryType}] ${normalized.content}`;
}
