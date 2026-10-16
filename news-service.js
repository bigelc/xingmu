const fs = require('node:fs');
const path = require('node:path');

const NEWS_ENDPOINT = 'https://aihot.news/api/v1/items?mode=selected&window=24h&limit=20';
const NEWS_USER_AGENT = 'aihot-api/2.0.0';
const MIN_REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ITEMS = 20;

function cleanText(value, maximum) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maximum)
    : '';
}

function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch (error) {
    return null;
  }
}

function isoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeItems(values) {
  if (!Array.isArray(values)) throw new Error('invalid_response');
  const seen = new Set();
  const result = [];
  for (const item of values) {
    if (!item || typeof item !== 'object') continue;
    const id = cleanText(item.id, 200);
    const title = cleanText(item.title, 500);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      title,
      summary: cleanText(item.summary, 4000),
      source: { name: cleanText(item.source?.name, 160) || '未知来源' },
      links: {
        aihot: httpUrl(item.links?.aihot) || 'https://aihot.news/',
        original: httpUrl(item.links?.original),
      },
      publishedAt: isoDate(item.publishedAt),
      discoveredAt: isoDate(item.discoveredAt),
      category: cleanText(item.category, 80) || null,
      attribution: {
        name: cleanText(item.attribution?.name, 160) || 'AIHOT',
        url: httpUrl(item.attribution?.url) || 'https://aihot.news/',
      },
    });
    if (result.length === MAX_ITEMS) break;
  }
  if (values.length && !result.length) throw new Error('invalid_response');
  return result;
}

function cleanEtag(value) {
  return typeof value === 'string' && value.length <= 1024 && !/[\r\n\u0000]/.test(value) ? value : '';
}

function retryAfterTime(value, currentTime) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const time = Number.isFinite(seconds) ? currentTime + seconds * 1000 : Date.parse(value);
  return Number.isFinite(time) && time > currentTime && time <= 8.64e15 ? time : 0;
}

async function readBoundedJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
  const chunks = [];
  let bytes = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          throw new Error('response_too_large');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
    chunks.push(Buffer.from(body));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new Error('invalid_response');
  }
}

function createNewsService({ cachePath, fetchImpl = (...args) => fetch(...args), now = Date.now, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let loaded = false;
  let cached = null;
  let etag = '';
  let nextRefreshTime = 0;
  let lastError = null;
  let inFlight = null;
  const resolveCachePath = () => typeof cachePath === 'function' ? cachePath() : cachePath;

  function loadCache() {
    if (loaded) return;
    loaded = true;
    try {
      const file = resolveCachePath();
      if (!file || fs.statSync(file).size > MAX_RESPONSE_BYTES) return;
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || saved.endpoint !== NEWS_ENDPOINT) return;
      if (saved.cached) {
        const updatedAt = isoDate(saved.cached.updatedAt);
        if (!updatedAt) return;
        cached = { items: normalizeItems(saved.cached.items), updatedAt };
        etag = cleanEtag(saved.etag);
      }
      nextRefreshTime = Date.parse(saved.nextRefreshAt) || 0;
      if (!Number.isFinite(nextRefreshTime)) nextRefreshTime = 0;
      lastError = typeof saved.error === 'string' && /^[a-z_0-9]+$/.test(saved.error) ? saved.error.slice(0, 80) : null;
    } catch (error) {
      // A missing or corrupt cache must never prevent a new request.
    }
  }

  function persistCache() {
    let temporary;
    try {
      const file = resolveCachePath();
      if (!file) return;
      temporary = `${file}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({
        version: 1,
        endpoint: NEWS_ENDPOINT,
        cached,
        etag,
        nextRefreshAt: nextRefreshTime ? new Date(nextRefreshTime).toISOString() : null,
        error: lastError,
      }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch (unlinkError) {}
      }
      // News still works in memory when the local cache is not writable.
    }
  }

  function snapshot() {
    return {
      ok: cached !== null,
      items: cached ? structuredClone(cached.items) : [],
      updatedAt: cached?.updatedAt || null,
      stale: !cached || Boolean(lastError) || now() - Date.parse(cached.updatedAt) >= MIN_REFRESH_INTERVAL_MS,
      error: lastError,
      nextRefreshAt: nextRefreshTime ? new Date(nextRefreshTime).toISOString() : null,
    };
  }

  async function refresh() {
    nextRefreshTime = Math.max(nextRefreshTime, now() + MIN_REFRESH_INTERVAL_MS);
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    try {
      const request = async () => {
        const headers = { Accept: 'application/json', 'User-Agent': NEWS_USER_AGENT };
        if (etag && cached) headers['If-None-Match'] = etag;
        const response = await fetchImpl(NEWS_ENDPOINT, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
        if (controller.signal.aborted) throw new Error('timeout');
        if (response.redirected || (response.status >= 300 && response.status < 400 && response.status !== 304)) {
          throw new Error('redirect_rejected');
        }
        if ([429, 503].includes(response.status)) {
          nextRefreshTime = Math.max(nextRefreshTime, retryAfterTime(response.headers.get('retry-after'), now()));
        }
        if (response.status === 304) {
          if (!cached) throw new Error('invalid_response');
          cached.updatedAt = new Date(now()).toISOString();
          etag = cleanEtag(response.headers.get('etag')) || etag;
          return;
        }
        if (response.status !== 200) throw new Error(`http_${Number(response.status) || 0}`);
        const body = await readBoundedJson(response);
        if (!body || body.schemaVersion !== 1) throw new Error('invalid_response');
        const items = normalizeItems(body.items);
        if (controller.signal.aborted) throw new Error('timeout');
        cached = { items, updatedAt: new Date(now()).toISOString() };
        etag = cleanEtag(response.headers.get('etag'));
      };
      await Promise.race([
        request(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('timeout'));
          }, timeoutMs);
        }),
      ]);
      lastError = null;
    } catch (error) {
      const code = String(error?.message || '');
      lastError = timedOut ? 'timeout'
        : /^(?:http_\d+|invalid_response|response_too_large|redirect_rejected)$/.test(code) ? code : 'network_error';
    } finally {
      clearTimeout(timer);
      persistCache();
    }
    return snapshot();
  }

  return {
    // Caller options cannot change the endpoint or bypass the refresh interval.
    getNews(_options = {}) {
      loadCache();
      if (inFlight) return inFlight;
      if (now() < nextRefreshTime) return Promise.resolve(snapshot());
      inFlight = refresh().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

module.exports = { createNewsService, NEWS_ENDPOINT, NEWS_USER_AGENT, MIN_REFRESH_INTERVAL_MS };
