(() => {
  'use strict';

  const api = window.notchAPI;
  const hooks = window.NotchPersistenceHooks;
  const ORIGIN_KEY = 'notch-workspace-origin-v1';
  const status = document.getElementById('workspace-save-status');
  const message = document.getElementById('workspace-save-message');
  const retryButton = document.getElementById('workspace-save-retry');
  const panels = document.getElementById('panels');
  let suspended = true;
  let blocked = false;
  let saveTimer = null;
  let savePromise = null;
  let retryPromise = null;
  let transition = 0;
  const previousInert = new Map();

  const fullSnapshot = () => Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index);
    return [key, localStorage.getItem(key)];
  }).filter(([key]) => key !== null));

  function setPanelsLocked(locked) {
    window.__notchWorkspaceInteractionLocked = locked;
    const controls = [panels, ...document.querySelectorAll('#tabs, [data-quick-capture]')].filter(Boolean);
    for (const control of controls) {
      if (locked && !previousInert.has(control)) previousInert.set(control, control.inert);
      control.inert = locked ? true : previousInert.has(control) ? previousInert.get(control) : control.inert;
      if (!locked) previousInert.delete(control);
    }
  }

  function showError(text, recovery = false) {
    if (status) status.hidden = false;
    if (message) message.textContent = text;
    if (retryButton) retryButton.textContent = recovery ? '重试恢复' : '重试保存';
  }

  function clearError() {
    if (status) status.hidden = true;
    if (message) message.textContent = '';
  }

  function pause() {
    suspended = true;
    if (saveTimer) clearInterval(saveTimer);
    saveTimer = null;
  }

  function resume() {
    blocked = false;
    suspended = false;
    window.__notchWorkspaceHydrating = false;
    setPanelsLocked(false);
    if (!saveTimer) saveTimer = setInterval(() => { void save(); }, 2000);
  }

  async function save() {
    if (suspended || blocked || window.__notchWorkspaceHydrating) return false;
    if (savePromise) return savePromise;
    savePromise = (async () => {
      try {
        const snapshot = hooks.snapshot();
        delete snapshot[ORIGIN_KEY];
        const saved = await api.saveWorkspaceData(snapshot);
        if (saved !== true) throw new Error('save_failed');
        if (!suspended) clearError();
        return true;
      } catch (error) {
        if (!suspended) showError('数据文件夹暂时无法保存。当前内容仍保留在本机，请检查文件夹权限或剩余空间后重试。');
        return false;
      }
    })().finally(() => { savePromise = null; });
    return savePromise;
  }

  function replaceStorage(snapshot) {
    localStorage.clear();
    for (const [key, value] of Object.entries(snapshot)) localStorage.setItem(key, value);
  }

  async function hydrate(state) {
    pause();
    blocked = true;
    window.__notchWorkspaceHydrating = true;
    setPanelsLocked(true);
    const rollback = fullSnapshot();
    let replaced = false;
    try {
      if (!state.path || !state.localStorage || typeof state.localStorage !== 'object'
        || Array.isArray(state.localStorage) || !Object.values(state.localStorage).every((value) => typeof value === 'string')) {
        throw new Error('invalid_snapshot');
      }
      const snapshot = { ...state.localStorage, [ORIGIN_KEY]: state.path };
      replaced = true;
      replaceStorage(snapshot);
      if (state.requiresHydration) {
        const acknowledged = await api.acknowledgeWorkspaceHydration(state.revision);
        if (acknowledged !== true) throw new Error('ack_failed');
      }
      clearError();
      // Keep the guard and timers frozen through beforeunload. Old component
      // closures still contain source-workspace values until the document reloads.
      if (hooks.reload) hooks.reload();
      else location.reload();
      return { ok: true, reloading: true };
    } catch (error) {
      let restored = true;
      if (replaced) {
        try { replaceStorage(rollback); } catch (rollbackError) { restored = false; }
      }
      showError(restored
        ? '工作区未能恢复，已保留原本机内容并暂停保存。请释放本机空间后重试；目标文件夹的快照不会被覆盖。'
        : '本机存储无法写入，已暂停保存。请释放空间后重试恢复；目标文件夹的快照仍保留。', true);
      return { ok: false, error: error.message };
    }
  }

  async function initialize() {
    const attempt = ++transition;
    pause();
    blocked = true;
    window.__notchWorkspaceHydrating = true;
    setPanelsLocked(true);
    try {
      const state = await api.loadWorkspaceState();
      if (attempt !== transition) return { ok: false, superseded: true };
      if (!state || state.error || !state.path) throw new Error(state?.error || 'load_failed');
      const origin = localStorage.getItem(ORIGIN_KEY);
      const hadLocalData = Object.keys(hooks.initialSnapshot || hooks.snapshot()).some((key) => key !== ORIGIN_KEY);
      if (state.requiresHydration || (origin && origin !== state.path) || (!hadLocalData && state.exists)) {
        return await hydrate(state);
      }
      // Existing LocalStorage may be newer than the periodic disk snapshot.
      // Upgrade it in place once, then use the origin marker to detect switches.
      localStorage.setItem(ORIGIN_KEY, state.path);
      clearError();
      resume();
      return { ok: true, reloading: false };
    } catch (error) {
      showError('无法读取当前工作区，已暂停保存以保护原文件。请检查或恢复工作区快照后重试。', true);
      return { ok: false, error: error.message };
    }
  }

  async function retry() {
    if (retryPromise) return retryPromise;
    if (retryButton) retryButton.disabled = true;
    retryPromise = (blocked ? initialize() : save()).finally(() => {
      retryPromise = null;
      if (retryButton) retryButton.disabled = false;
    });
    return retryPromise;
  }

  if (!api?.loadWorkspaceState || !hooks) {
    window.NotchPersistence = Object.freeze({ ready: Promise.resolve({ ok: true, supported: false }) });
    return;
  }

  const ready = initialize();
  window.NotchPersistence = Object.freeze({ ready, save, retry });
  retryButton?.addEventListener('click', () => { void retry(); });

  api.onPrepareWorkspaceSwitch?.(async ({ requestId }) => {
    await ready;
    if (blocked || window.__notchWorkspaceHydrating) {
      api.finishWorkspaceSwitchPreparation({ requestId, ok: false, error: '请先完成工作区恢复。' });
      return;
    }
    const attempt = ++transition;
    pause();
    setPanelsLocked(true);
    try {
      const snapshot = await hooks.flush();
      if (attempt !== transition) return;
      delete snapshot[ORIGIN_KEY];
      api.finishWorkspaceSwitchPreparation({ requestId, ok: true, storage: snapshot });
    } catch (error) {
      if (attempt !== transition) return;
      api.finishWorkspaceSwitchPreparation({ requestId, ok: false, error: String(error?.message || '当前内容无法保存。') });
    }
  });

  api.onWorkspaceChanged?.((state) => {
    transition += 1;
    void hydrate({ ...state, requiresHydration: true });
  });

  api.onWorkspaceSwitchCancelled?.((payload) => {
    transition += 1;
    if (blocked || window.__notchWorkspaceHydrating) return;
    resume();
    if (payload?.error) showError(`工作区未切换，当前内容已保留。${payload.error}`);
  });
})();
