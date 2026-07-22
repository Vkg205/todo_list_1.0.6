const { contextBridge, ipcRenderer } = require('electron');

const storageListeners = new Set();
const runtimeListeners = new Set();

ipcRenderer.on('storage-changed', (_event, todoData) => {
  const change = { todoData: { newValue: todoData } };
  for (const listener of storageListeners) {
    try { listener(change, 'local'); } catch (error) { console.error(error); }
  }
});

ipcRenderer.on('focus-quick-add', () => {
  for (const listener of runtimeListeners) {
    try { listener({ type: 'FOCUS_QUICK_ADD' }, {}, () => {}); } catch (error) { console.error(error); }
  }
});

const focusTodoApi = {
  storage: {
    local: {
      get: async () => ipcRenderer.invoke('storage-get'),
      set: async payload => ipcRenderer.invoke('storage-set', payload)
    },
    onChanged: {
      addListener: listener => {
        storageListeners.add(listener);
        return undefined;
      },
      removeListener: listener => {
        storageListeners.delete(listener);
        return undefined;
      }
    }
  },
  runtime: {
    sendMessage: async message => {
      if (message?.type === 'REBUILD_ALARMS') return ipcRenderer.invoke('rebuild-reminders');
      if (message?.type === 'NOTIFY') return ipcRenderer.invoke('notify', message);
      return { ok: true };
    },
    onMessage: {
      addListener: listener => {
        runtimeListeners.add(listener);
        return undefined;
      },
      removeListener: listener => {
        runtimeListeners.delete(listener);
        return undefined;
      }
    }
  },
  tabs: {
    query: async () => [await ipcRenderer.invoke('get-active-page')]
  },
  sidePanel: {
    open: async () => ({ ok: true })
  },
  desktop: {
    importTasks: () => ipcRenderer.invoke('tasks-import-dialog'),
    exportTasks: (format, todoData) => ipcRenderer.invoke('tasks-export-dialog', { format, todoData }),
    exportTemplate: () => ipcRenderer.invoke('template-export-dialog'),
    selectAttachments: () => ipcRenderer.invoke('attachments-select'),
    openPath: target => ipcRenderer.invoke('open-path', target),
    openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
    getDataPath: () => ipcRenderer.invoke('get-data-path')
  }
};

contextBridge.exposeInMainWorld('focusTodoApi', focusTodoApi);
