const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { importTasksFile, exportTasksFile } = require('./data-io');
const Schedule = require('./src/schedule-core');

let mainWindow = null;
let quickWindow = null;
let tray = null;
let quitting = false;
let reminderTimers = new Map();

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

function dataPath() {
  return path.join(app.getPath('userData'), 'todo-data.json');
}

function backupPath() {
  return path.join(app.getPath('userData'), 'todo-data.backup.json');
}

function normalizeTask(task = {}) {
  const now = Date.now();
  return {
    id: task.id || cryptoRandomId(),
    title: String(task.title || '').trim(),
    notes: String(task.notes || ''),
    listId: task.listId || 'inbox',
    tags: Array.isArray(task.tags) ? task.tags : [],
    priority: ['high', 'medium', 'low'].includes(task.priority) ? task.priority : 'medium',
    color: task.color || null,
    completed: Boolean(task.completed),
    archived: Boolean(task.archived),
    createdAt: Number(task.createdAt) || now,
    updatedAt: Number(task.updatedAt) || now,
    dueAt: task.dueAt || null,
    ddlAt: task.ddlAt || null,
    dependencyIds: Schedule.normalizeDependencyIds(task),
    isTerminal: Boolean(task.isTerminal),
    needsReschedule: Boolean(task.needsReschedule),
    scheduleShift: task.scheduleShift || null,
    completedAt: task.completedAt || null,
    reminders: Array.isArray(task.reminders) ? task.reminders : [],
    repeat: task.repeat || null,
    subtasks: Array.isArray(task.subtasks) ? task.subtasks : [],
    attachments: Array.isArray(task.attachments) ? task.attachments : [],
    order: Number(task.order) || Number(task.createdAt) || now,
    snoozeAt: task.snoozeAt || null
  };
}

function cryptoRandomId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeData(parsed = {}) {
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeTask).filter(task => task.title) : [];
  Schedule.refreshConflicts(tasks);
  return {
    ...structuredClone(DEFAULT_DATA),
    ...parsed,
    tasks,
    lists: Array.isArray(parsed.lists) && parsed.lists.length ? parsed.lists.map(list => ({ ...list, notificationsEnabled: list.notificationsEnabled !== false })) : structuredClone(DEFAULT_DATA.lists),
    trash: Array.isArray(parsed.trash) ? parsed.trash : [],
    habits: Array.isArray(parsed.habits) ? parsed.habits : [],
    settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
    version: 3
  };
}

function loadData() {
  for (const candidate of [dataPath(), backupPath()]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      return normalizeData(JSON.parse(fs.readFileSync(candidate, 'utf8')));
    } catch (error) {
      console.error(`Failed to load data from ${candidate}:`, error);
    }
  }
  return structuredClone(DEFAULT_DATA);
}

function saveData(todoData) {
  const normalized = normalizeData(todoData);
  const destination = dataPath();
  const backup = backupPath();
  const temp = `${destination}.tmp`;

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    try { fs.copyFileSync(destination, backup); } catch (error) { console.warn('Backup copy failed:', error); }
  }

  fs.writeFileSync(temp, JSON.stringify(normalized, null, 2), 'utf8');
  try {
    fs.renameSync(temp, destination);
  } catch (error) {
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    fs.renameSync(temp, destination);
  }

  if (!fs.existsSync(backup)) {
    try { fs.copyFileSync(destination, backup); } catch (error) { console.warn('Initial backup failed:', error); }
  }

  rebuildReminders(normalized);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('storage-changed', normalized);
  return normalized;
}

function isQuiet(settings = {}) {
  if (!settings.quietStart || !settings.quietEnd) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const [startHour, startMinute] = settings.quietStart.split(':').map(Number);
  const [endHour, endMinute] = settings.quietEnd.split(':').map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function showNotification(title, body) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: title || 'FocusTodo Pro',
    body: body || '你有一项待办需要处理',
    icon: path.join(__dirname, 'src', 'icons', 'icon128.png'),
    silent: false
  });
  notification.on('click', () => showMainWindow());
  notification.show();
}

function clearReminderTimers() {
  for (const timer of reminderTimers.values()) clearTimeout(timer);
  reminderTimers.clear();
}

function addReminderTimer(key, fireAt, callback) {
  const delay = fireAt - Date.now();
  if (delay <= 0 || delay > 2_147_483_647) return;
  const timer = setTimeout(() => {
    reminderTimers.delete(key);
    callback();
  }, delay);
  reminderTimers.set(key, timer);
}

