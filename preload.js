// Narrow, explicit bridge between the UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('sl', {
  // AI
  process: (opts) => ipcRenderer.invoke('ai:process', opts),
  align: (opts) => ipcRenderer.invoke('ai:align', opts),
  transcribe: (opts) => ipcRenderer.invoke('ai:transcribe', opts),
  syncVocals: (opts) => ipcRenderer.invoke('ai:sync-vocals', opts),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  aiInfo: () => ipcRenderer.invoke('ai:info'),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  onProgress: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('job:progress', h);
    return () => ipcRenderer.removeListener('job:progress', h);
  },
  // media
  exportVideo: (opts) => ipcRenderer.invoke('export:video', opts),
  peaks: (file) => ipcRenderer.invoke('audio:peaks', file),
  probe: (file) => ipcRenderer.invoke('media:probe', file),
  importMedia: (opts) => ipcRenderer.invoke('media:import', opts),
  onImportProgress: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('import:progress', h);
    return () => ipcRenderer.removeListener('import:progress', h);
  },
  fonts: () => ipcRenderer.invoke('fonts:list'),
  // projects
  newProjectDir: (title) => ipcRenderer.invoke('project:new-dir', title),
  saveProject: (dir, project) => ipcRenderer.invoke('project:save', { dir, project }),
  loadProject: (file) => ipcRenderer.invoke('project:load', file),
  recentProjects: () => ipcRenderer.invoke('project:recent'),
  pendingOpen: () => ipcRenderer.invoke('project:pending-open'),
  onOpenFile: (fn) => ipcRenderer.on('project:open-file', (_e, p) => fn(p)),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  // dialogs / shell
  openDialog: (kind) => ipcRenderer.invoke('dialog:open', kind),
  saveVideoDialog: (name) => ipcRenderer.invoke('dialog:save-video', name),
  readText: (p) => ipcRenderer.invoke('file:read-text', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  appInfo: () => ipcRenderer.invoke('app:info'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return file && file.path; } },
  fileUrl: (p) => (p ? pathToFileURL(p).href : ''),
  basename: (p) => String(p || '').split(/[\\/]/).pop(),
});
