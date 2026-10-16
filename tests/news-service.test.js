const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNewsService, NEWS_ENDPOINT, NEWS_USER_AGENT, MIN_REFRESH_INTERVAL_MS } = require('../news-service');
const { updateFeaturePreference, normalizeDefaultTabPreference, updateDefaultTabPreference } = require('../main-services');

const START = Date.parse('2026-10-12T00:00:00Z');
function item(id = 'story-1', extra = {}) {
  return {
    id,
    title: ' AI 产品发布 ',
    summary: '公开摘要',
    source: { name: '来源站点', secret: 'not retained' },
    links: { aihot: `https://aihot.news/item/${id}`, original: 'https://example.com/article' },
    publishedAt: null,
    discoveredAt: '2026-10-11T23:00:00+08:00',
    category: 'future-category',
    attribution: { name: 'AIHOT', url: 'https://aihot.news/' },
    ...extra,
  };
}
function response(items = [item()], { status = 200, headers = {}, body } = {}) {
  return new Response(status === 304 ? null : JSON.stringify(body || { schemaVersion: 1, items }), { status, headers });
}
function temporaryCache(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-news-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'ai-news-cache.json');
}

test('news requests are lazy, GET-only and fixed; caller URLs and force cannot bypass the minimum interval', async () => {
  let time = START;
  const calls = [];
  const service = createNewsService({ now: () => time, fetchImpl: async (...args) => { calls.push(args); return response(); } });
  assert.equal(calls.length, 0);
  const first = await service.getNews({ url: 'http://127.0.0.1/private', method: 'POST', limit: 500 });
  assert.equal(first.ok, true);
  assert.equal(first.stale, false);
  assert.equal(first.nextRefreshAt, new Date(START + MIN_REFRESH_INTERVAL_MS).toISOString());
  assert.equal(calls[0][0], NEWS_ENDPOINT);
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].headers['User-Agent'], NEWS_USER_AGENT);
  time += 59_999;
  await service.getNews({ force: true, endpoint: 'https://example.com/' });
  assert.equal(calls.length, 1);
  time += 1;
  await service.getNews({ force: true });
  assert.equal(calls.length, 2);
});

test('schema normalization deduplicates and keeps at most 20 minimal records with safe links', async () => {
  const values = [null, {}, item('one', {
    summary: null,
    links: { aihot: 'javascript:alert(1)', original: 'file:///private/file' },
    publishedAt: 'invalid',
    attribution: { name: 'AIHOT', url: 'https://user:password@example.com/' },
    content: 'full article must not be copied',
  }), item('one'), ...Array.from({ length: 25 }, (_, index) => item(`extra-${index}`))];
  const service = createNewsService({ now: () => START, fetchImpl: async () => response(values) });
  const result = await service.getNews();
  assert.equal(result.items.length, 20);
  assert.equal(result.items[0].title, 'AI 产品发布');
  assert.equal(result.items[0].summary, '');
  assert.equal(result.items[0].links.original, null);
  assert.equal(result.items[0].links.aihot, 'https://aihot.news/');
  assert.equal(result.items[0].publishedAt, null);
  assert.equal(result.items[0].discoveredAt, '2026-10-11T15:00:00.000Z');
  assert.equal(result.items[0].category, 'future-category');
  assert.deepEqual(result.items[0].attribution, { name: 'AIHOT', url: 'https://aihot.news/' });
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['attribution', 'category', 'discoveredAt', 'id', 'links', 'publishedAt', 'source', 'summary', 'title']);
  assert.deepEqual(result.items[0].source, { name: '来源站点' });
});

test('ETag is sent on refresh and 304 revalidates the same cached items without parsing a body', async () => {
  let time = START;
  const calls = [];
  const service = createNewsService({ now: () => time, fetchImpl: async (url, options) => {
    calls.push(options);
    return calls.length === 1 ? response([item()], { headers: { ETag: '"feed-v1"' } }) : response([], { status: 304 });
  } });
  const first = await service.getNews();
  time += MIN_REFRESH_INTERVAL_MS;
  const next = await service.getNews();
  assert.equal(calls[1].headers['If-None-Match'], '"feed-v1"');
  assert.deepEqual(next.items, first.items);
  assert.equal(next.updatedAt, new Date(time).toISOString());
  assert.equal(next.stale, false);
  assert.equal(next.error, null);
});

test('simultaneous callers share one network request and returned objects do not mutate cache', async () => {
  let release;
  let count = 0;
  const service = createNewsService({ now: () => START, fetchImpl: () => { count += 1; return new Promise(resolve => { release = resolve; }); } });
  const first = service.getNews();
  const second = service.getNews({ force: true });
  assert.equal(first, second);
  assert.equal(count, 1);
  release(response());
  const result = await first;
  result.items[0].title = 'changed by caller';
  assert.equal((await service.getNews()).items[0].title, 'AI 产品发布');
});