function rebuildReminders(todoData = loadData()) {
  clearReminderTimers();
  for (const task of todoData.tasks || []) {
    if (task.completed || task.archived) continue;
    const taskList = (todoData.lists || []).find(list => list.id === task.listId);
    if (taskList?.notificationsEnabled === false) continue;

    if (task.snoozeAt) {
      addReminderTimer(`${task.id}:snooze`, new Date(task.snoozeAt).getTime(), () => {
        const latest = loadData();
        const current = latest.tasks.find(item => item.id === task.id);
        if (!current || current.completed || current.archived || latest.settings.notifications === false || isQuiet(latest.settings)) return;
        showNotification(current.title, current.notes || '稍后提醒时间到了');
      });
    }

    if (!task.dueAt) continue;
    const offsets = task.reminders?.length ? task.reminders : [0];
    for (const offset of offsets) {
      const fireAt = new Date(task.dueAt).getTime() - Number(offset) * 60_000;
      addReminderTimer(`${task.id}:${offset}`, fireAt, () => {
        const latest = loadData();
        const current = latest.tasks.find(item => item.id === task.id);
        if (!current || current.completed || current.archived || latest.settings.notifications === false || isQuiet(latest.settings)) return;
        showNotification(current.title, current.notes || '待办时间到了');
      });
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    show: false,
    icon: path.join(__dirname, 'src', 'icons', 'icon.ico'),
    title: 'FocusTodo Pro',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html')).catch(error => console.error('Failed to load UI:', error));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => console.error('Preload error:', preloadPath, error));
  mainWindow.webContents.on('render-process-gone', (_event, details) => console.error('Renderer process gone:', details));
  mainWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showMainWindow(focusQuickAdd = false) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
  if (focusQuickAdd) setTimeout(() => mainWindow?.webContents.send('focus-quick-add'), 250);
}


function showQuickWindow() {
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.show();
    quickWindow.focus();
    return;
  }
  quickWindow = new BrowserWindow({
    width: 460,
    height: 230,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    show: false,
    icon: path.join(__dirname, 'src', 'icons', 'icon.ico'),
    title: '快速新建待办',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  quickWindow.loadFile(path.join(__dirname, 'src', 'quick.html'));
  quickWindow.once('ready-to-show', () => {
    quickWindow.show();
    quickWindow.focus();
  });
  quickWindow.on('closed', () => { quickWindow = null; });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'src', 'icons', 'icon128.png')).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip('FocusTodo Pro');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 FocusTodo', click: () => showMainWindow() },
    { label: '快速新建待办', click: () => showQuickWindow() },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true })
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => showMainWindow());
}

ipcMain.handle('storage-get', () => ({ todoData: loadData() }));
ipcMain.handle('storage-set', (_event, payload) => {
  if (!payload || typeof payload.todoData !== 'object') throw new Error('Invalid todo data');
  saveData(payload.todoData);
  return { ok: true };
});
ipcMain.handle('notify', (_event, payload) => {
  showNotification(payload?.title, payload?.message);
  return { ok: true };
});
ipcMain.handle('rebuild-reminders', () => {
  rebuildReminders();
  return { ok: true };
});
ipcMain.handle('get-active-page', () => ({ title: '', url: '' }));
ipcMain.handle('get-data-path', () => dataPath());
ipcMain.handle('open-data-folder', () => {
  fs.mkdirSync(path.dirname(dataPath()), { recursive: true });
  shell.showItemInFolder(dataPath());
  return { ok: true };
});

ipcMain.handle('tasks-import-dialog', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 FocusTodo 待办',
      properties: ['openFile'],
      filters: [
        { name: '支持的待办文件', extensions: ['xlsx', 'xls', 'csv', 'json'] },
        { name: 'Excel 工作簿', extensions: ['xlsx', 'xls'] },
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: 'JSON 备份', extensions: ['json'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, filePath: result.filePaths[0], result: importTasksFile(result.filePaths[0]) };
  } catch (error) {
    console.error('Import failed:', error);
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('tasks-export-dialog', async (_event, payload) => {
  try {
    const format = ['xlsx', 'csv', 'json'].includes(payload?.format) ? payload.format : 'xlsx';
    const filterName = format === 'xlsx' ? 'Excel 工作簿' : format === 'csv' ? 'CSV 文件' : 'JSON 备份';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出 FocusTodo 待办',
      defaultPath: path.join(app.getPath('documents'), `FocusTodo_待办备份_${new Date().toISOString().slice(0, 10)}.${format}`),
      filters: [{ name: filterName, extensions: [format] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    exportTasksFile(result.filePath, normalizeData(payload.todoData || loadData()));
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    console.error('Export failed:', error);
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('template-export-dialog', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存 FocusTodo 导入模板',
      defaultPath: path.join(app.getPath('documents'), 'FocusTodo_Import_Template.xlsx'),
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const source = path.join(__dirname, 'templates', 'FocusTodo_Import_Template.xlsx');
    fs.copyFileSync(source, result.filePath);
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    console.error('Template export failed:', error);
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('attachments-select', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择任务附件',
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled) return [];
  return result.filePaths.map(filePath => ({ type: 'file', path: filePath, name: path.basename(filePath) }));
});

ipcMain.handle('open-path', async (_event, target) => {
  if (!target) return { ok: false };
  if (/^https?:\/\//i.test(target)) {
    await shell.openExternal(target);
    return { ok: true };
  }
  const error = await shell.openPath(target);
  return error ? { ok: false, error } : { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  rebuildReminders();
  app.on('activate', () => showMainWindow());
});

app.on('before-quit', () => {
  quitting = true;
  clearReminderTimers();
});

app.on('window-all-closed', () => {
  // Keep the background process alive for tray reminders on Windows.
});
