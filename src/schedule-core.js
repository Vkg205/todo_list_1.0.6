(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FocusTodoSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function validTime(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  function normalizeDependencyIds(task) {
    const values = Array.isArray(task?.dependencyIds) ? task.dependencyIds : [];
    return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
  }

  function wouldCreateCycle(tasks, taskId, dependencyIds) {
    const graph = new Map();
    for (const task of tasks || []) graph.set(task.id, normalizeDependencyIds(task));
    graph.set(taskId, [...new Set((dependencyIds || []).filter(Boolean))]);

    const visiting = new Set();
    const visited = new Set();
    function visit(id) {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const depId of graph.get(id) || []) {
        if (!graph.has(depId)) continue;
        if (visit(depId)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    }
    return visit(taskId);
  }

  function incompleteDependencies(tasks, task) {
    const byId = new Map((tasks || []).map(item => [item.id, item]));
    return normalizeDependencyIds(task)
      .map(id => byId.get(id))
      .filter(item => item && !item.completed && !item.archived);
  }

  function shiftDependents(tasks, sourceTaskId, deltaMs, now = Date.now()) {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return [];
    const changed = [];
    const shiftedIds = new Set();
    const queue = [sourceTaskId];

    while (queue.length) {
      const currentId = queue.shift();
      for (const task of tasks || []) {
        if (shiftedIds.has(task.id)) continue;
        if (!normalizeDependencyIds(task).includes(currentId)) continue;
        const oldTime = validTime(task.dueAt);
        if (oldTime == null) continue;
        const nextTime = oldTime + deltaMs;
        task.dueAt = new Date(nextTime).toISOString();
        task.updatedAt = now;
        task.scheduleShift = {
          sourceTaskId,
          deltaMs,
          previousDueAt: new Date(oldTime).toISOString(),
          shiftedAt: now
        };
        shiftedIds.add(task.id);
        changed.push(task);
        queue.push(task.id);
      }
    }
    return changed;
  }

  function refreshConflicts(tasks) {
    const conflicts = [];
    for (const task of tasks || []) {
      const due = validTime(task.dueAt);
      const ddl = validTime(task.ddlAt);
      const conflict = Boolean(task.isTerminal && !task.completed && due != null && ddl != null && due > ddl);
      task.needsReschedule = conflict;
      if (conflict) conflicts.push(task);
    }
    return conflicts;
  }

  function terminalTasks(tasks) {
    return (tasks || []).filter(task => task.isTerminal && !task.archived);
  }

  return {
    normalizeDependencyIds,
    wouldCreateCycle,
    incompleteDependencies,
    shiftDependents,
    refreshConflicts,
    terminalTasks
  };
});
