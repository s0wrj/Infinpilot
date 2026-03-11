function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class ExecutionScheduler extends EventTarget {
  constructor() {
    super();
    this.foregroundQueue = [];
    this.activeForegroundTask = null;
    this.taskCounter = 0;
  }

  getSnapshot() {
    return {
      activeForegroundTask: this.activeForegroundTask ? clone(this.activeForegroundTask) : null,
      queue: this.foregroundQueue.map((task) => clone(task))
    };
  }

  emitUpdate() {
    const detail = this.getSnapshot();
    this.dispatchEvent(new CustomEvent('scheduler:updated', { detail }));
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('infinpilot:scheduler-updated', { detail }));
    }
  }

  async runForeground(taskInput, runner) {
    const task = {
      id: `foreground-task-${Date.now()}-${this.taskCounter += 1}`,
      createdAt: Date.now(),
      status: 'queued',
      source: taskInput?.source || 'workflow',
      templateId: taskInput?.templateId || '',
      templateName: taskInput?.templateName || '',
      runId: taskInput?.runId || '',
      toolName: taskInput?.toolName || '',
      agentName: taskInput?.agentName || '',
      executionId: taskInput?.executionId || '',
      label: taskInput?.label || ''
    };

    return new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
      task.runner = runner;
      this.foregroundQueue.push(task);
      this.emitUpdate();
      this.processForegroundQueue();
    });
  }

  async processForegroundQueue() {
    if (this.activeForegroundTask || this.foregroundQueue.length === 0) {
      return;
    }

    const task = this.foregroundQueue.shift();
    this.activeForegroundTask = {
      id: task.id,
      createdAt: task.createdAt,
      startedAt: Date.now(),
      status: 'running',
      source: task.source,
      templateId: task.templateId,
      templateName: task.templateName,
      runId: task.runId,
      toolName: task.toolName,
      agentName: task.agentName,
      executionId: task.executionId,
      label: task.label
    };
    this.emitUpdate();

    try {
      const result = await task.runner();
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      this.activeForegroundTask = null;
      this.emitUpdate();
      queueMicrotask(() => {
        void this.processForegroundQueue();
      });
    }
  }
}

const executionScheduler = new ExecutionScheduler();

if (typeof window !== 'undefined') {
  window.InfinPilotExecutionScheduler = executionScheduler;
}

export default executionScheduler;
