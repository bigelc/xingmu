(function exposeTaskMapDomain(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TaskMapDomain = api;
})(typeof window !== 'undefined' ? window : globalThis, function createTaskMapDomain() {
  const CATEGORY_NAMES = {
    P0: '课程',
    P1: '自媒体&写作',
    P2: 'Vibe coding',
    P3: '日常',
  };
  const CATEGORIES = Object.keys(CATEGORY_NAMES);
  const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

  function normalizeScore(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(100, value))
      : null;
  }

  function normalizeMetadata(raw) {
    // Metadata lives beside the original todo record. A null prototype makes all
    // stored IDs safe dictionary keys, including "__proto__" and "constructor".
    const result = Object.create(null);
    if (!isRecord(raw)) return result;
    Object.entries(raw).forEach(([id, value]) => {
      if (!id || !isRecord(value)) return;
      result[id] = {
        urgency: normalizeScore(owns(value, 'urgency') ? value.urgency : null),
        importance: normalizeScore(owns(value, 'importance') ? value.importance : null),
        focused: owns(value, 'focused') && value.focused === true,
      };
    });
    return result;
  }

  function todoRows(data) {
    if (Array.isArray(data)) return data;
    if (!isRecord(data)) return [];
    return CATEGORIES.flatMap((category) => (
      owns(data, category) && Array.isArray(data[category]) ? data[category] : []
    ));
  }

  function reconcileMetadata(meta, todos) {
    const normalized = normalizeMetadata(meta);
    const result = Object.create(null);
    todoRows(todos).forEach((item) => {
      if (!isRecord(item) || typeof item.id !== 'string' || !owns(normalized, item.id)) return;
      const values = normalized[item.id];
      result[item.id] = { ...values, focused: item.done === true ? false : values.focused };
    });
    return result;
  }

  function flattenTodos(data, names, meta) {
    const source = isRecord(data) ? data : {};
    const categoryNames = isRecord(names) ? names : {};
    const metadata = normalizeMetadata(meta);
    return CATEGORIES.flatMap((category) => {
      const rows = owns(source, category) && Array.isArray(source[category]) ? source[category] : [];
      const customName = owns(categoryNames, category) && typeof categoryNames[category] === 'string'
        ? categoryNames[category].trim()
        : '';
      return rows.filter((item) => (
        isRecord(item) && typeof item.id === 'string' && item.id.length > 0
      )).map((item) => {
        const values = metadata[item.id] || { urgency: null, importance: null, focused: false };
        return {
          ...item,
          category,
          categoryName: customName || CATEGORY_NAMES[category],
          urgency: values.urgency,
          importance: values.importance,
          focused: item.done === true ? false : values.focused,
          evaluated: values.urgency !== null && values.importance !== null,
        };
      });
    });
  }

  function filterTasks(tasks, filters = {}, now = Date.now()) {
    const options = isRecord(filters) ? filters : {};
    const mode = options.mode === 'focus' ? 'focus' : 'all';
    const range = ['today', 'week'].includes(options.range) ? options.range : 'all';
    const category = CATEGORIES.includes(options.category) ? options.category : 'all';
    const query = typeof options.query === 'string' ? options.query.trim().toLocaleLowerCase() : '';
    const start = new Date(now);
    if (!Number.isFinite(start.getTime())) start.setTime(Date.now());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    // Calendar arithmetic retains midnight boundaries across daylight saving.
    end.setDate(end.getDate() + (range === 'week' ? 7 : 1));
    return (Array.isArray(tasks) ? tasks : []).filter((task) => {
      if (!isRecord(task) || task.done === true) return false;
      if (mode === 'focus' && task.focused !== true) return false;
      if (category !== 'all' && task.category !== category) return false;
      if (query && !String(task.text || '').toLocaleLowerCase().includes(query)) return false;
      if (range !== 'all') {
        const deadline = typeof task.deadline === 'string' ? Date.parse(task.deadline) : NaN;
        if (!Number.isFinite(deadline) || deadline < start.getTime() || deadline >= end.getTime()) return false;
      }
      return true;
    });
  }

  function getOverlappingTasks(tasks, taskId, width, height, radius = 14) {
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return [];
    const hitRadius = Number.isFinite(radius) && radius >= 0 ? radius : 14;
    const rows = (Array.isArray(tasks) ? tasks : []).filter((task) => (
      isRecord(task) && task.evaluated === true
      && Number.isFinite(task.urgency) && task.urgency >= 0 && task.urgency <= 100
      && Number.isFinite(task.importance) && task.importance >= 0 && task.importance <= 100
    ));
    const target = rows.find((task) => task.id === taskId);
    if (!target) return [];
    return rows.filter((task) => {
      const x = (task.urgency - target.urgency) * width / 100;
      const y = (task.importance - target.importance) * height / 100;
      return x * x + y * y <= hitRadius * hitRadius;
    });
  }

  return {
    normalizeMetadata,
    reconcileMetadata,
    flattenTodos,
    filterTasks,
    getOverlappingTasks,
  };
});
