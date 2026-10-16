const test = require('node:test');
const assert = require('node:assert/strict');
const { createAISettingsService } = require('../ai-settings');
const { SPEECH_MODEL, qwenBaseUrl } = require('../ai-providers');

const off = () => ({ translation: null, naming: null, speech: null });
const cipher = (key) => Buffer.from(`test-cipher:${key}`).toString('base64');
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (key) => Buffer.from(`test-cipher:${key}`),
  decryptString: (value) => { const text = value.toString(); if (!text.startsWith('test-cipher:')) throw Error('unreadable'); return text.slice(12); },
};
const textConnection = (extra = {}) => ({ id: 'text', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'openai', apiKey: 'test-only-key', models: [{ id: 'deepseek-chat', capabilities: ['translation', 'naming'], manual: true }], ...extra });
const selection = (connectionId = 'text', model = 'deepseek-chat') => ({ connectionId, model });
function harness(options = {}) {
  let stored = options.stored ?? null;
  const writes = [], calls = [];
  const service = createAISettingsService({
    readSettings: () => stored,
    writeSettings: (next) => { if (options.failWrite) throw Error('disk'); stored = structuredClone(next); writes.push(stored); },
    safeStorage: options.safeStorage || safeStorage,
    readLegacySettings: () => options.legacy || {}, env: options.env || {},
    client: options.client || { discoverModels: async (config) => { calls.push(config); return { ok: true, models: [] }; } },
  });
  return { service, writes, calls, stored: () => stored };
}

test('legacy ASR and text keys migrate independently without writing or exposing secrets', () => {
  const h = harness({ legacy: { encryptedApiKey: cipher('speech-secret'), encryptedLlmApiKey: cipher('text-secret'), llmModel: 'deepseek-chat', region: 'singapore', workspaceId: 'team' } });
  const value = h.service.getSettings();
  assert.equal(value.migrated, true); assert.equal(h.writes.length, 0);
  assert.equal(h.service.resolveTask('translation').apiKey, 'text-secret');
  assert.equal(h.service.resolveTask('naming').apiKey, 'text-secret');
  assert.equal(h.service.resolveTask('speech').apiKey, 'speech-secret');
  assert.equal(h.service.resolveTask('speech').baseUrl, qwenBaseUrl('singapore', 'team'));
  assert.doesNotMatch(JSON.stringify(value), /text-secret|speech-secret|encryptedApiKey|envKeyRef/);
  assert.equal(h.service.saveSettings({ connections: value.connections, assignments: value.assignments }).ok, true);
  assert.equal(h.service.getSettings().migrated, false);
});

test('saved disabled tasks never fall back to legacy or environment credentials after restart', () => {
  const h = harness({ env: { NOTCH_LLM_API_KEY: 'env-text', DASHSCOPE_API_KEY: 'env-asr' } });
  assert.equal(h.service.resolveTask('translation').apiKey, 'env-text');
  assert.equal(h.service.saveSettings({ connections: [], assignments: off() }).ok, true);
  const restarted = harness({ stored: h.stored(), env: { NOTCH_LLM_API_KEY: 'env-text', DASHSCOPE_API_KEY: 'env-asr' }, legacy: { encryptedApiKey: cipher('old') } });
  for (const task of Object.keys(off())) assert.equal(restarted.service.resolveTask(task), null);
  assert.equal(restarted.service.getSettings().migrated, false);
});

test('manual models save untested while tasks route independently and secrets remain encrypted', () => {
  const h = harness();
  const qwen = { id: 'speech', provider: 'qwen', apiKey: 'speech-only-key', models: [{ id: SPEECH_MODEL, capabilities: ['speech'], manual: true }] };
  const value = h.service.saveSettings({ connections: [textConnection(), qwen], assignments: { translation: selection(), naming: null, speech: selection('speech', SPEECH_MODEL) } });
  assert.equal(value.ok, true);
  assert.equal(value.connections[0].models[0].manual, true);
  assert.equal(value.connections[0].models[0].capabilitySource, 'unverified');
  assert.equal(h.service.resolveTask('translation').apiKey, 'test-only-key');
  assert.equal(h.service.resolveTask('naming'), null);
  assert.equal(h.service.resolveTask('speech').apiKey, 'speech-only-key');
  assert.doesNotMatch(JSON.stringify(value), /test-only-key|speech-only-key|encryptedApiKey/);
  assert.doesNotMatch(JSON.stringify(h.stored()), /test-only-key|speech-only-key|"apiKey"/);
  const publicDraft = value.connections[0];
  assert.equal(h.service.saveSettings({ connections: [publicDraft], assignments: { ...off(), translation: selection() } }).ok, true, 'An unchanged connection reuses its encrypted credential');
});

