const assert = require('assert');
const Module = require('module');

let exposedApi = null;
const ipcListeners = new Map();
const mockElectron = {
  contextBridge: {
    exposeInMainWorld(name, value) {
      assert.strictEqual(name, 'focusTodoApi');
      exposedApi = value;
    }
  },
  ipcRenderer: {
    on(channel, listener) {
      ipcListeners.set(channel, listener);
    },
    invoke: async () => ({ ok: true })
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return mockElectron;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require('../preload.js');
} finally {
  Module._load = originalLoad;
}

assert.ok(exposedApi, 'focusTodoApi should be exposed');
const runtimeListener = () => {};
const storageListener = () => {};
assert.strictEqual(exposedApi.runtime.onMessage.addListener(runtimeListener), undefined);
assert.strictEqual(exposedApi.runtime.onMessage.removeListener(runtimeListener), undefined);
assert.strictEqual(exposedApi.storage.onChanged.addListener(storageListener), undefined);
assert.strictEqual(exposedApi.storage.onChanged.removeListener(storageListener), undefined);
assert.ok(ipcListeners.has('storage-changed'));
assert.ok(ipcListeners.has('focus-quick-add'));
console.log('preload bridge tests passed');
