const test = require('node:test');
const assert = require('node:assert/strict');
const { createArticleService } = require('../article-service');
const { createPublicHttpsValidator } = require('../news-network');

const ARTICLE_URL = 'https://article.example/story';
const TWEET_URL = 'https://x.com/author/status/1870000000000000000';
const IMAGE_URL = 'https://images.example/figure.png';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMfoAAAAASUVORK5CYII=', 'base64');
const textOf = (result) => result.blocks.map((block) => block.text || block.items?.join('\n') || '').join('\n');
const paragraph = '公开报道讨论了工具的实际使用方式，并保留作者给出的背景、过程和结论。';

function html(body = `<h1>公开报道标题</h1><p>${paragraph.repeat(10)}</p>`) {
  return `<!doctype html><html lang="zh"><head><title>公开报道标题</title><meta name="author" content="原文作者"></head><body><article>${body}</article></body></html>`;
}
function documentResponse(body, headers = {}) {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}
function tweet(extra = {}) {
  return {
    __typename: 'Tweet', id_str: '1870000000000000000', lang: 'zh',
    text: '这是一条完整的公开短文。', created_at: '2026-10-14T00:00:00.000Z',
    user: { name: '原文作者', screen_name: 'author' },
    mediaDetails: [], entities: { urls: [] }, ...extra,
  };
}
function harness(fetchImpl, options = {}) {
  const calls = [];
  const validations = [];
  const validatePublic = createPublicHttpsValidator({ lookup: async (host) => [{ address: host === 'private.example' ? '10.0.0.1' : '93.184.216.34', family: 4 }] });
  const service = createArticleService({
    ...options,
    validateUrl: async (url) => { validations.push(url); return validatePublic(url); },
    fetchImpl: async (url, settings) => { calls.push({ url: String(url), settings }); return fetchImpl(String(url), settings); },
  });
  return { service, calls, validations };
}

test('public HTML is returned as complete plain blocks with the ending and anonymous GET requests intact', async () => {
  const ending = '这是正文最后一段，必须完整保留。';
  const body = html(`<h1>公开报道标题</h1><p>${paragraph.repeat(20)}</p><h2>实际结论</h2><p>${ending}</p><blockquote>作者的原话</blockquote><ul><li>第一项</li><li>第二项</li></ul>`);
  const h = harness(async () => documentResponse(body));
  const result = await h.service.getArticle({ url: ARTICLE_URL });
  assert.equal(result.ok, true);
  assert.equal(result.completeness, 'full');
  assert.ok(textOf(result).includes(ending));
  assert.ok(textOf(result).includes('作者的原话'));
  assert.ok(result.blocks.some((block) => block.type === 'list' && block.items.includes('第二项')));
  assert.ok(result.blocks.every((block) => ['paragraph', 'heading', 'quote', 'list', 'image'].includes(block.type)));
  assert.equal(h.calls[0].settings.method, 'GET');
  assert.equal(h.calls[0].settings.redirect, 'manual');
  assert.equal(h.calls[0].settings.credentials, 'omit');
  assert.equal(h.calls[0].settings.headers.Cookie, undefined);
  assert.equal(h.calls[0].settings.headers.Authorization, undefined);
});

test('a short hero excerpt cannot hide public article text when its container has a sidebar-like class', async () => {
  const intro = 'A short public summary describes this investigation but does not contain the evidence or its final conclusion.';
  const body = 'The public report documents the detailed background, evidence, changes and conclusion for readers. ';
  const ending = 'This is the actual final conclusion of the public investigation.';
  const source = `<html><head><title>Public investigation</title><meta property="og:description" content="${intro}"></head><body><div class="post-hero"><h1>Public investigation</h1><div class="post-hero__excerpt">${intro}</div></div><article class="post post-access-public has-sidebar"><div class="post__content"><p>${body.repeat(12)}</p><figure><img src="${IMAGE_URL}" alt="Evidence chart"><figcaption>Public evidence</figcaption></figure><p>${ending}</p></div></article></body></html>`;
  const h = harness(async (url) => url === IMAGE_URL ? new Response(PNG, { headers: { 'content-type': 'image/png' } }) : documentResponse(source));
  const result = await h.service.getArticle({ url: ARTICLE_URL });
  assert.equal(result.ok, true);
  assert.equal(result.completeness, 'full');
  assert.ok(textOf(result).includes(body.trim()), 'The reader must select the publicly available body, not stop at the hero summary');
  assert.ok(textOf(result).includes(ending));
  assert.deepEqual(result.blocks.filter((block) => block.type === 'image').map((block) => block.src), [`data:image/png;base64,${PNG.toString('base64')}`]);
});