test('any connection identity change cannot reuse its old credential', async () => {
  const changes = [
    { provider: 'openai' }, { baseUrl: 'https://other.example/v1' },
    { provider: 'custom', protocol: 'anthropic' }, { region: 'singapore' }, { workspaceId: 'other-team' },
  ];
  for (const change of changes) {
    const qwen = { id: 'text', provider: 'qwen', apiKey: 'old-secret', models: [{ id: 'qwen-plus', capabilities: ['translation'], manual: true }] };
    const h = harness();
    const first = h.service.saveSettings({ connections: [qwen], assignments: { ...off(), translation: selection('text', 'qwen-plus') } });
    const draft = { ...first.connections[0], ...change };
    const discovered = await h.service.discoverModels({ connection: draft });
    assert.equal(discovered.error, 'not_configured', JSON.stringify(change));
    assert.equal(h.calls.length, 0);
    assert.equal(h.service.saveSettings({ connections: [draft], assignments: first.assignments }).error, 'not_configured');
    assert.equal(h.writes.length, 1, 'Rejected edits leave the saved configuration intact');
    assert.equal(h.service.resolveTask('translation').apiKey, 'old-secret');
  }
});

test('clearing a key requires disabling its tasks and keeps the key cleared', () => {
  const h = harness();
  const first = h.service.saveSettings({ connections: [textConnection()], assignments: { ...off(), translation: selection() } });
  const draft = { ...first.connections[0], clearApiKey: true };
  assert.equal(h.service.saveSettings({ connections: [draft], assignments: first.assignments }).error, 'not_configured');
  const result = h.service.saveSettings({ connections: [draft], assignments: off() });
  assert.equal(result.ok, true); assert.equal(result.connections[0].hasApiKey, false);
  assert.equal(h.service.resolveTask('translation'), null);
});

test('explicitly disabled tasks survive reload and cannot carry a conflicting model assignment', () => {
  const h = harness();
  const value = h.service.saveSettings({ connections: [textConnection()], assignments: { ...off(), translation: selection() }, disabledTasks: ['naming', 'speech', 'naming'] });
  assert.equal(value.ok, true);
  assert.deepEqual(value.disabledTasks, ['naming', 'speech']);
  const restarted = harness({ stored: h.stored() });
  assert.deepEqual(restarted.service.getSettings().disabledTasks, ['naming', 'speech']);
  assert.equal(restarted.service.resolveTask('naming'), null);
  assert.equal(restarted.service.saveSettings({ connections: value.connections, assignments: { ...value.assignments, naming: selection() }, disabledTasks: value.disabledTasks }).error, 'invalid_assignment');
  assert.equal(restarted.writes.length, 0);
  assert.equal(restarted.service.saveSettings({ connections: value.connections, assignments: value.assignments }).ok, true);
  assert.deepEqual(restarted.service.getSettings().disabledTasks, ['naming', 'speech'], 'Older clients cannot implicitly clear explicit off choices');
});

test('unavailable or unreadable secure storage never falls back to plain text', () => {
  for (const storage of [{ ...safeStorage, isEncryptionAvailable: () => false }, { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }]) {
    const h = harness({ safeStorage: storage, legacy: { encryptedLlmApiKey: cipher('legacy-secret') } });
    assert.equal(h.service.getSettings().connections[0].needsReentry, true);
    assert.equal(h.service.resolveTask('translation'), null);
    assert.equal(h.service.saveSettings({ connections: [textConnection()], assignments: off() }).error, 'secure_storage_unavailable');
    assert.equal(h.writes.length, 0);
  }
  const h = harness({ legacy: { encryptedApiKey: 'corrupt' } });
  assert.equal(h.service.getSettings().connections[0].needsReentry, true);
  assert.equal(h.service.resolveTask('speech'), null);
});

