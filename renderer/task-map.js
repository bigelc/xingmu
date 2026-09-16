/* Task coordinates are independent of todo categories and deadlines. */
(() => {
  'use strict';
  const model = window.TaskMapDomain;
  const todos = window.NotchTodos;
  const widget = document.getElementById('task-map-widget');
  if (!model || !todos || !widget) return;
  const META_KEY = 'notch-task-map-meta-v1';
  const MODE_KEY = 'notch-task-map-mode-v1';
  const workspaceLocked = () => window.__notchWorkspaceHydrating === true || window.__notchWorkspaceInteractionLocked === true;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let metadata;
  let mode = 'all';
  try { metadata = model.normalizeMetadata(JSON.parse(localStorage.getItem(META_KEY) || 'null')); }
  catch { metadata = model.normalizeMetadata(null); }
  try { mode = localStorage.getItem(MODE_KEY) === 'focus' ? 'focus' : 'all'; } catch {}
  let tasks = [];
  let selectedId = '';
  let overlapIds = [];
  let overlapScope = '';
  let filters = { range: 'all', category: 'all', query: '' };
  let drag = null;
  let suppressClickUntil = 0;
  let lastOpener = null;
  let persisted = true;
  let listLimit = 100;
  let scoreDraft = null;

  function notify(message) {
    if (dialog.open) {
      const feedback = dialog.querySelector('#tm-feedback');
      feedback.textContent = message;
      feedback.hidden = false;
    } else todos.notify(message);
  }
  function persistMetadata() {
    if (workspaceLocked()) return;
    try { localStorage.setItem(META_KEY, JSON.stringify(metadata)); persisted = true; }
    catch { persisted = false; notify('任务坐标仅在当前会话保留，未能保存到本机'); }
  }
  function refreshTasks() {
    if (workspaceLocked()) return null;
    const snapshot = todos.getSnapshot();
    const all = Object.values(snapshot.data).flat();
    const next = model.reconcileMetadata(metadata, all);
    if (JSON.stringify(next) !== JSON.stringify(metadata)) {
      metadata = next;
      persistMetadata();
    }
    tasks = model.flattenTodos(snapshot.data, snapshot.names, metadata);
    if (!tasks.some((task) => task.id === selectedId && !task.done)) selectedId = '';
    return snapshot;
  }
  function visibleTasks(expanded) {
    return model.filterTasks(tasks, { mode, ...(expanded ? filters : {}) });
  }
  function setScores(id, urgency, importance) {
    if (workspaceLocked()) return;
    const task = tasks.find((item) => item.id === id && !item.done);
    if (!task) return;
    metadata[id] = { ...(metadata[id] || {}), urgency, importance, focused: task.focused };
    persistMetadata();
    selectedId = id;
    scoreDraft = null;
    overlapIds = [];
    render();
  }
  const modeButtons = () => '<div class="tm-modes" role="group" aria-label="任务范围"><button type="button" data-tm-mode="all">全部</button><button type="button" data-tm-mode="focus">关注</button></div>';
  function plotMarkup(scope) {
    return `<div class="tm-plot" data-tm-scope="${scope}" aria-label="横轴紧急程度，纵轴重要程度"><span class="tm-axis-y">重要 ↑</span><span class="tm-axis-x">紧急 →</span><div class="tm-plot-board"><div class="tm-quadrant tm-q-tl">重要 · 不紧急</div><div class="tm-quadrant tm-q-tr">重要 · 紧急</div><div class="tm-quadrant tm-q-bl">不重要 · 不紧急</div><div class="tm-quadrant tm-q-br">不重要 · 紧急</div><div class="tm-points"></div><div class="tm-plot-empty"></div><span class="tm-drop-preview" hidden></span></div><div class="tm-tooltip" role="tooltip" hidden></div></div>`;
  }
  widget.innerHTML = `<div class="tm-widget-head"><strong>任务坐标图</strong>${modeButtons()}<button type="button" class="tm-expand" data-tm-action="expand" aria-label="展开任务坐标图" title="展开大图">↗</button></div>${plotMarkup('widget')}<div class="tm-widget-foot"><span class="tm-summary"></span><button type="button" data-tm-action="unassessed"></button></div><div class="tm-widget-detail" hidden></div><div class="tm-overlap" hidden></div>`;
  const dialog = document.createElement('dialog');
  dialog.id = 'task-map-dialog';
  dialog.className = 'tm-dialog';
  dialog.setAttribute('aria-labelledby', 'tm-title');
  dialog.innerHTML = `<header class="tm-dialog-head"><div><h2 id="tm-title">任务坐标图</h2><p>看清分布，选定下一步</p></div>${modeButtons()}<button type="button" class="tm-close" data-tm-action="close" aria-label="关闭任务坐标图">×</button></header>
    <div class="tm-filters"><label>时间<select id="tm-range"><option value="all">全部时间</option><option value="today">今天截止</option><option value="week">未来 7 天</option></select></label><label>分类<select id="tm-category"></select></label><input id="tm-search" type="search" placeholder="搜索任务…" aria-label="搜索坐标图任务" maxlength="80"/><button type="button" data-tm-action="reset">返回全部</button></div>
    <div class="tm-scope-line"><span class="tm-summary" role="status"></span><span id="tm-filter-state"></span></div>
    <div id="tm-feedback" role="alert" hidden></div><div class="tm-dialog-body"><div class="tm-map-column">${plotMarkup('dialog')}<div class="tm-legend"></div><div class="tm-map-hint">拖动圆点调整位置 · 方向键微调 · Shift 加快</div><div id="tm-detail" class="tm-detail"></div><div class="tm-overlap" hidden></div></div><aside class="tm-list-column" aria-label="与坐标图联动的任务列表"><div class="tm-list-head"><strong>任务列表</strong><span id="tm-list-count"></span></div><p class="tm-list-hint">点击查看；待评估任务可拖入左侧图中</p><div id="tm-task-list" class="tm-task-list"></div></aside></div>`;
  document.getElementById('panel').appendChild(dialog);

  function rememberFocus() {
    const active = document.activeElement;
    const root = dialog.contains(active) ? dialog : widget.contains(active) ? widget : null;
    if (!root) return () => {};
    const keys = ['data-tm-mode', 'data-tm-point', 'data-tm-select', 'data-tm-action', 'data-tm-score'];
    const attr = keys.find((key) => active.hasAttribute(key));
    const value = attr ? active.getAttribute(attr) : '';
    return () => {
      if (active.isConnected || !attr) return;
      const replacement = [...root.querySelectorAll(`[${attr}]`)].find((el) => el.getAttribute(attr) === value);
      (replacement || root.querySelector('[data-tm-action="close"], [data-tm-action="expand"]'))?.focus({ preventScroll: true });
    };
  }
  function renderPlot(root, visible) {
    root.querySelector('.tm-plot-board').classList.remove('is-drop-target');
    root.querySelector('.tm-drop-preview').hidden = true;
    const assessed = visible.filter((task) => task.evaluated);
    root.querySelector('.tm-points').innerHTML = assessed.map((task) => `<button type="button" class="tm-point${task.id === selectedId ? ' is-selected' : ''}${task.focused ? ' is-focused' : ''}" data-category="${task.category}" data-tm-point="${esc(task.id)}" style="left:${task.urgency}%;top:${100 - task.importance}%" aria-label="${esc(task.text)}，紧急 ${Math.round(task.urgency)}，重要 ${Math.round(task.importance)}${task.focused ? '，已关注' : ''}" aria-pressed="${task.id === selectedId}"><span></span></button>`).join('');
    const empty = root.querySelector('.tm-plot-empty');
    empty.hidden = assessed.length > 0;
    empty.textContent = visible.length ? '待评估任务尚未定位' : tasks.some((task) => !task.done) ? '当前范围没有任务' : '还没有未完成任务';
  }
  function scoreText(task) {
    return task.evaluated ? `紧急 ${Math.round(task.urgency)} · 重要 ${Math.round(task.importance)}` : '待评估';
  }
  function detailMarkup(task, expanded) {
    if (!task) return expanded ? '<p class="tm-detail-placeholder">选择一个圆点或列表任务，查看详情与调整位置。</p>' : '';
    const draft = scoreDraft?.id === task.id ? scoreDraft : task;
    const date = task.deadline ? new Date(task.deadline) : null;
    const deadline = date && Number.isFinite(date.getTime()) ? `${date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 截止` : '无截止时间';
    return `<div class="tm-detail-title"><span class="tm-category-dot" data-category="${task.category}"></span><strong>${esc(task.text)}</strong><button type="button" data-tm-action="dismiss-selection" aria-label="取消选择">×</button></div><div class="tm-detail-meta">${esc(task.categoryName)} · ${esc(deadline)}${expanded ? '' : ` · ${scoreText(task)}`}</div>${expanded ? `<div class="tm-score-editor"><label>紧急<input type="number" min="0" max="100" step="any" data-tm-score="urgency" aria-label="紧急程度" value="${esc(draft.urgency ?? '')}" placeholder="0–100"/></label><label>重要<input type="number" min="0" max="100" step="any" data-tm-score="importance" aria-label="重要程度" value="${esc(draft.importance ?? '')}" placeholder="0–100"/></label><button type="button" data-tm-action="save-scores">保存位置</button></div>` : ''}<div class="tm-detail-actions"><button type="button" data-tm-action="current">设为当前任务</button><button type="button" data-tm-action="star" aria-pressed="${task.focused}">${task.focused ? '★ 已关注' : '☆ 关注'}</button><button type="button" data-tm-action="complete">✓ 完成</button>${expanded && task.evaluated ? '<button type="button" data-tm-action="clear">移回待评估</button>' : ''}${expanded ? '' : '<button type="button" data-tm-action="expand">调整位置 ↗</button>'}</div>`;
  }
  function renderOverlap(root, scope, visible) {
    const container = root.querySelector('.tm-overlap');
    const overlap = scope === overlapScope ? visible.filter((task) => overlapIds.includes(task.id)) : [];
    container.hidden = overlap.length < 2;
    if (container.hidden) { container.replaceChildren(); return; }
    container.innerHTML = `<div class="tm-overlap-head"><strong>此处有 ${overlap.length} 项任务</strong><button type="button" data-tm-action="dismiss-overlap" aria-label="关闭重叠任务列表">×</button></div><div class="tm-overlap-list">${overlap.map((task) => `<button type="button" data-tm-select="${esc(task.id)}"><span class="tm-category-dot" data-category="${task.category}"></span><span>${esc(task.text)}</span></button>`).join('')}</div>`;
  }
  function render() {
    if (workspaceLocked()) return;
    const restoreFocus = rememberFocus();
    const snapshot = refreshTasks();
    const total = tasks.filter((task) => !task.done).length;
    const compact = visibleTasks(false);
    [widget, dialog].forEach((root) => root.querySelectorAll('[data-tm-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tmMode === mode))));
    renderPlot(widget, compact);
    const compactUnassessed = compact.filter((task) => !task.evaluated).length;
    widget.querySelector('.tm-summary').textContent = `${compact.length} / ${total} 项${persisted ? '' : ' · 未保存'}`;
    widget.querySelector('.tm-summary').title = `当前显示 ${compact.length} / 全部未完成 ${total}，图中已评估 ${compact.length - compactUnassessed} 项`;
    widget.querySelector('[data-tm-action="unassessed"]').textContent = `待评估 ${compactUnassessed}`;
    const compactSelected = compact.find((task) => task.id === selectedId);
    const compactDetail = widget.querySelector('.tm-widget-detail');
    compactDetail.hidden = !compactSelected || dialog.open;
    compactDetail.innerHTML = compactDetail.hidden ? '' : detailMarkup(compactSelected, false);
    renderOverlap(widget, 'widget', compact);
    if (dialog.open) {
      const visible = visibleTasks(true);
      const category = dialog.querySelector('#tm-category');
      const options = '<option value="all">全部分类</option>' + Object.entries(snapshot.names).map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
      if (category.innerHTML !== options) category.innerHTML = options;
      category.value = filters.category;
      dialog.querySelector('#tm-range').value = filters.range;
      dialog.querySelector('#tm-search').value = filters.query;
      const unassessed = visible.filter((task) => !task.evaluated).length;
      dialog.querySelector('.tm-summary').textContent = `当前显示 ${visible.length} / 全部未完成 ${total} · 图中 ${visible.length - unassessed} · 待评估 ${unassessed}${persisted ? '' : ' · 未保存'}`;
      const filterLabels = [mode === 'focus' ? '关注任务' : '全部任务', { all: '全部时间', today: '今天截止', week: '未来 7 天（含今天）' }[filters.range], filters.category === 'all' ? '全部分类' : snapshot.names[filters.category], filters.query ? `搜索「${filters.query}」` : ''].filter(Boolean);
      dialog.querySelector('#tm-filter-state').textContent = filterLabels.join(' / ');
      renderPlot(dialog, visible);
      dialog.querySelector('.tm-legend').innerHTML = Object.entries(snapshot.names).map(([id, name]) => `<span title="${esc(name)}"><i class="tm-category-dot" data-category="${id}"></i>${esc(name)}</span>`).join('');
      const selected = visible.find((task) => task.id === selectedId);
      dialog.querySelector('#tm-detail').innerHTML = detailMarkup(selected, true);
      const list = dialog.querySelector('#tm-task-list');
      const scrollTop = list.scrollTop;
      const displayed = visible.slice(0, listLimit);
      if (selected && !displayed.some((task) => task.id === selected.id)) displayed.unshift(selected);
      list.innerHTML = displayed.map((task) => `<button type="button" class="tm-list-row${task.id === selectedId ? ' is-selected' : ''}" data-tm-select="${esc(task.id)}" draggable="false" aria-pressed="${task.id === selectedId}"><span class="tm-category-dot" data-category="${task.category}"></span><span class="tm-row-copy"><strong>${esc(task.text)}</strong><small>${esc(task.categoryName)} · ${scoreText(task)}</small></span>${task.focused ? '<span class="tm-star" aria-label="已关注">★</span>' : ''}</button>`).join('') || '<p class="tm-list-empty">当前范围没有任务。可返回全部，或去待办页新增任务。</p>';
      if (visible.length > listLimit) list.insertAdjacentHTML('beforeend', `<button type="button" class="tm-load-more" data-tm-action="load-more">再显示 100 项（剩余 ${visible.length - listLimit}）</button>`);
      list.scrollTop = scrollTop;
      dialog.querySelector('#tm-list-count').textContent = `${visible.length} 项`;
      renderOverlap(dialog, 'dialog', visible);
    }
    restoreFocus();
  }
  function open() {
    if (workspaceLocked()) return false;
    if (selectedId && !visibleTasks(true).some((task) => task.id === selectedId)) {
      filters = { range: 'all', category: 'all', query: '' };
      listLimit = 100;
    }
    if (!dialog.open) {
      lastOpener = document.activeElement;
      dialog.showModal();
    }
    overlapIds = [];
    render();
    dialog.querySelector('[data-tm-action="close"]').focus({ preventScroll: true });
    return true;
  }
  function close() {
    const wasOpen = dialog.open;
    const hadTransient = Boolean(drag || overlapIds.length || selectedId);
    if (drag?.point.hasPointerCapture(drag.pointerId)) drag.point.releasePointerCapture(drag.pointerId);
    drag = null;
    overlapIds = [];
    if (wasOpen) dialog.close();
    else if (!hadTransient) return false;
    selectedId = '';
    render();
    const focusTarget = lastOpener?.isConnected ? lastOpener : widget.querySelector('[data-tm-action="expand"]');
    if (!workspaceLocked() && wasOpen && focusTarget && !focusTarget.closest('[inert], [hidden]')) focusTarget.focus({ preventScroll: true });
    return true;
  }
  function choose(id, scope) {
    if (workspaceLocked()) return;
    selectedId = id;
    scoreDraft = null;
    overlapIds = [];
    render();
    if (scope === 'dialog') {
      const row = [...dialog.querySelectorAll('.tm-list-row')].find((el) => el.dataset.tmSelect === id);
      row?.scrollIntoView({ block: 'nearest' });
    }
  }
  function click(event) {
    if (workspaceLocked()) {
      if (event.target.closest('[data-tm-action]')?.dataset.tmAction === 'close') close();
      return;
    }
    const root = event.currentTarget;
    const expanded = root === dialog;
    const scope = expanded ? 'dialog' : 'widget';
    const modeButton = event.target.closest('[data-tm-mode]');
    if (modeButton) {
      mode = modeButton.dataset.tmMode;
      try { localStorage.setItem(MODE_KEY, mode); } catch { notify('视图偏好未能保存'); }
      selectedId = '';
      overlapIds = [];
      render();
      return;
    }
    const select = event.target.closest('[data-tm-select]');
    if (select) { if (Date.now() >= suppressClickUntil) choose(select.dataset.tmSelect, scope); return; }
    const point = event.target.closest('[data-tm-point]');
    if (point) {
      if (Date.now() < suppressClickUntil) return;
      const board = root.querySelector('.tm-plot-board').getBoundingClientRect();
      const overlap = model.getOverlappingTasks(visibleTasks(expanded), point.dataset.tmPoint, board.width, board.height);
      if (overlap.length > 1) {
        overlapIds = overlap.map((task) => task.id);
        overlapScope = scope;
        selectedId = '';
        render();
        root.querySelector('.tm-overlap [data-tm-select]')?.focus({ preventScroll: true });
      } else choose(point.dataset.tmPoint, scope);
      return;
    }
    const action = event.target.closest('[data-tm-action]')?.dataset.tmAction;
    if (action) dialog.querySelector('#tm-feedback').hidden = true;
    const selected = tasks.find((task) => task.id === selectedId && !task.done);
    if (action === 'expand') open();
    if (action === 'close') close();
    if (action === 'unassessed') {
      filters = { range: 'all', category: 'all', query: '' };
      listLimit = 100;
      open();
      const task = visibleTasks(true).find((item) => !item.evaluated);
      if (task) choose(task.id, 'dialog');
    }
    if (action === 'reset') {
      filters = { range: 'all', category: 'all', query: '' };
      mode = 'all'; selectedId = ''; overlapIds = []; listLimit = 100;
      try { localStorage.setItem(MODE_KEY, mode); } catch {}
      render();
    }
    if (action === 'dismiss-selection') { selectedId = ''; render(); }
    if (action === 'dismiss-overlap') { overlapIds = []; render(); }
    if (action === 'load-more') { listLimit += 100; render(); }
    if (action === 'current' && selected) {
      if (window.NotchFocus?.selectTask(selected.id)) {
        if (dialog.open) close();
        notify('已设为当前任务，可在首页关联资料或开始专注');
      }
    }
    if (action === 'star' && selected) {
      metadata[selected.id] = { urgency: selected.urgency, importance: selected.importance, focused: !selected.focused };
      persistMetadata(); render();
    }
    if (action === 'complete' && selected) {
      todos.complete(selected.category, selected.id);
      render();
    }
    if (action === 'clear' && selected) setScores(selected.id, null, null);
    if (action === 'save-scores' && selected) {
      const inputs = [...dialog.querySelectorAll('[data-tm-score]')];
      const values = inputs.map((input) => input.value.trim() === '' ? NaN : Number(input.value));
      if (!values.every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) {
        notify('请填写 0–100 之间的紧急和重要程度');
        inputs.find((input) => input.value === '' || !input.validity.valid)?.focus();
        return;
      }
      setScores(selected.id, values[0], values[1]);
    }
  }
  function scoresAt(event, board) {
    const rect = board.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      urgency: Math.round(Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100)) * 10) / 10,
      importance: Math.round(Math.max(0, Math.min(100, (rect.bottom - event.clientY) / rect.height * 100)) * 10) / 10,
    };
  }
  for (const root of [widget, dialog]) {
    root.addEventListener('click', click);
    root.addEventListener('pointerdown', (event) => {
      if (workspaceLocked()) return;
      const row = event.target.closest('.tm-list-row');
      const point = event.target.closest('[data-tm-point]') || row;
      if (!point || event.button !== 0) return;
      event.stopPropagation();
      const board = root.querySelector('.tm-plot-board');
      const rect = board.getBoundingClientRect();
      const overlap = model.getOverlappingTasks(visibleTasks(root === dialog), point.dataset.tmPoint, rect.width, rect.height);
      if (!row && overlap.length > 1 && selectedId !== point.dataset.tmPoint) return;
      drag = { id: row ? row.dataset.tmSelect : point.dataset.tmPoint, fromList: Boolean(row), point, board, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
      point.setPointerCapture(event.pointerId);
    });
    root.addEventListener('pointermove', (event) => {
      if (workspaceLocked()) return;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4 && !drag.moved) return;
      drag.moved = true;
      const scores = scoresAt(event, drag.board);
      if (!scores) return;
      event.preventDefault();
      if (drag.fromList) {
        const rect = drag.board.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
        const preview = drag.board.querySelector('.tm-drop-preview');
        drag.board.classList.toggle('is-drop-target', inside);
        preview.hidden = !inside;
        preview.style.left = `${scores.urgency}%`;
        preview.style.top = `${100 - scores.importance}%`;
      } else {
        drag.point.style.left = `${scores.urgency}%`;
        drag.point.style.top = `${100 - scores.importance}%`;
      }
      drag.point.classList.add('is-dragging');
      root.querySelector('.tm-tooltip').hidden = true;
    });
    root.addEventListener('pointerup', (event) => {
      if (workspaceLocked()) { close(); return; }
      if (!drag || drag.pointerId !== event.pointerId) return;
      const finished = drag;
      drag = null;
      if (finished.point.hasPointerCapture(event.pointerId)) finished.point.releasePointerCapture(event.pointerId);
      if (finished.moved) {
        suppressClickUntil = Date.now() + 200;
        const rect = finished.board.getBoundingClientRect();
        if (finished.fromList && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) {
          render();
          return;
        }
        const scores = scoresAt(event, finished.board);
        if (scores) setScores(finished.id, scores.urgency, scores.importance);
      }
    });
    root.addEventListener('pointercancel', () => { if (drag) { drag = null; render(); } });
    root.addEventListener('keydown', (event) => {
      if (workspaceLocked()) return;
      const point = event.target.closest('[data-tm-point]');
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
      if (!point || !delta) return;
      event.preventDefault(); event.stopPropagation();
      const task = tasks.find((item) => item.id === point.dataset.tmPoint);
      const step = event.shiftKey ? 10 : 1;
      setScores(task.id, Math.max(0, Math.min(100, task.urgency + delta[0] * step)), Math.max(0, Math.min(100, task.importance + delta[1] * step)));
    });
    root.addEventListener('pointerover', (event) => {
      if (workspaceLocked()) return;
      if (drag) return;
      const point = event.target.closest('[data-tm-point]');
      if (!point) return;
      const task = tasks.find((item) => item.id === point.dataset.tmPoint);
      const tooltip = root.querySelector('.tm-tooltip');
      tooltip.textContent = task.text;
      tooltip.hidden = false;
    });
    root.addEventListener('pointerout', (event) => {
      if (event.target.closest('[data-tm-point]')) root.querySelector('.tm-tooltip').hidden = true;
    });
  }
  for (const [id, key] of [['tm-range', 'range'], ['tm-category', 'category'], ['tm-search', 'query']]) {
    dialog.querySelector(`#${id}`).addEventListener(id === 'tm-search' ? 'input' : 'change', (event) => {
      if (workspaceLocked()) return;
      filters[key] = event.target.value;
      overlapIds = []; selectedId = ''; listLimit = 100;
      render();
    });
  }
  dialog.addEventListener('input', (event) => {
    if (workspaceLocked()) return;
    if (!event.target.matches('[data-tm-score]')) return;
    scoreDraft = {
      id: selectedId,
      urgency: dialog.querySelector('[data-tm-score=urgency]').value,
      importance: dialog.querySelector('[data-tm-score=importance]').value,
    };
  });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  document.addEventListener('notch:todos-changed', render);
  document.addEventListener('notch:tabchange', (event) => { if (event.detail.tab !== 'home') close(); });
  document.addEventListener('notch:home-modules-changed', (event) => { if (event.detail.hiddenIds.includes('taskMap')) close(); });
  // Re-evaluate calendar ranges on wake/open and while actively viewing the map.
  window.addEventListener('focus', render);
  setInterval(() => { if (dialog.open && !drag && !document.activeElement?.matches('[data-tm-score]')) render(); }, 60000);
  window.NotchTaskMap = Object.freeze({
    open, close,
    getMetadata: (id) => metadata[id] ? { ...metadata[id] } : null,
    restoreMetadata: (id, values) => {
      if (workspaceLocked() || !values) return;
      const restored = model.normalizeMetadata({ [id]: values });
      if (restored[id]) { metadata[id] = restored[id]; persistMetadata(); }
    },
  });
  render();
})();
