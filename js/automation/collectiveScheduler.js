import { generateUniqueId } from '../utils.js';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function emitSchedulerUpdate(snapshot) {
  if (typeof document === 'undefined') {
    return;
  }
  document.dispatchEvent(new CustomEvent('infinpilot:collective-scheduler-updated', {
    detail: snapshot
  }));
}

export default class CollectiveScheduler {
  constructor() {
    this.tasks = [];
  }

  enqueueTask(taskInput = {}) {
    const task = {
      id: taskInput.id || generateUniqueId(),
      roleId: taskInput.roleId || 'unknown',
      roleName: taskInput.roleName || 'Unknown',
      roleDescriptor: taskInput.roleDescriptor ? clone(taskInput.roleDescriptor) : null,
      mission: taskInput.mission || '',
      round: Number.isFinite(taskInput.round) ? taskInput.round : 0,
      phase: typeof taskInput.phase === 'string' ? taskInput.phase : 'research',
      agentIndex: Number.isFinite(taskInput.agentIndex) ? taskInput.agentIndex : null,
      executionMode: taskInput.executionMode === 'foreground' ? 'foreground' : 'parallel',
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null
    };
    this.tasks.push(task);
    emitSchedulerUpdate(this.getSnapshot());
    return clone(task);
  }

  getNextQueuedTask() {
    const foregroundRunning = this.tasks.some((task) => task.status === 'running' && task.executionMode === 'foreground');
    for (const task of this.tasks) {
      if (task.status !== 'queued') {
        continue;
      }
      if (task.executionMode === 'foreground' && foregroundRunning) {
        continue;
      }
      return task;
    }
    return null;
  }

  async runNext(executor) {
    const task = this.getNextQueuedTask();
    if (!task) {
      return null;
    }
    return this.executeTask(task.id, executor);
  }

  async executeTask(taskId, executor) {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      return null;
    }
    task.status = 'running';
    task.startedAt = Date.now();
    emitSchedulerUpdate(this.getSnapshot());

    try {
      task.result = await executor(clone(task));
      task.status = 'done';
      task.finishedAt = Date.now();
      emitSchedulerUpdate(this.getSnapshot());
      return clone(task);
    } catch (error) {
      task.status = 'failed';
      task.error = error?.message || String(error);
      task.finishedAt = Date.now();
      emitSchedulerUpdate(this.getSnapshot());
      throw error;
    }
  }

  markTaskPaused(taskId, reason = '') {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      return;
    }
    task.status = 'paused_waiting_input';
    task.error = reason || '';
    emitSchedulerUpdate(this.getSnapshot());
  }

  getSnapshot() {
    return clone({
      queue: this.tasks,
      activeTask: this.tasks.find((task) => task.status === 'running') || null,
      queuedCount: this.tasks.filter((task) => task.status === 'queued').length
    });
  }
}
