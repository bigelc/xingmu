const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIUsageService, AI_USAGE_LIMITS, officialBalanceEndpoint } = require('../ai-usage');

const connection = (extra = {}) => ({ id: 'primary', provider: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', region: '', workspaceId: '', apiKey: 'test-only-secret', needsReentry: false, ...extra });
const balanceBody = (value = '25.50') => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: value, granted_balance: '0', topped_up_balance: value }] });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const usage = (extra = {}) => ({ connectionId: 'primary', provider: 'deepseek', model: 'text-model', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, ...extra });
function harness(options = {}) {
  let time = options.time ?? new Date(2026, 9, 15, 12).getTime();
  let stored = options.stored ?? null; let connections = options.connections || [connection()];
  let fetcher = options.fetchImpl || (() => json(balanceBody()));
  const calls = [], writes = [], validations = [];
  const service = createAIUsageService({
    readStore: () => { if (options.readError) throw Error('disk'); return stored; },
    writeStore: (next) => { if (options.writeError) throw Error('disk'); stored = structuredClone(next); writes.push(next); },
    getConnections: () => connections, now: () => time,
    fetchImpl: (url, init) => { calls.push({ url, init }); return fetcher(url, init); },
    validateUrl: options.validateUrl || ((url) => { validations.push(url); return new URL(url); }),
    limits: options.limits,
  });
  return { service, calls, writes, validations, stored: () => stored, setTime: (next) => { time = next; }, advance: (ms) => { time += ms; }, setConnections: (next) => { connections = next; }, setFetch: (next) => { fetcher = next; } };
}

test('reading statistics is network-free; explicit refresh uses only the authorized fixed balance endpoint', async () => {
  const h = harness();
  const initial = await h.service.getSnapshot();
  assert.equal(initial.connections[0].balance.error, 'not_loaded');
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
  const snapshot = await h.service.getSnapshot({ refresh: true });
  assert.equal(snapshot.connections[0].balance.amount, 25.5);
  assert.equal(snapshot.connections[0].balance.currency, 'CNY');
  const call = h.calls[0];
  assert.equal(call.url, 'https://api.deepseek.com/user/balance');
  assert.equal(call.init.method, 'GET'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.headers.Authorization, 'Bearer test-only-secret');
  assert.equal(call.init.body, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /test-only-secret|baseUrl|apiKey|encrypted|api\.deepseek/);
});

test('custom endpoints, unsupported providers, unusual paths and missing keys never receive official balance requests', async () => {
  for (const extra of [
    { provider: 'custom' }, { provider: 'zhipu' }, { baseUrl: 'https://api.deepseek.com.evil.example' },
    { baseUrl: 'https://api.deepseek.com:444' }, { baseUrl: 'https://api.deepseek.com/proxy' },
    { baseUrl: 'https://api.deepseek.com/v1?key=secret' }, { baseUrl: 'https://user:pass@api.deepseek.com' },
    { baseUrl: 'http://api.deepseek.com' }, { baseUrl: 'https://api.deepseek.com/v1/chat/completions' },
    { provider: 'moonshot', baseUrl: 'https://api.moonshot.ai/v1' },
    { provider: 'moonshot', baseUrl: 'https://api.moonshot.cn' }, { protocol: 'anthropic' },
  ]) {
    const h = harness({ connections: [connection(extra)] });
    assert.equal((await h.service.getSnapshot({ refresh: true })).connections[0].balance.status, 'unsupported', JSON.stringify(extra));
    assert.equal(h.calls.length, 0); assert.equal(h.validations.length, 0);
  }
  for (const extra of [{ apiKey: '' }, { apiKey: 'secret\nvalue' }, { needsReentry: true }]) {
    const h = harness({ connections: [connection(extra)] });
    assert.equal((await h.service.getSnapshot({ refresh: true })).connections[0].balance.status, 'not_configured');
    assert.equal(h.calls.length, 0);
  }
  assert.equal(officialBalanceEndpoint(connection({ baseUrl: 'https://api.deepseek.com/v1/' })), 'https://api.deepseek.com/user/balance');
});

