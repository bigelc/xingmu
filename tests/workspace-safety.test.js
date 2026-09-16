const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createWorkspaceStore } = require('../main-services');

test('production preload keeps queued saves bound to the original document revision', async () => {
  let api;
  let state = { path: '/source', revision: 'source-revision', localStorage: { notes: 'source' } };
  const listeners = new Map();
  const requests = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { api = value; } },
    ipcRenderer: {
      on: (name, handler) => listeners.set(name, handler),
      removeListener: () => {},
      send: (name, payload) => requests.push({ name, payload }),
      invoke: async (name, payload) => {
        requests.push({ name, payload });
        return name === 'workspace:load-state' ? state : true;
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), { require: () => electron });
  await api.loadWorkspaceState();
  api.onWorkspaceChanged(() => {});
  state = { path: '/target', revision: 'target-revision', localStorage: { notes: 'target' } };
  listeners.get('workspace:changed')({}, state);
  await api.acknowledgeWorkspaceHydration(state.revision);
  await api.saveWorkspaceData({ notes: 'queued source snapshot' });
  const saved = requests.find((request) => request.name === 'workspace:save-data');
  assert.equal(saved.payload.revision, 'source-revision', 'a switch event and target hydration ack must not renew the old document lease');
});

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-workspace-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  let active = source;
  let pending = false;
  const dependencies = {
    fs: options.fs || fs,
    getRoot: () => active,
    getHydrationRequired: () => pending,
    setRoot: (next, requiresHydration) => {
      if (options.failSettings) return false;
      active = next;
      pending = requiresHydration;
      return true;
    },
    assetNames: ['recordings', 'clipboard-images', 'mirror-cover.jpg'],
  };
  const store = createWorkspaceStore(dependencies);
  const write = (folder, localStorage) => fs.writeFileSync(path.join(folder, 'workspace.json'), JSON.stringify({ version: 1, localStorage }));
  const read = (folder) => JSON.parse(fs.readFileSync(path.join(folder, 'workspace.json'), 'utf8')).localStorage;
  const backups = (folder) => fs.readdirSync(path.join(folder, 'workspace-backups')).map((file) => JSON.parse(fs.readFileSync(path.join(folder, 'workspace-backups', file))).localStorage);
  return { root, source, target, store, dependencies, write, read, backups, active: () => active };
}

test('opening an existing workspace preserves its snapshot, saves current edits and blocks stale timers', (t) => {
  const f = fixture(t);
  f.write(f.source, { notes: 'previous source' });
  f.write(f.target, { notes: 'target notes', onlyTarget: 'keep' });
  const before = fs.readFileSync(path.join(f.target, 'workspace.json'), 'utf8');
  const oldRevision = f.store.load().revision;
  f.store.setSwitching(true);
  assert.equal(f.store.save({ notes: 'queued edit' }, oldRevision), false);
  const changed = f.store.switchTo(f.target, { notes: 'latest source' }, oldRevision, f.store.inspect(f.target, true));
  f.store.setSwitching(false);
  assert.equal(changed.ok, true);
  assert.equal(changed.action, 'open');
  assert.equal(fs.readFileSync(path.join(f.target, 'workspace.json'), 'utf8'), before);
  assert.deepEqual(f.read(f.source), { notes: 'latest source' });
  assert.deepEqual(f.backups(f.source), [{ notes: 'previous source' }]);
  assert.deepEqual(f.backups(f.target), [{ notes: 'target notes', onlyTarget: 'keep' }]);
  assert.equal(f.store.save({ notes: 'stale source timer' }, oldRevision), false);
  assert.equal(f.store.save({ notes: 'unhydrated renderer' }, changed.revision), false);
  assert.equal(f.store.acknowledgeHydration(oldRevision), false);
  assert.equal(f.store.acknowledgeHydration(changed.revision), true);
  assert.equal(f.store.save({ notes: 'stale after ack' }, oldRevision), false);
  assert.equal(f.store.save({ notes: 'edited target' }, changed.revision), true);
  assert.deepEqual(f.read(f.target), { notes: 'edited target' });
});

test('a crash before hydration keeps the selected snapshot protected after restart', (t) => {
  const f = fixture(t);
  f.write(f.target, { target: 'recover me' });
  const changed = f.store.switchTo(f.target, { source: 'old browser state' }, f.store.load().revision);
  assert.equal(changed.ok, true);
  const restarted = createWorkspaceStore(f.dependencies);
  const state = restarted.load();
  assert.equal(state.requiresHydration, true);
  assert.deepEqual(state.localStorage, { target: 'recover me' });
  assert.equal(restarted.save({ source: 'old browser state' }, state.revision), false);
  assert.equal(restarted.acknowledgeHydration(state.revision), true);
  assert.equal(restarted.save({ target: 'restored browser state' }, state.revision), true);
});

