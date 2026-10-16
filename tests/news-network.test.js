const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createPublicHttpsValidator, createDohPublicLookup, isTrustedNewsSender } = require('../news-network');
const { isPrivateAddress } = require('../main-services');
const LOCAL_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
const PUBLIC_IP = '93.184.216.34';

test('article validator accepts public HTTPS and rejects unsafe schemes, credentials and private IP forms', async () => {
  const validator = createPublicHttpsValidator({ lookup: async () => [{ address: PUBLIC_IP, family: 4 }], isPrivateAddress });
  assert.equal((await validator('https://article.example/news?q=one')).hostname, 'article.example');
  for (const url of [
    'http://article.example/news', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<h1>reader</h1>',
    'https://user:secret@article.example/news', 'https://localhost/news', 'https://app.local/news',
    'https://127.0.0.1/news', 'https://2130706433/news', 'https://0x7f000001/news',
    'https://10.0.0.1/', 'https://172.16.0.1/', 'https://192.168.0.1/', 'https://169.254.169.254/',
    'https://[::1]/', 'https://[fd00::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://100.64.0.1/', 'https://198.18.0.1/', 'https://192.0.2.1/', 'https://[2001:db8::1]/',
  ]) assert.equal(await validator(url), null, `Unsafe article URL accepted: ${url}`);
});

test('article validator distinguishes unsafe DNS answers from resolution failures and timeouts', async () => {
  const mixed = createPublicHttpsValidator({ lookup: async () => [{ address: PUBLIC_IP, family: 4 }, { address: '10.0.0.1', family: 4 }] });
  assert.equal(await mixed('https://article.example/news'), null);
  for (const lookup of [
    async () => [],
    async () => { throw new Error('DNS unavailable'); },
    () => new Promise(() => {}),
  ]) {
    const validator = createPublicHttpsValidator({ lookup, isPrivateAddress, timeoutMs: 10 });
    await assert.rejects(validator('https://article.example/news'), /^Error: network_error$/);
  }
});

test('synthetic DNS addresses need a remote-DNS proxy and independently public A and AAAA records', async () => {
  const addresses = ['198.18.0.1', '198.19.255.254', '::ffff:198.18.0.1', '::ffff:0:198.19.255.254'];
  for (const proxy of ['PROXY 127.0.0.1:7890', 'HTTPS proxy.example:443; SOCKS5 127.0.0.1:1080']) {
    const calls = [];
    const validator = createPublicHttpsValidator({
      lookup: async () => addresses.map((address) => ({ address })),
      resolveProxy: async (url) => { calls.push(['proxy', url]); return proxy; },
      publicLookup: async (host) => {
        calls.push(['dns', host]);
        return [{ address: PUBLIC_IP, family: 4 }, { address: '2606:4700:4700::1111', family: 6 }];
      },
    });
    assert.equal((await validator('https://article.example/news?q=one')).href, 'https://article.example/news?q=one');
    assert.deepEqual(calls, [['proxy', 'https://article.example/news?q=one'], ['dns', 'article.example']]);
  }
  const strict = createPublicHttpsValidator({ lookup: async () => [{ address: addresses[0] }] });
  assert.equal(await strict('https://article.example/news'), null, 'Synthetic DNS must remain blocked without both verification dependencies');
});

test('synthetic DNS fallback rejects direct/local-DNS proxies before asking the public resolver', async () => {
  for (const proxy of ['', 'DIRECT', 'SOCKS4 127.0.0.1:1080', 'PROXY 127.0.0.1:7890; DIRECT', 'PROXY 127.0.0.1:7890; SOCKS4 proxy.example:1080']) {
    let publicQueries = 0;
    const validator = createPublicHttpsValidator({
      lookup: async () => [{ address: '198.18.0.2' }],
      resolveProxy: async () => proxy,
      publicLookup: async () => { publicQueries += 1; return [{ address: PUBLIC_IP }]; },
    });
    if (!proxy) await assert.rejects(validator('https://article.example/news'), /^Error: network_error$/);
    else assert.equal(await validator('https://article.example/news'), null, `Unsafe proxy fallback accepted: ${proxy}`);
    assert.equal(publicQueries, 0);
  }
});

