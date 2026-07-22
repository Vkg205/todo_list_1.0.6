// FocusTodo Pro Desktop v1.0.5
// Renderer UI, task management, import/export, repeat tasks and local desktop features.

function createDesktopFallbackApi() {
  const storageListeners = new Set();
  const runtimeListeners = new Set();
  const storageKey = 'focustodo.todoData';

  const readData = () => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.error('Failed to read fallback todo data:', error);
      return null;
    }
  };

  const writeData = todoData => {
    localStorage.setItem(storageKey, JSON.stringify(todoData));
    const change = { todoData: { newValue: todoData } };
    for (const listener of storageListeners) {
      try { listener(change, 'local'); } catch (error) { console.error(error); }
    }
  };

  return {
    storage: {
      local: {
        get: async () => ({ todoData: readData() }),
        set: async payload => {
          if (payload?.todoData) writeData(payload.todoData);
          return { ok: true };
        }
      },
      onChanged: {
        addListener: listener => storageListeners.add(listener),
        removeListener: listener => storageListeners.delete(listener)
      }
    },
    runtime: {
      sendMessage: async message => {
        if (message?.type === 'NOTIFY' && 'Notification' in window) {
          try {
            if (Notification.permission === 'default') await Notification.requestPermission();
            if (Notification.permission === 'granted') {
              new Notification(message.title || 'FocusTodo Pro', { body: message.message || '' });
            }
          } catch (error) {
            console.warn('Fallback notification failed:', error);
          }
        }
        return { ok: true };
      },
      onMessage: {
        addListener: listener => runtimeListeners.add(listener),
        removeListener: listener => runtimeListeners.delete(listener)
      }
    },
    tabs: { query: async () => [{ title: '', url: '' }] },
    sidePanel: { open: async () => ({ ok: true }) },
    desktop: {
      importTasks: async () => ({ ok: false, error: '桌面接口不可用' }),
      exportTasks: async () => ({ ok: false, error: '桌面接口不可用' }),
      exportTemplate: async () => ({ ok: false, error: '桌面接口不可用' }),
      selectAttachments: async () => [],
      openPath: async () => ({ ok: false }),
      openDataFolder: async () => ({ ok: false }),
      getDataPath: async () => ''
    }
  };
}

const chrome = window.focusTodoApi?.storage?.local ? window.focusTodoApi : createDesktopFallbackApi();
const desktop = chrome.desktop || createDesktopFallbackApi().desktop;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const Schedule = window.FocusTodoSchedule;

const DEFAULT_DATA = {
  tasks: [],
  lists: [
    { id: 'inbox', name: '收集箱', color: '#5b7cfa', icon: '📥', archived: false, notificationsEnabled: true },
    { id: 'work', name: '工作', color: '#ef5350', icon: '💼', archived: false, notificationsEnabled: true },
    { id: 'life', name: '生活', color: '#26a69a', icon: '🌿', archived: false, notificationsEnabled: true },
    { id: 'study', name: '学习', color: '#8e67d5', icon: '📚', archived: false, notificationsEnabled: true },
    { id: 'shopping', name: '购物', color: '#f5a623', icon: '🛒', archived: false, notificationsEnabled: true }
  ],
  settings: {
    theme: 'system',
    fontSize: 14,
    defaultList: 'inbox',
    defaultPriority: 'medium',
    autoArchive: false,
    overdueHighlight: true,
    quietStart: '22:00',
    quietEnd: '07:00',
    notifications: true
  },
  trash: [],
  habits: [],
  version: 3
};

let data = structuredClone(DEFAULT_DATA);
let state = {
  view: 'today',
  mode: 'list',
  sort: 'custom',
  selected: new Set(),
  search: '',
  filters: { listId: '', priority: '', time: '' },
  calendarDate: new Date(),
  calendarMode: 'month'
};
let bound = false;
let draggedTaskId = null;

async function migrateLegacyLocalStorage() {
  if (!window.focusTodoApi?.storage?.local) return;
  try {
    const raw = localStorage.getItem('focustodo.todoData');
    if (!raw) return;
    const legacy = JSON.parse(raw);
    const current = await window.focusTodoApi.storage.local.get(['todoData']);
    if (!(current?.todoData?.tasks || []).length && (legacy?.tasks || []).length) {
      await window.focusTodoApi.storage.local.set({ todoData: legacy });
    }
    localStorage.removeItem('focustodo.todoData');
  } catch (error) {
    console.warn('Legacy data migration failed:', error);
  }
}

function normalizeLoadedData(value) {
  const incoming = value || {};
  const tasks = Array.isArray(incoming.tasks) ? incoming.tasks.map(task => ({
    ...task,
    dependencyIds: Schedule.normalizeDependencyIds(task),
    isTerminal: Boolean(task.isTerminal),
    ddlAt: task.ddlAt || null,
    needsReschedule: Boolean(task.needsReschedule),
    scheduleShift: task.scheduleShift || null
  })) : [];
  Schedule.refreshConflicts(tasks);
  return {
    ...structuredClone(DEFAULT_DATA),
    ...incoming,
    tasks,
    lists: Array.isArray(incoming.lists) && incoming.lists.length ? incoming.lists : structuredClone(DEFAULT_DATA.lists),
    trash: Array.isArray(incoming.trash) ? incoming.trash : [],
    habits: Array.isArray(incoming.habits) ? incoming.habits : [],
    settings: { ...DEFAULT_DATA.settings, ...(incoming.settings || {}) },
    version: 3
  };
}

async function load() {
  await migrateLegacyLocalStorage();
  const result = await chrome.storage.local.get(['todoData']);
  data = normalizeLoadedData(result.todoData);
  applyTheme();
  if (!bound) bind();
  render();
  checkIncoming();
  if (chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener(changes => {
      if (changes?.todoData) {
        data = normalizeLoadedData(changes.todoData.newValue);
        render();
      }
    });
  }
}

async function save(rebuildReminders = true) {
  data.version = 3;
  await chrome.storage.local.set({ todoData: data });
  if (rebuildReminders) {
    await chrome.runtime.sendMessage({ type: 'REBUILD_ALARMS' }).catch(() => {});
  }
}

function uid() {
  return crypto.randomUUID();
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function renderNotes(value = '') {
  const lines = String(value).split(/\r?\n/).slice(0, 6);
  return lines.map(line => {
    const checklist = line.match(/^\s*-\s*\[([xX ])\]\s*(.*)$/);
    const bullet = line.match(/^\s*-\s+(.*)$/);
    let content = checklist ? checklist[2] : bullet ? bullet[1] : line;
    content = esc(content).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (checklist) return `<div class="note-list ${checklist[1].toLowerCase() === 'x' ? 'done' : ''}">${checklist[1].toLowerCase() === 'x' ? '☑' : '☐'} ${content}</div>`;
    if (bullet) return `<div class="note-list">• ${content}</div>`;
    return `<div>${content || '&nbsp;'}</div>`;
  }).join('');
}

function fmtDate(value, withTime = true) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
  }).format(date);
}

function dayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isToday(value) {
  return Boolean(value) && dayKey(value) === dayKey(Date.now());
}

function startDay(value = Date.now()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startWeek(value = Date.now()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date.getTime();
}

function priorityLabel(priority) {
  return { high: '高优先级', medium: '中优先级', low: '低优先级' }[priority] || '中优先级';
}

function listById(id) {
  return data.lists.find(item => item.id === id) || { name: '未知', icon: '📋', color: '#999' };
}

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  $('#toastRoot').append(node);
  setTimeout(() => node.remove(), 2700);
}

function applyTheme() {
  const theme = data.settings.theme;
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark', dark);
  document.documentElement.style.fontSize = `${data.settings.fontSize || 14}px`;
}

function bind() {
  bound = true;
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
  $('#newTaskBtn').onclick = () => openTaskModal();
  $('#fab').onclick = () => openTaskModal();
  $('#quickAddBtn').onclick = quickAdd;
  $('#quickInput').onkeydown = event => { if (event.key === 'Enter') quickAdd(); };
  $('#voiceBtn').onclick = voiceInput;
  $('#calendarBtn').onclick = () => { state.view = 'calendar'; render(); };
  $('#themeBtn').onclick = async () => {
    data.settings.theme = document.body.classList.contains('dark') ? 'light' : 'dark';
    applyTheme();
    await save(false);
  };
  $('#sortSelect').onchange = event => { state.sort = event.target.value; renderTasks(); };
  $('#searchBtn').onclick = openSearch;
  $('#addListBtn').onclick = () => openListModal();
  $('#smartViews').onclick = navClick;
  $('#listNav').onclick = navClick;
  $('.sidebar-bottom').onclick = navClick;
  $('#tagCloud').onclick = event => {
    if (event.target.dataset.tag) {
      state.view = `tag:${event.target.dataset.tag}`;
      render();
    }
  };
  $('#taskList').onclick = taskClick;
  $('#taskList').ondblclick = event => {
    if (event.target.closest('button, a, input')) return;
    const card = event.target.closest('.task-card');
    if (card) openTaskModal(card.dataset.id);
  };
  $('#bulkBar').onclick = bulkAction;
  $('#moreBtn').onclick = openTools;
  if (chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === 'FOCUS_QUICK_ADD') $('#quickInput').focus();
    });
  }
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
    if (event.key === 'Escape') closeModal();
  });
}