test('retrying extraction below the normal threshold still preserves genuine short public articles', async () => {
  const short = 'This is a complete short public announcement. The product release includes the stated improvement, and this sentence is its final conclusion.';
  const h = harness(async () => documentResponse(html(`<p>${short}</p>`)));
  const result = await h.service.getArticle({ url: ARTICLE_URL });
  assert.equal(result.ok, true);
  assert.equal(result.completeness, 'full');
  assert.equal(textOf(result), short);
});

test('HTML scripts, browser embeds and unsafe link protocols never become executable article output', async () => {
  const body = html(`<p>${paragraph.repeat(10)}</p><script>globalThis.remoteExecuted = true</script><iframe src="https://private.example/"></iframe><p><a href="javascript:alert(1)">危险链接的可读文字</a>，<a href="file:///etc/passwd">文件链接文字</a>。</p><img src="javascript:alert(1)" onerror="globalThis.remoteExecuted=true"><p>安全结尾</p>`);
  const h = harness(async () => documentResponse(body));
  const result = await h.service.getArticle({ url: ARTICLE_URL });
  assert.equal(result.ok, true);
  assert.ok(textOf(result).includes('安全结尾'));
  const serialized = JSON.stringify(result.blocks);
  for (const forbidden of ['globalThis.remoteExecuted', '<script', '<iframe', 'javascript:', 'file:///']) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(h.calls.length, 1, 'Executable image and frame URLs must not be fetched');
  assert.equal(globalThis.remoteExecuted, undefined);
});

test('WeChat article content preserves paragraphs and lazy images without page navigation or account controls', async () => {
  const body = `<html><head><title>微信原文</title></head><body><nav>关注公众号导航</nav><h1 id="activity-name">微信原文</h1><div id="js_content"><p>${paragraph.repeat(4)}</p><img data-src="${IMAGE_URL}" alt="原文配图"><p>微信文章最后一段。</p></div><footer>登录后发表评论</footer></body></html>`;
  const h = harness(async (url) => url === IMAGE_URL ? new Response(PNG, { headers: { 'content-type': 'image/png' } }) : documentResponse(body));
  const result = await h.service.getArticle({ url: 'https://mp.weixin.qq.com/s/public-fixture' });
  assert.equal(result.ok, true);
  assert.ok(textOf(result).includes('微信文章最后一段。'));
  assert.equal(textOf(result).includes('关注公众号导航'), false);
  assert.equal(textOf(result).includes('登录后发表评论'), false);
  assert.deepEqual(result.blocks.filter((block) => block.type === 'image').map((block) => block.src), [`data:image/png;base64,${PNG.toString('base64')}`]);
});

test('X short posts and publicly available long post text preserve the complete text and media', async () => {
  for (const item of [
    tweet({ text: '短文正文，最后一个字。', mediaDetails: [{ type: 'photo', media_url_https: IMAGE_URL }] }),
    tweet({ text: '被截断的预览…', note_tweet: { note_tweet_results: { result: { text: paragraph.repeat(30) + '长文真正的结尾。' } } } }),
  ]) {
    const h = harness(async (url) => {
      if (url === IMAGE_URL) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      assert.equal(new URL(url).origin + new URL(url).pathname, 'https://cdn.syndication.twimg.com/tweet-result');
      assert.equal(new URL(url).searchParams.get('id'), item.id_str);
      return Response.json(item);
    });
    const result = await h.service.getArticle({ url: TWEET_URL });
    assert.equal(result.ok, true);
    assert.equal(result.completeness, 'full');
    assert.ok(textOf(result).includes(item.note_tweet ? '长文真正的结尾。' : '短文正文，最后一个字。'));
    assert.equal(textOf(result).includes('被截断的预览…'), false);
    if (!item.note_tweet) assert.equal(result.blocks.filter((block) => block.type === 'image').length, 1);
  }
});

