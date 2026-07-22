const api = window.focusTodoApi;
let todoData = null;

async function load() {
  const result = await api.storage.local.get(['todoData']);
  todoData = result.todoData;
  const lists = (todoData.lists || []).filter(list => !list.archived);
  document.querySelector('#list').innerHTML = lists.map(list => `<option value="${list.id}">${list.icon || '📋'} ${list.name}</option>`).join('');
  document.querySelector('#list').value = todoData.settings?.defaultList || 'inbox';
  document.querySelector('#priority').value = todoData.settings?.defaultPriority || 'medium';
}

async function add() {
  const input = document.querySelector('#title');
  const title = input.value.trim();
  if (!title) return;
  const now = Date.now();
  todoData.tasks.unshift({
    id: crypto.randomUUID(), title, notes: '', listId: document.querySelector('#list').value,
    tags: [], priority: document.querySelector('#priority').value, color: null,
    completed: false, archived: false, createdAt: now, updatedAt: now, dueAt: null,
    completedAt: null, reminders: [], repeat: null, subtasks: [], attachments: [], order: now, snoozeAt: null
  });
  await api.storage.local.set({ todoData });
  await api.runtime.sendMessage({ type: 'REBUILD_ALARMS' });
  input.value = '';
  document.querySelector('#tip').textContent = '已添加并保存。';
  setTimeout(() => window.close(), 500);
}

document.querySelector('#add').onclick = add;
document.querySelector('#title').onkeydown = event => { if (event.key === 'Enter') add(); };
load().catch(error => { document.querySelector('#tip').textContent = `加载失败：${error.message}`; });
