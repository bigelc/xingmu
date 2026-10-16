const { PROVIDERS, SPEECH_MODEL, TEXT_TASKS, normalizeConnection, connectionIdentity, qwenBaseUrl, modelCapabilities } = require('./ai-providers');
const TASKS = [...TEXT_TASKS, 'speech'];
const emptyAssignments = () => Object.fromEntries(TASKS.map((task) => [task, null]));
const failure = (error) => ({ ok: false, error });
function createAISettingsService({ readSettings, writeSettings, safeStorage, readLegacySettings = () => ({}), env = process.env, client } = {}) {
  let state;
  let migrated = false;
  let discoveryBusy = false;
  function secure() { try { return safeStorage?.isEncryptionAvailable() === true && safeStorage?.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; } }
  function decrypt(value) {
    if (!value || !secure()) return '';
    try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return ''; }
  }
  function keyFor(connection) {
    return connection.envKeyRef ? String(env[connection.envKeyRef] || '').trim() : decrypt(connection.encryptedApiKey);
  }
  function legacyState() {
    const old = readLegacySettings() || {};
    const connections = []; const assignments = emptyAssignments();
    if (old.encryptedLlmApiKey || env.NOTCH_LLM_API_KEY || old.llmModel) {
      const baseUrl = String(old.llmBaseUrl || 'https://api.deepseek.com').trim();
      const preset = PROVIDERS.find((provider) => provider.defaultBaseUrl && baseUrl.replace(/\/$/, '') === provider.defaultBaseUrl);
      try {
        const config = normalizeConnection({ id: 'legacy-text', provider: preset?.id || 'custom', protocol: 'openai', baseUrl });
        const model = String(old.llmModel || 'deepseek-v4-flash').trim();
        connections.push({ ...config, encryptedApiKey: String(old.encryptedLlmApiKey || ''), ...(env.NOTCH_LLM_API_KEY ? { envKeyRef: 'NOTCH_LLM_API_KEY' } : {}), models: [{ id: model, name: model, capabilities: [...TEXT_TASKS], manual: true }] });
        for (const task of TEXT_TASKS) assignments[task] = { connectionId: config.id, model };
      } catch { /* Unsafe legacy endpoints never receive credentials. The original file is preserved. */ }
    }
    if (old.encryptedApiKey || env.DASHSCOPE_API_KEY) {
      const envRegion = String(env.DASHSCOPE_REGION || '').toLowerCase();
      const region = ['beijing', 'singapore'].includes(envRegion) ? envRegion : old.region === 'singapore' ? 'singapore' : 'beijing';
      const workspaceId = String(env.DASHSCOPE_WORKSPACE_ID || env.DASHSCOPE_WORKSPACE || old.workspaceId || '').trim();
      try {
        const config = normalizeConnection({ id: 'legacy-speech', provider: 'qwen', region, workspaceId, baseUrl: qwenBaseUrl(region, workspaceId) });
        connections.push({ ...config, encryptedApiKey: String(old.encryptedApiKey || ''), ...(env.DASHSCOPE_API_KEY ? { envKeyRef: 'DASHSCOPE_API_KEY' } : {}), models: [{ id: SPEECH_MODEL, name: SPEECH_MODEL, capabilities: ['speech'], manual: true }] });
        assignments.speech = { connectionId: config.id, model: SPEECH_MODEL };
      } catch { /* Preserve unreadable legacy data without activating an unsafe destination. */ }
    }
    migrated = connections.length > 0;
    return { version: 1, connections, assignments, disabledTasks: [] };
  }
  function load() {
    if (state) return state;
    const stored = readSettings?.();
    if (stored === null || stored === undefined) state = legacyState();
    else {
      if (stored.version !== 1 || !Array.isArray(stored.connections) || !stored.assignments) throw new Error('settings_unreadable');
      // A saved empty configuration is intentional and must never reactivate legacy/environment keys.
      state = structuredClone(stored);
    }
    return state;
  }
  function publicConnection(connection) {
    const apiKey = keyFor(connection);
    return { ...normalizeConnection(connection), hasApiKey: Boolean(apiKey), needsReentry: Boolean(connection.needsReentry || ((connection.encryptedApiKey || connection.envKeyRef) && !apiKey)), models: structuredClone(connection.models || []) };
  }
  function getSettings() {
    try {
      const current = load();
      return { ok: true, version: 1, providers: structuredClone(PROVIDERS), connections: current.connections.map(publicConnection), assignments: structuredClone(current.assignments), disabledTasks: [...new Set((current.disabledTasks || []).filter((task) => TASKS.includes(task)))], secureStorage: secure(), migrated };
    } catch { return failure('settings_unreadable'); }
  }
  // Main-process only. Never expose this method or its result through IPC.
  function getUsageConnections() {
    try {
      return load().connections.map((stored) => {
        const config = normalizeConnection(stored);
        const apiKey = keyFor(stored);
        return { ...config, apiKey, needsReentry: Boolean(stored.needsReentry || ((stored.encryptedApiKey || stored.envKeyRef) && !apiKey)) };
      });
    } catch { throw new Error('settings_unreadable'); }
  }
  function secretForDraft(draft, previous, config, { encrypt = false } = {}) {
    const same = previous && connectionIdentity(previous) === connectionIdentity(config);
    const provided = draft.apiKey;
    if (provided !== undefined && typeof provided !== 'string') throw new Error('invalid_api_key');
    const apiKey = (provided || '').trim();
    if (apiKey.length > 16384 || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new Error('invalid_api_key');
    if (draft.clearApiKey === true) return { encryptedApiKey: '', apiKey: '', needsReentry: false };
    if (apiKey) {
      if (!encrypt) return { apiKey };
      if (!secure()) throw new Error('secure_storage_unavailable');
      return { encryptedApiKey: safeStorage.encryptString(apiKey).toString('base64'), needsReentry: false };
    }
    if (same) return encrypt
      ? { encryptedApiKey: previous.encryptedApiKey || '', ...(previous.envKeyRef ? { envKeyRef: previous.envKeyRef } : {}), needsReentry: previous.needsReentry === true }
      : { apiKey: keyFor(previous) };
    return { ...(encrypt ? { encryptedApiKey: '' } : { apiKey: '' }), needsReentry: Boolean(previous?.encryptedApiKey || previous?.envKeyRef || previous?.needsReentry) };
  }
  function normalizeModels(config, rows) {
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error('invalid_models');
    const seen = new Set();
    return rows.map((row) => {
      if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 240 || /[\s\u0000-\u001f\u007f]/.test(row.id) || seen.has(row.id)) throw new Error('invalid_models');
      seen.add(row.id);
      const allowed = modelCapabilities(config, row.id);
      const capabilities = row.manual === true ? allowed : allowed.filter((task) => Array.isArray(row.capabilities) && row.capabilities.includes(task));
      return { id: row.id, name: String(row.name || row.id).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240), capabilities, capabilitySource: row.id === SPEECH_MODEL && capabilities.includes('speech') ? 'adapter' : row.capabilitySource === 'metadata' && row.manual !== true ? 'metadata' : 'unverified', ...(row.manual === true ? { manual: true } : {}) };
    });
  }
  function saveSettings(payload) {
    try {
      const previous = load();
      if (!payload || !Array.isArray(payload.connections) || payload.connections.length > 20 || !payload.assignments || typeof payload.assignments !== 'object') return failure('invalid_request');
      const seen = new Set();
      const connections = payload.connections.map((draft) => {
        const config = normalizeConnection(draft);
        if (seen.has(config.id)) throw new Error('invalid_connection');
        seen.add(config.id);
        const old = previous.connections.find((item) => item.id === config.id);
        const secret = secretForDraft(draft, old, config, { encrypt: true });
        delete secret.apiKey;
        return { ...config, ...secret, models: normalizeModels(config, draft.models || []) };
      });
      const assignments = emptyAssignments();
      const disabledTasks = payload.disabledTasks ?? previous.disabledTasks ?? [];
      if (!Array.isArray(disabledTasks) || disabledTasks.some((task) => !TASKS.includes(task))) throw new Error('invalid_assignment');
      for (const task of TASKS) {
        const selected = payload.assignments[task];
        if (selected === null) continue;
        if (disabledTasks.includes(task)) throw new Error('invalid_assignment');
        if (!selected || typeof selected.connectionId !== 'string' || typeof selected.model !== 'string') throw new Error('invalid_assignment');
        const connection = connections.find((item) => item.id === selected.connectionId);
        const model = connection?.models.find((item) => item.id === selected.model);
        if (!model?.capabilities.includes(task)) throw new Error('unsupported_task');
        if (connection.provider !== 'ollama' && !keyFor(connection)) throw new Error('not_configured');
        assignments[task] = { connectionId: connection.id, model: model.id };
      }
      const next = { version: 1, connections, assignments, disabledTasks: [...new Set(disabledTasks)] };
      try { writeSettings(next); } catch { return failure('save_failed'); }
      state = next; migrated = false;
      return getSettings();
    } catch (error) {
      const known = ['settings_unreadable', 'invalid_connection', 'invalid_provider', 'invalid_protocol', 'invalid_region', 'invalid_workspace', 'unsafe_endpoint', 'invalid_api_key', 'secure_storage_unavailable', 'invalid_models', 'invalid_assignment', 'unsupported_task', 'not_configured'];
      return failure(known.includes(error?.message) ? error.message : 'save_failed');
    }
  }
  async function discoverModels(payload) {
    if (discoveryBusy) return failure('busy');
    try {
      const current = load();
      const config = normalizeConnection(payload?.connection);
      const old = current.connections.find((item) => item.id === config.id);
      const { apiKey } = secretForDraft(payload.connection, old, config);
      if (!apiKey && config.provider !== 'ollama') return failure('not_configured');
      discoveryBusy = true;
      return await client.discoverModels({ ...config, apiKey });
    } catch (error) { return failure(['invalid_provider', 'invalid_connection', 'invalid_protocol', 'invalid_region', 'invalid_workspace', 'unsafe_endpoint', 'invalid_api_key', 'settings_unreadable'].includes(error?.message) ? error.message : 'network'); }
    finally { discoveryBusy = false; }
  }
  function resolveTask(task) {
    try {
      if (!TASKS.includes(task)) return null;
      const current = load(); const selected = current.assignments[task];
      if (current.disabledTasks?.includes(task)) return null;
      if (!selected) return null;
      const stored = current.connections.find((item) => item.id === selected.connectionId);
      if (!stored) return null;
      const config = normalizeConnection(stored);
      const model = stored.models?.find((item) => item.id === selected.model);
      if (!model?.capabilities.includes(task) || !modelCapabilities(config, model.id).includes(task)) return null;
      const apiKey = keyFor(stored);
      if ((!apiKey && config.provider !== 'ollama') || /[\u0000-\u001f\u007f]/.test(apiKey)) return null;
      return { ...config, model: model.id, apiKey };
    } catch { return null; }
  }
  return { getSettings, saveSettings, discoverModels, resolveTask, getUsageConnections };
}
module.exports = { createAISettingsService };