test('the proxy exception never authorizes private literals or mixed and ordinary private DNS answers', async () => {
  let fallbackCalls = 0;
  const dependencies = {
    resolveProxy: async () => { fallbackCalls += 1; return 'PROXY 127.0.0.1:7890'; },
    publicLookup: async () => { fallbackCalls += 1; return [{ address: PUBLIC_IP }]; },
  };
  const validator = createPublicHttpsValidator({ ...dependencies, lookup: async () => [{ address: '198.18.0.2' }] });
  for (const url of ['https://127.0.0.1/', 'https://10.0.0.1/', 'https://198.18.0.1/', 'https://[::ffff:0:198.18.0.1]/', 'https://[fd00::1]/', 'https://private.local/']) {
    assert.equal(await validator(url), null, url);
  }
  for (const addresses of [
    ['10.0.0.1'], ['198.18.0.2', '10.0.0.1'], ['198.18.0.2', PUBLIC_IP],
    ['::ffff:127.0.0.1'],
  ]) {
    const check = createPublicHttpsValidator({ ...dependencies, lookup: async () => addresses.map((address) => ({ address })) });
    assert.equal(await check('https://article.example/news'), null);
  }
  const ordinary = createPublicHttpsValidator({ ...dependencies, lookup: async () => [{ address: PUBLIC_IP }] });
  assert.ok(await ordinary('https://article.example/news'));
  assert.equal(fallbackCalls, 0, 'Only an entirely synthetic DNS answer may invoke the proxy exception');
});

test('synthetic DNS verification fails closed on nonpublic answers, dependency errors and timeouts', async () => {
  for (const publicLookup of [
    async () => [{ address: '10.0.0.1' }],
    async () => [{ address: PUBLIC_IP }, { address: 'fd00::1' }],
    async () => [{ address: '198.18.0.1' }],
    async () => { throw new Error('unsafe_url'); },
  ]) {
    const validator = createPublicHttpsValidator({
      lookup: async () => [{ address: '198.18.0.2' }],
      resolveProxy: async () => 'SOCKS5 127.0.0.1:1080', publicLookup, timeoutMs: 10,
    });
    assert.equal(await validator('https://article.example/news'), null);
  }
  for (const publicLookup of [
    async () => [], async () => null,
    async () => { throw new Error('Public DNS unavailable'); },
    () => new Promise(() => {}),
  ]) {
    const validator = createPublicHttpsValidator({
      lookup: async () => [{ address: '198.18.0.2' }],
      resolveProxy: async () => 'SOCKS5 127.0.0.1:1080', publicLookup, timeoutMs: 10,
    });
    await assert.rejects(validator('https://article.example/news'), /^Error: network_error$/);
  }
  for (const resolveProxy of [async () => { throw new Error('Proxy unavailable'); }, () => new Promise(() => {})]) {
    const validator = createPublicHttpsValidator({
      lookup: async () => [{ address: '198.18.0.2' }], resolveProxy,
      publicLookup: async () => { assert.fail('A failed proxy lookup must not invoke public DNS'); }, timeoutMs: 10,
    });
    await assert.rejects(validator('https://article.example/news'), /^Error: network_error$/);
  }
});

function dohAnswer(host, type, { ttl = 120, addresses = [type === 1 ? PUBLIC_IP : '2606:4700:4700::1111'] } = {}) {
  return {
    Status: 0, Question: [{ name: `${host}.`, type }],
    Answer: addresses.map((address) => ({ name: `${host}.`, type, TTL: ttl, data: address })),
  };
}

function dohResponse(body, extra = {}) {
  return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body), ...extra };
}

function dohFixture(makeBody = (host, type) => dohAnswer(host, type)) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    return dohResponse(makeBody(parsed.searchParams.get('name'), Number(parsed.searchParams.get('type'))));
  };
  return { calls, fetchImpl };
}

test('public DNS queries are fixed credential-free HTTPS A and AAAA requests with validated CNAME answers', async () => {
  const fixture = dohFixture((host, type) => {
    const answer = dohAnswer(host, type);
    answer.Answer[0].name = 'cdn.article.example.';
    answer.Answer.unshift({ name: `${host}.`, type: 5, TTL: 60, data: 'cdn.article.example.' });
    return answer;
  });
  const lookup = createDohPublicLookup(fixture);
  assert.deepEqual(await lookup('ARTICLE.EXAMPLE.'), [{ address: PUBLIC_IP, family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]);
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.calls.map(({ url }) => Number(new URL(url).searchParams.get('type'))).sort(), [1, 28]);
  for (const { url, options } of fixture.calls) {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin + endpoint.pathname, 'https://dns.google/resolve');
    assert.equal(endpoint.searchParams.get('name'), 'article.example');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Accept, 'application/dns-json');
    assert.ok(options.signal instanceof AbortSignal);
  }
  for (const host of ['127.0.0.1', '::1', 'localhost', 'https://article.example/', 'article.example?type=ANY']) assert.deepEqual(await lookup(host), []);
  assert.equal(fixture.calls.length, 2, 'Invalid host input must not reach the resolver');
});

