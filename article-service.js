const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');
const { createPublicHttpsValidator } = require('./news-network');

const ARTICLE_LIMITS = Object.freeze({
  maxDocumentBytes: 2 * 1024 * 1024,
  maxImageBytes: 4 * 1024 * 1024,
  maxTotalImageBytes: 12 * 1024 * 1024,
  maxImages: 12,
  maxBlocks: 400,
  maxTextChars: 200000,
  timeoutMs: 15000,
  maxRedirects: 5,
  maxCacheBytes: 32 * 1024 * 1024,
});
const cleanText = (value) => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const errorCode = (error) => ['unsafe_url', 'network_error', 'timeout', 'response_too_large', 'unsupported_content', 'access_required', 'access_denied', 'article_unavailable'].includes(error?.message) ? error.message : 'fetch_failed';

function httpsUrl(value, base) {
  try {
    if (typeof value !== 'string' || value.length > 8192) return null;
    const url = new URL(value, base);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(new Error('timeout'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('timeout'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readBytes(response, maxBytes, signal) {
  if (Number(response.headers?.get?.('content-length')) > maxBytes) {
    void response.body?.cancel?.().catch(() => {});
    throw new Error('response_too_large');
  }
  if (!response.body?.getReader) throw new Error('unsupported_content');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('response_too_large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { try { reader.releaseLock(); } catch {} }
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function decodeEntities(value) {
  const { document } = parseHTML('<html><body><textarea></textarea></body></html>');
  const element = document.querySelector('textarea');
  element.innerHTML = String(value || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return cleanText(element.textContent);
}

function inlineText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeName === 'BR') return '\n';
  if (node.nodeName === 'IMG') return '';
  return Array.from(node.childNodes || []).map(inlineText).join('');
}

function documentBlocks(root, base) {
  const blocks = [];
  const image = (node) => {
    const candidate = node.getAttribute('data-src') || node.getAttribute('data-original') || node.getAttribute('src');
    const src = candidate ? httpsUrl(candidate, base)?.href : null;
    blocks.push({ type: 'image', ...(src ? { _url: src } : {}), alt: cleanText(node.getAttribute('alt')) || '文章图片',
      caption: cleanText(node.closest('figure')?.querySelector('figcaption')?.textContent) });
  };
  const textBlock = (node, type, extra = {}) => {
    const text = cleanText(inlineText(node));
    if (text) blocks.push({ type, text, ...extra });
    for (const child of node.querySelectorAll('img')) image(child);
  };
  function walk(node) {
    if (node.nodeType === 3) {
      const text = cleanText(node.textContent);
      if (text) blocks.push({ type: 'paragraph', text });
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.nodeName;
    if (tag === 'IMG') { image(node); return; }
    if (/^H[1-6]$/.test(tag)) { textBlock(node, 'heading', { level: Number(tag[1]) }); return; }
    if (tag === 'P' || tag === 'PRE') { textBlock(node, 'paragraph'); return; }
    if (tag === 'BLOCKQUOTE') { textBlock(node, 'quote'); return; }
    if (tag === 'UL' || tag === 'OL') {
      const items = Array.from(node.children).filter((child) => child.nodeName === 'LI').map((child) => cleanText(inlineText(child))).filter(Boolean);
      if (items.length) blocks.push({ type: 'list', items });
      for (const child of node.querySelectorAll('img')) image(child);
      return;
    }
    if (tag === 'FIGCAPTION') return;
    let inline = '';
    const flush = () => { const text = cleanText(inline); if (text) blocks.push({ type: 'paragraph', text }); inline = ''; };
    for (const child of node.childNodes) {
      if (child.nodeType === 3 || (child.nodeType === 1 && /^(A|SPAN|B|STRONG|I|EM|SMALL|MARK|CODE|BR|SUP|SUB)$/.test(child.nodeName) && !child.querySelector('img'))) inline += inlineText(child);
      else { flush(); walk(child); }
    }
    flush();
  }
  walk(root);
  return blocks;
}

function extractHtml(html, url) {
  const { document } = parseHTML(html);
  Object.defineProperty(document, 'documentURI', { value: url });
  Object.defineProperty(document, 'baseURI', { value: url });
  const meta = (selector) => cleanText(document.querySelector(selector)?.getAttribute('content'));
  const title = cleanText(document.querySelector('#activity-name, .rich_media_title')?.textContent)
    || meta('meta[property="og:title"]') || cleanText(document.title);
  const heading = cleanText(document.querySelector('h1')?.textContent);
  const loginHeading = [title, heading].some((value) => /^(?:(?:sign in|log in|login)(?:\s+to\s+(?:your\s+)?account)?|登录|登陆|账户登录|账号登录)(?:\s*[-|：:]\s*.{1,60})?[.!。]*$/i.test(value));
  const hasArticleBody = Boolean(document.querySelector('#js_content,article,[itemprop="articleBody"]'));
  if (document.querySelector('input[type="password"]') && !document.querySelector('#js_content')
    && [title, heading].some((value) => /^(?:sign in|log in|login|登录|登陆|账户登录)(?:\b|[ ：:]|$)/i.test(value))) {
    throw new Error('access_required');
  }
  const author = cleanText(document.querySelector('#js_name')?.textContent) || meta('meta[name="author"]') || meta('meta[property="article:author"]');
  const publishedAt = meta('meta[property="article:published_time"]') || document.querySelector('time[datetime]')?.getAttribute('datetime') || null;
  const preview = meta('meta[property="og:description"]') || meta('meta[name="description"]');
  // A source chart is part of its article even when this reader cannot safely
  // render its format. Replace it with a plain image-description placeholder;
  // page branding and navigation icons must not affect article completeness.
  const articleRoot = document.querySelector('#js_content,article,[itemprop="articleBody"],main,[role="main"]');
  for (const node of document.querySelectorAll('svg,canvas')) {
    if (!articleRoot?.contains(node) || node.closest('header,nav,footer,aside,button')) continue;
    if (node.nodeName === 'SVG' && !node.closest('figure') && node.getAttribute('role') !== 'img' && !node.hasAttribute('aria-label')) continue;
    const placeholder = document.createElement('img');
    const description = cleanText(node.getAttribute('aria-label') || node.querySelector('title')?.textContent);
    // Readability removes source-less images. This inert marker keeps the
    // position; documentBlocks rejects its protocol and never fetches it.
    placeholder.setAttribute('src', 'about:blank');
    placeholder.setAttribute('alt', `图表暂不能显示${description ? `：${description}` : ''}`);
    node.replaceWith(placeholder);
  }
  for (const node of document.querySelectorAll('script,style,iframe,object,embed,svg,canvas,video,audio,form,button,input,select,textarea,nav,footer,aside,noscript,[hidden],[aria-hidden="true"]')) node.remove();
  const wechat = new URL(url).hostname === 'mp.weixin.qq.com';
  const wechatContent = document.querySelector('#js_content');
  const pageText = cleanText(document.body?.textContent).slice(0, 5000);
  // An article may discuss CAPTCHA or authentication. Require an actual
  // verification instruction on a challenge-shaped page, not those keywords.
  const challengeHeading = [title, heading].some((value) => /^(?:just a moment(?:\.{0,3}|…)?|(?:please\s+)?verify (?:that )?you are human(?: to continue)?|checking your browser(?:\.{0,3}|…)?|(?:安全|人机)验证|请完成验证|请输入验证码|环境异常)(?:\s*[-|：:]\s*.{1,60})?$/i.test(value));
  const challengeInstruction = /^(?:(?:please\s+)?(?:verify (?:that )?you are human|complete (?:the )?(?:security )?(?:verification|captcha)|enable javascript and cookies to continue|checking your browser)|(?:请(?:先)?(?:完成|进行)(?:安全|人机)?验证|请输入验证码|(?:当前)?环境异常))/i.test(pageText)
    || (challengeHeading && /verify (?:that )?you are human|enable javascript.*cookies|请(?:先)?(?:完成|进行)(?:安全|人机)?验证|请输入验证码/i.test(pageText));
  const accessRequired = !wechatContent && (
    (wechat && new URL(url).pathname === '/mp/wappoc_appmsgcaptcha')
    || (pageText.length < 1000 && challengeInstruction && (challengeHeading || !hasArticleBody))
  );
  if (accessRequired) throw new Error('access_required');
  let content = wechatContent;
  let parsed;
  if (!content && !wechat) {
    // Keep Readability's normal retry threshold: a short hero excerpt must not
    // end extraction before it retries an article with a sidebar-like class.
    // The threshold controls retries, not whether a short article is returned.
    try { parsed = new Readability(document.cloneNode(true), { charThreshold: 500, maxElemsToParse: 20000 }).parse(); } catch {}
    if (parsed?.content) content = parseHTML(`<html><body>${parsed.content}</body></html>`).document.body;
  }
  if (!content && !wechat) content = document.querySelector('article,main,[role="main"]');
  let blocks = content ? documentBlocks(content, url) : [];
  let completeness = 'full';
  let notice = '';
  const textLength = blocks.reduce((sum, block) => sum + (block.text || block.items?.join('') || '').length, 0);
  if (!textLength) {
    if (!preview) throw new Error('article_unavailable');
    blocks = [{ type: 'paragraph', text: preview }];
    completeness = 'partial';
    notice = '来源仅提供公开摘要，未取得完整正文。';
  }
  if (!wechatContent && textLength > 0 && textLength < 80) {
    const extractedText = cleanText(blocks.map((block) => block.text || block.items?.join(' ') || '').join(' '));
    const loginInstruction = /^(?:(?:please\s+)?(?:sign in|log in|login)\s+to\s+(?:continue|read|view)|请(?:先)?(?:登录|登陆|订阅)(?:后|以|来|再)?(?:继续|阅读|查看))/i.test(extractedText);
    if ((!hasArticleBody && loginHeading) || loginInstruction) throw new Error('access_required');
    completeness = 'partial'; notice = '仅取得少量公开文字，无法确认已包含完整正文。';
  }
  if (/subscribe to (?:continue|read)|sign in to (?:continue|read)|订阅后(?:阅读|查看)|登录后(?:阅读|查看)|付费阅读/i.test(pageText)) {
    completeness = 'partial'; notice = '来源存在登录或订阅限制，仅显示公开内容。';
  }
  return { title: title || cleanText(parsed?.title), author: author || cleanText(parsed?.byline), publishedAt,
    blocks, completeness, notice };
}

function extractTweet(data, id) {
  if (!data || data.id_str !== id || typeof data.text !== 'string') throw new Error('article_unavailable');
  const article = data.article;
  const note = data.note_tweet;
  const noteText = note?.text || note?.note_tweet_results?.result?.text;
  const articleText = typeof article?.text === 'string' ? article.text : null;
  let body = article ? (articleText || article.preview_text || '') : (noteText || data.text);
  const incomplete = Boolean((article && !articleText) || (note && !noteText) || /(?:…|\.{3})\s*$/.test(body));
  const omittedQuote = Boolean(data.quoted_tweet);
  const omittedVideo = Boolean(data.video || data.mediaDetails?.some?.((item) => item.type && item.type !== 'photo'));
  for (const entity of data.entities?.urls || []) {
    if (typeof entity.url === 'string' && typeof entity.expanded_url === 'string') body = body.split(entity.url).join(entity.expanded_url);
  }
  const blocks = decodeEntities(body).split(/\n{2,}/).filter(Boolean).map((text) => ({ type: 'paragraph', text }));
  const media = [
    ...(Array.isArray(data.photos) ? data.photos.map((photo) => ({ url: photo.url, alt: photo.alt_text })) : []),
    ...(Array.isArray(data.mediaDetails) ? data.mediaDetails.filter((item) => item.type === 'photo').map((item) => ({ url: item.media_url_https, alt: item.ext_alt_text })) : []),
    ...(article?.cover_media?.media_info?.original_img_url ? [{ url: article.cover_media.media_info.original_img_url, alt: article.title }] : []),
  ];
  const seen = new Set();
  for (const item of media) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    const url = httpsUrl(item.url);
    blocks.push({ type: 'image', ...(url ? { _url: url.href } : {}), alt: cleanText(item.alt) || '原文图片' });
  }
  if (!blocks.some((block) => block.text)) throw new Error('article_unavailable');
  return { title: cleanText(article?.title) || `${cleanText(data.user?.name) || 'X'} 的帖子`,
    author: cleanText(data.user?.name), publishedAt: typeof data.created_at === 'string' ? data.created_at : null,
    blocks, completeness: incomplete || omittedQuote || omittedVideo ? 'partial' : 'full',
    notice: [
      incomplete ? (article ? 'X 仅公开提供这篇长文章的预览，以下不是完整正文。' : 'X 只返回了这条长帖的部分正文。') : '',
      omittedQuote ? '引用的帖子未包含在本次正文中。' : '',
      omittedVideo ? '原文含视频，当前仅显示文字与配图。' : '',
    ].filter(Boolean).join(' ') };
}

function createArticleService({ fetchImpl = globalThis.fetch, validateUrl = createPublicHttpsValidator(), now = Date.now, limits: overrides = {} } = {}) {
  const limits = Object.fromEntries(Object.entries(ARTICLE_LIMITS).map(([key, max]) => [key, Number.isInteger(overrides[key]) && overrides[key] > 0 ? Math.min(max, overrides[key]) : max]));
  const cache = new Map();
  const pending = new Map();
  let cacheBytes = 0;
  async function request(value, accept, maxBytes, signal) {
    let target = httpsUrl(value);
    for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
      if (!target || !await abortable(() => validateUrl(target.href), signal)) throw new Error('unsafe_url');
      const response = await abortable(() => fetchImpl(target.href, {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal,
        headers: { Accept: accept },
      }), signal);
      if (response.url && response.url !== target.href) throw new Error('unsafe_url');
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location');
        void response.body?.cancel?.().catch(() => {});
        if (!location || hop === limits.maxRedirects) throw new Error('unsafe_url');
        target = httpsUrl(location, target.href);
        continue;
      }
      if (response.status === 401) throw new Error('access_required');
      if (response.status === 403) throw new Error('access_denied');
      if (!response.ok) throw new Error('fetch_failed');
      const mime = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
      return { url: target.href, mime, bytes: await readBytes(response, maxBytes, signal) };
    }
    throw new Error('unsafe_url');
  }

  async function load(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    let result;
    try {
      if (!await abortable(() => validateUrl(url), controller.signal)) throw new Error('unsafe_url');
      const parsedUrl = new URL(url);
      const tweetId = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/.test(parsedUrl.hostname) ? parsedUrl.pathname.match(/^\/(?:[^/]+|i\/web)\/status\/(\d{1,24})(?:\/|$)/)?.[1] : null;
      if (tweetId) {
        const endpoint = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=zh&token=0`;
        const response = await request(endpoint, 'application/json', limits.maxDocumentBytes, controller.signal);
        if (response.mime !== 'application/json') throw new Error('unsupported_content');
        result = extractTweet(JSON.parse(response.bytes.toString('utf8')), tweetId);
      } else {
        const response = await request(url, 'text/html,application/xhtml+xml', limits.maxDocumentBytes, controller.signal);
        if (!['text/html', 'application/xhtml+xml'].includes(response.mime)) throw new Error('unsupported_content');
        result = extractHtml(response.bytes.toString('utf8'), response.url);
      }
      const notices = result.notice ? [result.notice] : [];
      let textChars = 0;
      let limited = result.blocks.length > limits.maxBlocks;
      result.blocks = result.blocks.slice(0, limits.maxBlocks).map((block) => {
        const copy = { ...block };
        for (const key of ['text', 'alt', 'caption']) {
          if (typeof copy[key] !== 'string') continue;
          const max = key === 'text' ? Math.max(0, limits.maxTextChars - textChars) : 1000;
          if (copy[key].length > max) limited = true;
          copy[key] = copy[key].slice(0, max);
          if (key === 'text') textChars += copy[key].length;
        }
        if (copy.items) copy.items = copy.items.map((item) => { const text = item.slice(0, Math.max(0, limits.maxTextChars - textChars)); if (text.length !== item.length) limited = true; textChars += text.length; return text; }).filter(Boolean);
        return copy;
      });
      if (limited) { result.completeness = 'partial'; notices.push('文章较长，已达到本次读取长度上限。'); }
      const images = result.blocks.filter((block) => block.type === 'image');
      let imageBytes = 0;
      let nextImage = 0;
      let missingImages = 0;
      async function imageWorker() {
        while (nextImage < images.length) {
          const index = nextImage++;
          const block = images[index];
          const source = block._url;
          delete block._url;
          if (!source || index >= limits.maxImages || controller.signal.aborted) { missingImages += 1; continue; }
          try {
            const response = await request(source, 'image/png,image/jpeg,image/gif,image/webp', limits.maxImageBytes, controller.signal);
            const mime = imageMime(response.bytes);
            if (!mime || mime !== response.mime || imageBytes + response.bytes.length > limits.maxTotalImageBytes) throw new Error('unsupported_content');
            imageBytes += response.bytes.length;
            block.src = `data:${mime};base64,${response.bytes.toString('base64')}`;
          } catch { missingImages += 1; }
        }
      }
      await Promise.all([imageWorker(), imageWorker(), imageWorker()]);
      if (missingImages) { result.completeness = 'partial'; notices.push(`${missingImages} 张配图暂未载入，已保留图片说明。`); }
      return { ok: true, url, ...result, title: result.title.slice(0, 500), author: result.author.slice(0, 200), notice: notices.join(' ') };
    } catch (error) {
      return { ok: false, url, title: '', author: '', publishedAt: null, blocks: [], completeness: 'partial', error: controller.signal.aborted ? 'timeout' : errorCode(error) };
    } finally { clearTimeout(timer); controller.abort(); }
  }

  async function getArticle(payload = {}) {
    const { url, refresh = false } = payload && typeof payload === 'object' ? payload : {};
    const target = httpsUrl(url);
    if (!target) return { ok: false, url: typeof url === 'string' ? url : '', title: '', author: '', publishedAt: null, blocks: [], completeness: 'partial', error: 'unsafe_url' };
    const key = target.href;
    const cached = cache.get(key);
    if (!refresh && cached && cached.expires > now()) return structuredClone(cached.result);
    if (!pending.has(key)) {
      const operation = load(key).then((result) => {
        if (result.ok) {
          const bytes = Buffer.byteLength(JSON.stringify(result));
          const previous = cache.get(key);
          if (previous) { cacheBytes -= previous.bytes; cache.delete(key); }
          while (cache.size && (cacheBytes + bytes > limits.maxCacheBytes || cache.size >= 8)) {
            const oldest = cache.keys().next().value;
            cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
          }
          if (bytes <= limits.maxCacheBytes) { cache.set(key, { result, bytes, expires: now() + 5 * 60 * 1000 }); cacheBytes += bytes; }
        }
        return result;
      }).finally(() => pending.delete(key));
      pending.set(key, operation);
    }
    return structuredClone(await pending.get(key));
  }
  return { getArticle };
}

module.exports = { createArticleService, ARTICLE_LIMITS };
