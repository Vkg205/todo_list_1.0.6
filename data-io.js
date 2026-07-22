const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const Schedule = require('./src/schedule-core');

const EXPORT_HEADERS = [
  '任务ID', '标题*', '备注', '清单', '优先级', '任务颜色',
  '计划完成日期', '计划完成时间', '前置任务ID', '末尾任务', 'DDL日期', 'DDL时间',
  '状态', '标签', '重复规则', '提前提醒分钟', '子任务', '附件链接', '创建时间'
];

const HEADER_ALIASES = {
  id: ['任务id', 'id', 'taskid', 'task id'],
  title: ['标题', '任务标题', '待办标题', 'title', 'task'],
  notes: ['备注', '详情', '说明', 'notes', 'description'],
  list: ['清单', '分类', '分组', 'list', 'category'],
  priority: ['优先级', 'priority'],
  color: ['任务颜色', '颜色', 'color'],
  dueDate: ['计划完成日期', '完成日期', '截止日期', '到期日期', '日期', 'due date', 'duedate'],
  dueTime: ['计划完成时间', '完成时间', '截止时间', '到期时间', '时间', 'due time', 'duetime'],
  dependencies: ['前置任务id', '前置任务', '依赖任务id', '依赖任务', 'dependencies', 'dependency ids'],
  terminal: ['末尾任务', '最终任务', '最终交付', 'terminal', 'is terminal'],
  ddlDate: ['ddl日期', '硬截止日期', '最终截止日期', 'deadline date'],
  ddlTime: ['ddl时间', '硬截止时间', '最终截止时间', 'deadline time'],
  status: ['状态', '完成状态', 'status'],
  tags: ['标签', 'tags', 'tag'],
  repeat: ['重复规则', '重复', 'repeat', 'recurrence'],
  reminders: ['提前提醒分钟', '提醒分钟', '提醒', 'reminders', 'reminder'],
  subtasks: ['子任务', '子待办', 'subtasks', 'subtask'],
  attachments: ['附件链接', '附件', '链接', 'attachments', 'attachment'],
  createdAt: ['创建时间', 'created at', 'createdat']
};

function normalizeHeader(value) {
  return String(value ?? '').trim().replace(/[＊*]/g, '').replace(/\s+/g, ' ').toLowerCase();
}

function findValue(row, key) {
  const normalized = new Map(Object.entries(row).map(([header, value]) => [normalizeHeader(header), value]));
  for (const alias of HEADER_ALIASES[key] || []) {
    const found = normalized.get(normalizeHeader(alias));
    if (found !== undefined) return found;
  }
  return '';
}

function splitValues(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value ?? '').split(/[|｜;；\n]+/).map(v => v.trim()).filter(Boolean);
}

function normalizePriority(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['高', 'high', 'h', '1'].includes(text)) return 'high';
  if (['低', 'low', 'l', '3'].includes(text)) return 'low';
  return 'medium';
}

function normalizeRepeat(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const map = new Map([
    ['每日', '每日'], ['每天', '每日'], ['daily', '每日'],
    ['工作日', '工作日'], ['weekday', '工作日'], ['weekdays', '工作日'],
    ['每周', '每周'], ['weekly', '每周'], ['每月', '每月'], ['monthly', '每月'],
    ['每年', '每年'], ['yearly', '每年'], ['annually', '每年']
  ]);
  return map.get(text) || null;
}

function normalizeBoolean(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return ['已完成', '完成', 'done', 'completed', 'true', 'yes', '是', '1', 'x', '√', '✓'].includes(text);
}

function localDateToIso(dateValue, timeValue, fallbackHour = 18) {
  if ((dateValue === '' || dateValue == null) && (timeValue === '' || timeValue == null)) return null;
  let year; let month; let day; let hour = fallbackHour; let minute = 0;
  if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
    year = dateValue.getFullYear(); month = dateValue.getMonth() + 1; day = dateValue.getDate();
    if (!timeValue) { hour = dateValue.getHours() || fallbackHour; minute = dateValue.getMinutes(); }
  } else if (typeof dateValue === 'number' && Number.isFinite(dateValue)) {
    const parsed = XLSX.SSF.parse_date_code(dateValue);
    if (parsed) { year = parsed.y; month = parsed.m; day = parsed.d; hour = parsed.H || fallbackHour; minute = parsed.M || 0; }
  } else {
    const text = String(dateValue ?? '').trim();
    const match = text.match(/(\d{4})[\-/年.](\d{1,2})[\-/月.](\d{1,2})/);
    if (match) {
      year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
      const inDateTime = text.match(/(?:\s|日)(\d{1,2}):(\d{1,2})/);
      if (inDateTime) { hour = Number(inDateTime[1]); minute = Number(inDateTime[2]); }
    } else {
      const parsed = new Date(text);
      if (!Number.isNaN(parsed.getTime())) {
        year = parsed.getFullYear(); month = parsed.getMonth() + 1; day = parsed.getDate();
        hour = parsed.getHours() || fallbackHour; minute = parsed.getMinutes();
      }
    }
  }
  const timeText = String(timeValue ?? '').trim();
  const timeMatch = timeText.match(/(\d{1,2})[:：](\d{1,2})/);
  if (timeMatch) { hour = Number(timeMatch[1]); minute = Number(timeMatch[2]); }
  else if (/^\d{1,2}$/.test(timeText)) { hour = Number(timeText); minute = 0; }
  if (!year || !month || !day) return null;
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  return Number.isNaN(local.getTime()) ? null : local.toISOString();
}