function navClick(event) {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  state.view = button.dataset.view;
  state.selected.clear();
  $('#sidebar').classList.remove('open');
  render();
}

function render() {
  renderSidebar();
  $$('main>section').forEach(section => section.classList.add('hidden'));
  if (state.view === 'calendar') {
    $('#calendarView').classList.remove('hidden');
    renderCalendar();
  } else if (state.view === 'stats') {
    $('#statsView').classList.remove('hidden');
    renderStats();
  } else if (state.view === 'settings') {
    $('#settingsView').classList.remove('hidden');
    renderSettings();
  } else {
    $('#taskView').classList.remove('hidden');
    renderTasks();
  }
}

function renderSidebar() {
  const active = data.tasks.filter(task => !task.archived);
  const smart = [
    ['all', '▣', '全部任务', active.filter(task => !task.completed).length],
    ['today', '☀', '今日待办', active.filter(task => !task.completed && isToday(task.dueAt)).length],
    ['reschedule', '🚨', '需重新排期', active.filter(task => task.needsReschedule).length],
    ['overdue', '⚠', '逾期任务', active.filter(task => !task.completed && task.dueAt && new Date(task.dueAt).getTime() < startDay()).length],
    ['upcoming', '◷', '即将到期', active.filter(task => !task.completed && task.dueAt && new Date(task.dueAt).getTime() >= startDay()).length],
    ['nodate', '○', '无日期任务', active.filter(task => !task.completed && !task.dueAt).length],
    ['completed', '✓', '已完成', active.filter(task => task.completed).length],
    ['trash', '♲', '回收站', data.trash.length]
  ];

  $('#smartViews').innerHTML = smart.map(([view, icon, name, count]) => `
    <button data-view="${view}" class="${state.view === view ? 'active' : ''}">
      <span>${icon} ${name}</span><span class="count">${count}</span>
    </button>`).join('');

  $('#listNav').innerHTML = data.lists.filter(list => !list.archived).map(list => `
    <button data-view="list:${list.id}" class="${state.view === `list:${list.id}` ? 'active' : ''}">
      <span><i style="color:${list.color}">●</i> ${esc(list.icon)} ${esc(list.name)}</span>
      <span class="count">${active.filter(task => !task.completed && task.listId === list.id).length}</span>
    </button>`).join('');
  $$('#listNav [data-view^="list:"]').forEach(button => {
    button.ondragover = event => { event.preventDefault(); button.classList.add('drop-target'); };
    button.ondragleave = () => button.classList.remove('drop-target');
    button.ondrop = async event => {
      event.preventDefault();
      button.classList.remove('drop-target');
      if (!draggedTaskId) return;
      const task = data.tasks.find(item => item.id === draggedTaskId);
      if (!task) return;
      task.listId = button.dataset.view.slice(5);
      task.updatedAt = Date.now();
      await save(false);
      render();
      toast('任务已移动到目标清单');
    };
  });

  const tags = [...new Set(data.tasks.flatMap(task => task.tags || []))].slice(0, 24);
  $('#tagCloud').innerHTML = tags.length
    ? tags.map(tag => `<span class="tag" data-tag="${esc(tag)}">#${esc(tag)}</span>`).join('')
    : '<span class="count">暂无标签</span>';
}

function filteredTasks() {
  let tasks = data.tasks.filter(task => !task.archived);
  const now = Date.now();
  const nextWeek = now + 7 * 86_400_000;

  if (state.view === 'today') tasks = tasks.filter(task => isToday(task.dueAt) && !task.completed);
  else if (state.view === 'all') tasks = tasks.filter(task => !task.completed);
  else if (state.view === 'reschedule') tasks = tasks.filter(task => task.needsReschedule && !task.completed);
  else if (state.view === 'overdue') tasks = tasks.filter(task => !task.completed && task.dueAt && new Date(task.dueAt).getTime() < startDay());
  else if (state.view === 'upcoming') tasks = tasks.filter(task => !task.completed && task.dueAt && new Date(task.dueAt).getTime() >= startDay() && new Date(task.dueAt).getTime() <= nextWeek);
  else if (state.view === 'nodate') tasks = tasks.filter(task => !task.completed && !task.dueAt);
  else if (state.view === 'completed') tasks = tasks.filter(task => task.completed);
  else if (state.view.startsWith('list:')) tasks = tasks.filter(task => task.listId === state.view.slice(5) && !task.completed);
  else if (state.view.startsWith('tag:')) tasks = tasks.filter(task => (task.tags || []).includes(state.view.slice(4)) && !task.completed);

  if (state.search) {
    const query = state.search.toLowerCase();
    tasks = tasks.filter(task => [task.title, task.notes, ...(task.tags || [])].join(' ').toLowerCase().includes(query));
  }
  if (state.filters.listId) tasks = tasks.filter(task => task.listId === state.filters.listId);
  if (state.filters.priority) tasks = tasks.filter(task => task.priority === state.filters.priority);
  if (state.filters.time === 'today') tasks = tasks.filter(task => isToday(task.dueAt));
  if (state.filters.time === 'overdue') tasks = tasks.filter(task => task.dueAt && !task.completed && new Date(task.dueAt).getTime() < startDay());
  if (state.filters.time === 'nodate') tasks = tasks.filter(task => !task.dueAt);

  const rank = { high: 0, medium: 1, low: 2 };
  if (state.sort === 'due') tasks.sort((a, b) => (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity));
  else if (state.sort === 'priority') tasks.sort((a, b) => rank[a.priority] - rank[b.priority]);
  else if (state.sort === 'created') tasks.sort((a, b) => b.createdAt - a.createdAt);
  else tasks.sort((a, b) => (a.order || 0) - (b.order || 0));

  if (['all', 'today'].includes(state.view) && state.sort === 'custom') {
    tasks.sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || (a.order || 0) - (b.order || 0));
  }
  tasks.sort((a, b) => Number(Boolean(b.needsReschedule)) - Number(Boolean(a.needsReschedule)));
  return tasks;
}

function titleForView() {
  if (state.view.startsWith('list:')) return listById(state.view.slice(5)).name;
  if (state.view.startsWith('tag:')) return `#${state.view.slice(4)}`;
  return {
    all: '全部任务', today: '今日待办', reschedule: '需重新排期', overdue: '逾期任务', upcoming: '未来 7 天',
    nodate: '无日期任务', completed: '已完成', trash: '回收站'
  }[state.view] || '待办';
}