test('migration into an empty folder copies latest data and attachments without removing the original', (t) => {
  const f = fixture(t);
  f.write(f.source, { notes: 'old' });
  fs.mkdirSync(path.join(f.source, 'recordings'));
  fs.writeFileSync(path.join(f.source, 'recordings', 'sample.webm'), 'synthetic audio');
  fs.writeFileSync(path.join(f.source, 'mirror-cover.jpg'), 'synthetic cover');
  const snapshot = { notes: 'latest', 'notch-recordings': '[{"audioPath":"recordings/sample.webm"}]' };
  const changed = f.store.switchTo(f.target, snapshot, f.store.load().revision);
  assert.equal(changed.ok, true);
  assert.equal(changed.action, 'migrate');
  assert.deepEqual(f.read(f.source), snapshot);
  assert.deepEqual(f.read(f.target), snapshot);
  for (const folder of [f.source, f.target]) {
    assert.equal(fs.readFileSync(path.join(folder, 'recordings', 'sample.webm'), 'utf8'), 'synthetic audio');
    assert.equal(fs.readFileSync(path.join(folder, 'mirror-cover.jpg'), 'utf8'), 'synthetic cover');
  }
});

test('invalid snapshots and occupied non-workspace directories are never overwritten', (t) => {
  const f = fixture(t);
  const targetFile = path.join(f.target, 'workspace.json');
  for (const invalid of ['{broken', '{"version":2,"localStorage":{}}', '{"version":1,"localStorage":{"notes":42}}']) {
    fs.writeFileSync(targetFile, invalid);
    const result = f.store.switchTo(f.target, { notes: 'source' }, f.store.load().revision);
    assert.equal(result.ok, false);
    assert.equal(f.active(), f.source);
    assert.equal(fs.readFileSync(targetFile, 'utf8'), invalid);
  }
  fs.unlinkSync(targetFile);
  fs.writeFileSync(path.join(f.target, 'personal.txt'), 'unrelated data');
  assert.equal(f.store.switchTo(f.target, { notes: 'source' }, f.store.load().revision).error, 'directory_not_empty');
  assert.equal(fs.existsSync(targetFile), false);
  f.write(f.source, { notes: 'healthy source' });
  fs.writeFileSync(path.join(f.source, 'workspace.json'), '{invalid source');
  assert.equal(f.store.save({ notes: 'would destroy evidence' }, f.store.load().revision), false);
});

test('a target edited while the confirmation is open aborts before migration', (t) => {
  const f = fixture(t);
  f.write(f.target, { notes: 'version one' });
  const selected = f.store.inspect(f.target, true);
  f.write(f.target, { notes: 'version two' });
  assert.equal(f.store.switchTo(f.target, { notes: 'source' }, f.store.load().revision, selected).error, 'target_changed');
  assert.equal(f.active(), f.source);
  assert.deepEqual(f.read(f.target), { notes: 'version two' });
});

test('failed source saves and failed settings commits never change the active workspace', (t) => {
  const failedFs = Object.create(fs);
  failedFs.renameSync = () => { throw new Error('simulated disk full'); };
  const saveFailure = fixture(t, { fs: failedFs });
  saveFailure.write(saveFailure.source, { notes: 'disk original' });
  const failed = saveFailure.store.switchTo(saveFailure.target, { notes: 'unsaved latest' }, saveFailure.store.load().revision);
  assert.equal(failed.error, 'save_failed');
  assert.equal(saveFailure.active(), saveFailure.source);
  assert.deepEqual(saveFailure.read(saveFailure.source), { notes: 'disk original' });
  assert.deepEqual(fs.readdirSync(saveFailure.target), []);

  const settingsFailure = fixture(t, { failSettings: true });
  fs.mkdirSync(path.join(settingsFailure.source, 'recordings'));
  fs.writeFileSync(path.join(settingsFailure.source, 'recordings', 'sample.webm'), 'audio');
  assert.equal(settingsFailure.store.switchTo(settingsFailure.target, { notes: 'latest' }, settingsFailure.store.load().revision).error, 'settings_failed');
  assert.equal(settingsFailure.active(), settingsFailure.source);
  assert.deepEqual(settingsFailure.read(settingsFailure.source), { notes: 'latest' });
  assert.deepEqual(fs.readdirSync(settingsFailure.target), [], 'failed migration removes only its newly created output');
});

test('attachment copy failures stop migration and keep every source attachment', (t) => {
  const failedFs = Object.create(fs);
  failedFs.cpSync = (from, to) => { fs.mkdirSync(to); throw new Error('simulated copy failure'); };
  const f = fixture(t, { fs: failedFs });
  fs.mkdirSync(path.join(f.source, 'recordings'));
  fs.writeFileSync(path.join(f.source, 'recordings', 'sample.webm'), 'audio');
  const result = f.store.switchTo(f.target, { notes: 'latest' }, f.store.load().revision);
  assert.equal(result.ok, false);
  assert.equal(f.active(), f.source);
  assert.deepEqual(fs.readdirSync(f.target), []);
  assert.equal(fs.readFileSync(path.join(f.source, 'recordings', 'sample.webm'), 'utf8'), 'audio');
});