test('HTTP 503 keeps previous items stale and honors a date Retry-After', async () => {
  let time = START;
  let calls = 0;
  const retryAt = START + 600_000;
  const service = createNewsService({ now: () => time, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? response() : response([], { status: 503, headers: { 'Retry-After': new Date(retryAt).toUTCString() } });
  } });
  const first = await service.getNews();
  time += MIN_REFRESH_INTERVAL_MS;
  const failed = await service.getNews();
  assert.equal(failed.ok, true);
  assert.equal(failed.stale, true);
  assert.equal(failed.error, 'http_503');
  assert.equal(failed.updatedAt, first.updatedAt);
  assert.deepEqual(failed.items, first.items);
  assert.equal(failed.nextRefreshAt, new Date(retryAt).toISOString());
  time = retryAt - 1;
  await service.getNews({ force: true });
  assert.equal(calls, 2);
  time += 1;
  await service.getNews();
  assert.equal(calls, 3);
});

test('cold 429 wait survives restart without creating extra requests', async (t) => {
  const cachePath = temporaryCache(t);
  let calls = 0;
  const options = { cachePath, now: () => START, fetchImpl: async () => { calls += 1; return response([], { status: 429, headers: { 'Retry-After': '180' } }); } };
  const first = await createNewsService(options).getNews();
  assert.equal(first.ok, false);
  assert.deepEqual(first.items, []);
  assert.equal(first.error, 'http_429');
  assert.equal(first.nextRefreshAt, new Date(START + 180_000).toISOString());
  const restored = await createNewsService(options).getNews({ force: true });
  assert.equal(calls, 1);
  assert.deepEqual(restored, first);
});

test('disk cache restores only normalized recent records and ETag; expired offline cache remains usable', async (t) => {
  const cachePath = temporaryCache(t);
  let time = START;
  let calls = 0;
  const service = createNewsService({ cachePath, now: () => time, fetchImpl: async () => response(Array.from({ length: 25 }, (_, index) => item(String(index))), { headers: { ETag: '"persisted"' } }) });
  await service.getNews();
  const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(raw.cached.items.length, 20);
  time += 20_000;
  const restored = createNewsService({ cachePath, now: () => time, fetchImpl: async (url, options) => { calls += 1; assert.equal(options.headers['If-None-Match'], '"persisted"'); throw new Error('offline internal detail'); } });
  assert.equal(calls, 0);
  assert.equal((await restored.getNews()).stale, false);
  assert.equal(calls, 0);
  time += 60_000;
  const offline = await restored.getNews();
  assert.equal(offline.ok, true);
  assert.equal(offline.stale, true);
  assert.equal(offline.items.length, 20);
  assert.equal(offline.error, 'network_error');
});

test('malformed or incompatible responses never replace a working cache', async () => {
  let time = START;
  let mode = 0;
  const service = createNewsService({ now: () => time, fetchImpl: async () => {
    if (mode === 0) return response();
    if (mode === 1) return response([], { body: { schemaVersion: 2, items: [] } });
    if (mode === 2) return response([{}, { id: 'missing-title' }]);
    return new Response('not JSON', { status: 200 });
  } });
  const first = await service.getNews();
  for (mode = 1; mode <= 3; mode += 1) {
    time += MIN_REFRESH_INTERVAL_MS;
    const result = await service.getNews();
    assert.equal(result.error, 'invalid_response');
    assert.equal(result.stale, true);
    assert.deepEqual(result.items, first.items);
  }
});

test('a valid empty feed is successful while a 304 without cache is an error', async () => {
  const empty = await createNewsService({ now: () => START, fetchImpl: async () => response([]) }).getNews();
  assert.equal(empty.ok, true);
  assert.equal(empty.stale, false);
  assert.deepEqual(empty.items, []);
  const missing = await createNewsService({ now: () => START, fetchImpl: async () => response([], { status: 304 }) }).getNews();
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'invalid_response');
});

test('redirects and oversized responses are rejected without trusting their content', async () => {
  const redirect = await createNewsService({ now: () => START, fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'http://localhost/' } }) }).getNews();
  assert.equal(redirect.error, 'redirect_rejected');
  const oversized = await createNewsService({ now: () => START, fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }) }).getNews();
  assert.equal(oversized.error, 'response_too_large');
});

test('timeout aborts the fetch and a late response cannot mutate the cache', async () => {
  let signal;
  let release;
  const service = createNewsService({ now: () => START, timeoutMs: 15, fetchImpl: (url, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); } });
  const result = await service.getNews();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  assert.equal(signal.aborted, true);
  release(response());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.getNews()).ok, false);
});

test('corrupt disk cache is ignored and writable cache failure does not hide fresh news', async (t) => {
  const cachePath = temporaryCache(t);
  fs.writeFileSync(cachePath, 'broken json');
  let calls = 0;
  const service = createNewsService({ cachePath, now: () => START, fetchImpl: async () => { calls += 1; return response(); } });
  assert.equal((await service.getNews()).ok, true);
  assert.equal(calls, 1);
  const unwritable = createNewsService({ cachePath: path.join(cachePath, 'nested.json'), now: () => START, fetchImpl: async () => response() });
  assert.equal((await unwritable.getNews()).ok, true);
});

test('news can be enabled, disabled and chosen as the default panel only while enabled', () => {
  assert.equal(updateFeaturePreference({}, 'news', true).news, true);
  assert.equal(updateFeaturePreference({}, 'news', false).news, false);
  assert.equal(normalizeDefaultTabPreference('news', { news: true }), 'news');
  assert.equal(normalizeDefaultTabPreference('news', { news: false }), 'home');
  assert.equal(updateDefaultTabPreference({ features: { news: false } }, 'news'), null);
});
