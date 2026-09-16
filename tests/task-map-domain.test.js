const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  normalizeMetadata,
  reconcileMetadata,
  flattenTodos,
  filterTasks,
  getOverlappingTasks,
} = require('../renderer/task-map-domain');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function localDeadline(day, hour = 12, minute = 0) {
  return new Date(2026, 8, day, hour, minute).toISOString();
}

const now = new Date(2026, 8, 10, 15, 30).getTime();
const task = (id, extra = {}) => ({ id, text: id, done: false, ...extra });
const ids = (tasks) => tasks.map((item) => item.id);

test('task-map metadata clamps numeric scores without rounding or coercing missing evaluations', () => {
  const raw = {
    a: { urgency: 35.125, importance: 75.9, focused: true, text: 'not metadata' },
    b: { urgency: -1, importance: 120, focused: 'true' },
    c: { urgency: '60', importance: Infinity, focused: 1 },
    d: { urgency: NaN, importance: null },
    e: { urgency: 0, importance: 0 },
  };
  const normalized = normalizeMetadata(raw);
  assert.equal(Object.getPrototypeOf(normalized), null);
  assert.deepEqual(plain(normalized), {
    a: { urgency: 35.125, importance: 75.9, focused: true },
    b: { urgency: 0, importance: 100, focused: false },
    c: { urgency: null, importance: null, focused: false },
    d: { urgency: null, importance: null, focused: false },
    e: { urgency: 0, importance: 0, focused: false },
  });
  assert.equal(raw.b.urgency, -1);
  assert.equal(raw.a.text, 'not metadata');
});

test('task-map metadata ignores malformed entries and inherited fields while preserving prototype-like IDs safely', () => {
  const raw = JSON.parse('{"__proto__":{"urgency":20,"importance":30,"focused":true},"constructor":{"urgency":40},"prototype":{"focused":true}}');
  raw.inherited = Object.create({ urgency: 60, importance: 70, focused: true });
  Object.setPrototypeOf(raw, { hidden: { urgency: 100, importance: 100, focused: true } });
  raw.nullish = null;
  raw.list = [20, 30];
  raw.number = 1;
  raw[''] = {};
  const result = normalizeMetadata(raw);
  assert.deepEqual(result.__proto__, { urgency: 20, importance: 30, focused: true });
  assert.deepEqual(result.constructor, { urgency: 40, importance: null, focused: false });
  assert.deepEqual(result.prototype, { urgency: null, importance: null, focused: true });
  assert.deepEqual(result.inherited, { urgency: null, importance: null, focused: false });
  assert.equal(result.hidden, undefined);
  assert.deepEqual(Object.keys(result), ['__proto__', 'constructor', 'prototype', 'inherited']);
  assert.equal({}.urgency, undefined);
  for (const value of [null, undefined, false, 42, 'bad json', []]) {
    assert.equal(Object.getPrototypeOf(normalizeMetadata(value)), null);
    assert.deepEqual(Object.keys(normalizeMetadata(value)), []);
  }
});

test('reconciling metadata removes deleted tasks and completed focus while preserving scores and original records', () => {
  const meta = {
    a: { urgency: 30, importance: 80, focused: true },
    b: { urgency: 50, importance: 90, focused: true },
    deleted: { urgency: 100, importance: 100, focused: true },
  };
  const todos = { P0: [task('a')], P1: [task('b', { done: true }), task('new')] };
  const before = JSON.stringify({ meta, todos });
  assert.deepEqual(plain(reconcileMetadata(meta, todos)), {
    a: { urgency: 30, importance: 80, focused: true },
    b: { urgency: 50, importance: 90, focused: false },
  });
  assert.deepEqual(plain(reconcileMetadata(meta, [task('a')])), { a: meta.a });
  assert.deepEqual(plain(reconcileMetadata(meta, null)), {});
  assert.equal(JSON.stringify({ meta, todos }), before);
});

