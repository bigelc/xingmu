const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createArticleFetch } = require('../electron-article-fetch');

const URL = 'https://article.example/story';

function harness(onRequest = () => {}, options = {}) {
  const requests = [];
  const session = { name: 'isolated-fixture' };
  const net = {
    request(settings) {
      const request = new EventEmitter();
      request.settings = settings;
      request.end = () => { queueMicrotask(() => onRequest(request)); return request; };
      request.abort = () => { request.aborted = true; request.emit('abort'); request.incoming?.emit('aborted'); };
      request.followRedirect = () => { assert.fail('The adapter must never follow a redirect before validation'); };
      request.setHeader = () => { assert.fail('Only declared request headers should be sent'); };
      request.respond = (headers = {}, statusCode = 200) => {
        const incoming = new EventEmitter();
        incoming.statusCode = statusCode;
        incoming.statusMessage = statusCode === 200 ? 'OK' : 'Fixture';
        incoming.headers = headers;
        request.incoming = incoming;
        request.emit('response', incoming);
        return incoming;
      };
      requests.push(request);
      return request;
    },
  };
  return { fetch: createArticleFetch({ net, session, ...options }), requests, session };
}

test('Electron article requests use the isolated session and omit credentials while preserving streamed content', async () => {
  const h = harness((request) => {
    const response = request.respond({ 'content-type': ['text/html; charset=utf-8'], 'x-fixture': ['first', 'second'] });
    response.emit('data', Buffer.from('正文'));
    response.emit('data', Buffer.from('结尾'));
    response.emit('end');
  });
  const response = await h.fetch(URL, { headers: { Accept: 'text/html', Cookie: 'never-send', Authorization: 'never-send' }, credentials: 'include' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(await response.text(), '正文结尾');
  const settings = h.requests[0].settings;
  assert.equal(settings.session, h.session);
  assert.equal(settings.method, 'GET');
  assert.equal(settings.redirect, 'manual');
  assert.equal(settings.credentials, 'omit');
  assert.equal(settings.headers.Accept, 'text/html');
  assert.equal(settings.headers.Cookie, undefined);
  assert.equal(settings.headers.Authorization, undefined);
});

test('302 is returned with its Location before cancellation and is never followed automatically', async () => {
  const h = harness((request) => {
    request.emit('redirect', 302, 'GET', 'https://article.example/next', { location: ['https://article.example/next'] });
    request.emit('error', new Error('Redirect was cancelled'));
  });
  const response = await h.fetch(URL);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://article.example/next');
  assert.equal(await response.text(), '');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].aborted, true);
});

test('non-HTTPS URLs, non-GET methods and already aborted requests cannot allocate a network request', async () => {
  const h = harness();
  for (const url of ['http://article.example/', 'file:///etc/passwd', 'javascript:alert(1)']) await assert.rejects(h.fetch(url));
  await assert.rejects(h.fetch(URL, { method: 'POST' }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.fetch(URL, { signal: controller.signal }));
  assert.equal(h.requests.length, 0);
});

test('aborting before headers rejects the request, and aborting after headers errors the response stream', async () => {
  const first = harness();
  const before = new AbortController();
  const pending = first.fetch(URL, { signal: before.signal });
  before.abort();
  await assert.rejects(pending);
  assert.equal(first.requests[0].aborted, true);

  const second = harness((request) => { request.respond({ 'content-type': 'text/html' }); });
  const after = new AbortController();
  const response = await second.fetch(URL, { signal: after.signal });
  const body = response.text();
  after.abort();
  await assert.rejects(body);
  assert.equal(second.requests[0].aborted, true);
});

test('cancelling a response body releases its underlying Electron request', async () => {
  const h = harness((request) => { request.respond(); });
  const response = await h.fetch(URL);
  await response.body.cancel();
  assert.equal(h.requests[0].aborted, true);
});

test('declared and streamed responses are bounded even when the consumer does not read immediately', async () => {
  for (const declared of [true, false]) {
    const h = harness((request) => {
      const response = request.respond(declared ? { 'content-length': '9' } : {});
      if (!request.aborted) response.emit('data', Buffer.from('123456789'));
    }, { maxBytes: 8 });
    await assert.rejects(async () => { const response = await h.fetch(URL); await response.text(); }, /response_too_large/);
    assert.equal(h.requests[0].aborted, true);
  }
});

test('request and response failures reject consumers without leaving a readable partial document', async () => {
  const before = harness((request) => { request.emit('error', new Error('fixture connection failed')); });
  await assert.rejects(before.fetch(URL), /fixture connection failed/);
  const after = harness((request) => {
    const response = request.respond();
    response.emit('data', Buffer.from('partial'));
    response.emit('error', new Error('fixture connection interrupted'));
  });
  const response = await after.fetch(URL);
  await assert.rejects(response.text(), /fixture connection interrupted/);
});
