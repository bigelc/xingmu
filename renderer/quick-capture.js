(() => {
  'use strict';
  const todos = window.NotchTodos;
  const navigation = window.NotchNavigation;
  if (!todos || !navigation) return;
  const KEY = 'notch-quick-capture-draft-v1';
  const dialog = document.createElement('dialog');
  dialog.id = 'quick-capture-dialog';
  dialog.className = 'quick-capture-dialog';
  dialog.setAttribute('aria-labelledby', 'quick-capture-title');
  dialog.innerHTML = `<form id="quick-capture-form"><header><div><h2 id="quick-capture-title">快速记一条</h2><p>先记下来，时间可以稍后安排。</p></div><button type="button" data-capture-close aria-label="关闭快速记录">×</button></header>
    <label class="capture-text-label" for="quick-capture-text">要做什么</label><input id="quick-capture-text" type="text" maxlength="80" placeholder="例如：整理产品评审的下一步" autocomplete="off" required />
    <div class="capture-options"><label>分类<select id="quick-capture-category"></select></label><label>截止时间<select id="quick-capture-deadline"><option value="none">无截止时间</option><option value="today">今天 23:30</option><option value="tomorrow">明天 23:30</option></select></label></div>
    <p id="quick-capture-status" role="status" hidden></p><footer><label><input id="quick-capture-return" type="checkbox" checked />保存后收起，回到工作</label><button class="capture-submit" type="submit">保存 ↵</button></footer></form>`;
  document.getElementById('panel').append(dialog);
  const input = dialog.querySelector('#quick-capture-text');
  const category = dialog.querySelector('#quick-capture-category');
  const deadline = dialog.querySelector('#quick-capture-deadline');
  const returnToWork = dialog.querySelector('#quick-capture-return');
  const status = dialog.querySelector('#quick-capture-status');
  let opener = null;
  let draft = {};
  try { draft = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch {}
  input.value = typeof draft.text === 'string' ? draft.text : '';
  deadline.value = ['none', 'today', 'tomorrow'].includes(draft.deadline) ? draft.deadline : 'none';
  returnToWork.checked = draft.returnToWork !== false;
  function persist() {
    if (window.__notchWorkspaceHydrating) return;
    localStorage.setItem(KEY, JSON.stringify({ text: input.value, category: category.value || draft.category || 'P0', deadline: deadline.value, returnToWork: returnToWork.checked }));
  }
  function saveDraft() {
    try { persist(); } catch { status.textContent = '草稿尚未保存，输入仍保留在这里。'; status.hidden = false; }
  }
  function open() {
    if (!navigation.isExpanded() || window.__notchWorkspaceHydrating || window.__notchWorkspaceInteractionLocked) return false;
    if (dialog.open) { input.focus(); return true; }
    window.NotchFocus?.close();
    window.NotchTaskMap?.close();
    opener = document.activeElement;
    const previous = category.value || draft.category;
    category.replaceChildren(...Object.entries(todos.getSnapshot().names).map(([id, name]) => new Option(name, id)));
    category.value = Object.hasOwn(todos.getSnapshot().names, previous) ? previous : 'P0';
    const today = new Date(); today.setHours(23, 30, 0, 0);
    deadline.querySelector('[value="today"]').disabled = today.getTime() <= Date.now();
    if (deadline.value === 'today' && today.getTime() <= Date.now()) deadline.value = 'none';
    status.hidden = true;
    dialog.showModal(); input.focus();
    return true;
  }
  function close() {
    if (!dialog.open) return false;
    saveDraft(); dialog.close();
    if (opener?.isConnected && !opener.closest('[hidden], [inert]')) opener.focus({ preventScroll: true });
    return true;
  }
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.querySelector('[data-capture-close]').addEventListener('click', close);
  dialog.addEventListener('input', saveDraft);
  dialog.addEventListener('change', saveDraft);
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (window.__notchWorkspaceHydrating || window.__notchWorkspaceInteractionLocked || event.isComposing || !input.value.trim()) return;
    let ddl = '';
    if (deadline.value !== 'none') {
      const date = new Date(); date.setHours(23, 30, 0, 0);
      if (deadline.value === 'tomorrow') date.setDate(date.getDate() + 1);
      if (date.getTime() <= Date.now()) { status.textContent = '今天的截止时间已过，请重新选择。'; status.hidden = false; return; }
      ddl = date.toISOString();
    }
    if (!todos.add(category.value, input.value, ddl)) {
      status.textContent = '未能保存，输入已保留。请检查本机存储后重试。'; status.hidden = false; return;
    }
    input.value = ''; saveDraft();
    const collapse = returnToWork.checked;
    close();
    todos.notify('待办已保存');
    if (collapse) await navigation.returnToWork();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229 || event.repeat)) event.preventDefault();
  });
  document.querySelectorAll('[data-quick-capture]').forEach((button) => button.addEventListener('click', open));
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !event.altKey && !event.isComposing && navigation.isExpanded()) {
      event.preventDefault(); if (!event.repeat) open();
    }
  });
  window.NotchQuickCapture = Object.freeze({ open, close, persist });
})();