test('X long-article previews are explicitly partial and access challenges never impersonate original text', async () => {
  for (const item of [
    tweet({ text: '长文预览…', note_tweet: { id: 'public-note-id' } }),
    tweet({ text: 'https://t.co/fixture', article: { title: '长篇文章标题', preview_text: '这只是长篇文章的公开预览。' } }),
  ]) {
    const h = harness(async () => Response.json(item));
    const result = await h.service.getArticle({ url: TWEET_URL });
    assert.equal(result.ok, true);
    assert.equal(result.completeness, 'partial');
    assert.ok(result.notice);
  }
  const blocked = harness(async () => documentResponse('<html><title>Just a moment...</title><body><h1>Verify you are human</h1><p>Enable JavaScript and cookies to continue</p></body></html>'));
  const result = await blocked.service.getArticle({ url: ARTICLE_URL });
  assert.equal(result.ok, false);
  assert.equal((result.blocks || []).length, 0);
});

test('document and image redirects are checked at each hop before accessing private destinations', async () => {
  const h = harness(async (url) => url === ARTICLE_URL
    ? new Response(null, { status: 302, headers: { location: '/public-step' } })
    : new Response(null, { status: 302, headers: { location: 'https://private.example/secret' } }));
  const result = await h.service.getArticle({ url: ARTICLE_URL });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsafe_url');
  assert.deepEqual(h.calls.map((call) => call.url), [ARTICLE_URL, 'https://article.example/public-step']);
  assert.ok(h.validations.includes('https://private.example/secret'));
  for (const url of ['https://127.0.0.1/', 'https://10.0.0.1/', 'https://[::1]/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://article.example/']) {
    const denied = harness(async () => { assert.fail('Unsafe input must be rejected before fetch'); });
    assert.equal((await denied.service.getArticle({ url })).ok, false, url);
  }
  const images = harness(async (url) => url === ARTICLE_URL
    ? documentResponse(html(`<p>${paragraph.repeat(10)}</p><img src="${IMAGE_URL}"><p>正文结尾</p>`))
    : new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private-image' } }));
  const article = await images.service.getArticle({ url: ARTICLE_URL });
  assert.equal(article.ok, true, 'A rejected picture should not discard readable body text');
  assert.equal(article.completeness, 'partial');
  assert.equal(article.blocks.filter((block) => block.type === 'image' && block.src).length, 0);
  assert.equal(images.calls.some((call) => call.url.includes('127.0.0.1')), false);
});

test('only verified raster image bytes are inlined; SVG and MIME mismatches cannot enter the document', async () => {
  for (const image of [
    new Response('<svg onload="alert(1)"></svg>', { headers: { 'content-type': 'image/svg+xml' } }),
    new Response('<script>alert(1)</script>', { headers: { 'content-type': 'image/png' } }),
    new Response(PNG, { headers: { 'content-type': 'image/jpeg' } }),
  ]) {
    const h = harness(async (url) => url === ARTICLE_URL ? documentResponse(html(`<p>${paragraph.repeat(10)}</p><img src="${IMAGE_URL}">`)) : image);
    const result = await h.service.getArticle({ url: ARTICLE_URL });
    assert.equal(result.ok, true);
    assert.equal(result.completeness, 'partial');
    assert.equal(result.blocks.filter((block) => block.type === 'image' && block.src).length, 0);
  }
});

test('declared and streamed documents obey byte limits and redirect chains have a finite bound', async () => {
  for (const response of [documentResponse(html(), { 'content-length': '100000' }), documentResponse(html())]) {
    const h = harness(async () => response, { limits: { maxDocumentBytes: 128 } });
    const result = await h.service.getArticle({ url: ARTICLE_URL });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'response_too_large');
  }
  let hop = 0;
  const loop = harness(async () => new Response(null, { status: 302, headers: { location: `https://article.example/hop-${++hop}` } }), { limits: { maxRedirects: 2 } });
  assert.equal((await loop.service.getArticle({ url: ARTICLE_URL })).ok, false);
  assert.ok(loop.calls.length <= 3, 'Redirect loops must stop within the configured hop bound');
});