test('ASR routing accepts only the supported Qwen endpoint and rejects text or image models', () => {
  const h = harness();
  for (const connection of [
    textConnection({ models: [{ id: SPEECH_MODEL, manual: true }] }),
    { id: 'text', provider: 'qwen', baseUrl: 'https://proxy.example/v1', apiKey: 'test', models: [{ id: SPEECH_MODEL, manual: true }] },
    textConnection(),
  ]) {
    const model = connection.models[0].id;
    assert.equal(h.service.saveSettings({ connections: [connection], assignments: { ...off(), speech: selection('text', model) } }).error, 'unsupported_task');
  }
  for (const id of ['gpt-image-1', 'seedream-4', 'cogview-4', 'music-generation', 'text-embedding-3-small']) {
    assert.equal(h.service.saveSettings({ connections: [textConnection({ models: [{ id, manual: true }] })], assignments: { ...off(), translation: selection('text', id) } }).error, 'unsupported_task');
  }
  assert.equal(h.writes.length, 0);
});

test('model discovery is temporary, rejects missing credentials and serializes pending calls', async () => {
  let finish;
  const received = [];
  const h = harness({ client: { discoverModels: (config) => { received.push(config); return new Promise(resolve => { finish = resolve; }); } } });
  assert.equal((await h.service.discoverModels({ connection: textConnection({ apiKey: undefined }) })).error, 'not_configured');
  const first = h.service.discoverModels({ connection: textConnection() });
  assert.equal((await h.service.discoverModels({ connection: textConnection() })).error, 'busy');
  finish({ ok: false, error: 'auth' });
  assert.equal((await first).error, 'auth');
  assert.equal(received.length, 1); assert.equal(h.writes.length, 0);
  assert.deepEqual(h.service.getSettings().connections, []);
});

test('malformed saved state and failed writes preserve task state rather than silently remigrating', () => {
  const corrupt = harness({ stored: { version: 99 }, env: { NOTCH_LLM_API_KEY: 'env-secret' } });
  assert.equal(corrupt.service.getSettings().error, 'settings_unreadable');
  assert.equal(corrupt.service.resolveTask('translation'), null);
  const h = harness({ failWrite: true });
  assert.equal(h.service.saveSettings({ connections: [textConnection()], assignments: { ...off(), translation: selection() } }).error, 'save_failed');
  assert.equal(h.service.resolveTask('translation'), null);
  assert.deepEqual(h.service.getSettings().connections, []);
});

test('usage can inspect saved connections privately without exposing keys or sharing mutable settings', () => {
  const h = harness();
  const saved = h.service.saveSettings({ connections: [textConnection()], assignments: off() });
  assert.equal(saved.ok, true);
  const connections = h.service.getUsageConnections();
  assert.equal(connections.length, 1, 'An unassigned connection can still expose its supported account balance');
  assert.equal(connections[0].apiKey, 'test-only-key');
  assert.equal(connections[0].needsReentry, false);
  assert.equal(connections[0].models, undefined);
  assert.equal(connections[0].encryptedApiKey, undefined);
  connections[0].baseUrl = 'https://changed.example';
  connections[0].apiKey = 'mutated-secret';
  assert.equal(h.service.getUsageConnections()[0].baseUrl, 'https://api.deepseek.com');
  assert.equal(h.service.getUsageConnections()[0].apiKey, 'test-only-key');
  assert.doesNotMatch(JSON.stringify(h.service.getSettings()), /test-only-key|mutated-secret|encryptedApiKey|"apiKey"/);
  const unreadable = harness({ legacy: { encryptedApiKey: 'corrupt' } });
  assert.equal(unreadable.service.getUsageConnections()[0].apiKey, '');
  assert.equal(unreadable.service.getUsageConnections()[0].needsReentry, true);
  const corrupt = harness({ stored: { version: 99 } });
  assert.throws(() => corrupt.service.getUsageConnections(), /settings_unreadable/);
});
