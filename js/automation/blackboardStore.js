import { generateUniqueId } from '../utils.js';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default class BlackboardStore {
  constructor({ sessionId, topic = '', initialSnapshot = null } = {}) {
    this.sessionId = sessionId || `collective_${Date.now()}`;
    this.topic = topic;
    this.entries = [];
    this.decisions = [];
    this.draft = null;
    this.teamPlan = null;
    this.version = 0;

    if (initialSnapshot) {
      this.loadSnapshot(initialSnapshot);
      return;
    }

    if (topic) {
      this.addEntry({
        role: 'system',
        action: 'post_note',
        entryType: 'question',
        content: topic,
        references: []
      });
    }
  }

  static fromSnapshot(snapshot) {
    return new BlackboardStore({
      sessionId: snapshot?.sessionId,
      topic: snapshot?.topic || '',
      initialSnapshot: snapshot
    });
  }

  loadSnapshot(snapshot = {}) {
    this.sessionId = snapshot.sessionId || this.sessionId;
    this.topic = snapshot.topic || this.topic;
    this.entries = Array.isArray(snapshot.entries) ? clone(snapshot.entries) : [];
    this.decisions = Array.isArray(snapshot.decisions) ? clone(snapshot.decisions) : [];
    this.draft = snapshot.draft ? clone(snapshot.draft) : null;
    this.teamPlan = snapshot.teamPlan ? clone(snapshot.teamPlan) : null;
    this.version = Number.isFinite(snapshot.version)
      ? snapshot.version
      : this.entries.length + this.decisions.length + (this.draft ? 1 : 0) + (this.teamPlan ? 1 : 0);
    return this.getSnapshot();
  }

  addEntry(input = {}) {
    const entry = {
      id: input.id || generateUniqueId(),
      role: input.role || 'unknown',
      action: input.action || 'post_note',
      entryType: input.entryType || 'note',
      content: typeof input.content === 'string' ? input.content.trim() : '',
      references: Array.isArray(input.references) ? input.references.filter(Boolean) : [],
      relatedEntryIds: Array.isArray(input.relatedEntryIds) ? input.relatedEntryIds.filter(Boolean) : [],
      round: Number.isFinite(input.round) ? input.round : null,
      metadata: input.metadata && typeof input.metadata === 'object' ? clone(input.metadata) : {},
      createdAt: input.createdAt || Date.now()
    };

    this.entries.push(entry);
    this.version += 1;
    return clone(entry);
  }

  addDecision(input = {}) {
    const decision = {
      id: input.id || generateUniqueId(),
      role: input.role || 'unknown',
      content: typeof input.content === 'string' ? input.content.trim() : '',
      relatedEntryIds: Array.isArray(input.relatedEntryIds) ? input.relatedEntryIds.filter(Boolean) : [],
      metadata: input.metadata && typeof input.metadata === 'object' ? clone(input.metadata) : {},
      createdAt: input.createdAt || Date.now()
    };

    this.decisions.push(decision);
    this.version += 1;
    return clone(decision);
  }

  setDraft(content, metadata = {}) {
    this.draft = {
      id: generateUniqueId(),
      content: typeof content === 'string' ? content.trim() : '',
      role: metadata.role || 'unknown',
      relatedEntryIds: Array.isArray(metadata.relatedEntryIds) ? metadata.relatedEntryIds.filter(Boolean) : [],
      metadata: metadata && typeof metadata === 'object' ? clone(metadata) : {},
      createdAt: Date.now()
    };
    this.version += 1;
    return clone(this.draft);
  }

  setTeamPlan(teamPlan, metadata = {}) {
    this.teamPlan = {
      id: generateUniqueId(),
      members: Array.isArray(teamPlan?.members) ? clone(teamPlan.members) : [],
      summary: typeof teamPlan?.summary === 'string' ? teamPlan.summary.trim() : '',
      source: typeof teamPlan?.source === 'string' ? teamPlan.source : 'unknown',
      createdAt: Date.now(),
      metadata: metadata && typeof metadata === 'object' ? clone(metadata) : {}
    };
    this.version += 1;
    return clone(this.teamPlan);
  }

  getEntriesByType(entryType) {
    return clone(this.entries.filter((entry) => entry.entryType === entryType));
  }

  getLatestEntries(limit = 12) {
    return clone(this.entries.slice(-Math.max(1, limit)));
  }

  getAvailableRounds() {
    return Array.from(new Set(
      this.entries
        .map((entry) => entry.round)
        .filter((round) => Number.isFinite(round))
    )).sort((left, right) => left - right);
  }

  getPendingEntries(entryType, limit = 6) {
    return clone(
      this.entries
        .filter((entry) => entry.entryType === entryType)
        .slice(-Math.max(1, limit))
    );
  }

  summarizeForPrompt(limit = 10) {
    const planSummary = this.teamPlan?.members?.length
      ? `研究组：${this.teamPlan.members.map((member) => member.name).join('、')}`
      : '';
    const entrySummary = this.entries
      .slice(-Math.max(1, limit))
      .map((entry) => `[${entry.entryType}] ${entry.role}: ${entry.content}`)
      .join('\n');
    return [planSummary, entrySummary].filter(Boolean).join('\n');
  }

  getSnapshot() {
    return clone({
      sessionId: this.sessionId,
      topic: this.topic,
      version: this.version,
      entries: this.entries,
      decisions: this.decisions,
      draft: this.draft,
      teamPlan: this.teamPlan
    });
  }
}