test('flattened tasks retain category identity, source fields and manual scores independent of deadlines', () => {
  const data = {
    P0: [task('a', { deadline: localDeadline(10), createdAt: 123, remindedAt: 456 })],
    P1: [task('b', { deadline: localDeadline(20), done: true })],
    P2: [task('c')],
    P3: [task('d')],
    P4: [task('ignored')],
  };
  const meta = {
    a: { urgency: 0, importance: 100, focused: true },
    b: { urgency: 90, importance: 10, focused: true },
    c: { urgency: 50 },
  };
  const before = JSON.stringify({ data, meta });
  const tasks = flattenTodos(data, { P0: ' 学习 ', P1: '', P3: '生活' }, meta);
  assert.deepEqual(ids(tasks), ['a', 'b', 'c', 'd']);
  assert.deepEqual(tasks[0], {
    ...data.P0[0], category: 'P0', categoryName: '学习',
    urgency: 0, importance: 100, focused: true, evaluated: true,
  });
  assert.equal(tasks[1].categoryName, '自媒体&写作');
  assert.equal(tasks[1].focused, false);
  assert.equal(tasks[1].urgency, 90);
  assert.equal(tasks[2].categoryName, 'Vibe coding');
  assert.equal(tasks[2].evaluated, false);
  assert.equal(tasks[2].importance, null);
  assert.equal(tasks[3].categoryName, '生活');
  assert.equal(tasks[3].evaluated, false);
  assert.equal(JSON.stringify({ data, meta }), before);
});

test('flattening tolerates malformed collections and handles prototype-like IDs', () => {
  const meta = JSON.parse('{"__proto__":{"urgency":0,"importance":0,"focused":true}}');
  const data = { P0: [null, 'legacy', {}, task(''), task('__proto__')], P1: 'bad' };
  const tasks = flattenTodos(data, null, meta);
  assert.deepEqual(ids(tasks), ['__proto__']);
  assert.equal(tasks[0].evaluated, true);
  assert.equal(tasks[0].focused, true);
  assert.deepEqual(flattenTodos(null, null, null), []);
  assert.deepEqual(flattenTodos([], {}, {}), []);
});

test('all-task filtering includes unassessed, undated and overdue tasks but excludes completed tasks', () => {
  const tasks = [
    task('overdue', { deadline: localDeadline(9) }),
    task('undated', { deadline: '' }),
    task('invalid', { deadline: 'invalid' }),
    task('unassessed', { urgency: null, importance: null, evaluated: false }),
    task('future', { deadline: localDeadline(20) }),
    task('done', { done: true, focused: true }),
  ];
  assert.deepEqual(ids(filterTasks(tasks, { range: 'all' }, now)), ['overdue', 'undated', 'invalid', 'unassessed', 'future']);
  assert.deepEqual(ids(filterTasks(tasks, null, now)), ['overdue', 'undated', 'invalid', 'unassessed', 'future']);
  assert.deepEqual(filterTasks(null), []);
});

test('today means the local calendar day and keeps deadlines that elapsed earlier today', () => {
  const tasks = [
    task('yesterday', { deadline: localDeadline(9, 23, 59) }),
    task('midnight', { deadline: localDeadline(10, 0) }),
    task('elapsed', { deadline: localDeadline(10, 8) }),
    task('tonight', { deadline: localDeadline(10, 23, 59) }),
    task('tomorrow', { deadline: localDeadline(11, 0) }),
    task('undated'),
  ];
  assert.deepEqual(ids(filterTasks(tasks, { range: 'today' }, now)), ['midnight', 'elapsed', 'tonight']);
});

test('week means today through the next six calendar days with an exclusive day-seven boundary', () => {
  const tasks = [
    task('yesterday', { deadline: localDeadline(9, 23, 59) }),
    task('today', { deadline: localDeadline(10, 0) }),
    task('day6', { deadline: localDeadline(16, 23, 59) }),
    task('day7', { deadline: localDeadline(17, 0) }),
    task('undated'),
  ];
  assert.deepEqual(ids(filterTasks(tasks, { range: 'week' }, now)), ['today', 'day6']);
});