test('image and block limits preserve readable text while making truncation explicit', async () => {
  const h = harness(async (url) => url === ARTICLE_URL
    ? documentResponse(html(`<p>${paragraph.repeat(6)}</p><img src="${IMAGE_URL}"><p>结尾仍然可读。</p>`))
    : new Response(PNG, { headers: { 'content-type': 'image/png' } }), { limits: { maxImageBytes: 16 } });
  const result = await h.service.getArticle({ url: ARTICLE_URL });
  assert.equal(result.ok, true);
  assert.equal(result.completeness, 'partial');
  assert.ok(textOf(result).includes('结尾仍然可读。'));
  assert.equal(result.blocks.filter((block) => block.type === 'image' && block.src).length, 0);
  const limited = harness(async () => documentResponse(html(Array.from({ length: 5 }, (_, i) => `<p>第 ${i + 1} 段。${paragraph.repeat(4)}</p>`).join(''))), { limits: { maxBlocks: 2 } });
  const shortened = await limited.service.getArticle({ url: ARTICLE_URL });
  assert.equal(shortened.ok, true);
  assert.ok(shortened.blocks.length <= 2);
  assert.equal(shortened.completeness, 'partial', 'A limited excerpt must never be marked complete');
});

test('an article deadline cancels stalled requests and leaves a later retry usable', async () => {
  let stalled = true;
  let requestSignal;
  const h = harness(async (url, { signal }) => {
    requestSignal = signal;
    if (stalled) return new Promise(() => {});
    return documentResponse(html());
  }, { limits: { timeoutMs: 20 } });
  const first = await h.service.getArticle({ url: ARTICLE_URL });
  assert.equal(first.ok, false);
  assert.equal(first.error, 'timeout');
  assert.equal(requestSignal.aborted, true);
  stalled = false;
  assert.equal((await h.service.getArticle({ url: ARTICLE_URL, refresh: true })).ok, true);
});

test('concurrent article requests share extraction while cached documents remain independent of callers', async () => {
  let finish;
  let now = 1000;
  const h = harness(() => new Promise((resolve) => { finish = resolve; }), { now: () => now });
  const first = h.service.getArticle({ url: ARTICLE_URL });
  const second = h.service.getArticle({ url: ARTICLE_URL });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  finish(documentResponse(html()));
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.ok, true);
  const original = textOf(two);
  one.blocks[0].text = 'caller mutation';
  assert.equal(textOf(await h.service.getArticle({ url: ARTICLE_URL })), original);
  assert.equal(h.calls.length, 1);
  now += 5 * 60 * 1000 + 1;
  const expired = h.service.getArticle({ url: ARTICLE_URL });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 2, 'Expired public content must be retrieved again');
  finish(documentResponse(html('<p>' + paragraph.repeat(10) + '更新正文</p>')));
  assert.ok(textOf(await expired).includes('更新正文'));
});

test('a mismatched X post and a silently followed network redirect cannot authorize unrelated content', async () => {
  const wrongPost = harness(async () => Response.json(tweet({ id_str: '1' })));
  assert.equal((await wrongPost.service.getArticle({ url: TWEET_URL })).ok, false);
  const response = documentResponse(html());
  Object.defineProperty(response, 'url', { value: 'https://127.0.0.1/private' });
  const redirected = harness(async () => response);
  const result = await redirected.service.getArticle({ url: ARTICLE_URL });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsafe_url');
});

test('X video or quoted-post omissions are disclosed instead of claiming the article is complete', async () => {
  for (const extra of [{ mediaDetails: [{ type: 'video', video_info: { variants: [] } }] }, { quoted_tweet: tweet({ text: '未展开的引用原文' }) }]) {
    const h = harness(async () => Response.json(tweet(extra)));
    const result = await h.service.getArticle({ url: TWEET_URL });
    assert.equal(result.ok, true);
    assert.equal(result.completeness, 'partial');
    assert.ok(result.notice);
    assert.ok(textOf(result).includes('这是一条完整的公开短文。'));
    assert.equal(h.calls.length, 1, 'Unavailable media must not trigger extra unauthenticated API guesses');
  }
});

test('malformed article request payloads fail safely before making a network request', async () => {
  const h = harness(async () => { assert.fail('Malformed input must not be fetched'); });
  for (const payload of [null, undefined, {}, [], 42, { url: null }, { url: { toString: () => ARTICLE_URL } }]) {
    const result = await h.service.getArticle(payload);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unsafe_url');
    assert.deepEqual(result.blocks, []);
  }
  assert.equal(h.calls.length, 0);
});

test('a substantial account sign-in page is never mistaken for the original article', async () => {
  const body = `<html><head><title>Sign in to your account</title></head><body><main><h1>Sign in to your account</h1><p>${'Your account gives you access to saved settings and personal information. Enter the email and password associated with your account to continue. '.repeat(4)}</p><form><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password"></label><button>Sign in</button></form></main></body></html>`;
  const h = harness(async () => documentResponse(body));
  const result = await h.service.getArticle({ url: ARTICLE_URL });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'access_required');
  assert.deepEqual(result.blocks, []);
});