test('public DNS requires every A and AAAA answer to be public, related to the query and correctly typed', async () => {
  const mutations = [
    (body, type) => { if (type === 28) body.Answer[0].data = 'fd00::1'; },
    (body, type) => { if (type === 1) body.Answer.push({ ...body.Answer[0], data: '198.18.0.1' }); },
    (body, type) => { if (type === 1) body.Answer[0].data = '127.0.0.1'; },
    (body) => { body.Answer[0].name = 'unrelated.example.'; },
    (body) => { body.Answer[0].type = 28; body.Answer[0].data = '2606:4700:4700::1111'; },
    (body) => { body.Question[0].name = 'unrelated.example.'; },
    (body) => { body.Question[0].type = '1'; },
    (body) => { body.Status = 3; },
    (body) => { body.TC = true; },
    (body) => { body.Answer = {}; },
  ];
  for (const mutate of mutations) {
    const fixture = dohFixture((host, type) => { const body = dohAnswer(host, type); mutate(body, type); return body; });
    await assert.rejects(createDohPublicLookup(fixture)('article.example'));
  }
  const empty = dohFixture((host, type) => dohAnswer(host, type, { addresses: [] }));
  await assert.rejects(createDohPublicLookup(empty)('article.example'), /dns_unavailable/);
  const ipv4Only = dohFixture((host, type) => dohAnswer(host, type, { addresses: type === 1 ? [PUBLIC_IP] : [] }));
  assert.deepEqual(await createDohPublicLookup(ipv4Only)('article.example'), [{ address: PUBLIC_IP, family: 4 }]);
});

test('public DNS caches only up to the shortest answer TTL, capped at thirty seconds', async () => {
  for (const { ttl, duration } of [{ ttl: 120, duration: 30_000 }, { ttl: 2, duration: 2000 }, { ttl: 0, duration: 0 }]) {
    let now = 10_000;
    const fixture = dohFixture((host, type) => dohAnswer(host, type, { ttl: type === 1 ? ttl : 120 }));
    const lookup = createDohPublicLookup({ ...fixture, now: () => now });
    await lookup('article.example');
    assert.equal(fixture.calls.length, 2);
    if (duration > 0) {
      now += duration - 1;
      await lookup('ARTICLE.EXAMPLE.');
      assert.equal(fixture.calls.length, 2);
      now += 1;
    }
    await lookup('article.example');
    assert.equal(fixture.calls.length, 4, `The ${ttl}-second TTL must not outlive its safe cache window`);
  }
});

test('public DNS merges concurrent lookups for the same host and retries failures instead of caching them', async () => {
  const pending = [];
  const lookup = createDohPublicLookup({ fetchImpl: (url) => new Promise((resolve) => pending.push({ url, resolve })) });
  const results = [lookup('article.example'), lookup('ARTICLE.EXAMPLE.'), lookup('article.example')];
  assert.equal(pending.length, 2, 'Concurrent host checks should share one A and one AAAA request');
  for (const request of pending) {
    const url = new URL(request.url);
    request.resolve(dohResponse(dohAnswer(url.searchParams.get('name'), Number(url.searchParams.get('type')))));
  }
  const resolved = await Promise.all(results);
  assert.deepEqual(resolved[0], resolved[1]);
  assert.deepEqual(resolved[1], resolved[2]);

  let failed = true;
  const fixture = dohFixture((host, type) => failed ? { Status: 2 } : dohAnswer(host, type));
  const retry = createDohPublicLookup(fixture);
  await assert.rejects(retry('article.example'));
  failed = false;
  assert.equal((await retry('article.example')).length, 2);
  assert.equal(fixture.calls.length, 4, 'A failed lookup must not persist an unusable result');
});

test('public DNS rejects failed or oversized responses and aborts timed-out queries', async () => {
  for (const response of [
    dohResponse({}, { ok: false }),
    dohResponse({}, { headers: { get: () => '65537' } }),
    dohResponse({}, { text: async () => 'x'.repeat(65537) }),
    dohResponse({}, { text: async () => '{not json' }),
  ]) {
    await assert.rejects(createDohPublicLookup({ fetchImpl: async () => response })('article.example'));
  }
  const signals = [];
  const lookup = createDohPublicLookup({
    timeoutMs: 10,
    fetchImpl: (url, { signal }) => { signals.push(signal); return new Promise(() => {}); },
  });
  await assert.rejects(lookup('article.example'), /dns_timeout/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted), 'Both DNS requests must be cancelled on timeout');
});

test('only the local main renderer frame is trusted to request an article document', () => {
  const contents = { getURL: () => LOCAL_URL, isDestroyed: () => false, mainFrame: { url: LOCAL_URL } };
  const host = { webContents: contents, isDestroyed: () => false };
  const valid = { sender: host.webContents, senderFrame: host.webContents.mainFrame };
  assert.equal(isTrustedNewsSender(valid, host, LOCAL_URL), true);
  assert.equal(isTrustedNewsSender({ ...valid, sender: { getURL: () => LOCAL_URL } }, host, LOCAL_URL), false);
  assert.equal(isTrustedNewsSender({ ...valid, senderFrame: { url: LOCAL_URL } }, host, LOCAL_URL), false);
  host.webContents.mainFrame.url = 'https://article.example/news';
  assert.equal(isTrustedNewsSender(valid, host, LOCAL_URL), false);
  assert.equal(isTrustedNewsSender(valid, null, LOCAL_URL), false);
});