test('calendar filters remain correct across a daylight-saving change', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { filterTasks } = require(${JSON.stringify(require.resolve('../renderer/task-map-domain'))});
    const now = new Date(2026, 2, 7, 15).getTime();
    const rows = [
      { id: 'last', deadline: new Date(2026, 2, 13, 23, 59).toISOString() },
      { id: 'next', deadline: new Date(2026, 2, 14, 0).toISOString() }
    ];
    assert.deepEqual(filterTasks(rows, { range: 'week' }, now).map(task => task.id), ['last']);
  `;
  execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/New_York' } });
});

test('focus, date, category and text query intersect without affecting manual priorities', () => {
  const selected = task('a', {
    text: 'Prepare AI 产品方案', category: 'P2', focused: true,
    deadline: localDeadline(10), urgency: 13.25, importance: 88.5,
  });
  const tasks = [
    selected,
    { ...selected, id: 'not-focused', focused: false },
    { ...selected, id: 'other-category', category: 'P1' },
    { ...selected, id: 'future', deadline: localDeadline(20) },
    { ...selected, id: 'other-text', text: '买菜' },
    { ...selected, id: 'done', done: true },
  ];
  const filters = { mode: 'focus', range: 'today', category: 'P2', query: '  ai 产品  ' };
  const before = JSON.stringify({ tasks, filters });
  assert.deepEqual(ids(filterTasks(tasks, filters, now)), ['a']);
  assert.equal(filterTasks(tasks, filters, now)[0], selected);
  assert.equal(selected.urgency, 13.25);
  assert.equal(selected.importance, 88.5);
  assert.equal(JSON.stringify({ tasks, filters }), before);
  assert.deepEqual(ids(filterTasks(tasks, { mode: 'focus' }, now)), ['a', 'other-category', 'future', 'other-text']);
});

test('overlap selection uses pixel distances in both axes and retains stable task order', () => {
  const tasks = [
    task('near-y', { evaluated: true, urgency: 50, importance: 56 }),
    task('far-x', { evaluated: true, urgency: 52, importance: 50 }),
    task('target', { evaluated: true, urgency: 50, importance: 50 }),
    task('same', { evaluated: true, urgency: 50, importance: 50 }),
    task('far-y', { evaluated: true, urgency: 50, importance: 60 }),
    task('unassessed', { evaluated: false, urgency: 50, importance: null }),
  ];
  const before = JSON.stringify(tasks);
  assert.deepEqual(ids(getOverlappingTasks(tasks, 'target', 1000, 200)), ['near-y', 'target', 'same']);
  assert.deepEqual(ids(getOverlappingTasks(tasks, 'target', 200, 1000)), ['far-x', 'target', 'same']);
  assert.deepEqual(ids(getOverlappingTasks(tasks, 'target', 1000, 200, 0)), ['target', 'same']);
  assert.equal(JSON.stringify(tasks), before);
});

test('overlap lookup does not merge transitively or treat missing geometry as a pile of tasks', () => {
  const tasks = [
    task('a', { evaluated: true, urgency: 0, importance: 0 }),
    task('b', { evaluated: true, urgency: 10, importance: 0 }),
    task('c', { evaluated: true, urgency: 20, importance: 0 }),
    task('bad', { evaluated: true, urgency: Infinity, importance: 0 }),
  ];
  assert.deepEqual(ids(getOverlappingTasks(tasks, 'a', 100, 100)), ['a', 'b']);
  assert.deepEqual(getOverlappingTasks(tasks, 'missing', 100, 100), []);
  assert.deepEqual(getOverlappingTasks(tasks, 'bad', 100, 100), []);
  for (const [width, height] of [[0, 100], [100, 0], [-1, 100], [NaN, 100], [100, Infinity]]) {
    assert.deepEqual(getOverlappingTasks(tasks, 'a', width, height), []);
  }
});