function parseCreatedAt(value) {
  const iso = localDateToIso(value, '', 0);
  return iso ? new Date(iso).getTime() : Date.now();
}

function parseSubtasks(value) {
  return splitValues(value).map(item => {
    const completed = /^\s*\[(?:x|√|✓)\]\s*/i.test(item);
    let title = item.replace(/^\s*\[(?:x|√|✓| )\]\s*/i, '').trim();
    const levelMatch = title.match(/^(>{1,2})\s*/);
    const level = levelMatch ? levelMatch[1].length : 0;
    if (levelMatch) title = title.slice(levelMatch[0].length).trim();
    return title ? { id: crypto.randomUUID(), title, completed, level } : null;
  }).filter(Boolean);
}

function parseAttachments(value) {
  return splitValues(value).map(item => /^https?:\/\//i.test(item)
    ? { type: 'link', url: item, name: item }
    : { type: 'file', path: item, name: path.basename(item) || item });
}

function parseRows(rows) {
  const tasks = [];
  const listNames = new Set();
  const warnings = [];
  const now = Date.now();

  rows.forEach((row, index) => {
    const title = String(findValue(row, 'title') ?? '').trim();
    if (!title) {
      if (Object.values(row).some(v => String(v ?? '').trim())) warnings.push(`第 ${index + 2} 行缺少标题，已跳过`);
      return;
    }
    const listName = String(findValue(row, 'list') ?? '').trim() || '收集箱';
    listNames.add(listName);
    const completed = normalizeBoolean(findValue(row, 'status'));
    const dueAt = localDateToIso(findValue(row, 'dueDate'), findValue(row, 'dueTime'));
    const ddlAt = localDateToIso(findValue(row, 'ddlDate'), findValue(row, 'ddlTime'), 18);
    const isTerminal = normalizeBoolean(findValue(row, 'terminal')) || Boolean(ddlAt);
    const createdAt = parseCreatedAt(findValue(row, 'createdAt'));
    const taskId = String(findValue(row, 'id') ?? '').trim() || crypto.randomUUID();
    tasks.push({
      id: taskId, title, notes: String(findValue(row, 'notes') ?? ''), listName,
      priority: normalizePriority(findValue(row, 'priority')),
      color: String(findValue(row, 'color') || '').trim() || null,
      dueAt, ddlAt, isTerminal,
      dependencyRefs: splitValues(findValue(row, 'dependencies')),
      dependencyIds: [], needsReschedule: false, scheduleShift: null,
      completed, completedAt: completed ? now : null, archived: false,
      tags: splitValues(findValue(row, 'tags')),
      repeat: normalizeRepeat(findValue(row, 'repeat')),
      reminders: splitValues(findValue(row, 'reminders')).map(Number).filter(v => Number.isFinite(v) && v >= 0),
      subtasks: parseSubtasks(findValue(row, 'subtasks')),
      attachments: parseAttachments(findValue(row, 'attachments')),
      createdAt, updatedAt: now, order: createdAt, snoozeAt: null,
      importRow: index + 2
    });
  });

  const byId = new Map(tasks.map(task => [task.id, task]));
  const byTitle = new Map();
  for (const task of tasks) {
    if (!byTitle.has(task.title)) byTitle.set(task.title, []);
    byTitle.get(task.title).push(task);
  }
  for (const task of tasks) {
    const resolved = [];
    for (const reference of task.dependencyRefs) {
      let dependency = byId.get(reference);
      if (!dependency) {
        const matches = byTitle.get(reference) || [];
        if (matches.length === 1) dependency = matches[0];
        else if (matches.length > 1) warnings.push(`第 ${task.importRow} 行前置任务“${reference}”标题重复，请改用任务ID`);
      }
      if (!dependency) warnings.push(`第 ${task.importRow} 行未找到前置任务“${reference}”`);
      else if (dependency.id === task.id) warnings.push(`第 ${task.importRow} 行不能依赖自身，已忽略`);
      else resolved.push(dependency.id);
    }
    task.dependencyIds = [...new Set(resolved)];
    delete task.dependencyRefs;
    delete task.importRow;
  }
  for (const task of tasks) {
    if (Schedule.wouldCreateCycle(tasks, task.id, task.dependencyIds)) {
      warnings.push(`任务“${task.title}”的依赖关系形成循环，已清空该任务的前置任务`);
      task.dependencyIds = [];
    }
    if (task.isTerminal && !task.dueAt) warnings.push(`末尾任务“${task.title}”未填写计划完成时间`);
    if (task.isTerminal && !task.ddlAt) warnings.push(`末尾任务“${task.title}”未填写 DDL`);
  }
  Schedule.refreshConflicts(tasks);
  return { tasks, listNames: [...listNames], warnings };
}

function readRowsFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) return { rows: parsed, backup: null };
    if (Array.isArray(parsed.tasks)) return { rows: null, backup: parsed };
    throw new Error('JSON 文件中没有 tasks 数组');
  }
  const workbook = XLSX.readFile(filePath, { cellDates: true, raw: true, codepage: 65001 });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('工作簿中没有可读取的工作表');
  return { rows: XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true }), backup: null };
}

function importTasksFile(filePath) {
  const { rows, backup } = readRowsFromFile(filePath);
  if (backup) return { type: 'backup', data: backup, warnings: [] };
  return { type: 'tasks', ...parseRows(rows) };
}

function formatDateParts(value) {
  if (!value) return { date: '', time: '' };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  return {
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  };
}

function humanPriority(value) { return value === 'high' ? '高' : value === 'low' ? '低' : '中'; }

function taskToRow(task, listName) {
  const due = formatDateParts(task.dueAt);
  const ddl = formatDateParts(task.ddlAt);
  const created = task.createdAt ? new Date(task.createdAt) : null;
  const createdText = created && !Number.isNaN(created.getTime())
    ? `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')} ${String(created.getHours()).padStart(2, '0')}:${String(created.getMinutes()).padStart(2, '0')}` : '';
  return {
    '任务ID': task.id || '', '标题*': task.title || '', '备注': task.notes || '', '清单': listName || '收集箱',
    '优先级': humanPriority(task.priority), '任务颜色': task.color || '',
    '计划完成日期': due.date, '计划完成时间': due.time,
    '前置任务ID': Schedule.normalizeDependencyIds(task).join('|'),
    '末尾任务': task.isTerminal ? '是' : '否', 'DDL日期': ddl.date, 'DDL时间': ddl.time,
    '状态': task.completed ? '已完成' : '未完成', '标签': (task.tags || []).join('|'),
    '重复规则': task.repeat || '不重复', '提前提醒分钟': (task.reminders || []).join('|'),
    '子任务': (task.subtasks || []).map(s => `${s.completed ? '[x]' : ''}${'>'.repeat(Math.max(0, Math.min(2, Number(s.level) || 0)))}${s.title}`).join('|'),
    '附件链接': (task.attachments || []).map(a => a.url || a.path || a.name || '').filter(Boolean).join('|'),
    '创建时间': createdText
  };
}

function exportTasksFile(filePath, todoData) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') { fs.writeFileSync(filePath, JSON.stringify(todoData, null, 2), 'utf8'); return; }
  const listMap = new Map((todoData.lists || []).map(list => [list.id, list.name]));
  const rows = (todoData.tasks || []).map(task => taskToRow(task, listMap.get(task.listId)));
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: EXPORT_HEADERS });
  worksheet['!cols'] = [
    { wch: 20 }, { wch: 28 }, { wch: 34 }, { wch: 14 }, { wch: 10 }, { wch: 13 },
    { wch: 14 }, { wch: 12 }, { wch: 30 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
    { wch: 12 }, { wch: 22 }, { wch: 13 }, { wch: 18 }, { wch: 36 }, { wch: 42 }, { wch: 20 }
  ];
  if (ext === '.csv') {
    fs.writeFileSync(filePath, `\uFEFF${XLSX.utils.sheet_to_csv(worksheet, { FS: ',', RS: '\r\n' })}`, 'utf8');
    return;
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '待办列表');
  XLSX.writeFile(workbook, filePath, { bookType: 'xlsx' });
}

module.exports = { EXPORT_HEADERS, importTasksFile, exportTasksFile, parseRows, localDateToIso };
