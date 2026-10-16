(function initNews() {
  'use strict';

  const FAVORITES_KEY = 'notch-news-favorites-v1';
  const FAVORITES_LIMIT = 200;
  const NEWS_PAGE_SIZE = 5;
  const AIHOT_URL = 'https://aihot.news/';
  const MIN_REFRESH_MS = 60000;
  const ARTICLE_CACHE_LIMIT = 4;
  const MAX_ARTICLE_IMAGE_LENGTH = 8 * 1024 * 1024;
  const CATEGORY_LABELS = {
    'ai-models': 'AI 模型', 'ai-products': 'AI 产品', industry: '行业动态',
    paper: '研究论文', tip: '实用技巧', opinion: '观点',
  };
  const home = document.getElementById('home-news');
  const page = document.getElementById('news-page');
  const homeList = document.getElementById('home-news-list');
  const list = document.getElementById('news-list');
  const loadMore = document.getElementById('news-load-more');
  const detail = document.getElementById('news-detail');
  const refreshButtons = [document.getElementById('home-news-refresh'), document.getElementById('news-refresh')].filter(Boolean);
  if (!home || !page || !list || !detail) return;

  const text = (value) => typeof value === 'string' ? value.trim() : '';
  function safeUrl(value, aihotOnly = false) {
    try {
      const url = new URL(text(value));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
      if (aihotOnly && url.hostname !== 'aihot.news' && !url.hostname.endsWith('.aihot.news')) return '';
      return window.NotchDomain.normalizeHttpUrl(url.toString()) || '';
    } catch (error) { return ''; }
  }
  function validDate(value) {
    const parsed = Date.parse(text(value));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  function normalizeArticle(value) {
    if (!value || typeof value !== 'object') return null;
    const id = text(value.id);
    const title = text(value.title);
    if (!id || !title) return null;
    return {
      id, title, summary: text(value.summary),
      source: { name: text(value.source?.name) || 'AIHOT' },
      links: { aihot: safeUrl(value.links?.aihot, true), original: safeUrl(value.links?.original) },
      publishedAt: validDate(value.publishedAt), discoveredAt: validDate(value.discoveredAt),
      category: text(value.category),
      attribution: {
        name: text(value.attribution?.name) || text(value.attribution) || 'AIHOT',
        url: safeUrl(value.attribution?.url, true) || AIHOT_URL,
      },
    };
  }
  function normalizeItems(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).map(normalizeArticle).filter((item) => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }
  function readFavorites() {
    try {
      return normalizeItems(JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]'));
    } catch (error) { return []; }
  }

  let items = [];
  let favorites = readFavorites();
  let view = 'latest';
  let latestVisibleCount = NEWS_PAGE_SIZE;
  let selectedId = '';
  let updatedAt = null;
  let nextRefreshAt = 0;
  let lastAttemptAt = 0;
  let stale = false;
  let error = '';
  let loading = false;
  let loaded = false;
  let inFlight = null;
  let cooldownTimer = null;
  let disposed = false;
  let expanded = document.getElementById('app')?.classList.contains('expanded') === true;
  let currentTab = document.querySelector('.tab.active')?.dataset.tab || 'home';
  let readMode = 'summary';
  let articleSequence = 0;
  let readerStatus = 'closed';
  let readerError = '';
  let articleUrl = '';
  let articleDocument = null;
  let renderedArticleDocument = null;
  const articleCache = new Map();
  const articleRequests = new Map();
  const summaryScrollPositions = new Map();
  const articleScrollPositions = new Map();
  const translations = new WeakMap();

  function element(tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = label;
    return node;
  }
  function button(className, label) {
    const node = element('button', className, label);
    node.type = 'button';
    return node;
  }
  function dateLabel(value, includeYear = false) {
    if (!value) return '时间未提供';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '时间未提供';
    return new Intl.DateTimeFormat('zh-CN', {
      ...(includeYear ? { year: 'numeric' } : {}),
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }
  function sourceLine(item) {
    const stamp = item.publishedAt || item.discoveredAt;
    return `${item.source.name}${stamp ? ` · ${item.publishedAt ? '' : '收录于 '}${dateLabel(stamp)}` : ''}`;
  }
  function toast(message) {
    if (typeof showStatusToast === 'function') showStatusToast(message);
  }
  function newsEnabled() { return document.getElementById('tab-button-news')?.hidden !== true; }
  function visibleItems() { return view === 'favorites' ? favorites : items.slice(0, latestVisibleCount); }
  function selectedArticle() { return (view === 'favorites' ? favorites : items).find((item) => item.id === selectedId) || null; }
  function isFavorite(id) { return favorites.some((item) => item.id === id); }
  function noteId(item) { return `news:${item.id}`; }
  function empty(className, title, description) {
    const node = element('div', className);
    node.append(element('strong', '', title));
    if (description) node.append(element('p', '', description));
    return node;
  }
  function addLink(container, className, label, url) {
    if (!url) return;
    const anchor = element('a', className, label);
    anchor.href = url;
    anchor.rel = 'noopener noreferrer';
    container.append(anchor);
  }
  function setFeedback(node, message, tone) {
    if (!node) return;
    node.textContent = message;
    node.hidden = !message;
    node.dataset.tone = tone || '';
  }

  function syncRefreshButtons() {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
    const cooling = Date.now() < nextRefreshAt;
    refreshButtons.forEach((control) => {
      control.disabled = !newsEnabled() || loading || cooling;
      control.setAttribute('aria-busy', String(loading));
      control.textContent = loading ? '更新中…' : '刷新';
      control.title = !newsEnabled() ? '请在设置中开启 AI 新闻' : loading ? '正在获取新闻' : cooling ? `可于 ${dateLabel(new Date(nextRefreshAt).toISOString())} 再次刷新` : '刷新 AI 新闻';
    });
    // 只更新按钮的冷却状态；不在后台触发新闻请求。
    if (cooling && !disposed) {
      cooldownTimer = setTimeout(syncRefreshButtons, Math.min(nextRefreshAt - Date.now() + 20, 2147483647));
    }
  }
  function renderStatus() {
    let message = '';
    let tone = '';
    if (!newsEnabled()) message = 'AI 新闻已关闭，可在设置的“显示功能”中开启。';
    else if (loading) message = items.length ? '正在更新，当前内容仍可阅读…' : '正在获取 AI 新闻…';
    else if (stale && items.length) {
      message = error ? '暂时无法更新，正在显示上次内容。' : '正在显示上次缓存的内容。';
      tone = 'warning';
    } else if (error && !items.length) {
      message = '暂时无法获取新闻，请稍后刷新重试。';
      tone = 'error';
    }
    setFeedback(document.getElementById('home-news-feedback'), message, tone);
    setFeedback(document.getElementById('news-feedback'), view === 'favorites' ? '' : message, tone);
    for (const id of ['home-news-updated', 'news-updated']) {
      const time = document.getElementById(id);
      if (!time) continue;
      time.textContent = updatedAt ? `${dateLabel(updatedAt)} 更新` : loading ? '正在更新' : '尚未更新';
      if (updatedAt) time.dateTime = updatedAt;
      else time.removeAttribute('datetime');
    }
    const more = document.getElementById('home-news-more');
    if (more) more.textContent = newsEnabled() ? '查看更多 →' : '打开设置 →';
    page.setAttribute('aria-busy', String(loading && !items.length && view === 'latest'));
    document.getElementById('news-count').textContent = `${view === 'favorites' ? '我的收藏' : '今日精选'} · ${visibleItems().length} 条`;
    if (loadMore) {
      const remaining = Math.max(0, items.length - latestVisibleCount);
      loadMore.hidden = view !== 'latest' || remaining === 0;
      loadMore.textContent = `加载更多（${Math.min(NEWS_PAGE_SIZE, remaining)} 条）`;
    }
    syncRefreshButtons();
  }
  function renderHome() {
    if (!homeList) return;
    homeList.replaceChildren();
    if (!newsEnabled()) {
      homeList.append(element('li', 'home-news-empty', '开启 AI 新闻后，精选内容会显示在这里。'));
      return;
    }
    if (!items.length) {
      const row = element('li', 'home-news-empty');
      row.textContent = loading ? '新闻正在路上…' : loaded ? '暂时没有可展示的新闻' : '打开首页后获取 AI 动态';
      homeList.append(row);
      return;
    }
    items.slice(0, 4).forEach((item, index) => {
      const row = element('li', 'home-news-row');
      const control = button('home-news-item', '');
      control.dataset.newsId = item.id;
      control.append(element('span', 'home-news-number', String(index + 1).padStart(2, '0')));
      const copy = element('span', 'home-news-copy');
      copy.append(element('strong', '', item.title));
      control.append(copy);
      row.append(control);
      homeList.append(row);
    });
  }
  function renderList() {
    const previousScroll = list.scrollTop;
    const focusId = list.contains(document.activeElement) ? document.activeElement?.closest('[data-news-id]')?.dataset.newsId : null;
    list.replaceChildren();
    // Refreshes or opening a saved item can move the selection beyond the current batch.
    if (view === 'latest') {
      const selectedIndex = items.findIndex((item) => item.id === selectedId);
      if (selectedIndex >= latestVisibleCount) latestVisibleCount = Math.ceil((selectedIndex + 1) / NEWS_PAGE_SIZE) * NEWS_PAGE_SIZE;
    }
    const rows = visibleItems();
    if (!rows.some((item) => item.id === selectedId)) selectedId = rows[0]?.id || '';
    page.querySelectorAll('[data-news-view]').forEach((control) => {
      const active = control.dataset.newsView === view;
      control.classList.toggle('active', active);
      control.setAttribute('aria-pressed', String(active));
    });
    if (!rows.length) {
      const title = view === 'favorites' ? '还没有收藏' : loading ? '正在获取新闻…' : error ? '新闻暂时未能加载' : '暂时没有新闻';
      const description = view === 'favorites' ? '阅读时点击“收藏”，喜欢的新闻会留在这里。' : '稍后刷新，再看看新的 AI 动态。';
      list.append(empty('news-empty news-list-empty', title, description));
    }
    rows.forEach((item) => {
      const control = button(`news-item${item.id === selectedId ? ' active' : ''}`, '');
      control.dataset.newsId = item.id;
      control.setAttribute('aria-pressed', String(item.id === selectedId));
      control.append(element('strong', 'news-item-title', item.title));
      const meta = element('small', 'news-item-meta', sourceLine(item));
      if (isFavorite(item.id)) meta.append(element('span', 'news-favorite-mark', ' · 已收藏'));
      control.append(meta);
      list.append(control);
      if (item.id === focusId) control.focus({ preventScroll: true });
    });
    list.scrollTop = previousScroll;
  }
  function renderDetail() {
    const previousId = detail.dataset.newsId;
    const item = selectedArticle();
    if (previousId !== item?.id) {
      rememberSummaryScroll();
      resetReader();
      renderedArticleDocument = null;
      detail.replaceChildren();
    }
    if (readMode === 'original' && articleUrl !== item?.links.original) resetReader();
    if (!item) {
      delete detail.dataset.newsId;
      delete detail.dataset.readMode;
      detail.replaceChildren();
      detail.append(empty('news-empty news-detail-empty', view === 'favorites' ? '把值得回看的消息留住' : '读懂今天的 AI 动态', '选择左侧新闻，查看摘要与原始来源。'));
      return;
    }
    detail.dataset.newsId = item.id;
    // Keep the article's DOM and scroll position during save/favorite updates.
    if (!detail.querySelector('.news-detail-head')) {
      const header = element('header', 'news-detail-head');
      const title = element('h2', 'news-detail-title');
      title.tabIndex = -1;
      header.append(element('span', 'news-category'), title, element('div', 'news-meta'));
      const actions = element('div', 'news-detail-actions');
      const favorite = button('workspace-button compact news-favorite', '收藏');
      favorite.dataset.newsAction = 'favorite';
      const save = button('workspace-button compact news-save-note', '保存摘要');
      save.dataset.newsAction = 'save-note';
      save.title = '将新闻摘要与来源保存为一篇笔记';
      actions.append(favorite, save);
      const readBar = element('div', 'news-read-bar');
      const modes = element('div', 'news-read-tabs');
      modes.setAttribute('role', 'group');
      modes.setAttribute('aria-label', '阅读内容');
      for (const [mode, label] of [['summary', '摘要'], ['original', '图文原文']]) {
        const control = button(mode === 'original' ? 'news-original-link' : '', label);
        control.dataset.newsReadMode = mode;
        modes.append(control);
      }
      readBar.append(modes);
      const summary = element('div', 'news-summary');
      summary.id = 'news-summary';
      const reader = element('div', 'news-reader');
      reader.id = 'news-reader';
      reader.hidden = true;
      const status = element('p', 'news-reader-status');
      status.id = 'news-reader-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      const feedback = element('div', 'news-reader-feedback');
      const retry = button('workspace-button compact news-reader-retry', '重新获取');
      retry.dataset.newsAction = 'reader-retry';
      retry.hidden = true;
      feedback.append(status, retry);
      const translationBar = element('div', 'news-translation-bar');
      const translate = button('workspace-button compact', '翻译成中文');
      translate.id = 'news-translate-button';
      translate.dataset.newsAction = 'translate';
      const translationStatus = element('p', 'news-translation-status');
      translationStatus.id = 'news-translation-status';
      translationStatus.setAttribute('role', 'status');
      translationStatus.setAttribute('aria-live', 'polite');
      const translationSettings = button('workspace-button compact', '配置翻译');
      translationSettings.id = 'news-translation-settings';
      translationSettings.dataset.newsAction = 'translation-settings';
      translationSettings.hidden = true;
      translationBar.append(translate, translationStatus, translationSettings);
      const body = element('article', 'news-article-body');
      body.id = 'news-article-body';
      body.tabIndex = 0;
      body.setAttribute('aria-label', '图文原文');
      reader.append(feedback, translationBar, body);
      const attribution = element('footer', 'news-attribution');
      attribution.append(element('span', 'news-attribution-copy'));
      addLink(attribution, 'news-source-link news-aihot-link', '新闻来源：AIHOT ↗', item.attribution.url);
      detail.append(header, actions, readBar, summary, reader, attribution);
      summary.scrollTop = summaryScrollPositions.get(item.id) || 0;
    }
    const category = detail.querySelector('.news-category');
    category.textContent = CATEGORY_LABELS[item.category] || item.category;
    category.hidden = !item.category;
    const title = detail.querySelector('.news-detail-title');
    title.textContent = item.title;
    title.title = item.title;
    detail.querySelector('.news-meta').textContent = sourceLine(item);
    const favorite = detail.querySelector('[data-news-action="favorite"]');
    favorite.textContent = isFavorite(item.id) ? '已收藏' : '收藏';
    favorite.classList.toggle('active', isFavorite(item.id));
    favorite.setAttribute('aria-pressed', String(isFavorite(item.id)));
    favorite.setAttribute('aria-label', isFavorite(item.id) ? '取消收藏这条新闻' : '收藏这条新闻');
    const saved = window.NotchNotes?.has(noteId(item)) === true;
    const save = detail.querySelector('[data-news-action="save-note"]');
    save.textContent = saved ? '摘要已存笔记' : '保存摘要';
    save.disabled = saved;
    const original = detail.querySelector('[data-news-read-mode="original"]');
    original.disabled = !item.links.original;
    original.title = item.links.original ? '直接在卡片内阅读正文与配图' : '这条新闻暂未提供原文链接';
    const summary = detail.querySelector('.news-summary');
    if (summary.dataset.content !== item.summary) {
      const position = previousId === item.id ? summary.scrollTop : summaryScrollPositions.get(item.id) || 0;
      summary.replaceChildren();
      if (item.summary) {
        item.summary.split(/\n\s*\n/).forEach((paragraph) => summary.append(element('p', '', paragraph)));
      } else {
        summary.append(element('p', 'news-summary-empty', item.links.original
          ? '此条新闻暂未提供摘要，可切换到“图文原文”阅读正文。'
          : '此条新闻暂未提供摘要与原文链接，可通过下方 AIHOT 来源了解详情。'));
      }
      summary.dataset.content = item.summary;
      summary.scrollTop = position;
    }
    detail.querySelector('.news-attribution-copy').textContent = `新闻摘要来自 ${item.attribution.name}，原始报道归原作者所有。`;
    detail.querySelector('.news-aihot-link').href = item.links.aihot || item.attribution.url;
    renderReader();
  }
  function rememberSummaryScroll() {
    const summary = detail.querySelector('.news-summary');
    if (detail.dataset.newsId && summary && !summary.hidden) {
      summaryScrollPositions.set(detail.dataset.newsId, summary.scrollTop);
    }
  }
  function readerVisible() {
    return !disposed && readMode === 'original' && currentTab === 'news'
      && expanded && newsEnabled() && !document.hidden;
  }
  function resetReader() {
    rememberArticleScroll();
    articleSequence += 1;
    readerStatus = 'closed';
    readerError = '';
    articleUrl = '';
    articleDocument = null;
    readMode = 'summary';
  }
  function readerFailureLabel(reason) {
    if (reason === 'unavailable') return '当前暂时无法获取图文原文，请稍后重试。';
    if (reason === 'access_required') return '来源返回了登录、订阅或验证页面，暂时未取得正文。';
    if (reason === 'access_denied') return '来源网站拒绝了直接读取请求，暂时未取得正文。';
    if (reason === 'network_error') return '连接来源网站失败，请检查网络后重试。';
    if (reason === 'response_too_large') return '文章超过本次读取大小上限，摘要仍可阅读。';
    if (reason === 'unsupported_content') return '来源内容暂不支持图文提取，摘要仍可阅读。';
    if (reason === 'unsafe_url' || reason === 'invalid_url' || reason === 'blocked_url') return '这条新闻的原文暂时无法读取，摘要仍可阅读。';
    if (reason === 'timeout' || reason === 'load_timeout') return '正文获取超时，请重试。';
    if (reason === 'no_content' || reason === 'extraction_failed' || reason === 'article_unavailable') return '未能取得正文，摘要仍可阅读。';
    return '暂时无法获取图文原文，请稍后重试。';
  }
  function translationState(article) {
    if (!translations.has(article)) translations.set(article, { status: 'idle', error: '', document: null, showTranslation: false, scrollTop: 0 });
    return translations.get(article);
  }
  function rememberArticleScroll() {
    const body = detail.querySelector('#news-article-body');
    if (readMode !== 'original' || readerStatus !== 'ready' || !articleDocument || !body || !detail.dataset.newsId) return;
    const state = translationState(articleDocument);
    if (state.showTranslation) state.scrollTop = body.scrollTop;
    else articleScrollPositions.set(detail.dataset.newsId, body.scrollTop);
  }
  function articleTextSegments(article) {
    const segments = [];
    const add = (id, value) => { if (text(value)) segments.push({ id, text: value }); };
    add('title', article.title);
    article.blocks.forEach((block, index) => {
      if (block.type === 'list') block.items.forEach((value, entry) => add(`block-${index}-item-${entry}`, value));
      else if (block.type === 'image') {
        add(`block-${index}-caption`, block.caption);
        add(`block-${index}-alt`, block.alt);
      } else add(`block-${index}-text`, block.text);
    });
    return segments;
  }
  function translatedDocument(source, segments, result) {
    if (!result?.ok || !Array.isArray(result.segments) || result.segments.length !== segments.length) throw new Error(text(result?.error) || 'invalid_response');
    const expected = new Set(segments.map((entry) => entry.id));
    const values = new Map();
    let length = 0;
    for (const entry of result.segments) {
      if (!entry || !expected.has(entry.id) || values.has(entry.id) || !text(entry.text)) throw new Error('invalid_response');
      length += entry.text.length;
      if (length > 240000) throw new Error('response_too_large');
      values.set(entry.id, entry.text.trim());
    }
    return {
      ...source, title: values.get('title') || source.title, isTranslation: true,
      blocks: source.blocks.map((block, index) => {
        if (block.type === 'list') return { ...block, items: block.items.map((value, entry) => values.get(`block-${index}-item-${entry}`) || value) };
        if (block.type === 'image') return { ...block, caption: values.get(`block-${index}-caption`) || block.caption, alt: values.get(`block-${index}-alt`) || block.alt };
        return { ...block, text: values.get(`block-${index}-text`) || block.text };
      }),
    };
  }
  function translationFailureLabel(reason) {
    if (reason === 'not_configured') return '请先在设置中配置模型 API Key，即可翻译正文。';
    if (reason === 'auth') return '模型服务未通过身份验证，请检查 API Key。';
    if (reason === 'quota') return '模型服务额度不足或请求过于频繁，请稍后再试。';
    if (reason === 'unsafe_endpoint') return '模型 API 地址不可用，请在设置中检查 HTTPS 地址。';
    if (reason === 'too_long') return '正文超过本次翻译长度上限，原文仍可阅读。';
    if (reason === 'busy') return '另一篇文章正在翻译，请完成后再试。';
    if (reason === 'timeout') return '翻译超时，原文已保留，可点击重试。';
    if (reason === 'invalid_response' || reason === 'response_too_large') return '未收到完整可用的译文，原文已保留，可点击重试。';
    return '翻译未完成，请检查网络与模型配置后重试。';
  }
  function renderTranslationControls() {
    const bar = detail.querySelector('.news-translation-bar');
    if (!bar) return;
    const ready = readerStatus === 'ready' && !!articleDocument;
    bar.hidden = !ready;
    const control = bar.querySelector('#news-translate-button');
    control.hidden = !ready;
    if (!ready) return;
    const state = translationState(articleDocument);
    control.disabled = state.status === 'loading';
    control.setAttribute('aria-pressed', String(state.showTranslation));
    control.textContent = state.status === 'loading' ? '正在翻译…' : state.showTranslation ? '查看原文' : state.document ? '查看译文' : state.status === 'error' ? '重试翻译' : '翻译成中文';
    control.title = '使用设置中的 AI 服务翻译已取得的正文，按服务规则计费';
    const status = bar.querySelector('#news-translation-status');
    status.dataset.state = state.status;
    status.textContent = state.status === 'error' ? translationFailureLabel(state.error)
      : state.status === 'loading' ? '正在翻译已取得的文字，原文仍可阅读…'
        : state.showTranslation ? `${articleDocument.completeness === 'partial' ? '部分正文 · ' : ''}AI 中文译文 · 图片内文字保留原样`
          : '按需发送正文到设置中的 AI 服务，图片内文字不翻译。';
    bar.querySelector('#news-translation-settings').hidden = state.status !== 'error' || !['not_configured', 'auth', 'unsafe_endpoint'].includes(state.error);
  }
  async function toggleTranslation() {
    if (!readerVisible() || readerStatus !== 'ready' || !articleDocument) return;
    const source = articleDocument;
    const state = translationState(source);
    if (state.status === 'loading') return;
    rememberArticleScroll();
    if (state.document) {
      state.showTranslation = !state.showTranslation;
      renderReader();
      return;
    }
    state.status = 'loading';
    state.error = '';
    renderTranslationControls();
    try {
      if (typeof window.notchAPI?.translateNewsArticle !== 'function') throw new Error('unavailable');
      const segments = articleTextSegments(source);
      const result = await window.notchAPI.translateNewsArticle({ segments });
      state.document = translatedDocument(source, segments, result);
      state.status = 'ready';
      // The original may have been scrolled while the translation was in flight.
      if (articleDocument === source && readerVisible()) rememberArticleScroll();
      state.showTranslation = true;
    } catch (failure) {
      state.status = 'error';
      state.error = text(failure?.message) || 'request_failed';
    }
    if (articleDocument === source && readerVisible()) renderReader();
  }
  function safeArticleImage(value) {
    if (typeof value !== 'string' || value.length > MAX_ARTICLE_IMAGE_LENGTH) return '';
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([a-z0-9+/]+={0,2})$/i.exec(value);
    if (!match) return '';
    try {
      const prefix = atob(match[2].slice(0, 32));
      const mime = match[1].toLowerCase();
      const valid = mime === 'png' ? prefix.startsWith('\x89PNG\r\n\x1a\n')
        : mime === 'jpeg' ? prefix.startsWith('\xff\xd8\xff')
          : mime === 'gif' ? /^GIF8[79]a/.test(prefix)
            : prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP';
      return valid ? value : '';
    } catch (failure) { return ''; }
  }
  function normalizeArticleDocument(value, fallbackUrl) {
    if (!value || typeof value !== 'object' || value.ok !== true || !Array.isArray(value.blocks)) return null;
    const blocks = [];
    let omitted = value.blocks.length > 500;
    for (const block of value.blocks.slice(0, 500)) {
      if (!block || typeof block !== 'object') { omitted = true; continue; }
      if (['paragraph', 'heading', 'quote'].includes(block.type)) {
        const content = text(block.text);
        if (content) blocks.push({ type: block.type, text: content, level: Math.max(2, Math.min(4, Math.round(Number(block.level)) || 2)) });
      } else if (block.type === 'list' && Array.isArray(block.items)) {
        const entries = block.items.map(text).filter(Boolean);
        if (entries.length) blocks.push({ type: 'list', items: entries });
      } else if (block.type === 'image') {
        const src = safeArticleImage(block.src);
        blocks.push({ type: 'image', src, alt: text(block.alt), caption: text(block.caption) });
        if (!src) omitted = true;
      } else { omitted = true; }
    }
    if (!blocks.length) return null;
    return {
      url: safeUrl(value.url) || fallbackUrl,
      title: text(value.title), author: text(value.author), publishedAt: validDate(value.publishedAt),
      blocks, completeness: value.completeness === 'full' && !omitted ? 'full' : 'partial',
      notice: text(value.notice) || (omitted ? '部分内容或配图未能显示。' : ''),
    };
  }
  function renderArticleDocument(body, article, item) {
    if (renderedArticleDocument === article && body.dataset.articleId === item.id) return;
    body.replaceChildren();
    body.dataset.articleId = item.id;
    const header = element('header', 'news-article-header');
    if (article.isTranslation) header.append(element('span', 'news-translation-badge', 'AI 中文译文'));
    header.append(element('h2', 'news-article-title', article.title || item.title));
    const meta = [article.author, item.source.name];
    try {
      const host = new URL(article.url).hostname;
      if (host && host.toLowerCase() !== item.source.name.toLowerCase()) meta.push(host);
    } catch (failure) { /* A source name is still available when no URL is provided. */ }
    const publishedAt = article.publishedAt || item.publishedAt;
    if (publishedAt) meta.push(dateLabel(publishedAt, true));
    header.append(element('div', 'news-article-meta', meta.filter(Boolean).join(' · ')));
    const content = element('div', 'news-article-blocks');
    for (const block of article.blocks) {
      if (block.type === 'image') {
        const figure = element('figure', 'news-article-figure');
        if (block.src) {
          const picture = element('img', 'news-article-image');
          picture.alt = block.alt;
          picture.loading = 'lazy';
          picture.decoding = 'async';
          picture.src = block.src;
          picture.addEventListener('error', () => {
            picture.hidden = true;
            figure.classList.add('image-unavailable');
            if (!figure.querySelector('.news-article-image-error')) figure.prepend(element('p', 'news-article-image-error', block.alt ? `配图暂时无法显示：${block.alt}` : '这张配图暂时无法显示'));
            article.completeness = 'partial';
            const notice = '有配图暂时无法显示，可重新获取。';
            if (!article.notice.includes(notice)) article.notice = [article.notice, notice].filter(Boolean).join(' ');
            if (renderedArticleDocument === article && readerVisible()) renderReader();
          }, { once: true });
          figure.append(picture);
        } else {
          figure.classList.add('image-unavailable');
          figure.append(element('p', 'news-article-image-error', block.alt ? `配图暂时无法显示：${block.alt}` : '这张配图暂时无法显示'));
        }
        if (block.caption) figure.append(element('figcaption', 'news-article-caption', block.caption));
        content.append(figure);
      } else if (block.type === 'list') {
        const entries = element('ul', 'news-article-list');
        block.items.forEach((entry) => entries.append(element('li', '', entry)));
        content.append(entries);
      } else {
        const tag = block.type === 'heading' ? `h${block.level}` : block.type === 'quote' ? 'blockquote' : 'p';
        content.append(element(tag, `news-article-${block.type}`, block.text));
      }
    }
    body.append(header, content);
    renderedArticleDocument = article;
  }
  function renderReader() {
    const item = selectedArticle();
    const reader = detail.querySelector('.news-reader');
    if (!item || !reader) return;
    detail.dataset.readMode = readMode;
    const original = readMode === 'original';
    detail.querySelectorAll('[data-news-read-mode]').forEach((control) => {
      const active = control.dataset.newsReadMode === readMode;
      control.classList.toggle('active', active);
      control.setAttribute('aria-pressed', String(active));
    });
    const summary = detail.querySelector('.news-summary');
    const restoreSummary = summary.hidden && !original;
    summary.hidden = original;
    if (restoreSummary) summary.scrollTop = summaryScrollPositions.get(item.id) || 0;
    const restoreArticle = reader.hidden && original;
    reader.hidden = !original;
    if (!original) return;
    renderTranslationControls();
    const translation = articleDocument ? translationState(articleDocument) : null;
    const displayedDocument = translation?.showTranslation && translation.document ? translation.document : articleDocument;
    reader.dataset.state = readerStatus;
    reader.dataset.completeness = displayedDocument?.completeness || '';
    const status = detail.querySelector('#news-reader-status');
    status.dataset.state = readerStatus;
    const partial = readerStatus === 'ready' && displayedDocument?.completeness === 'partial';
    status.dataset.tone = partial ? 'warning' : readerStatus === 'error' ? 'error' : '';
    status.textContent = readerStatus === 'ready'
      ? partial ? `部分正文 · ${displayedDocument.notice || '可能缺少段落或配图。'}`
        : ['已加载图文原文', displayedDocument.notice].filter(Boolean).join(' · ')
      : readerStatus === 'error' ? readerFailureLabel(readerError) : '正在获取正文与配图…';
    const retry = reader.querySelector('[data-news-action="reader-retry"]');
    retry.hidden = readerStatus !== 'error' && !partial;
    retry.textContent = partial ? '重新获取' : '重试';
    retry.title = '重新获取正文与配图';
    const body = detail.querySelector('#news-article-body');
    body.setAttribute('aria-busy', String(readerStatus === 'loading'));
    body.setAttribute('aria-label', translation?.showTranslation ? 'AI 中文译文' : '图文原文');
    if (readerStatus === 'ready' && articleDocument) {
      const needsRender = renderedArticleDocument !== displayedDocument || body.dataset.articleId !== item.id;
      renderArticleDocument(body, displayedDocument, item);
      if (needsRender || restoreArticle) body.scrollTop = translation?.showTranslation ? translation.scrollTop : articleScrollPositions.get(item.id) || 0;
    } else {
      renderedArticleDocument = null;
      delete body.dataset.articleId;
      body.replaceChildren();
      const placeholder = empty('news-article-placeholder', readerStatus === 'error' ? '图文原文暂时无法获取' : '正在整理图文原文…',
        readerStatus === 'error' ? '可以重新尝试，或切回摘要继续阅读。' : '正文与配图会直接显示在这张卡片里。');
      body.append(placeholder);
    }
  }
  async function openReader(refresh = false) {
    const item = selectedArticle();
    if (!item?.links.original || disposed || currentTab !== 'news' || !expanded || !newsEnabled() || document.hidden) return;
    rememberSummaryScroll();
    resetReader();
    const requestSequence = articleSequence;
    const requestUrl = item.links.original;
    const requestArticleId = item.id;
    articleUrl = requestUrl;
    readMode = 'original';
    const cached = !refresh && articleCache.get(requestUrl);
    if (cached) {
      articleCache.delete(requestUrl);
      articleCache.set(requestUrl, cached);
      articleDocument = cached;
      readerStatus = 'ready';
      renderDetail();
      return;
    }
    readerStatus = 'loading';
    renderDetail();
    articleRequests.set(requestUrl, requestSequence);
    try {
      if (typeof window.notchAPI?.getNewsArticle !== 'function') throw new Error('unavailable');
      const result = await window.notchAPI.getNewsArticle({ url: requestUrl, refresh });
      const article = normalizeArticleDocument(result, requestUrl);
      if (!article) throw new Error(text(result?.error) || 'no_content');
      if (!disposed && articleRequests.get(requestUrl) === requestSequence) {
        articleCache.delete(requestUrl);
        articleCache.set(requestUrl, article);
        while (articleCache.size > ARTICLE_CACHE_LIMIT) articleCache.delete(articleCache.keys().next().value);
      }
      if (requestSequence !== articleSequence || !readerVisible() || selectedId !== requestArticleId
        || selectedArticle()?.links.original !== requestUrl) return;
      articleDocument = article;
      readerStatus = 'ready';
    } catch (failure) {
      if (requestSequence !== articleSequence || !readerVisible() || selectedId !== requestArticleId) return;
      readerStatus = 'error';
      readerError = text(failure?.message) || 'load_failed';
    } finally {
      if (articleRequests.get(requestUrl) === requestSequence) articleRequests.delete(requestUrl);
    }
    renderReader();
  }
  function render() {
    renderHome();
    renderList();
    renderDetail();
    renderStatus();
  }

  function toggleFavorite() {
    const item = selectedArticle();
    if (!item) return;
    const exists = isFavorite(item.id);
    if (!exists && favorites.length >= FAVORITES_LIMIT) {
      toast('收藏已满 200 条，请先移除不需要的收藏。');
      return;
    }
    const next = exists ? favorites.filter((entry) => entry.id !== item.id) : [normalizeArticle(item), ...favorites];
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      favorites = next;
      const keepFocus = document.activeElement?.dataset.newsAction === 'favorite';
      render();
      if (keepFocus) detail.querySelector('[data-news-action="favorite"]')?.focus({ preventScroll: true });
      toast(exists ? '已取消收藏' : '已收藏，可在“我的收藏”中回看');
    } catch (error) { toast('收藏未能保存，请检查本机可用空间后重试。'); }
  }
  function saveToNotes() {
    const item = selectedArticle();
    if (!item) return;
    const content = [
      `# ${item.title}`, '', '## 新闻摘要', '', item.summary || '此条新闻未提供摘要。', '',
      `来源：${item.source.name}`, `发布时间：${item.publishedAt ? dateLabel(item.publishedAt, true) : '未提供'}`,
      ...(item.discoveredAt ? [`收录时间：${dateLabel(item.discoveredAt, true)}`] : []),
      ...(item.links.original ? [`原文：${item.links.original}`] : []),
      `AIHOT：${item.links.aihot || AIHOT_URL}`,
      '', `数据来源：${item.attribution.name} ${item.attribution.url}`,
    ].join('\n');
    const result = window.NotchNotes?.append({ id: noteId(item), title: item.title, content });
    if (!result?.ok) {
      toast(result?.error === 'archive_full' ? '笔记已满 200 篇，请先整理笔记后再保存。' : '笔记未能保存，请稍后重试。');
      return;
    }
    renderDetail();
    toast(result.existed ? '这条新闻的摘要与来源已在笔记中' : '摘要与来源已保存到笔记');
  }
  async function openNews(id = '') {
    const newsTab = document.getElementById('tab-button-news');
    if (newsTab?.hidden) {
      toast('请先在设置的“显示功能”中开启 AI 新闻。');
      return;
    }
    view = 'latest';
    if (id) selectedId = id;
    render();
    if (typeof setActiveTab === 'function') await setActiveTab('news');
    maybeLoad();
  }
  async function openLink(event) {
    const anchor = event.target.closest('a[href]');
    if (!anchor) return;
    event.preventDefault();
    const url = safeUrl(anchor.href);
    if (!url) return;
    try {
      if (!window.notchAPI?.openExternal) throw new Error('unavailable');
      await window.notchAPI.openExternal(url);
    } catch (error) { toast('暂时无法打开链接，请稍后重试。'); }
  }
  function shouldLoad() {
    return !disposed && newsEnabled() && expanded && !document.hidden
      && (currentTab === 'news' && view === 'latest'
        || currentTab === 'home' && window.NotchHome?.isVisible?.('news') === true);
  }
  function maybeLoad() {
    if (!shouldLoad()) return;
    if (loaded && Date.now() < nextRefreshAt) return;
    loadNews(false);
  }
  function loadNews(force = false) {
    if (!newsEnabled()) return Promise.resolve(null);
    if (inFlight) return inFlight;
    if (loaded && Date.now() < nextRefreshAt) {
      if (force) toast('刚刚更新过，请稍后再刷新。');
      return Promise.resolve(null);
    }
    loading = true;
    lastAttemptAt = Date.now();
    render();
    inFlight = Promise.resolve().then(async () => {
      try {
        if (!window.notchAPI?.getNews) throw new Error('unavailable');
        const result = await window.notchAPI.getNews({ force });
        if (disposed) return null;
        if (!result || typeof result !== 'object') throw new Error('invalid_response');
        if (result.ok) {
          items = normalizeItems(result.items);
          updatedAt = validDate(result.updatedAt);
          stale = result.stale === true;
          error = text(result.error);
        } else {
          stale = items.length > 0;
          error = text(result.error) || 'request_failed';
        }
        const backendNext = Date.parse(result.nextRefreshAt || '');
        nextRefreshAt = Math.max(lastAttemptAt + MIN_REFRESH_MS, Number.isFinite(backendNext) ? backendNext : 0);
        return result;
      } catch (failure) {
        if (!disposed) {
          stale = items.length > 0;
          error = 'request_failed';
          nextRefreshAt = lastAttemptAt + MIN_REFRESH_MS;
        }
        return null;
      } finally {
        loaded = true;
        loading = false;
        inFlight = null;
        if (!disposed) render();
      }
    });
    return inFlight;
  }

  refreshButtons.forEach((control) => control.addEventListener('click', () => loadNews(true)));
  loadMore?.addEventListener('click', () => {
    if (view !== 'latest' || latestVisibleCount >= items.length) return;
    const firstNewIndex = visibleItems().length;
    const hadFocus = document.activeElement === loadMore;
    latestVisibleCount = Math.min(items.length, latestVisibleCount + NEWS_PAGE_SIZE);
    renderList();
    renderStatus();
    if (hadFocus && loadMore.hidden) list.children[firstNewIndex]?.focus({ preventScroll: true });
  });
  document.getElementById('home-news-more')?.addEventListener('click', () => {
    if (!newsEnabled() && typeof setActiveTab === 'function') setActiveTab('settings');
    else openNews();
  });
  home.addEventListener('click', (event) => {
    const row = event.target.closest('[data-news-id]');
    if (row) openNews(row.dataset.newsId);
    else openLink(event);
  });
  page.addEventListener('click', (event) => {
    const viewButton = event.target.closest('[data-news-view]');
    if (viewButton) {
      if (view !== viewButton.dataset.newsView) {
        rememberSummaryScroll();
        resetReader();
      }
      view = viewButton.dataset.newsView === 'favorites' ? 'favorites' : 'latest';
      render();
      if (view === 'latest') maybeLoad();
      return;
    }
    const row = event.target.closest('[data-news-id]');
    if (row && list.contains(row)) {
      selectedId = row.dataset.newsId;
      renderList();
      renderDetail();
      return;
    }
    const readButton = event.target.closest('[data-news-read-mode]');
    if (readButton) {
      if (readButton.disabled || readButton.dataset.newsReadMode === readMode) return;
      if (readButton.dataset.newsReadMode === 'original') openReader();
      else { resetReader(); renderDetail(); }
      return;
    }
    const action = event.target.closest('[data-news-action]')?.dataset.newsAction;
    if (action === 'favorite') toggleFavorite();
    if (action === 'save-note') saveToNotes();
    if (action === 'reader-retry') openReader(true);
    if (action === 'translate') toggleTranslation();
    if (action === 'translation-settings' && typeof setActiveTab === 'function') {
      Promise.resolve(setActiveTab('settings')).then(() => document.getElementById('settings-api-configure')?.focus());
    }
    openLink(event);
  });
  document.addEventListener('notch:tabchange', (event) => {
    currentTab = event.detail?.tab || currentTab;
    if (currentTab !== 'news') resetReader();
    if (currentTab === 'news') renderDetail();
    maybeLoad();
  });
  document.addEventListener('notch:modechange', (event) => {
    expanded = event.detail?.expanded === true;
    if (!expanded) { resetReader(); renderDetail(); }
    maybeLoad();
  });
  document.addEventListener('notch:home-modules-changed', maybeLoad);
  document.addEventListener('notch:featureschange', () => {
    if (!newsEnabled()) resetReader();
    render();
    maybeLoad();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { resetReader(); renderDetail(); }
    maybeLoad();
  });
  window.addEventListener('pagehide', () => {
    disposed = true;
    clearTimeout(cooldownTimer);
    resetReader();
    articleCache.clear();
    articleRequests.clear();
    articleScrollPositions.clear();
    summaryScrollPositions.clear();
  }, { once: true });
  window.NotchNews = { refresh: (options = {}) => loadNews(options.force === true), open: openNews };
  render();
  maybeLoad();
})();