test('Moonshot has its own schema and CNY unit; DeepSeek USD stays USD', async () => {
  const h = harness({ connections: [connection({ provider: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1' })], fetchImpl: () => json({ code: 0, status: true, data: { available_balance: 3.5, voucher_balance: 5, cash_balance: -1.5 } }) });
  const balance = (await h.service.getSnapshot({ refresh: true })).connections[0].balance;
  assert.equal(balance.amount, 3.5); assert.equal(balance.currency, 'CNY');
  assert.equal(h.calls[0].url, 'https://api.moonshot.cn/v1/users/me/balance');
  const usd = harness({ fetchImpl: () => json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '8.25' }] }) });
  assert.equal((await usd.service.getSnapshot({ refresh: true })).connections[0].balance.currency, 'USD');
});

test('refreshes coalesce and cannot bypass 60 seconds; failure retains the last value as stale', async () => {
  let finish;
  const h = harness({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const first = h.service.getSnapshot({ refresh: true });
  const second = h.service.getSnapshot({ refresh: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1); finish(json(balanceBody()));
  assert.deepEqual(await first, await second);
  h.advance(59999); await h.service.getSnapshot({ refresh: true }); assert.equal(h.calls.length, 1);
  h.advance(1); h.setFetch(() => { throw Error('test-only-secret https://api.deepseek.com'); });
  const stale = (await h.service.getSnapshot({ refresh: true })).connections[0].balance;
  assert.equal(stale.status, 'error'); assert.equal(stale.error, 'network'); assert.equal(stale.stale, true); assert.equal(stale.amount, 25.5);
  await h.service.getSnapshot({ refresh: true }); assert.equal(h.calls.length, 2);
});

test('full connection identity and key changes clear old cache while unchanged invalidation preserves throttling', async () => {
  for (const extra of [{ apiKey: 'replacement' }, { baseUrl: 'https://api.deepseek.com/v1' }, { region: 'changed' }, { workspaceId: 'changed' }]) {
    const h = harness(); await h.service.getSnapshot({ refresh: true });
    h.service.invalidateConnections(); await h.service.getSnapshot({ refresh: true }); assert.equal(h.calls.length, 1);
    h.setConnections([connection(extra)]); h.service.invalidateConnections();
    assert.equal((await h.service.getSnapshot()).connections[0].balance.error, 'not_loaded');
    await h.service.getSnapshot({ refresh: true }); assert.equal(h.calls.length, 2);
  }
  const h = harness(); await h.service.getSnapshot({ refresh: true });
  h.setConnections([]); h.service.invalidateConnections();
  assert.deepEqual((await h.service.getSnapshot()).connections, []);
  h.setConnections([connection()]);
  assert.equal((await h.service.getSnapshot()).connections[0].balance.error, 'not_loaded');
});

test('an in-flight old-key response is not returned after configuration changes', async () => {
  let finish;
  const h = harness({ fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  const result = h.service.getSnapshot({ refresh: true });
  await new Promise(resolve => setImmediate(resolve));
  h.setConnections([connection({ apiKey: 'new-secret' })]); h.service.invalidateConnections();
  const snapshot = await result;
  assert.equal(snapshot.connections[0].balance.error, 'not_loaded');
  assert.equal(snapshot.connections[0].balance.amount, undefined);
  assert.equal(h.calls[0].init.signal.aborted, true);
  finish(json(balanceBody('999')));
});

test('private DNS, redirects, auth, schema, size and time failures expose only stable error codes', async () => {
  const scenarios = [
    { validateUrl: () => null, error: 'unsafe_endpoint', calls: 0 },
    { fetchImpl: () => new Response(null, { status: 302, headers: { Location: 'https://attacker.example' } }), error: 'unsafe_endpoint' },
    { fetchImpl: () => new Response(null, { status: 401 }), error: 'auth' },
    { fetchImpl: () => new Response(null, { status: 429 }), error: 'rate_limited' },
    { fetchImpl: () => json(balanceBody('NaN')), error: 'invalid_response' },
    { fetchImpl: () => json(balanceBody(true)), error: 'invalid_response' },
    { fetchImpl: () => new Response('x'.repeat(AI_USAGE_LIMITS.balanceBytes + 1)), error: 'response_too_large' },
    { fetchImpl: () => new Response(null, { headers: { 'Content-Length': String(AI_USAGE_LIMITS.balanceBytes + 1) } }), error: 'response_too_large' },
    { validateUrl: () => new Promise(() => {}), limits: { balanceTimeoutMs: 10 }, error: 'timeout', calls: 0 },
    { fetchImpl: () => new Response(new ReadableStream({ start() {} })), limits: { balanceTimeoutMs: 10 }, error: 'timeout' },
  ];
  for (const scenario of scenarios) {
    const h = harness(scenario); const snapshot = await h.service.getSnapshot({ refresh: true });
    assert.equal(snapshot.connections[0].balance.error, scenario.error);
    assert.equal(snapshot.connections[0].balance.amount, undefined);
    assert.equal(h.calls.length, scenario.calls ?? 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /test-only-secret|attacker/);
  }
});

test('local calendar day/month aggregation separates models and counts missing or malformed usage honestly', async () => {
  const h = harness({ time: new Date(2026, 8, 30, 23, 59).getTime() });
  h.service.recordUsage(usage());
  h.setTime(new Date(2026, 9, 1, 0, 1).getTime());
  h.service.recordUsage(usage());
  for (const reported of [null, {}, { inputTokens: -1, outputTokens: 1, totalTokens: 0 }, { inputTokens: '10', outputTokens: 1, totalTokens: 11 }, { inputTokens: 1.5, outputTokens: 1, totalTokens: 2.5 }, { inputTokens: 10, outputTokens: 5, totalTokens: 9 }]) h.service.recordUsage(usage({ usage: reported }));
  h.service.recordUsage(usage({ model: 'second-model', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }));
  let snapshot = await h.service.getSnapshot();
  assert.deepEqual(snapshot.totals.today, { inputTokens: 12, outputTokens: 8, totalTokens: 20, requests: 8, unreportedRequests: 6 });
  assert.deepEqual(snapshot.totals.today, snapshot.totals.month);
  assert.equal(snapshot.models.length, 2);
  h.setTime(new Date(2026, 9, 2, 0, 1).getTime());
  snapshot = await h.service.getSnapshot();
  assert.equal(snapshot.totals.today.requests, 0); assert.equal(snapshot.totals.month.requests, 8);
  const restarted = harness({ stored: h.stored(), time: new Date(2026, 9, 2, 12).getTime() });
  assert.deepEqual((await restarted.service.getSnapshot()).totals, snapshot.totals);
  assert.doesNotMatch(JSON.stringify(h.stored()), /test-only-secret|connectionId|apiKey|baseUrl|endpoint|primary/);
});

test('corrupt or unreadable history is never overwritten; write failure remains observable without losing in-memory totals', async () => {
  for (const options of [{ stored: { version: 99 } }, { readError: true }]) {
    const h = harness(options); h.service.recordUsage(usage());
    const snapshot = await h.service.getSnapshot();
    assert.equal(snapshot.storageError, 'store_unreadable'); assert.equal(snapshot.totals.today.totalTokens, 15); assert.equal(h.writes.length, 0);
  }
  const h = harness({ writeError: true });
  assert.equal(h.service.recordUsage(usage()), true);
  const snapshot = await h.service.getSnapshot();
  assert.equal(snapshot.storageError, 'save_failed'); assert.equal(snapshot.totals.today.totalTokens, 15);
});

test('retention is 365 local days and model-detail bounds preserve complete daily totals', async () => {
  const h = harness({ time: new Date(2025, 0, 1, 12).getTime() });
  for (let i = 0; i < 370; i++) { h.setTime(new Date(2025, 0, 1 + i, 12).getTime()); h.service.recordUsage(usage()); }
  assert.equal(h.stored().days.length, 365);
  for (let i = 0; i < AI_USAGE_LIMITS.modelsPerDay + 1; i++) h.service.recordUsage(usage({ model: `model-${i}` }));
  const snapshot = await h.service.getSnapshot();
  assert.equal(snapshot.totals.today.requests, AI_USAGE_LIMITS.modelsPerDay + 2);
  assert.equal(snapshot.storageError, 'model_details_limited');
  assert.equal(h.stored().days.at(-1).models.length, AI_USAGE_LIMITS.modelsPerDay);
});

test('statistics snapshots and stored objects do not allow callers to mutate service state', async () => {
  const h = harness(); h.service.recordUsage(usage());
  const first = await h.service.getSnapshot(); first.totals.today.requests = 999; first.models[0].month.requests = 999;
  h.writes[0].days[0].totals.requests = 999;
  assert.equal((await h.service.getSnapshot()).totals.today.requests, 1);
});

test('individually valid stored days that overflow the month return an explicit error instead of zero or a thrown IPC exception', async () => {
  const huge = { inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER, requests: 1, unreportedRequests: 0 };
  const stored = { version: 1, startedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', days: ['2026-10-01', '2026-10-02'].map(date => ({ date, totals: huge, models: [{ provider: 'deepseek', model: 'text-model', ...huge }], modelsTruncated: false })) };
  const h = harness({ stored });
  assert.deepEqual(await h.service.getSnapshot(), { ok: false, error: 'stats_limit_reached' });
  assert.equal(h.writes.length, 0);
});
