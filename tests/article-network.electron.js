const assert = require('node:assert/strict');
const { app, net, session } = require('electron');
const { createArticleFetch } = require('../electron-article-fetch');
const { createArticleService } = require('../article-service');
const { createPublicHttpsValidator } = require('../news-network');
const { createNewsTranslationService } = require('../news-translation-service');

app.setPath('userData', process.env.TODO_TEST_USER_DATA);
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');

const HOST = 'https://article.fixture';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMfoAAAAASUVORK5CYII=', 'base64');
const requests = [];
const transportRequests = [];
let isolated;
let translationSession;

async function main() {
  await app.whenReady();
  const deadline = setTimeout(() => { console.error('Article network fixture timed out', { requests, transportRequests }); app.exit(1); }, 20_000);
  isolated = session.fromPartition(`article-network-fixture-${process.pid}`, { cache: false });
  await isolated.setProxy({ mode: 'direct' });
  isolated.protocol.handle('https', (request) => {
    requests.push(request.url);
    const url = new URL(request.url);
    if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: `${HOST}/story` } });
    if (url.pathname === '/private-redirect') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    if (url.pathname === '/image-redirect') return new Response(null, { status: 302, headers: { location: 'https://assets.fixture/real.png' } });
    if (url.pathname === '/real.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    if (url.pathname === '/story') return new Response(`<html><head><title>真实网络适配器原文</title></head><body><article><p>${'这是内存 HTTPS fixture 的完整原始报道。'.repeat(15)}</p><img src="https://assets.fixture/image-redirect"><p>正文最后一段。</p></article></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/stall') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<html><body>')); } }), { headers: { 'content-type': 'text/html' } });
    return new Response('Unexpected fixture target', { status: 404 });
  });
  const realNet = { request: (settings) => { transportRequests.push({ url: settings.url, redirect: settings.redirect, credentials: settings.credentials }); return net.request(settings); } };
  const fetchImpl = createArticleFetch({ net: realNet, session: isolated });
  const validateUrl = createPublicHttpsValidator({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  const service = createArticleService({ fetchImpl, validateUrl });
  try {
    const redirect = await fetchImpl(`${HOST}/redirect`);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), `${HOST}/story`);
    assert.deepEqual(requests, [`${HOST}/redirect`], 'Chromium must stop before the redirect target until the service validates it');
    assert.deepEqual(transportRequests, [{ url: `${HOST}/redirect`, redirect: 'manual', credentials: 'omit' }], 'The fixture must exercise the real Electron net.request adapter');

    const article = await service.getArticle({ url: `${HOST}/redirect` });
    assert.equal(article.ok, true);
    assert.equal(article.completeness, 'full');
    assert.ok(article.blocks.some((block) => block.text?.includes('正文最后一段。')));
    assert.deepEqual(article.blocks.filter((block) => block.type === 'image').map((block) => block.src), [`data:image/png;base64,${PNG.toString('base64')}`]);
    assert.ok(requests.includes(`${HOST}/story`));
    assert.ok(requests.includes('https://assets.fixture/image-redirect'));
    assert.ok(requests.includes('https://assets.fixture/real.png'));

    const count = requests.length;
    const denied = await service.getArticle({ url: `${HOST}/private-redirect` });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'unsafe_url');
    assert.deepEqual(requests.slice(count), [`${HOST}/private-redirect`]);
    assert.equal(transportRequests.some((request) => new URL(request.url).hostname === '127.0.0.1'), false, 'Private targets must never reach even the network adapter');

    const timed = createArticleService({ fetchImpl, validateUrl, limits: { timeoutMs: 500 } });
    const stalled = await timed.getArticle({ url: `${HOST}/stall` });
    assert.equal(stalled.ok, false);
    assert.equal(stalled.error, 'timeout');
    assert.ok(requests.includes(`${HOST}/stall`), 'The deadline fixture must start its real response stream');
    assert.equal(requests.length, transportRequests.length, 'All requests must reach an in-memory handler; no external network fallback is allowed');

    // Translation uses Electron's POST-capable fetch, with no shared cookies
    // and no redirect authorization. The HTTPS handler is entirely in memory.
    translationSession = session.fromPartition(`news-translation-fixture-${process.pid}`, { cache: false });
    await translationSession.setProxy({ mode: 'direct' });
    await translationSession.cookies.set({ url: 'https://translation.fixture', name: 'must-not-send', value: 'fixture-only' });
    const translationRequests = [];
    translationSession.protocol.handle('https', async (request) => {
      translationRequests.push(request.url);
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('authorization'), 'Bearer fixture-key');
      assert.equal(request.headers.get('cookie'), null);
      if (new URL(request.url).pathname.startsWith('/redirect/')) {
        return new Response(null, { status: 302, headers: { location: 'https://other.fixture/never-follow' } });
      }
      assert.equal(request.url, 'https://translation.fixture/v1/chat/completions');
      const body = await request.json();
      const input = JSON.parse(body.messages[1].content);
      const segments = input.segments.map((segment) => ({ id: segment.id, text: `中文译文：${segment.text}` }));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ segments }) } }] }), { headers: { 'content-type': 'application/json' } });
    });
    const makeTranslation = (baseUrl) => createNewsTranslationService({
      getConfig: () => ({ apiKey: 'fixture-key', model: 'fixture-model', baseUrl }),
      fetchImpl: (url, options) => {
        assert.equal(options.redirect, 'error');
        assert.equal(options.credentials, 'omit');
        return translationSession.fetch(url, options);
      },
      validateUrl,
    });
    const translated = await makeTranslation('https://translation.fixture/v1').translate({ segments: [{ id: 'title', text: 'Model 8.1 release' }] });
    assert.equal(translated.ok, true);
    assert.deepEqual(translated.segments, [{ id: 'title', text: '中文译文：Model 8.1 release' }]);
    assert.equal(translated.model, 'fixture-model');
    const redirectedTranslation = await makeTranslation('https://translation.fixture/redirect').translate({ segments: [{ id: 'body', text: 'Untrusted redirect fixture' }] });
    assert.equal(redirectedTranslation.ok, false);
    assert.equal(redirectedTranslation.error, 'network');
    assert.deepEqual(translationRequests, ['https://translation.fixture/v1/chat/completions', 'https://translation.fixture/redirect/chat/completions']);
    console.log('Article network Electron checks passed: manual redirects, images, private hops, stream timeout and isolated translation POST without redirects');
  } finally {
    clearTimeout(deadline);
    isolated.protocol.unhandle('https');
    await isolated.closeAllConnections();
    await isolated.clearStorageData();
    if (translationSession) {
      translationSession.protocol.unhandle('https');
      await translationSession.closeAllConnections();
      await translationSession.clearStorageData();
    }
  }
}

main().then(() => app.quit(), (error) => { console.error(error, { requests, transportRequests }); app.exit(1); });
