const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { normalizeCredentialInput } = require('../main-services');

// Run the actual IPC handlers with a synthetic vault and fake encryption only.
function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmu-vault-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'vault.json');
  const handlers = new Map();
  const state = { available: true, decryptFailure: false, encryptFailure: false, readFailure: false, copied: [] };
  const context = vm.createContext({
    fs: { ...fs, readFileSync: (...args) => {
      if (state.readFailure && args[0] === file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.readFileSync(...args);
    } }, path, Buffer, process, crypto: require('node:crypto'), normalizeCredentialInput,
    CREDENTIALS_VAULT_FILE: 'vault.json', app: { getPath: () => directory },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    clipboard: { writeText: async (value) => state.copied.push(value) },
    setTimeout: () => ({ unref() {} }),
    safeStorage: {
      isEncryptionAvailable: () => state.available,
      encryptString(value) {
        if (state.encryptFailure) throw new Error('fixture encryption failed');
        return Buffer.from(`fixture:${value}`);
      },
      decryptString(value) {
        if (state.decryptFailure || !value.toString().startsWith('fixture:')) throw new Error('fixture identity changed');
        return value.toString().slice(8);
      },
    },
  });
  const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function getCredentialsVaultPath()'), source.indexOf('// ============ 百炼实时语音转写')), context);
  const writeFixture = (rows) => fs.writeFileSync(file, JSON.stringify({ version: 1, payload: Buffer.from(`fixture:${JSON.stringify(rows)}`).toString('base64') }));
  return { file, state, context, writeFixture, call: (name, payload) => handlers.get(`credentials:${name}`)({}, payload) };
}

const fixtureCredential = { id: 'old', service: 'Fixture service', account: 'fixture-user', password: 'fixture-password', createdAt: 1 };

test('a missing vault remains a valid empty state and normal save/read/delete still work', (t) => {
  const h = harness(t);
  assert.equal(h.call('list').ok, true);
  assert.equal(h.call('list').items.length, 0);
  const saved = h.call('save', fixtureCredential);
  assert.equal(saved.ok, true);
  assert.equal(saved.item.password, undefined);
  assert.equal(h.call('get', saved.item.id).item.password, fixtureCredential.password);
  assert.equal(h.call('delete-many', [saved.item.id]).deleted, 1);
  assert.equal(h.call('list').items.length, 0);
});

test('an old vault that cannot decrypt is never reported empty or overwritten by save/delete', async (t) => {
  const h = harness(t);
  h.writeFixture([fixtureCredential]);
  const original = fs.readFileSync(h.file);
  h.state.decryptFailure = true;
  assert.equal(h.call('list').error, 'vault_unreadable');
  assert.equal(h.call('list').ok, false);
  for (const [method, payload] of [['get', 'old'], ['save', fixtureCredential], ['delete-many', ['old']]]) {
    assert.equal(h.call(method, payload).error, 'vault_unreadable');
    assert.deepEqual(fs.readFileSync(h.file), original);
  }
  assert.equal(await h.call('copy', { id: 'old', field: 'password' }), false);
  assert.equal(h.state.copied.length, 0);
  assert.equal(vm.runInContext('writeCredentialsVault([]).error', h.context), 'vault_unreadable');
  assert.deepEqual(fs.readFileSync(h.file), original);
  h.state.decryptFailure = false;
  assert.equal(h.call('list').ok, true, 'retrying after access is restored recovers the existing vault');
  assert.equal(h.call('list').items[0].id, 'old');
});

test('malformed and unreadable existing vault files are protected rather than treated as empty', (t) => {
  const h = harness(t);
  for (const raw of ['{bad json', '{}', JSON.stringify({ version: 1, payload: Buffer.from('fixture:{}').toString('base64') }), JSON.stringify({ version: 1, payload: Buffer.from('fixture:[{}]').toString('base64') })]) {
    fs.writeFileSync(h.file, raw);
    assert.equal(h.call('save', fixtureCredential).error, 'vault_unreadable');
    assert.equal(fs.readFileSync(h.file, 'utf8'), raw);
  }
  h.writeFixture([fixtureCredential]);
  h.state.readFailure = true;
  assert.equal(h.call('list').error, 'vault_unreadable');
  assert.equal(h.call('delete-many', ['old']).error, 'vault_unreadable');
});

test('unavailable storage or encryption failure leaves the original vault intact', (t) => {
  const h = harness(t);
  h.writeFixture([fixtureCredential]);
  const original = fs.readFileSync(h.file);
  h.state.available = false;
  assert.equal(h.call('list').secureStorage, false);
  assert.equal(h.call('save', fixtureCredential).error, 'secure_storage_unavailable');
  h.state.available = true;
  h.state.encryptFailure = true;
  assert.equal(h.call('save', fixtureCredential).error, 'save_failed');
  assert.deepEqual(fs.readFileSync(h.file), original);
});

test('the credential page distinguishes an unreadable vault and permits a read retry without saving', async () => {
  const { document } = parseHTML(`<html><body>
    <input id="credential-service" value="" /><input id="credential-account" value="" /><input id="credential-password" value="" />
    <input id="credential-search" value="" /><button id="credential-save"></button><button id="credential-bulk-delete"></button>
    <div id="credential-list"></div><span id="credential-count"></span><p id="credentials-note"></p>
  </body></html>`);
  let unreadable = true, saves = 0;
  const context = vm.createContext({
    document, Domain: require('../renderer/domain'),
    window: { notchAPI: {
      listCredentials: async () => unreadable
        ? { ok: false, error: 'vault_unreadable', secureStorage: true, items: [] }
        : { ok: true, secureStorage: true, items: [] },
      saveCredential: async () => { saves++; return { ok: true }; },
    } },
  });
  const source = fs.readFileSync(require.resolve('../renderer/workspace.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('  // ============ 本机加密密钥库'), source.indexOf("  document.addEventListener('notch:clear-selection'")), context);
  await vm.runInContext('loadCredentials()', context);
  assert.match(document.getElementById('credential-list').textContent, /原保险库文件已保留/);
  assert.match(document.getElementById('credential-list').textContent, /旧版恢复/);
  assert.equal(document.getElementById('credential-list').textContent.includes('还没有保存密钥'), false);
  assert.ok(document.getElementById('credential-retry'));
  assert.equal(document.getElementById('credential-save').disabled, true);
  await vm.runInContext('saveCredential()', context);
  assert.equal(saves, 0);
  unreadable = false;
  await vm.runInContext('loadCredentials()', context);
  assert.equal(document.getElementById('credential-save').disabled, false);
  assert.match(document.getElementById('credentials-note').textContent, /恢复读取/);
});
