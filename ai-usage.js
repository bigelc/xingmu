const { createHash } = require('node:crypto');
const { PROVIDERS, connectionIdentity } = require('./ai-providers');
const { createPublicHttpsValidator } = require('./news-network');

const AI_USAGE_LIMITS = Object.freeze({ balanceTimeoutMs: 10000, balanceBytes: 64 * 1024, balanceIntervalMs: 60000, days: 365, modelsPerDay: 50, connections: 20 });
const METRICS = ['inputTokens', 'outputTokens', 'totalTokens', 'requests', 'unreportedRequests'];
const emptyMetric = () => Object.fromEntries(METRICS.map((key) => [key, 0]));
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validModel = (value) => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\s\u0000-\u001f\u007f]/.test(value);
const validProvider = (value) => PROVIDERS.some((provider) => provider.id === value);
const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && dayKey(new Date(`${value}T12:00:00`)) === value;
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function readMetric(value) {
  if (!value || !METRICS.every((key) => validCount(value[key])) || value.unreportedRequests > value.requests || !validCount(value.inputTokens + value.outputTokens) || value.totalTokens < value.inputTokens + value.outputTokens) throw new Error('store_unreadable');
  return Object.fromEntries(METRICS.map((key) => [key, value[key]]));
}
function sumMetric(target, source) {
  const next = Object.fromEntries(METRICS.map((key) => [key, target[key] + source[key]]));
  if (!METRICS.every((key) => validCount(next[key]))) throw new Error('stats_limit_reached');
  return next;
}
function officialBalanceEndpoint(config) {
  try {
    const url = new URL(config.baseUrl);
    if (config.protocol !== 'openai' || url.username || url.password || url.search || url.hash || url.protocol !== 'https:') return null;
    const path = url.pathname.replace(/\/+$/, '');
    if (config.provider === 'deepseek' && url.origin === 'https://api.deepseek.com' && ['', '/v1'].includes(path)) return 'https://api.deepseek.com/user/balance';
    if (config.provider === 'moonshot' && url.origin === 'https://api.moonshot.cn' && path === '/v1') return 'https://api.moonshot.cn/v1/users/me/balance';
  } catch {}
  return null;
}
function parseBalance(provider, body) {
  const amount = (value) => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))) throw new Error('invalid_response');
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) > 1e12) throw new Error('invalid_response');
    return number;
  };
  if (provider === 'deepseek') {
    if (typeof body?.is_available !== 'boolean' || !Array.isArray(body.balance_infos)) throw new Error('invalid_response');
    const row = body.balance_infos.find((item) => item?.currency === 'CNY') || body.balance_infos.find((item) => item?.currency === 'USD');
    if (!row) throw new Error('invalid_response');
    return { amount: amount(row.total_balance), currency: row.currency };
  }
  if (provider === 'moonshot' && body?.code === 0 && body.status === true) return { amount: amount(body.data?.available_balance), currency: 'CNY' };
  throw new Error('invalid_response');
}
function createAIUsageService({ readStore = () => null, writeStore = () => {}, getConnections = () => [], fetchImpl = globalThis.fetch, validateUrl = createPublicHttpsValidator(), now = Date.now, limits: overrides = {} } = {}) {
  const limits = { ...AI_USAGE_LIMITS, balanceTimeoutMs: Number.isInteger(overrides.balanceTimeoutMs) && overrides.balanceTimeoutMs > 0 ? Math.min(overrides.balanceTimeoutMs, AI_USAGE_LIMITS.balanceTimeoutMs) : AI_USAGE_LIMITS.balanceTimeoutMs };
  let store, storageError, readBlocked = false;
  const balances = new Map();
  const timestamp = () => new Date(now()).toISOString();
  function prune() {
    const today = new Date(now()); const earliest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (limits.days - 1));
    store.days = store.days.filter((day) => day.date >= dayKey(earliest)).sort((a, b) => a.date.localeCompare(b.date)).slice(-limits.days);
  }
  function load() {
    if (store) return;
    const initial = { version: 1, startedAt: timestamp(), updatedAt: null, days: [] };
    try {
      const saved = readStore();
      if (saved == null) { store = initial; return; }
      if (saved.version !== 1 || !validTime(saved.startedAt) || (saved.updatedAt !== null && !validTime(saved.updatedAt)) || !Array.isArray(saved.days) || saved.days.length > limits.days) throw new Error('store_unreadable');
      const dates = new Set();
      const days = saved.days.map((day) => {
        if (!validDate(day?.date) || dates.has(day.date) || !Array.isArray(day.models) || day.models.length > limits.modelsPerDay || typeof day.modelsTruncated !== 'boolean') throw new Error('store_unreadable');
        dates.add(day.date);
        const models = new Set();
        const rows = day.models.map((row) => {
          const key = JSON.stringify([row?.provider, row?.model]);
          if (!validProvider(row?.provider) || !validModel(row?.model) || models.has(key)) throw new Error('store_unreadable');
          models.add(key);
          return { provider: row.provider, model: row.model, ...readMetric(row) };
        });
        const totals = readMetric(day.totals);
        const detailed = rows.reduce((sum, row) => sumMetric(sum, row), emptyMetric());
        if (METRICS.some((key) => detailed[key] > totals[key] || (!day.modelsTruncated && detailed[key] !== totals[key]))) throw new Error('store_unreadable');
        return { date: day.date, totals, models: rows, modelsTruncated: day.modelsTruncated };
      });
      store = { version: 1, startedAt: saved.startedAt, updatedAt: saved.updatedAt, days };
      prune();
    } catch { store = initial; storageError = 'store_unreadable'; readBlocked = true; }
  }
  function recordUsage(event) {
    load();
    if (!validProvider(event?.provider) || !validModel(event?.model)) return false;
    const usage = event.usage;
    const reported = usage && ['inputTokens', 'outputTokens', 'totalTokens'].every((key) => validCount(usage[key])) && validCount(usage.inputTokens + usage.outputTokens) && usage.totalTokens >= usage.inputTokens + usage.outputTokens;
    const delta = { inputTokens: reported ? usage.inputTokens : 0, outputTokens: reported ? usage.outputTokens : 0, totalTokens: reported ? usage.totalTokens : 0, requests: 1, unreportedRequests: reported ? 0 : 1 };
    try {
      prune();
      const date = dayKey(new Date(now()));
      let day = store.days.find((row) => row.date === date);
      if (!day) { day = { date, totals: emptyMetric(), models: [], modelsTruncated: false }; store.days.push(day); }
      const totals = sumMetric(day.totals, delta);
      let model = day.models.find((row) => row.provider === event.provider && row.model === event.model);
      const modelTotals = sumMetric(model || emptyMetric(), delta);
      day.totals = totals;
      if (model) Object.assign(model, modelTotals);
      else if (day.models.length < limits.modelsPerDay) day.models.push({ provider: event.provider, model: event.model, ...modelTotals });
      else day.modelsTruncated = true;
      store.updatedAt = timestamp(); prune();
      if (!readBlocked) {
        try { writeStore(structuredClone(store)); storageError = undefined; }
        catch { storageError = 'save_failed'; }
      }
      return true;
    } catch { storageError = 'stats_limit_reached'; return false; }
  }
  function connectionRows() {
    const rows = getConnections();
    if (!Array.isArray(rows) || rows.length > limits.connections) throw new Error('settings_unreadable');
    const ids = new Set();
    return rows.map((row) => {
      if (!row || !/^[A-Za-z0-9_-]{1,80}$/.test(row.id) || ids.has(row.id) || !validProvider(row.provider)) throw new Error('settings_unreadable');
      ids.add(row.id);
      const fingerprint = createHash('sha256').update(JSON.stringify([row.id, connectionIdentity(row), String(row.apiKey || ''), row.needsReentry === true])).digest('hex');
      return { config: row, fingerprint };
    });
  }
  function syncConnections(rows) {
    const active = new Set(rows.map((row) => row.fingerprint));
    for (const [key, entry] of balances) {
      if (!active.has(key)) { entry.controller?.abort(); balances.delete(key); }
    }
  }
  function invalidateConnections() {
    try { syncConnections(connectionRows()); }
    catch { for (const entry of balances.values()) entry.controller?.abort(); balances.clear(); }
  }
  async function fetchBalance(config, endpoint, entry) {
    const controller = new AbortController(); entry.controller = controller;
    const timer = setTimeout(() => controller.abort(), limits.balanceTimeoutMs);
    let reader;
    const bounded = (work) => new Promise((resolve, reject) => {
      if (controller.signal.aborted) return reject(new Error('timeout'));
      const aborted = () => reject(new Error('timeout'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(work).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
    });
    try {
      if (!await bounded(() => validateUrl(endpoint))) throw new Error('unsafe_endpoint');
      const response = await bounded(() => fetchImpl(endpoint, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}` }, credentials: 'omit', redirect: 'error', signal: controller.signal }));
      if (response.redirected || (response.url && response.url !== endpoint) || (response.status >= 300 && response.status < 400)) { void response.body?.cancel?.().catch(() => {}); throw new Error('unsafe_endpoint'); }
      if (!response.ok) { void response.body?.cancel?.().catch(() => {}); throw new Error([401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate_limited' : 'network'); }
      if (Number(response.headers?.get?.('content-length')) > limits.balanceBytes) { void response.body?.cancel?.().catch(() => {}); throw new Error('response_too_large'); }
      if (!response.body?.getReader) throw new Error('invalid_response');
      reader = response.body.getReader();
      let bytes = 0; const chunks = [];
      while (true) {
        const chunk = await bounded(() => reader.read());
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > limits.balanceBytes) throw new Error('response_too_large');
        chunks.push(Buffer.from(chunk.value));
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { throw new Error('invalid_response'); }
      entry.value = { ...parseBalance(config.provider, body), updatedAt: timestamp() };
      entry.error = undefined;
    } catch (error) {
      entry.error = controller.signal.aborted ? 'timeout' : ['unsafe_endpoint', 'auth', 'rate_limited', 'response_too_large', 'invalid_response'].includes(error?.message) ? error.message : 'network';
    } finally {
      clearTimeout(timer);
      if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
      controller.abort(); entry.controller = null;
    }
  }
  async function balanceFor({ config, fingerprint }, refresh) {
    const endpoint = officialBalanceEndpoint(config);
    if (!endpoint) return { status: 'unsupported' };
    if (!config.apiKey || typeof config.apiKey !== 'string' || config.apiKey.length > 16384 || config.needsReentry || /[\u0000-\u001f\u007f]/.test(config.apiKey)) return { status: 'not_configured' };
    let entry = balances.get(fingerprint);
    if (!entry) { entry = { attemptAt: null, value: null, error: null, pending: null }; balances.set(fingerprint, entry); }
    if (refresh) {
      if (!entry.pending && (entry.attemptAt === null || now() - entry.attemptAt >= limits.balanceIntervalMs)) {
        entry.attemptAt = now();
        entry.pending = fetchBalance(config, endpoint, entry).finally(() => { entry.pending = null; });
      }
      if (entry.pending) await entry.pending;
    }
    if (entry.error) return { status: 'error', ...(entry.value || {}), ...(entry.value ? { stale: true } : {}), error: entry.error };
    if (entry.value) return { status: 'ready', ...entry.value, stale: now() - Date.parse(entry.value.updatedAt) >= limits.balanceIntervalMs };
    return { status: 'error', error: 'not_loaded' };
  }
  async function getSnapshot({ refresh = false } = {}) {
    load(); prune();
    let rows;
    try { rows = connectionRows(); syncConnections(rows); }
    catch { invalidateConnections(); return { ok: false, error: 'settings_unreadable' }; }
    await Promise.all(rows.map((row) => balanceFor(row, refresh === true)));
    // Configuration may have changed while requests were in flight. Never return
    // a stale credential identity's result after an edit/removal.
    try { rows = connectionRows(); syncConnections(rows); }
    catch { invalidateConnections(); return { ok: false, error: 'settings_unreadable' }; }
    const connections = await Promise.all(rows.map(async (row) => ({ id: row.config.id, provider: row.config.provider, name: PROVIDERS.find((provider) => provider.id === row.config.provider).name, balance: await balanceFor(row, false) })));
    const today = dayKey(new Date(now())); const month = today.slice(0, 7);
    const totals = { today: emptyMetric(), month: emptyMetric() }; const models = new Map();
    let modelsTruncated = false;
    try {
      for (const day of store.days) {
        if (day.date > today || !day.date.startsWith(month)) continue;
        totals.month = sumMetric(totals.month, day.totals);
        if (day.date === today) totals.today = sumMetric(totals.today, day.totals);
        modelsTruncated ||= day.modelsTruncated;
        for (const row of day.models) {
          const key = JSON.stringify([row.provider, row.model]);
          const model = models.get(key) || { provider: row.provider, model: row.model, today: emptyMetric(), month: emptyMetric() };
          model.month = sumMetric(model.month, row);
          if (day.date === today) model.today = sumMetric(model.today, row);
          models.set(key, model);
        }
      }
    } catch { return { ok: false, error: 'stats_limit_reached' }; }
    return { ok: true, startedAt: store.startedAt, updatedAt: store.updatedAt, totals, models: [...models.values()].sort((a, b) => b.month.totalTokens - a.month.totalTokens || a.model.localeCompare(b.model)), connections, ...(storageError ? { storageError } : modelsTruncated ? { storageError: 'model_details_limited' } : {}) };
  }
  return { recordUsage, getSnapshot, invalidateConnections };
}
module.exports = { createAIUsageService, AI_USAGE_LIMITS, officialBalanceEndpoint };