test('ordinary articles about CAPTCHA and login features are not mistaken for access challenges', async () => {
  for (const body of [
    `<h1>AI 图像识别研究</h1><p>${'这篇公开报道介绍 CAPTCHA 图像识别研究，讨论模型的识别准确率、测试数据与产品应用。'.repeat(4)}</p>`,
    '<p>新工具增加一键登录功能，公开介绍新界面的使用方式，并支持在手机与电脑之间同步项目。</p>',
    '<p>产品新增订阅管理和账号注册功能。</p>',
  ]) {
    const h = harness(async () => documentResponse(html(body)));
    const result = await h.service.getArticle({ url: ARTICLE_URL });
    assert.equal(result.ok, true);
    assert.notEqual(result.error, 'access_required');
    assert.ok(textOf(result).length > 0);
    assert.ok(textOf(result).includes(body.includes('CAPTCHA') ? 'CAPTCHA' : body.includes('一键登录') ? '一键登录' : '订阅管理'));
  }
});

test('real human-verification and sign-in instructions still stop article extraction', async () => {
  for (const [url, body] of [
    [ARTICLE_URL, '<html><head><title>Verify you are human</title></head><body><main><h1>Verify you are human</h1><p>Please complete the security verification.</p></main></body></html>'],
    [ARTICLE_URL, '<html><head><title>Account</title></head><body><main><p>Please sign in to continue reading.</p></main></body></html>'],
    ['https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha', '<html><head><title>访问验证</title></head><body><p>请完成验证</p></body></html>'],
  ]) {
    const h = harness(async () => documentResponse(body));
    const result = await h.service.getArticle({ url });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'access_required');
    assert.deepEqual(result.blocks, []);
    assert.equal(h.calls.length, 1, 'The reader must not attempt an authenticated or challenge-solving follow-up');
  }
});

test('HTTP access refusal is distinct from an authentication requirement', async () => {
  for (const [status, expected] of [[401, 'access_required'], [403, 'access_denied']]) {
    const h = harness(async () => new Response('Denied', { status }));
    const result = await h.service.getArticle({ url: ARTICLE_URL });
    assert.equal(result.ok, false);
    assert.equal(result.error, expected);
    assert.deepEqual(result.blocks, []);
    assert.equal(h.calls.length, 1);
  }
});

test('DNS failures are reported as network errors without sending the article request', async () => {
  for (const lookup of [async () => { throw new Error('EAI_AGAIN'); }, async () => [], () => new Promise(() => {})]) {
    let fetched = false;
    const service = createArticleService({
      validateUrl: createPublicHttpsValidator({ lookup, timeoutMs: 10 }),
      fetchImpl: async () => { fetched = true; throw new Error('unexpected request'); },
    });
    const result = await service.getArticle({ url: ARTICLE_URL });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'network_error');
    assert.equal(fetched, false);
  }
});

test('an omitted SVG chart is disclosed while a site-header logo does not make an article partial', async () => {
  const chart = harness(async () => documentResponse(html(`<p>${paragraph.repeat(10)}</p><figure><svg role="img" aria-label="Benchmark chart"><rect width="100" height="100"></rect></svg><figcaption>实验对比结果</figcaption></figure><p>图表后的结论。</p>`)));
  const result = await chart.service.getArticle({ url: ARTICLE_URL });
  assert.equal(result.ok, true);
  assert.equal(result.completeness, 'partial');
  assert.ok(result.notice);
  assert.ok(result.blocks.some((block) => block.type === 'image' && !block.src && /Benchmark chart|实验对比结果/.test(`${block.alt} ${block.caption}`)), 'An unsupported article chart must leave a readable description');
  assert.ok(textOf(result).includes('图表后的结论。'));
  const logo = harness(async () => documentResponse(`<html><head><title>公开报道标题</title></head><body><header><svg role="img" aria-label="Site logo"><rect width="100" height="100"></rect></svg></header><article><p>${paragraph.repeat(10)}</p><p>报道结尾。</p></article></body></html>`));
  const complete = await logo.service.getArticle({ url: ARTICLE_URL });
  assert.equal(complete.ok, true);
  assert.equal(complete.completeness, 'full');
  assert.equal(complete.blocks.some((block) => /Site logo/.test(`${block.alt} ${block.text}`)), false);
});
