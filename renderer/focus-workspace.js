/* A task keeps its context by reference; existing todo, note and link records stay unchanged. */
(() => {
  'use strict';
  const strip = document.getElementById('home-focus-strip');
  const todos = window.NotchTodos;
  if (!strip || !todos) return;
  const CURRENT_KEY = 'notch-current-task-v1';
  const CONTEXT_KEY = 'notch-task-context-v1';
  const NOTES_KEY = 'notch-note-archive-v1';
  const LINKS_KEY = 'notch-link-groups';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
  const ids = (value) => [...new Set((Array.isArray(value) ? value : []).filter((id) => typeof id === 'string' && id))];
  const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const hydrating = () => window.__notchWorkspaceHydrating === true || window.__notchWorkspaceInteractionLocked === true;
  let currentId = read(CURRENT_KEY, '');
  if (typeof currentId !== 'string') currentId = '';
  const contexts = Object.create(null);
  const saved = read(CONTEXT_KEY, {});
  if (record(saved)) Object.entries(saved).forEach(([id, context]) => {
    if (record(context)) contexts[id] = { noteIds: ids(context.noteIds), linkIds: ids(context.linkIds) };
  });
  let opener = null;
  let resourceTaskId = '';
  let focusBusy = false;

  function taskRows() {
    const snapshot = todos.getSnapshot();
    return Object.entries(snapshot.data || {}).flatMap(([category, rows]) => (Array.isArray(rows) ? rows : [])
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({ ...item, category, categoryName: snapshot.names?.[category] || category })));
  }
  function currentTask() { return taskRows().find((task) => task.id === currentId && !task.done); }
  function notify(message) { todos.notify?.(message); }
  function persistCurrent() {
    if (hydrating()) return;
    try { if (currentId) localStorage.setItem(CURRENT_KEY, JSON.stringify(currentId)); else localStorage.removeItem(CURRENT_KEY); }
    catch { notify('当前任务仅在本次会话保留，未能保存到本机'); }
  }
  function deadlineLabel(task) {
    const deadline = Date.parse(task?.deadline || '');
    if (!Number.isFinite(deadline)) return '无截止时间';
    const text = new Date(deadline).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `${text} ${deadline <= Date.now() ? '已逾期' : '截止'}`;
  }
  function library() {
    const archive = read(NOTES_KEY, []);
    const groups = read(LINKS_KEY, []);
    const notes = (Array.isArray(archive) ? archive : []).filter((note) => record(note) && typeof note.id === 'string')
      .map((note) => ({ id: note.id, title: String(note.title || '').trim() || '未命名笔记' }));
    const links = (Array.isArray(groups) ? groups : []).flatMap((group) => Array.isArray(group?.links) ? group.links : [])
      .filter((link) => record(link) && typeof link.id === 'string' && typeof link.url === 'string')
      .map((link) => ({ id: link.id, title: String(link.title || '').trim() || link.url, url: link.url }));
    return { notes, links };
  }

  strip.classList.add('focus-strip');
  strip.setAttribute('aria-label', '当前任务工作区');
  strip.innerHTML = '<div class="focus-task-copy"><span class="focus-eyebrow">当前任务</span><strong id="focus-task-title"></strong><span id="focus-task-meta"></span></div><div class="focus-strip-actions"><button type="button" data-focus-action="choose">选择任务</button><button type="button" data-focus-action="todos">去待办</button><button type="button" data-focus-action="start" hidden>开始专注</button><button type="button" data-focus-action="resources" hidden>资料</button><button type="button" data-focus-action="complete" hidden>完成</button></div>';
  const picker = document.createElement('dialog');
  picker.id = 'focus-task-picker';
  picker.className = 'focus-dialog focus-picker';
  picker.setAttribute('aria-labelledby', 'focus-picker-title');
  picker.innerHTML = '<header class="focus-dialog-head"><h2 id="focus-picker-title">选择当前任务</h2><button type="button" data-focus-action="close" aria-label="关闭任务选择">×</button></header><p class="focus-dialog-caption">先选定要做的事，再按需要关联资料或开始专注。</p><input id="focus-task-query" class="focus-search" type="search" placeholder="搜索未完成任务" aria-label="搜索未完成任务"/><div id="focus-task-options" class="focus-options"></div><footer class="focus-dialog-footer"><button type="button" data-focus-action="clear">清空当前任务</button><button type="button" data-focus-action="todos">去待办添加</button></footer>';
  const resources = document.createElement('dialog');
  resources.id = 'focus-resource-dialog';
  resources.className = 'focus-dialog';
  resources.setAttribute('aria-labelledby', 'focus-resources-title');
  resources.innerHTML = '<header class="focus-dialog-head"><div><h2 id="focus-resources-title">任务资料</h2><p id="focus-resource-task"></p></div><button type="button" data-focus-action="close" aria-label="关闭任务资料">×</button></header><p class="focus-dialog-caption">勾选已有笔记和链接，保存后可随任务打开。</p><div class="focus-resource-columns"><section><h3>笔记</h3><div id="focus-note-options" class="focus-options"></div></section><section><h3>链接</h3><div id="focus-link-options" class="focus-options"></div></section></div><p id="focus-resource-status" role="status"></p><footer class="focus-dialog-footer"><span>取消或按 Esc 放弃未保存的修改</span><button type="button" data-focus-action="close">取消</button><button type="button" class="focus-primary" data-focus-action="save-resources">保存关联</button></footer>';
  (document.getElementById('panel') || document.body).append(picker, resources);

  function close() {
    const wasOpen = picker.open || resources.open;
    picker.close(); resources.close();
    resourceTaskId = '';
    if (wasOpen && !hydrating()) {
      const target = opener?.isConnected ? opener : strip.querySelector('[data-focus-action="choose"]');
      if (!target?.closest('[inert], [hidden]')) target?.focus({ preventScroll: true });
    }
    return wasOpen;
  }
  function showDialog(dialog) {
    opener = document.activeElement;
    dialog.showModal();
  }
  function renderPicker() {
    const query = picker.querySelector('#focus-task-query').value.trim().toLocaleLowerCase();
    const rows = taskRows().filter((task) => !task.done && `${task.text} ${task.categoryName}`.toLocaleLowerCase().includes(query));
    picker.querySelector('#focus-task-options').innerHTML = rows.map((task) => `<button class="focus-task-option" type="button" data-focus-task="${esc(task.id)}" aria-pressed="${task.id === currentId}"><strong>${esc(task.text)}</strong><span>${esc(task.categoryName)} · ${esc(deadlineLabel(task))}</span></button>`).join('')
      || `<p class="focus-empty">${query ? '没有匹配的任务，试试其他关键词。' : '还没有未完成任务，先去待办记下一件事。'}</p>`;
    picker.querySelector('[data-focus-action="clear"]').hidden = !currentId;
  }
  function openPicker() {
    if (hydrating()) return;
    picker.querySelector('#focus-task-query').value = '';
    renderPicker(); showDialog(picker);
    picker.querySelector('#focus-task-query').focus();
  }
  function resourceRow(item, kind, selected) {
    return `<div class="focus-resource-row"><label><input type="checkbox" data-focus-resource="${kind}" value="${esc(item.id)}"${selected.includes(item.id) ? ' checked' : ''}/><span title="${esc(item.title)}">${esc(item.title)}</span></label><button type="button" data-focus-open="${kind}" data-resource-id="${esc(item.id)}" aria-label="打开${kind === 'notes' ? '笔记' : '链接'}：${esc(item.title)}">打开</button></div>`;
  }
  function openResources() {
    if (hydrating()) return;
    const task = currentTask();
    if (!task) return;
    resourceTaskId = task.id;
    const stored = contexts[task.id] || { noteIds: [], linkIds: [] };
    const { notes, links } = library();
    resources.querySelector('#focus-resource-task').textContent = task.text;
    resources.querySelector('#focus-note-options').innerHTML = notes.map((note) => resourceRow(note, 'notes', stored.noteIds)).join('') || '<p class="focus-empty">还没有已保存笔记。可在首页「随笔记」保存后再关联。</p>';
    resources.querySelector('#focus-link-options').innerHTML = links.map((link) => resourceRow(link, 'links', stored.linkIds)).join('') || '<p class="focus-empty">还没有收藏链接。可在「链接」页保存后再关联。</p>';
    resources.querySelector('#focus-resource-status').textContent = '';
    showDialog(resources);
    resources.querySelector('[data-focus-action="close"]').focus();
  }
  function saveResources() {
    if (hydrating()) return;
    if (!taskRows().some((task) => task.id === resourceTaskId && !task.done)) { close(); notify('这个任务已完成或不存在'); return; }
    const { notes, links } = library();
    const checked = (kind, source) => [...resources.querySelectorAll(`[data-focus-resource="${kind}"]:checked`)].map((input) => input.value).filter((id) => source.some((item) => item.id === id));
    const next = { noteIds: ids(checked('notes', notes)), linkIds: ids(checked('links', links)) };
    try {
      localStorage.setItem(CONTEXT_KEY, JSON.stringify({ ...contexts, [resourceTaskId]: next }));
      contexts[resourceTaskId] = next;
      close(); render(); notify('已保存任务资料关联');
    } catch { resources.querySelector('#focus-resource-status').textContent = '未能保存到本机，关联尚未更新，请重试。'; }
  }
  async function openResource(kind, id) {
    if (hydrating()) return;
    const item = library()[kind]?.find((row) => row.id === id);
    if (!item) { resources.querySelector('#focus-resource-status').textContent = '这份资料已被删除，请重新选择并保存关联。'; return; }
    try {
      if (kind === 'notes') {
        if (!window.NotchNavigation?.openNote) throw new Error('笔记入口暂不可用');
        close();
        if (await window.NotchNavigation.openNote(id) === false) notify('无法打开这篇笔记');
      } else {
        const url = window.NotchDomain?.normalizeHttpUrl?.(item.url);
        if (!url || !window.notchAPI?.openExternal) throw new Error('无法打开这个链接');
        const result = await window.notchAPI.openExternal(url);
        if (result === false || result?.ok === false) throw new Error('无法打开这个链接');
      }
    } catch (error) { if (resources.open) resources.querySelector('#focus-resource-status').textContent = error.message || '资料打开失败'; else notify('资料打开失败'); }
  }
  function selectTask(id) {
    if (hydrating()) return false;
    const task = taskRows().find((row) => row.id === id && !row.done);
    if (!task) { notify('请选择一个未完成任务'); return false; }
    currentId = task.id; persistCurrent(); render();
    document.dispatchEvent(new CustomEvent('notch:current-task-changed', { detail: { taskId: currentId } }));
    return true;
  }
  function renderTimer() {
    if (hydrating()) return;
    const task = currentTask();
    const button = strip.querySelector('[data-focus-action="start"]');
    const state = window.NotchPomodoro?.getState?.() || {};
    const own = task && state.taskId === task.id;
    const seconds = Math.max(0, Math.ceil(Number(state.remainingSeconds) || 0));
    const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    const canPause = typeof window.NotchPomodoro?.pause === 'function';
    const different = task && state.started && state.taskId !== task.id;
    button.textContent = different ? '切换专注' : own && state.running ? `${canPause ? '暂停' : '专注中'} ${clock}` : own && state.started ? '继续专注' : '开始专注';
    button.disabled = focusBusy || Boolean(own && state.running && !canPause);
    button.title = different ? '结束上一项专注，并开始当前任务的专注计时' : own && state.running ? (canPause ? '暂停当前任务的专注计时' : '可在番茄钟中暂停或结束') : '使用番茄钟当前设置的时长';
  }
  function render() {
    if (hydrating()) return;
    const task = currentTask();
    if (!task && currentId) { currentId = ''; persistCurrent(); }
    strip.dataset.hasTask = String(Boolean(task));
    strip.querySelector('#focus-task-title').textContent = task?.text || '现在想完成哪件事？';
    strip.querySelector('#focus-task-title').title = task?.text || '';
    strip.querySelector('#focus-task-meta').textContent = task ? `${task.categoryName} · ${deadlineLabel(task)}` : '选择一个任务，把资料和专注放在一起';
    strip.querySelector('[data-focus-action="choose"]').textContent = task ? '切换' : '选择任务';
    strip.querySelector('[data-focus-action="todos"]').hidden = Boolean(task);
    ['start', 'resources', 'complete'].forEach((action) => { strip.querySelector(`[data-focus-action="${action}"]`).hidden = !task; });
    const context = task && contexts[task.id];
    const available = context ? library() : null;
    const count = context ? context.noteIds.filter((id) => available.notes.some((note) => note.id === id)).length
      + context.linkIds.filter((id) => available.links.some((link) => link.id === id)).length : 0;
    strip.querySelector('[data-focus-action="resources"]').textContent = count ? `资料 ${count}` : '关联资料';
    renderTimer();
    if (picker.open) renderPicker();
    if (resources.open && !taskRows().some((row) => row.id === resourceTaskId && !row.done)) close();
  }
  async function handleClick(event) {
    if (hydrating()) {
      if (event.target.closest('[data-focus-action]')?.dataset.focusAction === 'close') close();
      return;
    }
    const taskButton = event.target.closest('[data-focus-task]');
    if (taskButton) { if (selectTask(taskButton.dataset.focusTask)) close(); return; }
    const resourceButton = event.target.closest('[data-focus-open]');
    if (resourceButton) { await openResource(resourceButton.dataset.focusOpen, resourceButton.dataset.resourceId); return; }
    const action = event.target.closest('[data-focus-action]')?.dataset.focusAction;
    if (action === 'choose') openPicker();
    if (action === 'close') close();
    if (action === 'resources') openResources();
    if (action === 'save-resources') saveResources();
    if (action === 'todos') { close(); window.NotchNavigation?.openTodos?.(); }
    if (action === 'clear') { currentId = ''; persistCurrent(); close(); render(); }
    if (action === 'complete') { const task = currentTask(); if (task) { todos.complete(task.category, task.id); render(); } }
    if (action === 'start' && !focusBusy) {
      const task = currentTask();
      if (!task) return;
      if (!window.NotchPomodoro?.startForTask) { notify('番茄钟暂不可用'); return; }
      const timer = window.NotchPomodoro.getState?.();
      if (timer?.taskId === task.id && timer.running && window.NotchPomodoro.pause) {
        window.NotchPomodoro.pause(); renderTimer(); return;
      }
      focusBusy = true; renderTimer();
      try {
        if (timer?.started && timer.taskId !== task.id) {
          if (!window.NotchPomodoro.stop) { notify('请先结束上一项专注'); return; }
          await window.NotchPomodoro.stop();
        }
        if (hydrating()) return;
        const result = await window.NotchPomodoro.startForTask(task.id);
        if (result === false || result?.ok === false) notify(result?.message || '专注未启动，请检查番茄钟状态');
      } catch { notify('专注未启动，请重试'); }
      finally { focusBusy = false; renderTimer(); }
    }
  }
  [strip, picker, resources].forEach((element) => element.addEventListener('click', handleClick));
  [picker, resources].forEach((dialog) => dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); }));
  picker.querySelector('#focus-task-query').addEventListener('input', renderPicker);
  document.addEventListener('notch:todos-changed', render);
  document.addEventListener('notch:pomodoro-changed', renderTimer);
  document.addEventListener('notch:tabchange', (event) => { if (event.detail?.tab !== 'home') close(); else render(); });
  document.addEventListener('notch:modechange', (event) => { if (!event.detail?.expanded) close(); else render(); });
  window.NotchFocus = Object.freeze({ selectTask, close });
  render();
})();