function renderScheduleAlert() {
  const conflicts = data.tasks.filter(task => task.needsReschedule && !task.completed && !task.archived);
  const container = $('#scheduleAlert');
  if (!conflicts.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  const first = conflicts[0];
  container.classList.remove('hidden');
  container.innerHTML = `<span>🚨</span><strong>${conflicts.length} 个末尾任务的计划完成时间已超过 DDL，需要重新排期。</strong><button type="button" data-reschedule-task="${first.id}">立即调整</button>`;
  container.querySelector('[data-reschedule-task]').onclick = () => openTaskModal(first.id);
}

function renderTasks() {
  Schedule.refreshConflicts(data.tasks);
  renderScheduleAlert();
  const tasks = state.view === 'trash' ? data.trash : filteredTasks();
  $('#viewTitle').textContent = titleForView();
  const filterCount = Object.values(state.filters).filter(Boolean).length + Number(Boolean(state.search));
  $('#viewSubtitle').textContent = `${tasks.length} 项任务${filterCount ? ` · 已启用 ${filterCount} 个筛选` : ''} · ${new Intl.DateTimeFormat('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}`;
  $('#sortSelect').value = state.sort;

  if (state.view === 'trash') {
    renderTrash();
    return;
  }

  $('#taskList').className = state.mode === 'board' ? 'board' : '';
  $$('.seg').forEach(button => {
    button.classList.toggle('active', button.dataset.mode === state.mode);
    button.onclick = () => { state.mode = button.dataset.mode; renderTasks(); };
  });

  if (state.mode === 'board') renderBoard(tasks);
  else {
    $('#taskList').innerHTML = tasks.map(taskHtml).join('');
    enableDrag();
  }
  $('#emptyState').classList.toggle('hidden', tasks.length > 0);
  $('#bulkBar').classList.toggle('hidden', state.selected.size === 0);
  $('#selectedCount').textContent = `${state.selected.size} 项`;
}

function taskHtml(task) {
  const subtasks = task.subtasks || [];
  const completedSubtasks = subtasks.filter(item => item.completed).length;
  const progress = subtasks.length ? Math.round(completedSubtasks / subtasks.length * 100) : 0;
  const overdue = data.settings.overdueHighlight && task.dueAt && !task.completed && new Date(task.dueAt).getTime() < Date.now();
  const list = listById(task.listId);
  const attachments = task.attachments || [];
  const dependencies = Schedule.normalizeDependencyIds(task).map(id => data.tasks.find(item => item.id === id)).filter(Boolean);
  const incomplete = Schedule.incompleteDependencies(data.tasks, task);
  const subtaskPreview = subtasks.length ? `
    <div class="subtask-preview">
      ${subtasks.slice(0, 5).map(subtask => `
        <button class="subtask-chip ${subtask.completed ? 'done' : ''}" style="margin-left:${Math.max(0, Math.min(2, Number(subtask.level) || 0)) * 14}px" data-action="sub-toggle" data-sub-id="${subtask.id}">
          <span>${subtask.completed ? '✓' : '○'}</span>${esc(subtask.title)}
        </button>`).join('')}
      ${subtasks.length > 5 ? `<span class="count">+${subtasks.length - 5}</span>` : ''}
    </div>` : '';
  const shiftNote = task.scheduleShift?.deltaMs
    ? `<div class="schedule-shift-note">因前置任务延期，计划完成时间自动顺延 ${Math.round(task.scheduleShift.deltaMs / 60_000)} 分钟。</div>`
    : '';

  return `<article class="task-card ${overdue ? 'overdue' : ''} ${task.needsReschedule ? 'schedule-conflict' : ''} ${incomplete.length ? 'blocked' : ''} ${state.selected.has(task.id) ? 'selected' : ''} ${task.color ? 'custom-color' : ''}" style="${task.color ? `--task-color:${esc(task.color)}` : ''}" draggable="true" data-id="${task.id}">
    <button class="check ${task.completed ? 'done' : ''}" data-action="toggle" title="${incomplete.length ? '前置任务未完成，暂不可完成' : '标记完成'}">${task.completed ? '✓' : ''}</button>
    <div>
      <div class="task-title ${task.completed ? 'done' : ''}">${esc(task.title)}</div>
      ${task.notes ? `<div class="task-notes rich-note">${renderNotes(task.notes.slice(0, 500))}</div>` : ''}
      <div class="meta">
        ${task.dueAt ? `<span class="pill ${overdue ? 'high' : ''}">🕒 计划 ${fmtDate(task.dueAt)}</span>` : ''}
        ${task.isTerminal && task.ddlAt ? `<span class="pill ddl">🎯 DDL ${fmtDate(task.ddlAt)}</span>` : ''}
        ${task.needsReschedule ? '<span class="pill conflict">🚨 超过 DDL，需重排</span>' : ''}
        ${dependencies.length ? `<span class="pill dependency">🔗 前置：${dependencies.map(item => esc(item.title)).join('、')}</span>` : ''}
        ${incomplete.length ? `<span class="pill waiting">⏳ 等待 ${incomplete.length} 项前置任务</span>` : ''}
        <span class="pill ${task.priority}">${priorityLabel(task.priority)}</span>
        <span class="pill"><i style="color:${list.color}">●</i> ${esc(list.icon)} ${esc(list.name)}</span>
        ${(task.tags || []).map(tag => `<span class="pill">#${esc(tag)}</span>`).join('')}
        ${task.repeat ? `<span class="pill">↻ ${esc(task.repeat)}</span>` : ''}
        ${task.snoozeAt && new Date(task.snoozeAt).getTime() > Date.now() ? `<span class="pill">⏰ 稍后 ${fmtDate(task.snoozeAt)}</span>` : ''}
        ${attachments.length ? `<span class="pill">📎 ${attachments.length}</span>` : ''}
      </div>
      ${shiftNote}
      ${subtaskPreview}
      ${subtasks.length ? `<div class="progress"><i style="width:${progress}%"></i></div><div class="task-notes">${completedSubtasks}/${subtasks.length} 子任务完成</div>` : ''}
    </div>
    <button class="task-menu" data-action="menu">•••</button>
  </article>`;
}

function renderBoard(tasks) {
  const groups = [['high', '高优先级'], ['medium', '中优先级'], ['low', '低优先级']];
  $('#taskList').innerHTML = groups.map(([priority, name]) => `
    <div class="board-col" data-priority="${priority}">
      <h3>${name} · ${tasks.filter(task => task.priority === priority).length}</h3>
      ${tasks.filter(task => task.priority === priority).map(taskHtml).join('')}
    </div>`).join('');
  enableDrag();
}

function enableDrag() {
  $$('.task-card').forEach(card => {
    card.ondragstart = event => {
      if (event.target.closest('button, input')) {
        event.preventDefault();
        return;
      }
      draggedTaskId = card.dataset.id;
      card.classList.add('dragging');
    };
    card.ondragend = () => { card.classList.remove('dragging'); draggedTaskId = null; };
    card.ondragover = event => event.preventDefault();
    card.ondrop = async event => {
      event.preventDefault();
      const targetId = card.dataset.id;
      if (!draggedTaskId || draggedTaskId === targetId) return;
      const dragged = data.tasks.find(task => task.id === draggedTaskId);
      const target = data.tasks.find(task => task.id === targetId);
      if (!dragged || !target) return;
      const order = dragged.order;
      dragged.order = target.order;
      target.order = order;
      await save(false);
      renderTasks();
    };
  });

  $$('.board-col').forEach(column => {
    column.ondragover = event => event.preventDefault();
    column.ondrop = async () => {
      if (!draggedTaskId) return;
      const task = data.tasks.find(item => item.id === draggedTaskId);
      if (!task) return;
      task.priority = column.dataset.priority;
      task.updatedAt = Date.now();
      await save(false);
      renderTasks();
    };
  });
}

function nextRepeatDueAt(dueAt, repeat) {
  if (!dueAt || !repeat) return null;
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return null;
  if (repeat === '每日') date.setDate(date.getDate() + 1);
  else if (repeat === '工作日') {
    do { date.setDate(date.getDate() + 1); } while ([0, 6].includes(date.getDay()));
  } else if (repeat === '每周') date.setDate(date.getDate() + 7);
  else if (repeat === '每月') date.setMonth(date.getMonth() + 1);
  else if (repeat === '每年') date.setFullYear(date.getFullYear() + 1);
  else return null;
  return date.toISOString();
}

async function toggleTask(task) {
  if (!task.completed) {
    const incomplete = Schedule.incompleteDependencies(data.tasks, task);
    if (incomplete.length) {
      toast(`请先完成前置任务：${incomplete.map(item => item.title).join('、')}`);
      return;
    }
    task.completed = true;
    task.completedAt = Date.now();
    task.updatedAt = Date.now();
    if (task.repeat && task.dueAt) {
      const nextDueAt = nextRepeatDueAt(task.dueAt, task.repeat);
      if (nextDueAt && !task.repeatNextTaskId) {
        const next = structuredClone(task);
        next.id = uid();
        next.completed = false;
        next.completedAt = null;
        next.archived = false;
        next.dueAt = nextDueAt;
        next.createdAt = Date.now();
        next.updatedAt = Date.now();
        next.order = Date.now();
        next.snoozeAt = null;
        next.repeatNextTaskId = null;
        next.subtasks = (next.subtasks || []).map(subtask => ({ ...subtask, id: uid(), completed: false }));
        task.repeatNextTaskId = next.id;
        data.tasks.unshift(next);
      }
    }
    if (data.settings.autoArchive) task.archived = true;
    toast(task.repeat ? '任务已完成，下一次循环已生成' : '任务已完成');
  } else {
    task.completed = false;
    task.completedAt = null;
    task.archived = false;
    task.updatedAt = Date.now();
    if (task.repeatNextTaskId) {
      const generated = data.tasks.find(item => item.id === task.repeatNextTaskId);
      if (generated && !generated.completed) data.tasks = data.tasks.filter(item => item.id !== generated.id);
      task.repeatNextTaskId = null;
    }
    toast('已恢复任务');
  }
  await save();
}

async function taskClick(event) {
  const card = event.target.closest('.task-card');
  if (!card) return;
  const task = data.tasks.find(item => item.id === card.dataset.id);
  if (!task) return;

  const subToggle = event.target.closest('[data-action="sub-toggle"]');
  if (subToggle) {
    const subtask = (task.subtasks || []).find(item => item.id === subToggle.dataset.subId);
    if (subtask) {
      subtask.completed = !subtask.completed;
      task.updatedAt = Date.now();
      await save(false);
      renderTasks();
    }
    return;
  }
  if (event.target.closest('[data-action="toggle"]')) {
    await toggleTask(task);
    return;
  }
  if (event.target.closest('[data-action="menu"]')) {
    openTaskMenu(task);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    state.selected.has(task.id) ? state.selected.delete(task.id) : state.selected.add(task.id);
    renderTasks();
  }
}

function openTaskMenu(task) {
  modal(`<h2>${esc(task.title)}</h2>
    <div class="modal-actions action-grid">
      <button data-task-action="edit">编辑</button>
      <button data-task-action="duplicate">复制</button>
      <button data-task-action="pomodoro">🍅 专注 25 分钟</button>
      <button data-task-action="snooze10">稍后提醒 10 分钟</button>
      <button data-task-action="snooze60">稍后提醒 1 小时</button>
      ${task.repeat ? '<button data-task-action="skipRepeat">跳过本次循环</button><button data-task-action="stopRepeat">终止循环</button>' : ''}
      <button data-task-action="share">复制分享文本</button>
      <button data-task-action="delete" class="danger">移入回收站</button>
    </div>`);

  $$('[data-task-action]').forEach(button => {
    button.onclick = async () => {
      const action = button.dataset.taskAction;
      closeModal();
      if (action === 'edit') openTaskModal(task.id);
      else if (action === 'duplicate') {
        const copy = structuredClone(task);
        copy.id = uid();
        copy.title += '（副本）';
        copy.completed = false;
        copy.completedAt = null;
        copy.archived = false;
        copy.createdAt = copy.updatedAt = copy.order = Date.now();
        copy.subtasks = (copy.subtasks || []).map(subtask => ({ ...subtask, id: uid() }));
        data.tasks.unshift(copy);
        await save();
        toast('已复制');
      } else if (action === 'delete') await trashTask(task.id);
      else if (action === 'pomodoro') openPomodoro(task);
      else if (action === 'snooze10' || action === 'snooze60') {
        const minutes = action === 'snooze10' ? 10 : 60;
        task.snoozeAt = new Date(Date.now() + minutes * 60_000).toISOString();
        await save();
        toast(`已设置 ${minutes} 分钟后提醒`);
      } else if (action === 'skipRepeat') {
        const next = nextRepeatDueAt(task.dueAt, task.repeat);
        if (next) {
          task.dueAt = next;
          task.updatedAt = Date.now();
          await save();
          toast('已跳过本次循环');
        }
      } else if (action === 'stopRepeat') {
        task.repeat = null;
        task.updatedAt = Date.now();
        await save();
        toast('循环已终止');
      } else if (action === 'share') {
        const text = `${task.title}${task.dueAt ? `\n截止：${fmtDate(task.dueAt)}` : ''}${task.notes ? `\n${task.notes}` : ''}`;
        await navigator.clipboard.writeText(text).catch(() => {});
        toast('分享文本已复制');
      }
    };
  });
}

async function trashTask(id) {
  const index = data.tasks.findIndex(task => task.id === id);
  if (index < 0) return;
  data.trash.unshift({ ...data.tasks[index], deletedAt: Date.now() });
  data.tasks.splice(index, 1);
  await save();
  toast('已移入回收站');
}

function renderTrash() {
  $('#taskList').className = '';
  $('#taskList').innerHTML = data.trash.map(task => `
    <article class="task-card" data-id="${task.id}">
      <span>🗑</span>
      <div><div class="task-title">${esc(task.title)}</div><div class="task-notes">删除于 ${fmtDate(task.deletedAt)}</div></div>
      <div><button data-restore="${task.id}">恢复</button> <button data-purge="${task.id}" class="danger">彻底删除</button></div>
    </article>`).join('');
  $('#emptyState').classList.toggle('hidden', data.trash.length > 0);
  $$('[data-restore]').forEach(button => {
    button.onclick = async () => {
      const index = data.trash.findIndex(task => task.id === button.dataset.restore);
      const task = data.trash.splice(index, 1)[0];
      delete task.deletedAt;
      data.tasks.unshift(task);
      await save();
      toast('任务已恢复');
    };
  });
  $$('[data-purge]').forEach(button => {
    button.onclick = async () => {
      data.trash = data.trash.filter(task => task.id !== button.dataset.purge);
      await save(false);
      render();
    };
  });
}

async function quickAdd() {
  const input = $('#quickInput');
  const raw = input.value.trim();
  if (!raw) return;
  const parsed = parseNatural(raw);
  const now = Date.now();
  data.tasks.unshift({
    id: uid(),
    title: parsed.title || raw,
    notes: '',
    listId: parsed.listId || data.settings.defaultList,
    tags: parsed.tags,
    priority: parsed.priority || data.settings.defaultPriority,
    completed: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
    dueAt: parsed.dueAt,
    reminders: parsed.dueAt ? [30] : [],
    repeat: null,
    subtasks: [],
    attachments: [],
    dependencyIds: [],
    isTerminal: false,
    ddlAt: null,
    needsReschedule: false,
    scheduleShift: null,
    order: now,
    snoozeAt: null
  });
  input.value = '';
  await save();
  toast('待办已添加');
}

function parseNatural(raw) {
  let title = raw;
  let dueAt = null;
  let priority = null;
  let listId = null;
  const tags = [];
  const date = new Date();
  date.setSeconds(0, 0);

  if (/今天/.test(raw)) {
    date.setHours(18, 0, 0, 0);
    dueAt = date.toISOString();
    title = title.replace('今天', '');
  }
  if (/明天/.test(raw)) {
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    dueAt = date.toISOString();
    title = title.replace('明天', '');
  }
  if (/下周/.test(raw)) {
    date.setDate(date.getDate() + 7);
    date.setHours(9, 0, 0, 0);
    dueAt = date.toISOString();
    title = title.replace('下周', '');
  }
  const time = raw.match(/(\d{1,2})[点:时](\d{1,2})?/);
  if (time) {
    date.setHours(Number(time[1]), Number(time[2] || 0), 0, 0);
    dueAt = date.toISOString();
    title = title.replace(time[0], '');
  }
  if (/!高/.test(raw)) {
    priority = 'high';
    title = title.replace('!高', '');
  } else if (/!低/.test(raw)) {
    priority = 'low';
    title = title.replace('!低', '');
  }
  const hashTags = [...raw.matchAll(/#([\w\u4e00-\u9fa5-]+)/g)].map(match => match[1]);
  for (const tag of hashTags) {
    tags.push(tag);
    const list = data.lists.find(item => item.name === tag);
    if (list) listId = list.id;
    title = title.replace(`#${tag}`, '');
  }
  return { title: title.trim(), dueAt, priority, listId, tags };
}

function voiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast('当前系统不支持语音识别');
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = false;
  recognition.onresult = event => {
    $('#quickInput').value = event.results[0][0].transcript;
    quickAdd();
  };
  recognition.onerror = () => toast('语音识别失败，请检查麦克风权限');
  recognition.start();
  toast('正在聆听…');
}

function subRow(subtask = {}) {
  const level = Math.max(0, Math.min(2, Number(subtask.level) || 0));
  return `<div class="subtask-row" data-id="${subtask.id || uid()}">
    <input type="checkbox" data-subdone ${subtask.completed ? 'checked' : ''} aria-label="子任务完成状态">
    <select data-sublevel aria-label="子任务层级"><option value="0" ${level === 0 ? 'selected' : ''}>一级</option><option value="1" ${level === 1 ? 'selected' : ''}>二级</option><option value="2" ${level === 2 ? 'selected' : ''}>三级</option></select>
    <input type="text" data-subtitle value="${esc(subtask.title || '')}" placeholder="输入子任务内容">
    <button type="button" data-remove-sub aria-label="删除子任务">×</button>
  </div>`;
}

function attachmentRow(attachment, index) {
  const target = attachment.url || attachment.path || '';
  return `<div class="attachment-row" data-attachment-index="${index}">
    <span title="${esc(target)}">📎 ${esc(attachment.name || target)}</span>
    <div><button type="button" data-open-attachment="${index}">打开</button><button type="button" data-remove-attachment="${index}">删除</button></div>
  </div>`;
}

