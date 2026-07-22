const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { importTasksFile, exportTasksFile } = require('../data-io');

const template = path.join(__dirname, '..', 'templates', 'FocusTodo_Import_Template.xlsx');
const imported = importTasksFile(template);
assert.strictEqual(imported.type, 'tasks');
assert.strictEqual(imported.tasks.length, 3);
assert.ok(imported.tasks[0].title);
assert.ok(imported.tasks[0].subtasks.length >= 1);
assert.ok(Array.isArray(imported.tasks[1].dependencyIds));
assert.strictEqual(imported.tasks[1].dependencyIds[0], imported.tasks[0].id);
assert.strictEqual(imported.tasks[2].isTerminal, true);
assert.ok(imported.tasks[2].ddlAt);

const lists = imported.listNames.map((name, index) => ({ id: `list-${index}`, name }));
const listMap = new Map(lists.map(list => [list.name, list.id]));
const todoData = {
  lists,
  tasks: imported.tasks.map(task => ({ ...task, listId: listMap.get(task.listName) }))
};

for (const extension of ['xlsx', 'csv', 'json']) {
  const output = path.join(os.tmpdir(), `focustodo-data-io-test.${extension}`);
  exportTasksFile(output, todoData);
  assert.ok(fs.statSync(output).size > 10, `${extension} export should not be empty`);
  if (extension === 'csv') {
    const buffer = fs.readFileSync(output);
    assert.strictEqual(buffer[0], 0xEF);
    assert.strictEqual(buffer[1], 0xBB);
    assert.strictEqual(buffer[2], 0xBF);
  }
  fs.unlinkSync(output);
}

console.log('data-io tests passed');
