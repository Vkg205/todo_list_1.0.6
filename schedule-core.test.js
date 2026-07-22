const assert = require('assert');
const Schedule = require('../src/schedule-core');

const base = Date.UTC(2026, 6, 22, 9, 0, 0);
const tasks = [
  { id: 'A', title: 'A', dueAt: new Date(base).toISOString(), dependencyIds: [], completed: false },
  { id: 'B', title: 'B', dueAt: new Date(base + 24 * 3600_000).toISOString(), dependencyIds: ['A'], completed: false, isTerminal: false },
  { id: 'C', title: 'C', dueAt: new Date(base + 48 * 3600_000).toISOString(), dependencyIds: ['B'], completed: false, isTerminal: true, ddlAt: new Date(base + 60 * 3600_000).toISOString() }
];

assert.strictEqual(Schedule.wouldCreateCycle(tasks, 'A', ['C']), true);
assert.strictEqual(Schedule.wouldCreateCycle(tasks, 'B', ['A']), false);
assert.strictEqual(Schedule.incompleteDependencies(tasks, tasks[1]).length, 1);

const changed = Schedule.shiftDependents(tasks, 'A', 24 * 3600_000, base + 1000);
assert.deepStrictEqual(changed.map(t => t.id), ['B', 'C']);
assert.strictEqual(new Date(tasks[1].dueAt).getTime(), base + 48 * 3600_000);
assert.strictEqual(new Date(tasks[2].dueAt).getTime(), base + 72 * 3600_000);

const conflicts = Schedule.refreshConflicts(tasks);
assert.strictEqual(conflicts.length, 1);
assert.strictEqual(conflicts[0].id, 'C');
assert.strictEqual(tasks[2].needsReschedule, true);

console.log('schedule-core tests passed');
