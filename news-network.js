const dns = require('node:dns');
const net = require('node:net');
const { isPrivateAddress: defaultIsPrivateAddress } = require('./main-services');

function httpsCandidate(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || !host) return null;
    if (host === 'localhost' || /\.(?:localhost|local|internal|lan|home)$/.test(host)) return null;
    return url;
  } catch (error) { return null; }
}

function isNonPublicAddress(value, isPrivateAddress) {
  const address = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateAddress(address)) return true;
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  // Only globally routed IPv6 unicast is useful in this public webpage reader.
  return net.isIP(address) !== 6 || !/^[23]/.test(address) || address.startsWith('2001:db8:');
}

function isSyntheticProxyAddress(value) {
  const address = String(value || '').toLowerCase();
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 198 && (b === 18 || b === 19);
  }
  if (net.isIP(address) !== 6) return false;
  // Canonicalize both dotted and hexadecimal IPv4-mapped forms. Shadowrocket
  // also supplies IPv4-translatable ::ffff:0:198.18.x.x answers.
  const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  return /^::ffff:(?:0:)?c61[23]:[0-9a-f]{1,4}$/.test(canonical);
}

function usesRemoteDnsProxy(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const entries = value.split(';').map((part) => part.trim());
  // A DIRECT fallback could send a checked name to a different resolver. SOCKS4
  // also resolves locally, so only remote-DNS proxy schemes qualify here.
  return entries.every((entry) => /^(?:PROXY|HTTPS|SOCKS5)\s+[^\s;]+:\d{1,5}$/.test(entry));
}

function createDohPublicLookup({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  const normalizeName = (value) => String(value || '').toLowerCase().replace(/\.$/, '');
  async function query(host, type, signal) {
    const endpoint = new URL('https://dns.google/resolve');
    endpoint.searchParams.set('name', host);
    endpoint.searchParams.set('type', String(type));
    const response = await fetchImpl(endpoint.toString(), {
      method: 'GET', redirect: 'error', credentials: 'omit', signal,
      headers: { Accept: 'application/dns-json' },
    });
    if (!response.ok || Number(response.headers?.get?.('content-length')) > 65536) throw new Error('dns_unavailable');
    const raw = await response.text();
    if (raw.length > 65536) throw new Error('dns_unavailable');
    const body = JSON.parse(raw);
    if (body.Status !== 0 || body.TC === true || !Array.isArray(body.Question)
      || body.Question.length !== 1 || normalizeName(body.Question[0]?.name) !== host
      || body.Question[0]?.type !== type || (body.Answer != null && !Array.isArray(body.Answer))) {
      throw new Error('dns_unavailable');
    }
    const answers = body.Answer || [];
    const names = new Set([host]);
    // Only answers belonging to this query's CNAME chain may authorize a host.
    for (let pass = 0; pass < 8; pass += 1) {
      for (const answer of answers) {
        if (answer.type === 5 && names.has(normalizeName(answer.name))) names.add(normalizeName(answer.data));
      }
    }
    const records = answers.filter((answer) => answer.type === 1 || answer.type === 28);
    if (records.some((answer) => !names.has(normalizeName(answer.name)) || answer.type !== type
      || net.isIP(answer.data) !== (type === 1 ? 4 : 6)
      || isNonPublicAddress(answer.data, defaultIsPrivateAddress))) throw new Error('unsafe_url');
    return { records: records.map((answer) => ({ address: answer.data, family: type === 1 ? 4 : 6 })),
      ttl: Math.min(30, ...answers.map((answer) => Number.isFinite(answer.TTL) && answer.TTL >= 0 ? answer.TTL : 0)) };
  }
  return async (value) => {
    const host = normalizeName(value);
    if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || net.isIP(host)) return [];
    const cached = cache.get(host);
    if (cached && cached.expires > now()) return cached.records;
    if (pending.has(host)) return pending.get(host);
    const controller = new AbortController();
    let timer;
    const request = Promise.race([
      Promise.all([query(host, 1, controller.signal), query(host, 28, controller.signal)]),
      new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('dns_timeout')); }, timeoutMs); }),
    ]).then((results) => {
      const records = results.flatMap((result) => result.records);
      if (!records.length) throw new Error('dns_unavailable');
      const ttl = Math.min(...results.map((result) => result.ttl));
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(host, { records, expires: now() + ttl * 1000 });
      return records;
    }).finally(() => { clearTimeout(timer); controller.abort(); pending.delete(host); });
    pending.set(host, request);
    return request;
  };
}

function createPublicHttpsValidator({ lookup = dns.promises.lookup, isPrivateAddress = defaultIsPrivateAddress, timeoutMs = 5000, resolveProxy, publicLookup } = {}) {
  const pending = new Map();
  async function bounded(work) {
    let deadline;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('network_error')), timeoutMs); })]);
    } finally { clearTimeout(deadline); }
  }
  return async (value) => {
    const url = httpsCandidate(value);
    if (!url) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (net.isIP(host)) return isNonPublicAddress(host, isPrivateAddress) ? null : url;
    let timer;
    try {
      let resolution = pending.get(host);
      if (!resolution) {
        resolution = Promise.resolve().then(() => lookup(host, { all: true, verbatim: true }));
        pending.set(host, resolution);
        void resolution.finally(() => { if (pending.get(host) === resolution) pending.delete(host); }).catch(() => {});
      }
      const addresses = await Promise.race([
        resolution,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            if (pending.get(host) === resolution) pending.delete(host);
            resolve([]);
          }, timeoutMs);
        }),
      ]);
      if (!Array.isArray(addresses) || !addresses.length) throw new Error('network_error');
      if (addresses.every((entry) => entry && !isNonPublicAddress(entry.address, isPrivateAddress))) return url;
      if (typeof resolveProxy !== 'function' || typeof publicLookup !== 'function'
        || !addresses.every((entry) => entry && isSyntheticProxyAddress(entry.address))) return null;
      const proxy = await bounded(() => resolveProxy(url.toString()));
      if (typeof proxy !== 'string' || !proxy.trim()) throw new Error('network_error');
      if (!usesRemoteDnsProxy(proxy)) return null;
      const publicAddresses = await bounded(() => publicLookup(host));
      if (!Array.isArray(publicAddresses) || !publicAddresses.length) throw new Error('network_error');
      return publicAddresses.every((entry) => entry && !isNonPublicAddress(entry.address, isPrivateAddress)) ? url : null;
    } catch (error) {
      // Resolution failures do not establish whether the destination is safe.
      // Reject them as network errors while continuing to deny unsafe answers.
      if (error?.message === 'unsafe_url') return null;
      throw new Error('network_error');
    }
    finally { clearTimeout(timer); }
  };
}

function isTrustedNewsSender(event, hostWindow, expectedUrl) {
  if (!hostWindow || hostWindow.isDestroyed() || !event) return false;
  const contents = hostWindow.webContents;
  return !contents.isDestroyed() && event.sender === contents
    && event.senderFrame === contents.mainFrame
    && typeof expectedUrl === 'string' && expectedUrl.startsWith('file:')
    && contents.getURL() === expectedUrl && event.senderFrame?.url === expectedUrl;
}

module.exports = { createPublicHttpsValidator, createDohPublicLookup, isTrustedNewsSender };