function openTaskModal(id = null) {
  const existing = id ? data.tasks.find(task => task.id === id) : null;
  const newTaskId = existing?.id || uid();
  const task = existing || {
    id: newTaskId,
    title: '', notes: '', listId: data.settings.defaultList, tags: [], priority: data.settings.defaultPriority,
    dueAt: null, reminders: [30], repeat: null, subtasks: [], attachments: [], dependencyIds: [],
    isTerminal: false, ddlAt: null
  };
  let draftAttachments = structuredClone(task.attachments || []);
  const toLocalInput = value => value
    ? new Date(new Date(value).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    : '';
  const localDue = toLocalInput(task.dueAt);
  const localDdl = toLocalInput(task.ddlAt);
  const selectedDependencies = new Set(Schedule.normalizeDependencyIds(task));
  const dependencyCandidates = data.tasks.filter(candidate => !candidate.archived && candidate.id !== newTaskId);
  const dependencyOptions = dependencyCandidates.length
    ? dependencyCandidates.map(candidate => `<label class="dependency-option"><input type="checkbox" data-dependency-id="${candidate.id}" ${selectedDependencies.has(candidate.id) ? 'checked' : ''}><span title="${esc(candidate.title)}">${candidate.completed ? '✓' : '○'} ${esc(candidate.title)} · ${esc(listById(candidate.listId).name)}</span></label>`).join('')
    : '<div class="count">暂无可选任务。先创建前置任务，再回来设置依赖。</div>';

  modal(`<h2>${existing ? '编辑待办' : '新建待办'}</h2>
    <div class="form-grid">
      <div class="field full"><label>标题</label><input id="fTitle" value="${esc(task.title)}" placeholder="要完成什么？"></div>
      <div class="field full"><label>详细备注</label><div class="note-toolbar"><button type="button" data-note-format="bold"><b>B</b></button><button type="button" data-note-format="bullet">• 列表</button><button type="button" data-note-format="check">☐ 清单</button></div><textarea id="fNotes" placeholder="支持 **加粗**、- 列表、- [ ] 清单">${esc(task.notes || '')}</textarea></div>
      <div class="field"><label>清单</label><select id="fList">${data.lists.filter(list => !list.archived).map(list => `<option value="${list.id}" ${list.id === task.listId ? 'selected' : ''}>${esc(list.icon)} ${esc(list.name)}</option>`).join('')}</select></div>
      <div class="field"><label>优先级</label><select id="fPriority"><option value="high" ${task.priority === 'high' ? 'selected' : ''}>高</option><option value="medium" ${task.priority === 'medium' ? 'selected' : ''}>中</option><option value="low" ${task.priority === 'low' ? 'selected' : ''}>低</option></select></div>
      <div class="field"><label>任务颜色</label><div class="color-field"><input id="fColor" type="color" value="${task.color || '#5b7cfa'}"><label><input id="fUseColor" type="checkbox" ${task.color ? 'checked' : ''}> 启用自定义颜色</label></div></div>
      <div class="field"><label>计划完成时间</label><input id="fDue" type="datetime-local" value="${localDue}"></div>
      <div class="field full"><label>前置任务（可多选）</label><div class="dependency-checklist">${dependencyOptions}</div><div class="dependency-help">当前任务只有在所有前置任务完成后才能标记完成。若某个前置任务的计划完成时间向后调整，其后续任务会按相同时间差自动顺延。</div></div>
      <div class="field"><label>任务类型</label><label class="terminal-options"><input id="fTerminal" type="checkbox" ${task.isTerminal ? 'checked' : ''}> 末尾任务 / 最终交付任务</label></div>
      <div class="field ddl-field ${task.isTerminal ? '' : 'hidden'}" id="ddlField"><label>DDL（末尾任务硬截止）</label><input id="fDdl" type="datetime-local" value="${localDdl}"></div>
      <div class="field"><label>重复</label><select id="fRepeat"><option value="">不重复</option>${['每日', '工作日', '每周', '每月', '每年'].map(value => `<option ${task.repeat === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
      <div class="field"><label>提前提醒（分钟，使用逗号分隔）</label><input id="fReminders" value="${(task.reminders || []).join(',')}"></div>
      <div class="field"><label>标签（使用逗号分隔）</label><input id="fTags" value="${esc((task.tags || []).join(','))}"></div>
      <div class="field full"><label>子任务</label><div id="subs">${(task.subtasks || []).map(subtask => subRow(subtask)).join('')}</div><button type="button" id="addSub">＋ 添加子任务</button></div>
      <div class="field full"><label>附件</label><div id="attachments"></div><div class="inline-actions"><button type="button" id="addFiles">＋ 选择文件</button><button type="button" id="addLink">＋ 添加链接</button></div></div>
    </div>
    <div class="modal-actions">${existing ? '<button id="deleteTask" class="danger">删除</button>' : ''}<button data-close>取消</button><button class="save" id="saveTask">保存</button></div>`);

  const renderAttachments = () => {
    $('#attachments').innerHTML = draftAttachments.length
      ? draftAttachments.map(attachmentRow).join('')
      : '<div class="count">暂无附件</div>';
    $$('[data-open-attachment]').forEach(button => {
      button.onclick = () => {
        const attachment = draftAttachments[Number(button.dataset.openAttachment)];
        desktop.openPath(attachment?.url || attachment?.path || '');
      };
    });
    $$('[data-remove-attachment]').forEach(button => {
      button.onclick = () => {
        draftAttachments.splice(Number(button.dataset.removeAttachment), 1);
        renderAttachments();
      };
    });
  };
  renderAttachments();

  $$('[data-note-format]').forEach(button => {
    button.onclick = () => {
      const textarea = $('#fNotes');
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = textarea.value.slice(start, end);
      const format = button.dataset.noteFormat;
      const insertion = format === 'bold' ? `**${selected || '加粗文本'}**` : format === 'bullet' ? `- ${selected || '列表项'}` : `- [ ] ${selected || '清单项'}`;
      textarea.setRangeText(insertion, start, end, 'end');
      textarea.focus();
    };
  });
  $('#fTitle').focus();
  $('#fTerminal').onchange = () => $('#ddlField').classList.toggle('hidden', !$('#fTerminal').checked);
  $('#addSub').onclick = () => {
    $('#subs').insertAdjacentHTML('beforeend', subRow());
    const inputs = $$('#subs [data-subtitle]');
    inputs[inputs.length - 1]?.focus();
  };
  $('#subs').onclick = event => {
    const remove = event.target.closest('[data-remove-sub]');
    if (remove) remove.closest('.subtask-row').remove();
  };
  $('#addFiles').onclick = async () => {
    const files = await desktop.selectAttachments();
    if (files?.length) {
      draftAttachments.push(...files);
      renderAttachments();
    }
  };
  $('#addLink').onclick = () => {
    const link = prompt('请输入网页链接：');
    if (!link?.trim()) return;
    draftAttachments.push({ type: 'link', url: link.trim(), name: link.trim() });
    renderAttachments();
  };

  $('#saveTask').onclick = async () => {
    const title = $('#fTitle').value.trim();
    if (!title) {
      toast('请输入标题');
      return;
    }
    const dependencyIds = $$('[data-dependency-id]:checked').map(input => input.dataset.dependencyId);
    if (Schedule.wouldCreateCycle(data.tasks, newTaskId, dependencyIds)) {
      toast('依赖关系形成循环，请取消其中一个前置任务');
      return;
    }
    const dueAt = $('#fDue').value ? new Date($('#fDue').value).toISOString() : null;
    const isTerminal = $('#fTerminal').checked;
    const ddlAt = isTerminal && $('#fDdl').value ? new Date($('#fDdl').value).toISOString() : null;
    if (isTerminal && !dueAt) {
      toast('末尾任务必须填写计划完成时间');
      return;
    }
    if (isTerminal && !ddlAt) {
      toast('末尾任务必须填写 DDL');
      return;
    }

    const now = Date.now();
    const oldDueTime = existing?.dueAt ? new Date(existing.dueAt).getTime() : null;
    const newDueTime = dueAt ? new Date(dueAt).getTime() : null;
    const object = {
      ...(existing || {}),
      id: newTaskId,
      title,
      notes: $('#fNotes').value,
      listId: $('#fList').value,
      priority: $('#fPriority').value,
      color: $('#fUseColor').checked ? $('#fColor').value : null,
      dueAt,
      dependencyIds,
      isTerminal,
      ddlAt,
      repeat: $('#fRepeat').value || null,
      reminders: $('#fReminders').value.split(/[,，|]/).map(Number).filter(value => Number.isFinite(value) && value >= 0),
      tags: $('#fTags').value.split(/[,，|]/).map(value => value.trim()).filter(Boolean),
      subtasks: $$('.subtask-row').map(row => ({
        id: row.dataset.id || uid(),
        title: row.querySelector('[data-subtitle]').value.trim(),
        completed: row.querySelector('[data-subdone]').checked,
        level: Number(row.querySelector('[data-sublevel]').value) || 0
      })).filter(subtask => subtask.title),
      attachments: draftAttachments,
      completed: existing?.completed || false,
      archived: existing?.archived || false,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      order: existing?.order || now,
      snoozeAt: existing?.snoozeAt || null,
      scheduleShift: existing && (dueAt !== existing.dueAt || ddlAt !== existing.ddlAt) ? null : (existing?.scheduleShift || null)
    };

    if (existing) Object.assign(existing, object);
    else data.tasks.unshift(object);

    let shifted = [];
    if (existing && oldDueTime != null && newDueTime != null && newDueTime > oldDueTime) {
      shifted = Schedule.shiftDependents(data.tasks, existing.id, newDueTime - oldDueTime, now);
    }
    const conflicts = Schedule.refreshConflicts(data.tasks);
    await save();
    closeModal();
    if (shifted.length && conflicts.length) toast(`已顺延 ${shifted.length} 个后续任务；${conflicts.length} 个末尾任务超过 DDL，已置顶提醒`);
    else if (shifted.length) toast(`已自动顺延 ${shifted.length} 个后续任务`);
    else if (object.needsReschedule) toast('计划完成时间超过 DDL，任务已置顶等待重新排期');
    else toast(existing ? '待办已更新' : '待办已创建');
  };
  if (existing) $('#deleteTask').onclick = async () => { closeModal(); await trashTask(existing.id); };
}

function modal(html) {
  $('#modalRoot').innerHTML = `<div class="modal-overlay"><div class="modal">${html}</div></div>`;
  $$('[data-close]').forEach(button => { button.onclick = closeModal; });
  $('.modal-overlay').onclick = event => {
    if (event.target.classList.contains('modal-overlay')) closeModal();
  };
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
}

async function bulkAction(event) {
  const action = event.target.dataset.bulk;
  if (!action) return;
  if (action === 'cancel') {
    state.selected.clear();
    renderTasks();
    return;
  }
  const ids = [...state.selected];
  if (action === 'complete') {
    let blockedCount = 0;
    for (const task of data.tasks.filter(item => ids.includes(item.id) && !item.completed)) {
      if (Schedule.incompleteDependencies(data.tasks, task).length) {
        blockedCount += 1;
        continue;
      }
      task.completed = true;
      task.completedAt = Date.now();
      task.updatedAt = Date.now();
    }
    if (blockedCount) toast(`${blockedCount} 个任务因前置任务未完成而跳过`);
  } else if (action === 'delete') {
    for (const id of ids) {
      const index = data.tasks.findIndex(task => task.id === id);
      if (index >= 0) {
        data.trash.unshift({ ...data.tasks[index], deletedAt: Date.now() });
        data.tasks.splice(index, 1);
      }
    }
  } else if (action === 'move') {
    openMoveModal(ids);
    return;
  }
  state.selected.clear();
  await save();
  renderTasks();
}

function openMoveModal(ids) {
  modal(`<h2>移动到清单</h2><div class="field"><label>目标清单</label><select id="moveTarget">${data.lists.filter(list => !list.archived).map(list => `<option value="${list.id}">${esc(list.icon)} ${esc(list.name)}</option>`).join('')}</select></div><div class="modal-actions"><button data-close>取消</button><button id="confirmMove" class="save">移动</button></div>`);
  $('#confirmMove').onclick = async () => {
    const target = $('#moveTarget').value;
    data.tasks.forEach(task => { if (ids.includes(task.id)) task.listId = target; });
    state.selected.clear();
    await save();
    closeModal();
    renderTasks();
  };
}

function openListModal(id = null) {
  const existing = id ? data.lists.find(list => list.id === id) : null;
  modal(`<h2>${existing ? '编辑清单' : '新建清单'}</h2><div class="form-grid"><div class="field full"><label>名称</label><input id="lName" value="${esc(existing?.name || '')}" placeholder="例如：项目 A"></div><div class="field"><label>图标</label><input id="lIcon" value="${esc(existing?.icon || '📋')}"></div><div class="field"><label>颜色</label><input id="lColor" type="color" value="${existing?.color || '#5b7cfa'}"></div><div class="field full"><label class="checkbox-label"><input id="lNotify" type="checkbox" ${existing?.notificationsEnabled === false ? '' : 'checked'}> 启用该清单提醒</label></div></div><div class="modal-actions"><button data-close>取消</button><button class="save" id="saveList">保存</button></div>`);
  $('#saveList').onclick = async () => {
    const name = $('#lName').value.trim();
    if (!name) return;
    if (existing) {
      existing.name = name;
      existing.icon = $('#lIcon').value || '📋';
      existing.color = $('#lColor').value;
      existing.notificationsEnabled = $('#lNotify').checked;
    } else {
      data.lists.push({ id: uid(), name, icon: $('#lIcon').value || '📋', color: $('#lColor').value, archived: false, notificationsEnabled: $('#lNotify').checked });
    }
    await save(false);
    closeModal();
    render();
  };
}

function openSearch() {
  modal(`<h2>搜索与组合筛选</h2><div class="form-grid">
    <div class="field full"><label>关键词</label><input id="searchInput" value="${esc(state.search)}" placeholder="搜索标题、备注、标签"></div>
    <div class="field"><label>清单</label><select id="filterList"><option value="">全部清单</option>${data.lists.filter(list => !list.archived).map(list => `<option value="${list.id}" ${state.filters.listId === list.id ? 'selected' : ''}>${esc(list.name)}</option>`).join('')}</select></div>
    <div class="field"><label>优先级</label><select id="filterPriority"><option value="">全部优先级</option><option value="high" ${state.filters.priority === 'high' ? 'selected' : ''}>高</option><option value="medium" ${state.filters.priority === 'medium' ? 'selected' : ''}>中</option><option value="low" ${state.filters.priority === 'low' ? 'selected' : ''}>低</option></select></div>
    <div class="field full"><label>时间</label><select id="filterTime"><option value="">全部时间</option><option value="today" ${state.filters.time === 'today' ? 'selected' : ''}>今日</option><option value="overdue" ${state.filters.time === 'overdue' ? 'selected' : ''}>逾期</option><option value="nodate" ${state.filters.time === 'nodate' ? 'selected' : ''}>无日期</option></select></div>
  </div><div class="modal-actions"><button id="clearSearch">清除筛选</button><button class="save" id="doSearch">应用</button></div>`);
  $('#searchInput').focus();
  $('#doSearch').onclick = () => {
    state.search = $('#searchInput').value.trim();
    state.filters = { listId: $('#filterList').value, priority: $('#filterPriority').value, time: $('#filterTime').value };
    state.view = 'all';
    closeModal();
    render();
  };
  $('#clearSearch').onclick = () => {
    state.search = '';
    state.filters = { listId: '', priority: '', time: '' };
    closeModal();
    render();
  };
}

function renderCalendar() {
  if (state.calendarMode === 'week') renderWeekCalendar();
  else renderMonthCalendar();
}

function calendarHeader(title) {
  return `<div class="calendar-head"><button id="calBack">←</button><h1>${title}</h1><div><button id="calMonth" class="${state.calendarMode === 'month' ? 'active' : ''}">月</button><button id="calWeek" class="${state.calendarMode === 'week' ? 'active' : ''}">周</button><button id="calToday">今天</button><button id="calNext">→</button></div></div>`;
}

function bindCalendarHeader(back, next) {
  $('#calBack').onclick = back;
  $('#calNext').onclick = next;
  $('#calToday').onclick = () => { state.calendarDate = new Date(); renderCalendar(); };
  $('#calMonth').onclick = () => { state.calendarMode = 'month'; renderCalendar(); };
  $('#calWeek').onclick = () => { state.calendarMode = 'week'; renderCalendar(); };
  $$('.cal-task').forEach(node => { node.onclick = event => { event.stopPropagation(); openTaskModal(node.dataset.id); }; });
}

function renderMonthCalendar() {
  const base = state.calendarDate;
  const year = base.getFullYear();
  const month = base.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
  $('#calendarView').innerHTML = `${calendarHeader(`${year} 年 ${month + 1} 月`)}<div class="calendar-grid">${['日', '一', '二', '三', '四', '五', '六'].map(value => `<b class="cal-weekday">${value}</b>`).join('')}${days.map(date => {
    const tasks = data.tasks.filter(task => task.dueAt && dayKey(task.dueAt) === dayKey(date) && !task.archived);
    return `<div class="cal-day ${date.getMonth() !== month ? 'muted' : ''} ${isToday(date) ? 'today' : ''}"><span class="cal-num">${date.getDate()}</span>${tasks.slice(0, 5).map(task => `<div class="cal-task" data-id="${task.id}">${esc(task.title)}</div>`).join('')}${tasks.length > 5 ? `<small>+${tasks.length - 5}</small>` : ''}</div>`;
  }).join('')}</div>`;
  bindCalendarHeader(
    () => { state.calendarDate = new Date(year, month - 1, 1); renderCalendar(); },
    () => { state.calendarDate = new Date(year, month + 1, 1); renderCalendar(); }
  );
}

function renderWeekCalendar() {
  const start = new Date(startWeek(state.calendarDate));
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
  const end = days[6];
  $('#calendarView').innerHTML = `${calendarHeader(`${start.getMonth() + 1}/${start.getDate()} – ${end.getMonth() + 1}/${end.getDate()}`)}<div class="week-calendar">${days.map(date => {
    const tasks = data.tasks.filter(task => task.dueAt && dayKey(task.dueAt) === dayKey(date) && !task.archived);
    return `<div class="week-day ${isToday(date) ? 'today' : ''}"><h3>${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()]}<small>${date.getMonth() + 1}/${date.getDate()}</small></h3>${tasks.map(task => `<button class="week-task cal-task" data-id="${task.id}"><span>${new Date(task.dueAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>${esc(task.title)}</button>`).join('') || '<p class="count">暂无任务</p>'}</div>`;
  }).join('')}</div>`;
  bindCalendarHeader(
    () => { state.calendarDate = new Date(start.getTime() - 7 * 86_400_000); renderCalendar(); },
    () => { state.calendarDate = new Date(start.getTime() + 7 * 86_400_000); renderCalendar(); }
  );
}

function renderStats() {
  const all = data.tasks.filter(task => !task.archived);
  const completed = all.filter(task => task.completed);
  const todayCompleted = completed.filter(task => isToday(task.completedAt));
  const todayRelevant = all.filter(task => isToday(task.createdAt) || isToday(task.dueAt));
  const weekStart = startWeek();
  const weekCompleted = completed.filter(task => task.completedAt && task.completedAt >= weekStart);
  const weekRelevant = all.filter(task => (task.createdAt && task.createdAt >= weekStart) || (task.dueAt && new Date(task.dueAt).getTime() >= weekStart));
  let streak = 0;
  const date = new Date();
  for (let index = 0; index < 365; index += 1) {
    const key = dayKey(date);
    if (completed.some(task => task.completedAt && dayKey(task.completedAt) === key)) {
      streak += 1;
      date.setDate(date.getDate() - 1);
    } else break;
  }
  const byList = data.lists.map(list => ({ name: list.name, count: all.filter(task => task.listId === list.id).length })).filter(item => item.count);
  const max = Math.max(1, ...byList.map(item => item.count));
  $('#statsView').innerHTML = `<div class="view-head"><div><h1>数据统计</h1><p>了解你的任务完成节奏</p></div></div>
    <div class="stats-cards">
      <div class="stat"><b>${all.length}</b><span>任务总数</span></div>
      <div class="stat"><b>${completed.length}</b><span>累计完成</span></div>
      <div class="stat"><b>${todayRelevant.length ? Math.round(todayCompleted.length / todayRelevant.length * 100) : 0}%</b><span>今日完成率</span></div>
      <div class="stat"><b>${weekRelevant.length ? Math.round(weekCompleted.length / weekRelevant.length * 100) : 0}%</b><span>本周完成率</span></div>
      <div class="stat"><b>${streak}</b><span>连续完成天数</span></div>
    </div>
    <div class="chart"><h3>各清单任务占比</h3>${byList.map(item => `<div class="bar-row"><span>${esc(item.name)}</span><div class="bar-bg"><div class="bar-fill" style="width:${item.count / max * 100}%"></div></div><b>${item.count}</b></div>`).join('') || '<p>暂无数据</p>'}</div>
    <div class="chart"><h3>最近 7 天完成数</h3>${[6, 5, 4, 3, 2, 1, 0].map(offset => {
      const day = new Date();
      day.setDate(day.getDate() - offset);
      const count = completed.filter(task => task.completedAt && dayKey(task.completedAt) === dayKey(day)).length;
      return `<div class="bar-row"><span>${day.getMonth() + 1}/${day.getDate()}</span><div class="bar-bg"><div class="bar-fill" style="width:${Math.min(100, count * 20)}%"></div></div><b>${count}</b></div>`;
    }).join('')}</div>
    ${renderHabitCalendar(completed)}`;
}

function renderHabitCalendar(completedTasks) {
  const repeating = completedTasks.filter(task => task.repeat && task.completedAt);
  const groups = new Map();
  for (const task of repeating) {
    const key = task.title.trim();
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(dayKey(task.completedAt));
  }
  if (!groups.size) return '<div class="chart"><h3>循环任务打卡</h3><p class="count">完成循环任务后，这里会显示最近 30 天打卡记录。</p></div>';
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (29 - index));
    return date;
  });
  return `<div class="chart"><h3>循环任务打卡（最近 30 天）</h3><div class="habit-grid">${[...groups.entries()].map(([title, doneDays]) => `<div class="habit-row"><span title="${esc(title)}">${esc(title)}</span><div>${days.map(date => `<i class="${doneDays.has(dayKey(date)) ? 'done' : ''}" title="${dayKey(date)}"></i>`).join('')}</div></div>`).join('')}</div></div>`;
}

function toggleRow(label, key, on) {
  return `<div class="setting-row"><span>${label}</span><button class="switch ${on ? 'on' : ''}" data-setting="${key}"><i></i></button></div>`;
}

function renderSettings() {
  const settings = data.settings;
  $('#settingsView').innerHTML = `<div class="view-head"><div><h1>设置</h1><p>个性化你的待办体验</p></div></div>
    <div class="settings-card"><h3>外观</h3>
      <div class="setting-row"><span>主题</span><select id="setTheme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div>
      <div class="setting-row"><span>字体大小</span><input id="setFont" type="range" min="12" max="18" value="${settings.fontSize}"></div>
    </div>
    <div class="settings-card"><h3>新建任务默认值</h3>
      <div class="setting-row"><span>默认清单</span><select id="defaultList">${data.lists.filter(list => !list.archived).map(list => `<option value="${list.id}">${esc(list.icon)} ${esc(list.name)}</option>`).join('')}</select></div>
      <div class="setting-row"><span>默认优先级</span><select id="defaultPriority"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></div>
    </div>
    <div class="settings-card"><h3>行为与通知</h3>
      ${toggleRow('自动归档已完成任务', 'autoArchive', settings.autoArchive)}
      ${toggleRow('逾期任务标红', 'overdueHighlight', settings.overdueHighlight)}
      ${toggleRow('系统通知', 'notifications', settings.notifications)}
      <div class="setting-row"><span>静音时段</span><span><input id="quietStart" type="time" value="${settings.quietStart}"> - <input id="quietEnd" type="time" value="${settings.quietEnd}"></span></div>
    </div>
    <div class="settings-card"><h3>导入、导出与备份</h3>
      <div class="setting-row"><span>导入待办（XLSX / CSV / JSON）</span><button id="importTasks">导入</button></div>
      <div class="setting-row"><span>下载标准导入模板</span><button id="exportTemplate">XLSX 模板</button></div>
      <div class="setting-row"><span>导出待办</span><span><button data-export="xlsx">XLSX</button> <button data-export="csv">CSV</button> <button data-export="json">JSON</button></span></div>
      <div class="setting-row"><span>打开本地数据目录</span><button id="openDataFolder">打开</button></div>
      <div class="setting-row"><span>清空已完成</span><button id="clearCompleted" class="danger">清空</button></div>
    </div>
    <div class="settings-card"><h3>清单管理</h3><div class="list-manager">${data.lists.map(list => `<div class="list-manage-row"><span><i style="color:${list.color}">●</i> ${esc(list.icon)} ${esc(list.name)} ${list.archived ? '<em>已隐藏</em>' : ''} ${list.notificationsEnabled === false ? '<em>提醒关闭</em>' : ''}</span><div><button data-toggle-list-notify="${list.id}">${list.notificationsEnabled === false ? '开启提醒' : '关闭提醒'}</button><button data-edit-list="${list.id}">编辑</button><button data-archive-list="${list.id}">${list.archived ? '恢复' : '隐藏'}</button></div></div>`).join('')}</div></div>
    <div class="settings-card"><h3>同步与协作</h3><p class="count">当前版本为本地桌面版，已支持持久保存、备份和文件导入导出。账号云同步、多人协作共享、手机小组件和第三方日历双向同步仍需要独立后端及对应平台客户端。</p></div>`;

  $('#setTheme').value = settings.theme;
  $('#defaultList').value = settings.defaultList;
  $('#defaultPriority').value = settings.defaultPriority;
  $('#setTheme').onchange = async event => { settings.theme = event.target.value; applyTheme(); await save(false); };
  $('#setFont').oninput = async event => { settings.fontSize = Number(event.target.value); applyTheme(); await save(false); };
  $('#defaultList').onchange = async event => { settings.defaultList = event.target.value; await save(false); };
  $('#defaultPriority').onchange = async event => { settings.defaultPriority = event.target.value; await save(false); };
  $$('[data-setting]').forEach(button => {
    button.onclick = async () => {
      const key = button.dataset.setting;
      settings[key] = !settings[key];
      await save(false);
      renderSettings();
    };
  });
  $('#quietStart').onchange = async event => { settings.quietStart = event.target.value; await save(false); };
  $('#quietEnd').onchange = async event => { settings.quietEnd = event.target.value; await save(false); };
  $('#importTasks').onclick = importTasks;
  $('#exportTemplate').onclick = exportTemplate;
  $$('[data-export]').forEach(button => { button.onclick = () => exportTasks(button.dataset.export); });
  $('#openDataFolder').onclick = async () => {
    const result = await desktop.openDataFolder();
    if (result?.ok === false) toast(result.error || '无法打开数据目录');
  };
  $('#clearCompleted').onclick = async () => {
    const completed = data.tasks.filter(task => task.completed);
    data.trash.unshift(...completed.map(task => ({ ...task, deletedAt: Date.now() })));
    data.tasks = data.tasks.filter(task => !task.completed);
    await save();
    renderSettings();
    toast('已清空已完成任务');
  };
  $$('[data-edit-list]').forEach(button => { button.onclick = () => openListModal(button.dataset.editList); });
  $$('[data-toggle-list-notify]').forEach(button => {
    button.onclick = async () => {
      const list = data.lists.find(item => item.id === button.dataset.toggleListNotify);
      if (!list) return;
      list.notificationsEnabled = list.notificationsEnabled === false;
      await save();
      renderSettings();
    };
  });
  $$('[data-archive-list]').forEach(button => {
    button.onclick = async () => {
      const list = data.lists.find(item => item.id === button.dataset.archiveList);
      if (!list) return;
      list.archived = !list.archived;
      if (list.id === data.settings.defaultList && list.archived) data.settings.defaultList = 'inbox';
      await save(false);
      render();
    };
  });
}

async function importTasks() {
  const response = await desktop.importTasks();
  if (!response?.ok) {
    if (!response?.canceled) toast(response?.error || '导入失败');
    return;
  }
  const result = response.result;
  if (result.type === 'backup') {
    modal(`<h2>导入 JSON 备份</h2><p>检测到完整备份，包含 ${(result.data.tasks || []).length} 条任务。请选择导入方式。</p><div class="modal-actions"><button data-close>取消</button><button id="mergeBackup">仅合并任务</button><button id="replaceBackup" class="save">覆盖全部数据</button></div>`);
    $('#replaceBackup').onclick = async () => {
      data = normalizeLoadedData(result.data);
      await save();
      closeModal();
      render();
      toast('完整备份已恢复');
    };
    $('#mergeBackup').onclick = async () => {
      mergeBackupTasks(result.data.tasks || [], result.data.lists || []);
      await save();
      closeModal();
      render();
      toast('备份任务已合并');
    };
    return;
  }

  const warningHtml = result.warnings?.length ? `<details><summary>${result.warnings.length} 条提示</summary><div class="import-warnings">${result.warnings.map(warning => `<div>${esc(warning)}</div>`).join('')}</div></details>` : '';
  modal(`<h2>导入待办</h2><p>已识别 ${result.tasks.length} 条任务、${result.listNames.length} 个清单。</p>${warningHtml}<div class="modal-actions"><button data-close>取消</button><button id="replaceImport">替换现有任务</button><button id="appendImport" class="save">追加/按 ID 更新</button></div>`);
  $('#appendImport').onclick = async () => {
    applyImportedTasks(result.tasks, result.listNames, false);
    await save();
    closeModal();
    render();
    toast(`已导入 ${result.tasks.length} 条任务`);
  };
  $('#replaceImport').onclick = async () => {
    applyImportedTasks(result.tasks, result.listNames, true);
    await save();
    closeModal();
    render();
    toast(`已替换为 ${result.tasks.length} 条任务`);
  };
}

function ensureLists(listNames = []) {
  const colors = ['#5b7cfa', '#ef5350', '#26a69a', '#8e67d5', '#f5a623', '#607d8b'];
  listNames.forEach((name, index) => {
    if (!data.lists.some(list => list.name === name)) {
      data.lists.push({ id: uid(), name, color: colors[index % colors.length], icon: '📋', archived: false, notificationsEnabled: true });
    }
  });
}

function applyImportedTasks(tasks, listNames, replace) {
  ensureLists(listNames);
  const listMap = new Map(data.lists.map(list => [list.name, list.id]));
  const imported = tasks.map(task => ({ ...task, listId: listMap.get(task.listName) || 'inbox' }));
  imported.forEach(task => { delete task.listName; });
  if (replace) data.tasks = imported;
  else {
    const byId = new Map(data.tasks.map(task => [task.id, task]));
    for (const task of imported) {
      if (byId.has(task.id)) Object.assign(byId.get(task.id), task);
      else data.tasks.unshift(task);
    }
  }
}

function mergeBackupTasks(tasks, lists) {
  ensureLists((lists || []).map(list => list.name));
  const sourceListMap = new Map((lists || []).map(list => [list.id, list.name]));
  const targetListMap = new Map(data.lists.map(list => [list.name, list.id]));
  const existingById = new Map(data.tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    const copy = structuredClone(task);
    const listName = sourceListMap.get(copy.listId) || '收集箱';
    copy.listId = targetListMap.get(listName) || 'inbox';
    if (existingById.has(copy.id)) Object.assign(existingById.get(copy.id), copy);
    else data.tasks.unshift(copy);
  }
}

async function exportTasks(format) {
  const result = await desktop.exportTasks(format, data);
  if (result?.ok) toast(`已导出：${result.filePath}`);
  else if (!result?.canceled) toast(result?.error || '导出失败');
}

async function exportTemplate() {
  const result = await desktop.exportTemplate();
  if (result?.ok) toast(`模板已保存：${result.filePath}`);
  else if (!result?.canceled) toast(result?.error || '模板保存失败');
}

function openTools() {
  modal(`<h2>工具箱</h2><div class="modal-actions action-grid">
    <button id="toolImport">📥 导入待办</button>
    <button id="toolExport">📤 导出 XLSX</button>
    <button id="toolTemplate">📄 下载导入模板</button>
    <button id="toolCal">▦ 打开日历</button>
    <button id="toolStats">📊 查看统计</button>
    <button id="toolClear">清空搜索筛选</button>
  </div>`);
  $('#toolImport').onclick = () => { closeModal(); importTasks(); };
  $('#toolExport').onclick = () => { closeModal(); exportTasks('xlsx'); };
  $('#toolTemplate').onclick = () => { closeModal(); exportTemplate(); };
  $('#toolCal').onclick = () => { closeModal(); state.view = 'calendar'; render(); };
  $('#toolStats').onclick = () => { closeModal(); state.view = 'stats'; render(); };
  $('#toolClear').onclick = () => {
    state.search = '';
    state.filters = { listId: '', priority: '', time: '' };
    closeModal();
    render();
  };
}

function openPomodoro(task) {
  let seconds = 25 * 60;
  let running = false;
  let timer;
  modal(`<h2>🍅 专注：${esc(task.title)}</h2><div id="timer" class="pomodoro-time">25:00</div><div class="modal-actions center"><button id="timerReset">重置</button><button class="save" id="timerStart">开始</button></div>`);
  const draw = () => { $('#timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
  $('#timerStart').onclick = () => {
    running = !running;
    $('#timerStart').textContent = running ? '暂停' : '继续';
    clearInterval(timer);
    if (running) {
      timer = setInterval(() => {
        seconds -= 1;
        draw();
        if (seconds <= 0) {
          clearInterval(timer);
          chrome.runtime.sendMessage({ type: 'NOTIFY', title: '专注完成', message: task.title, taskId: task.id });
          toast('本次专注完成');
        }
      }, 1000);
    }
  };
  $('#timerReset').onclick = () => {
    clearInterval(timer);
    running = false;
    seconds = 25 * 60;
    draw();
  };
}

function checkIncoming() {
  const params = new URLSearchParams(location.search);
  if (params.get('new') === '1') setTimeout(() => $('#quickInput').focus(), 100);
}

load().catch(error => {
  console.error('FocusTodo failed to start:', error);
  document.body.innerHTML = `<div style="padding:30px;font-family:system-ui"><h2>FocusTodo 启动失败</h2><pre>${esc(error.stack || error.message || String(error))}</pre></div>`;
});
