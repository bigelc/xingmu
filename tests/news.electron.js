const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', process.env.TODO_TEST_USER_DATA);
const fixture = {
  ok: true, stale: false, error: null, updatedAt: '2026-10-12T01:00:00.000Z',
  items: [
    { id: 'test-news-1', title: '让日常工作更简单：AI 工具的新进展', summary: '这是一条用于界面验收的新闻样本。\n\n打开一条新闻，可以阅读摘要、查看来源，并将有用的信息保存为独立笔记。', source: { name: '测试来源' }, category: '产品动态', links: { aihot: 'https://aihot.news/', original: 'https://example.com/news/1' }, publishedAt: '2026-10-12T00:30:00.000Z', attribution: { name: 'AIHOT', url: 'https://aihot.news/' } },
    { id: 'test-news-2', title: '<img src=x onerror="window.remoteExecuted=true"> 测试标题', summary: '<script>window.remoteExecuted=true</script>\n\n所有远端文字都应作为文本显示。', source: { name: '边界测试' }, links: { aihot: 'https://aihot.news/', original: 'javascript:alert(1)' }, discoveredAt: '2026-10-12T00:00:00.000Z' },
    { id: 'test-news-3', title: '把值得回看的消息收藏起来', summary: '收藏保存在当前本地工作区。', source: { name: '测试来源' }, links: { aihot: 'https://aihot.news/', original: 'https://example.com/news/3' } },
  ],
};
const articleFixture = {
  ok: true, url: 'https://example.com/news/1', title: '完整图文报道', author: '原文作者',
  publishedAt: '2026-10-12T00:30:00.000Z', completeness: 'full', notice: '', error: null,
  blocks: [
    { type: 'heading', level: 2, text: '正文小标题' },
    { type: 'paragraph', text: '这是可以完整阅读的原始报道。'.repeat(80) + '正文最后一段标记。' },
    { type: 'paragraph', text: '<script>window.remoteExecuted=true</script><img src=x onerror="window.remoteExecuted=true">' },
    { type: 'quote', text: '重要原文引述' },
    { type: 'list', items: ['第一项', '第二项'], ordered: true },
    { type: 'image', src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMfoAAAAASUVORK5CYII=', alt: '配图说明', caption: '原文配图' },
  ],
};
async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ width: 1240, height: 616, frame: false, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  const unexpectedNetwork = [];
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    unexpectedNetwork.push(details.url);
    callback({ cancel: true });
  });
  window.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message); });
  const run = (source) => window.webContents.executeJavaScript(source);
  async function installAPI(response = fixture) {
    await run(`
      window.newsCalls = 0; window.openedUrls = []; window.articleRequests = []; window.articleDeferredUrl = ''; window.articleResolvers = {};
      window.newsResponse = ${JSON.stringify(response)};
      window.articleResponse = ${JSON.stringify(articleFixture)};
      window.articleResponses = {};
      window.translationRequests = []; window.translationResolvers = []; window.translationDeferred = false; window.translationResponse = null;
      window.translationTexts = {};
      window.makeTranslationResult = payload => ({ok:true,model:'test-model',segments:payload.segments.map(segment=>({id:segment.id,text:window.translationTexts[segment.id] || ('中文译文 '+segment.id)})).reverse()});
      window.notchAPI = {
        getNews: async () => { window.newsCalls++; return structuredClone(window.newsResponse); },
        openExternal: async (url) => { window.openedUrls.push(url); return true; },
        getNewsArticle: async (payload) => {
          window.articleRequests.push(structuredClone(payload));
          if (window.articleDeferredUrl === payload.url) return new Promise(resolve => { window.articleResolvers[payload.url] = resolve; });
          return structuredClone(window.articleResponses[payload.url] || {...window.articleResponse, url:payload.url});
        },
        translateNewsArticle: async payload => {
          window.translationRequests.push(structuredClone(payload));
          if (window.translationDeferred) return new Promise(resolve=>window.translationResolvers.push(resolve));
          return structuredClone(window.translationResponse || window.makeTranslationResult(payload));
        },
      }; void 0;
    `);
  }
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    window.showInactive();
    await installAPI();
    assert.equal(await run('window.newsCalls'), 0, 'A collapsed app must not fetch news');
    await run(`document.getElementById('home-note').value = '正在写的速记'; document.getElementById('home-note').dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('home-note').dispatchEvent(new Event('blur'));`);
    await run("window.NotchHome.setModuleVisible('news', false)");
    await run('setMode(true)');
    assert.equal(await run('window.newsCalls'), 0, 'A hidden news widget must not fetch on opening home');
    await run("(async () => { await setActiveTab('todo'); window.NotchHome.setModuleVisible('news', true); })()");
    assert.equal(await run('window.newsCalls'), 0, 'Enabling the widget while another page is open must not fetch');
    await run("setActiveTab('home')");
    await run('window.NotchNews.refresh()');
    assert.equal(await run('window.newsCalls'), 1, 'Opening the visible home widget fetches once');
    assert.equal(await run("document.querySelectorAll('#home-news-list [data-news-id]').length"), 3);
    await run("document.querySelector('#home-news-list [data-news-id]').click()");
    const state = await run(`({tab:document.querySelector('.tab.active').dataset.tab,title:document.querySelector('.news-detail-title').textContent,rows:document.querySelectorAll('#news-list [data-news-id]').length,summary:document.querySelector('.news-summary').textContent,refreshDisabled:document.getElementById('news-refresh').disabled})`);
    assert.equal(state.tab, 'news');
    assert.equal(state.title, fixture.items[0].title);
    assert.equal(state.rows, 3);
    assert.ok(state.summary.includes('独立笔记'));
    assert.equal(state.refreshDisabled, true, 'The API cooldown is reflected by the refresh control');
    await run("(async () => { document.querySelector('[data-news-read-mode=original]').click(); const deadline = performance.now() + 2000; while (document.getElementById('news-reader-status')?.dataset.state !== 'ready' && performance.now() < deadline) await new Promise(resolve=>setTimeout(resolve,20)); })()");
    const openedArticle = await run(`({requests:window.articleRequests,mode:document.getElementById('news-detail').dataset.readMode,body:document.getElementById('news-article-body').textContent,images:[...document.querySelectorAll('#news-article-body img')].map(img=>img.getAttribute('src')),unsafeNodes:document.querySelectorAll('#news-article-body script,#news-article-body iframe,#news-article-body webview').length,executed:!!window.remoteExecuted,external:window.openedUrls})`);
    assert.equal(openedArticle.mode, 'original');
    assert.equal(openedArticle.requests.length, 1, 'Original mode extracts one document');
    assert.equal(openedArticle.requests[0].url, 'https://example.com/news/1');
    assert.ok(openedArticle.body.includes('正文最后一段标记。'), 'Long original text must retain its ending');
    assert.ok(openedArticle.body.includes('<script>window.remoteExecuted=true</script>'), 'Source text is displayed literally');
    assert.ok(openedArticle.body.includes('原文配图'));
    assert.deepEqual(openedArticle.images, [articleFixture.blocks.at(-1).src]);
    assert.equal(openedArticle.unsafeNodes, 0);
    assert.equal(openedArticle.executed, false);
    assert.deepEqual(openedArticle.external, [], 'Reading inside the app never launches the external browser');
    assert.equal(await run("document.querySelector('#news-reader-address,#news-reader-viewport,.news-open-browser')"), null, 'Article reading contains no browser chrome');
    const articleLayout = await run(`(async () => {
      const image = document.querySelector('#news-article-body img'); await image.decode();
      const body = document.getElementById('news-article-body'); body.scrollTop = body.scrollHeight;
      window.articleScrollTop = body.scrollTop;
      return {width:image.naturalWidth,height:image.naturalHeight,scrollTop:body.scrollTop,scrollable:body.scrollHeight>body.clientHeight};
    })()`);
    assert.ok(articleLayout.width > 0 && articleLayout.height > 0, 'The inline picture must actually decode');
    assert.equal(articleLayout.scrollable, true, 'A long original must remain scrollable');
    assert.ok(articleLayout.scrollTop > 0);
    await run("document.querySelector('[data-news-action=favorite]').click(); document.querySelector('[data-news-action=save-note]').click();");
    const saved = await run(`({favorites:JSON.parse(localStorage.getItem('notch-news-favorites-v1')),notes:JSON.parse(localStorage.getItem('notch-note-archive-v1')),scratch:localStorage.getItem('notch-home-note'),saveDisabled:document.querySelector('[data-news-action=save-note]').disabled})`);
    assert.equal(saved.favorites[0].id, fixture.items[0].id);
    assert.deepEqual(saved.favorites[0].attribution, fixture.items[0].attribution);
    assert.ok(saved.notes[0].content.includes('数据来源：AIHOT https://aihot.news/'));
    assert.equal(saved.notes.length, 1);
    assert.equal(saved.notes[0].title, fixture.items[0].title);
    assert.ok(saved.notes[0].content.includes('https://example.com/news/1'));
    assert.equal(saved.scratch, '正在写的速记', 'Saving an article must preserve an unfinished scratch note');
    assert.equal(saved.saveDisabled, true);
    assert.equal(await run('window.articleRequests.length'), 1, 'Favorite and save actions preserve the extracted document');
    assert.equal(await run("document.getElementById('news-article-body').scrollTop === window.articleScrollTop"), true, 'Saving and favoriting must not move the reading position');
    assert.equal(await run("document.getElementById('news-detail').dataset.readMode"), 'original');
    await run("document.querySelector('[data-news-read-mode=summary]').click()");
    assert.equal(await run("document.getElementById('news-reader').hidden"), true);
    await run("document.querySelector('[data-news-read-mode=original]').click()");
    assert.equal(await run('window.articleRequests.length'), 1, 'Returning to a loaded original uses the session cache');
    assert.ok(await run("document.getElementById('news-article-body').textContent.includes('正文最后一段标记。')"));

    await run(`window.articleResponses['https://example.com/news/3'] = {ok:false,url:'https://example.com/news/3',blocks:[],error:'fetch_failed'};`);
    await run("(async () => { document.querySelector('#news-list [data-news-id=\"test-news-3\"]').click(); document.querySelector('[data-news-read-mode=original]').click(); const deadline=performance.now()+2000; while(document.getElementById('news-reader-status')?.dataset.state!=='error' && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20)); })()");
    assert.equal(await run("document.getElementById('news-reader-status').dataset.state"), 'error');
    assert.ok(await run("document.querySelector('[data-news-action=reader-retry]') !== null"));
    assert.equal(await run("document.getElementById('news-article-body').textContent.includes('收藏保存在当前本地工作区。')"), false, 'A failed extraction must not pretend the summary is the original');
    await run(`window.articleDeferredUrl='https://example.com/news/3'; document.querySelector('[data-news-action=reader-retry]').click();`);
    assert.equal(await run('window.articleRequests.at(-1).refresh'), true);
    assert.equal(await run("document.getElementById('news-reader-status').dataset.state"), 'loading');
    await run("document.querySelector('#news-list [data-news-id=\"test-news-1\"]').click(); document.querySelector('[data-news-read-mode=original]').click();");
    await run(`window.articleResolvers['https://example.com/news/3']({...window.articleResponse,url:'https://example.com/news/3',title:'稍后完成的第三篇原文',completeness:'partial',notice:'来源仅提供部分正文',blocks:[{type:'paragraph',text:'第三篇原文正文'},{type:'image',src:'https://images.example/unsafe.png',alt:'远端图片说明'},{type:'image',src:'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=',alt:'不支持的图片说明'}]}); window.articleDeferredUrl='';`);
    assert.equal(await run("document.querySelector('.news-detail-title').textContent"), fixture.items[0].title);
    assert.ok(await run("document.getElementById('news-article-body').textContent.includes('正文最后一段标记。')"), 'A late result cannot replace the selected article');
    await run("(async () => { document.querySelector('#news-list [data-news-id=\"test-news-3\"]').click(); document.querySelector('[data-news-read-mode=original]').click(); const deadline=performance.now()+2000; while(document.getElementById('news-reader-status')?.dataset.state!=='ready' && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20)); })()");
    assert.equal(await run("document.getElementById('news-reader').dataset.completeness"), 'partial');
    assert.match(await run("document.getElementById('news-reader-status').textContent"), /部分正文/);
    assert.ok(await run("document.getElementById('news-article-body').textContent.includes('第三篇原文正文')"), 'A retried article can finish while another item is selected');
    assert.equal(await run("document.querySelectorAll('#news-article-body img').length"), 0, 'Remote and SVG image sources must never reach image elements');
    assert.ok(await run("document.getElementById('news-article-body').textContent.includes('远端图片说明')"));
    assert.equal(await run("document.querySelector('[data-news-action=reader-retry]').hidden"), false, 'Partial content offers an explicit way to retrieve the missing text or pictures');
    await run(`window.articleResponses['https://example.com/news/3'] = {...window.articleResponse,url:'https://example.com/news/3',title:'第三篇完整原文',blocks:[{type:'paragraph',text:'重新获取后恢复的完整正文。'},window.articleResponse.blocks.at(-1)]};`);
    await run("(async () => { document.querySelector('[data-news-action=reader-retry]').click(); const deadline=performance.now()+2000; while(document.getElementById('news-reader-status')?.dataset.state!=='ready' && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20)); await document.querySelector('#news-article-body img').decode(); })()");
    assert.equal(await run('window.articleRequests.at(-1).refresh'), true);
    assert.equal(await run("document.getElementById('news-reader').dataset.completeness"), 'full');
    assert.ok(await run("document.getElementById('news-article-body').textContent.includes('重新获取后恢复的完整正文。')"));
    assert.ok(await run("document.querySelector('#news-article-body img').naturalWidth > 0"));
    assert.equal(await run("document.querySelector('[data-news-action=reader-retry]').hidden"), true, 'The retry control disappears after complete content is recovered');
    await run("document.querySelector('[data-news-view=favorites]').click()");
    assert.equal(await run("document.querySelectorAll('#news-list [data-news-id]').length"), 1);
    await run("document.querySelector('[data-news-view=latest]').click(); document.querySelector('#news-list [data-news-id=\"test-news-2\"]').click();");
    const safe = await run(`({title:document.querySelector('.news-detail-title').textContent,unsafeNodes:document.querySelectorAll('#news-page img,#news-page script').length,executed:!!window.remoteExecuted,original:document.querySelector('.news-open-browser')?.hasAttribute('href') === true,originalDisabled:document.querySelector('[data-news-read-mode=original]')?.disabled})`);
    assert.equal(safe.title, fixture.items[1].title);
    assert.equal(safe.unsafeNodes, 0);
    assert.equal(safe.executed, false);
    assert.equal(safe.original, false, 'Non-HTTP source links are never rendered');
    assert.equal(safe.originalDisabled, true);
    await run('window.NotchNews.refresh({force:true})');
    assert.equal(await run('window.newsCalls'), 1, 'Force refresh cannot bypass the UI cooldown');

    // Advance only the clock used by refresh decisions, without waiting a minute.
    await run(`window.realNow = Date.now; Date.now = () => window.realNow() + 61000; window.newsResponse = {...window.newsResponse, stale:true,error:'network_error'};`);
    await run('window.NotchNews.refresh({force:true})');
    assert.equal(await run("document.getElementById('news-feedback').dataset.tone"), 'warning');
    assert.equal(await run("document.querySelectorAll('#news-list [data-news-id]').length"), 3, 'Cached articles remain readable after an update failure');
    await run('Date.now = window.realNow; void 0;');

    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await installAPI({ok:false,items:[],error:'network_error'});
    await run("(async () => { await setMode(true); await window.NotchNews.open(); await window.NotchNews.refresh(); document.querySelector('[data-news-view=favorites]').click(); })()");
    assert.equal(await run("document.querySelectorAll('#news-list [data-news-id]').length"), 1, 'Favorites survive reload and are readable offline');
    assert.equal(await run("document.querySelector('.news-detail-title').textContent"), fixture.items[0].title);
    assert.equal(await run("document.querySelector('[data-news-action=save-note]').disabled"), true);
    await run("document.querySelector('[data-news-view=latest]').click()");
    assert.equal(await run("document.getElementById('news-feedback').dataset.tone"), 'error');
    assert.equal(await run("document.querySelectorAll('#news-list [data-news-id]').length"), 0);

    const beforeDisabled = await run('window.newsCalls');
    await run("applyFeatureSettings({features:{news:false,clip:false}});");
    await run('window.NotchNews.refresh({force:true})');
    assert.equal(await run('window.newsCalls'), beforeDisabled, 'Disabling news prevents refresh requests');
    assert.equal(await run("document.querySelectorAll('#home-news-list [data-news-id]').length"), 0);
    assert.equal(await run("document.getElementById('home-news-refresh').disabled"), true);
    assert.match(await run("document.getElementById('home-news-feedback').textContent"), /已关闭/);
    const settingsDestination = await run("(async () => { document.getElementById('home-news-more').click(); const deadline = performance.now() + 2500; while (document.querySelector('.tab.active').dataset.tab !== 'settings' && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); return document.querySelector('.tab.active').dataset.tab; })()");
    assert.equal(settingsDestination, 'settings');

    // A separate feed exercises progressive disclosure without changing the three-item workflow above.
    const paginationItems = Array.from({ length: 12 }, (_, index) => ({
      ...fixture.items[0], id: `pagination-news-${index + 1}`, title: `第 ${index + 1} 条分页资讯`,
      links: { aihot: 'https://aihot.news/', original: `https://example.com/pagination/${index + 1}` },
    }));
    const paginationFixture = { ...fixture, items: paginationItems };
    const originalFavorites = await run("localStorage.getItem('notch-news-favorites-v1')");
    await run(`localStorage.setItem('notch-news-favorites-v1', ${JSON.stringify(JSON.stringify(paginationItems))});`);
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await installAPI(paginationFixture);
    await run("(async () => { await setMode(true); await setActiveTab('news'); await window.NotchNews.refresh(); })()");
    const paginationState = () => run(`({ids:[...document.querySelectorAll('#news-list [data-news-id]')].map(node=>node.dataset.newsId),count:document.getElementById('news-count').textContent,moreHidden:document.getElementById('news-load-more').hidden,calls:window.newsCalls,articleCalls:window.articleRequests.length})`);
    const capturePagination = async (label) => {
      if (!process.env.TODO_UI_AUDIT_DIR) return;
      fs.mkdirSync(process.env.TODO_UI_AUDIT_DIR, { recursive: true });
      await run('new Promise(resolve => setTimeout(resolve, 250))');
      fs.writeFileSync(path.join(process.env.TODO_UI_AUDIT_DIR, `pagination-${label}.png`), (await window.webContents.capturePage()).toPNG());
    };
    const firstPage = await paginationState();
    assert.deepEqual(firstPage.ids, paginationItems.slice(0, 5).map(item => item.id));
    assert.match(firstPage.count, /5\s*条$/);
    assert.equal(firstPage.moreHidden, false);
    assert.equal(await run("document.getElementById('news-load-more').closest('#news-list') === null"), true, 'The load-more control must stay outside the scrolling article list');
    await capturePagination(5);
    await run("(async () => { document.querySelector('[data-news-read-mode=original]').click(); const deadline=performance.now()+2000; while(document.getElementById('news-reader-status')?.dataset.state!=='ready' && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20)); await document.querySelector('#news-article-body img').decode(); window.paginationReaderBody=document.getElementById('news-article-body'); window.paginationReaderBody.scrollTop=150; window.paginationReaderTop=window.paginationReaderBody.scrollTop; })()");
    assert.ok(await run('window.paginationReaderTop > 0'));
    const beforeMore = await paginationState();
    for (const visible of [10, 12]) {
      await run("document.getElementById('news-load-more').click()");
      const page = await paginationState();
      assert.deepEqual(page.ids, paginationItems.slice(0, visible).map(item => item.id), 'Expanding the feed preserves the source order');
      assert.match(page.count, new RegExp(`${visible}\\s*条$`));
      assert.equal(page.moreHidden, visible === 12);
      assert.equal(page.calls, beforeMore.calls, 'Showing more already-loaded items must not request the news feed again');
      assert.equal(page.articleCalls, beforeMore.articleCalls, 'Showing more list items must not reload the selected original');
      assert.equal(await run("document.getElementById('news-detail').dataset.newsId"), paginationItems[0].id);
      assert.equal(await run("document.getElementById('news-detail').dataset.readMode"), 'original');
      assert.equal(await run("document.getElementById('news-article-body') === window.paginationReaderBody && window.paginationReaderBody.scrollTop === window.paginationReaderTop"), true, 'Load more must preserve the current article DOM and reading position');
      await capturePagination(visible);
    }
    await run("document.querySelector('[data-news-view=favorites]').click()");
    const allFavorites = await paginationState();
    assert.deepEqual(allFavorites.ids, paginationItems.map(item => item.id), 'Favorites are shown in full without pagination');
    assert.equal(allFavorites.moreHidden, true);
    assert.match(allFavorites.count, /12\s*条$/);
    await run("document.querySelector('[data-news-view=latest]').click()");
    assert.equal((await paginationState()).ids.length, 12, 'Switching views preserves the expanded latest feed');
    const beforePaginationRefresh = (await paginationState()).calls;
    await run('window.paginationRealNow=Date.now; Date.now=()=>window.paginationRealNow()+61000; void 0;');
    await run('window.NotchNews.refresh({force:true})');
    assert.equal((await paginationState()).ids.length, 12, 'Manual refresh preserves the expanded count during the same session');
    assert.equal((await paginationState()).calls, beforePaginationRefresh + 1);
    await run('Date.now=()=>window.paginationRealNow()+122000; void 0;');
    await run('window.NotchNews.refresh()');
    assert.equal((await paginationState()).ids.length, 12, 'A later feed update preserves the expanded count');
    assert.equal((await paginationState()).calls, beforePaginationRefresh + 2);
    await run('Date.now=window.paginationRealNow; void 0;');
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await installAPI(paginationFixture);
    await run("(async () => { await setMode(true); await setActiveTab('news'); await window.NotchNews.refresh(); })()");
    assert.deepEqual((await paginationState()).ids, paginationItems.slice(0, 5).map(item => item.id), 'A restarted renderer begins with five latest stories');
    await run(originalFavorites === null ? "localStorage.removeItem('notch-news-favorites-v1')" : `localStorage.setItem('notch-news-favorites-v1', ${JSON.stringify(originalFavorites)});`);

    // Translation fixtures use plain text segments and never invoke a model or upload image bytes.
    const translationItems = Array.from({ length: 5 }, (_, index) => ({
      ...fixture.items[0], id: `translation-news-${index + 1}`, title: `Original report ${index + 1}`,
      links: { aihot: 'https://aihot.news/', original: `https://example.com/translation/${index + 1}` },
    }));
    const englishArticle = {
      ...articleFixture, title: 'Original article headline', author: 'Original author',
      blocks: [
        { type: 'heading', level: 2, text: 'Original section heading' },
        { type: 'paragraph', text: 'This original article describes a useful product and the evidence behind its design. '.repeat(70) + 'The complete original ending.' },
        { type: 'quote', text: 'An original quotation.' },
        { type: 'list', items: ['First original item', 'Second original item'] },
        { ...articleFixture.blocks.at(-1), alt: 'Original image description', caption: 'Original figure caption' },
      ],
    };
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await installAPI({ ...fixture, items: translationItems });
    await run(`window.articleResponse=${JSON.stringify(englishArticle)}; window.translationTexts=${JSON.stringify({ title: '完整中文报道', 'block-0-text': '中文小标题', 'block-1-text': '这是翻译后的完整正文。'.repeat(150) + '中文末段。', 'block-2-text': '中文引用。', 'block-3-item-0': '中文第一项', 'block-3-item-1': '中文第二项', 'block-4-caption': '中文配图标题', 'block-4-alt': '中文图片说明' })};`);
    await run(`window.articleResponses=${JSON.stringify(Object.fromEntries(translationItems.map((item, index) => [item.links.original, { ...englishArticle, url: item.links.original, title: `Original article ${index + 1}`, ...(index === 3 ? { completeness: 'partial', notice: '来源只提供部分正文。' } : {}) }])))};`);
    await run("(async () => { await setMode(true); await setActiveTab('news'); await window.NotchNews.refresh(); })()");
    const waitForArticle = async () => assert.equal(await run("(async () => { const deadline=performance.now()+2000; while(document.getElementById('news-reader-status')?.dataset.state!=='ready' && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20)); return document.getElementById('news-reader-status')?.dataset.state; })()"), 'ready');
    const waitForTranslation = async () => assert.equal(await run("(async () => { const deadline=performance.now()+2000; while(document.getElementById('news-translate-button')?.disabled && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20)); return document.getElementById('news-translate-button')?.disabled; })()"), false);
    const openTranslationArticle = async (index) => {
      await run(`document.querySelector('#news-list [data-news-id="translation-news-${index}"]').click(); document.querySelector('[data-news-read-mode=original]').click();`);
      await waitForArticle();
    };
    await openTranslationArticle(1);
    assert.equal(await run("document.getElementById('news-translate-button').textContent"), '翻译成中文');
    await run("(async () => { await document.querySelector('#news-article-body img').decode(); document.getElementById('news-article-body').scrollTop=180; window.translationOriginalTop=document.getElementById('news-article-body').scrollTop; window.translationDeferred=true; document.getElementById('news-translate-button').click(); document.getElementById('news-translate-button').click(); })()");
    assert.equal(await run('window.translationRequests.length'), 1, 'Repeated clicks share one pending translation');
    assert.equal(await run("document.getElementById('news-translate-button').disabled"), true);
    const translationPayload = await run('window.translationRequests[0]');
    assert.deepEqual(translationPayload.segments.map(segment => segment.id).sort(), ['title', 'block-0-text', 'block-1-text', 'block-2-text', 'block-3-item-0', 'block-3-item-1', 'block-4-caption', 'block-4-alt'].sort());
    assert.ok(translationPayload.segments.every(segment => Object.keys(segment).sort().join(',') === 'id,text'));
    assert.equal(JSON.stringify(translationPayload).includes('data:image'), false, 'Image bytes must never enter a translation request');
    await run('window.translationResolvers.shift()(window.makeTranslationResult(window.translationRequests[0])); window.translationDeferred=false;');
    await waitForTranslation();
    const translated = await run(`({title:document.querySelector('.news-article-title').textContent,body:document.getElementById('news-article-body').textContent,items:[...document.querySelectorAll('#news-article-body li')].map(node=>node.textContent),image:document.querySelector('#news-article-body img').getAttribute('src'),alt:document.querySelector('#news-article-body img').alt,button:document.getElementById('news-translate-button').textContent})`);
    assert.equal(translated.title, '完整中文报道');
    assert.ok(translated.body.includes('中文末段。'));
    assert.ok(translated.body.includes('中文配图标题'));
    assert.deepEqual(translated.items, ['中文第一项', '中文第二项'], 'Returning segments in another order must not reorder the original structure');
    assert.equal(translated.image, articleFixture.blocks.at(-1).src);
    assert.equal(translated.alt, '中文图片说明');
    assert.equal(translated.button, '查看原文');
    if (process.env.TODO_UI_AUDIT_DIR) {
      fs.mkdirSync(process.env.TODO_UI_AUDIT_DIR, { recursive: true });
      for (const [width, height] of [[1240, 616], [1000, 576]]) {
        window.setSize(width, height);
        await run('new Promise(resolve=>setTimeout(resolve,250))');
        fs.writeFileSync(path.join(process.env.TODO_UI_AUDIT_DIR, `translation-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
      window.setSize(1240, 616);
    }
    await run("document.getElementById('news-translate-button').click()");
    assert.equal(await run("document.querySelector('.news-article-title').textContent"), 'Original article 1');
    assert.ok(await run("document.getElementById('news-article-body').textContent.includes('The complete original ending.')"));
    assert.equal(await run("document.getElementById('news-article-body').scrollTop === window.translationOriginalTop"), true, 'Returning to the source restores the original reading position');
    await run("document.getElementById('news-translate-button').click()");
    assert.equal(await run("document.querySelector('.news-article-title').textContent"), '完整中文报道');
    assert.equal(await run('window.translationRequests.length'), 1, 'Original/translation toggles reuse the completed translation');

    await openTranslationArticle(2);
    await run("window.translationDeferred=true; document.getElementById('news-translate-button').click();");
    const staleTranslationIndex = await run('window.translationRequests.length - 1');
    await openTranslationArticle(3);
    await run(`window.translationResolvers.shift()(window.makeTranslationResult(window.translationRequests[${staleTranslationIndex}])); window.translationDeferred=false;`);
    assert.equal(await run("document.querySelector('.news-article-title').textContent"), 'Original article 3', 'A late translation must not replace a newly selected article');
    assert.equal(await run("document.getElementById('news-translate-button').textContent"), '翻译成中文');
    await run("window.translationResponse={ok:false,error:'not_configured'}; document.getElementById('news-translate-button').click();");
    await waitForTranslation();
    assert.equal(await run("document.querySelector('.news-article-title').textContent"), 'Original article 3');
    assert.match(await run("document.getElementById('news-translation-status').textContent"), /设置|配置/);
    assert.equal(await run("document.getElementById('news-translation-settings').hidden"), false);
    await run("document.getElementById('news-translation-settings').click()");
    assert.equal(await run("(async () => { const deadline=performance.now()+2000; while(document.querySelector('.tab.active').dataset.tab!=='settings' && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20)); return document.querySelector('.tab.active').dataset.tab; })()"), 'settings');
    await run("setActiveTab('news')");
    await openTranslationArticle(3);
    for (const invalid of [{ ok: false, error: 'request_failed' }, { ok: true, model: 'test-model', segments: [{ id: 'title', text: '不完整的译文标题' }] }]) {
      await run(`window.translationResponse=${JSON.stringify(invalid)}; document.getElementById('news-translate-button').click();`);
      await waitForTranslation();
      assert.equal(await run("document.querySelector('.news-article-title').textContent"), 'Original article 3', 'Failed or incomplete translations leave every original segment in place');
      assert.ok(await run("document.getElementById('news-article-body').textContent.includes('The complete original ending.')"));
      assert.match(await run("document.getElementById('news-translate-button').textContent"), /翻译成中文|重试翻译/);
      assert.ok(await run("document.getElementById('news-translation-status').textContent.length > 0"));
    }
    await run("window.translationResponse=null; window.translationDeferred=true; document.getElementById('news-translate-button').click();");
    await run("setActiveTab('todo')");
    await run('window.translationResolvers.shift()(window.makeTranslationResult(window.translationRequests.at(-1))); window.translationDeferred=false;');
    assert.equal(await run("document.querySelector('.tab.active').dataset.tab"), 'todo', 'A completed background translation must not navigate back to news');
    await run("setActiveTab('news')");
    await openTranslationArticle(4);
    await run("window.translationResponse=null; document.getElementById('news-translate-button').click();");
    await waitForTranslation();
    assert.equal(await run("document.querySelector('.news-article-title').textContent"), '完整中文报道');
    assert.equal(await run("document.getElementById('news-reader').dataset.completeness"), 'partial');
    assert.match(await run("document.getElementById('news-reader-status').textContent"), /部分正文/);
    await run("window.articleResponses['https://example.com/translation/5']={ok:false,error:'fetch_failed',blocks:[]}; document.querySelector('#news-list [data-news-id=\"translation-news-5\"]').click(); document.querySelector('[data-news-read-mode=original]').click();");
    assert.equal(await run("(async () => { const deadline=performance.now()+2000; while(document.getElementById('news-reader-status')?.dataset.state!=='error' && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20)); return document.getElementById('news-reader-status')?.dataset.state; })()"), 'error');
    assert.equal(await run("document.getElementById('news-translate-button').hidden"), true, 'Unavailable originals cannot offer translation');

    // Optional visual evidence uses fixture data in this isolated profile only.
    if (process.env.TODO_UI_AUDIT_DIR) {
      fs.mkdirSync(process.env.TODO_UI_AUDIT_DIR, { recursive: true });
      await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
      await installAPI(fixture);
      await run('(async () => { await setMode(true); await window.NotchNews.refresh(); })()');
      for (const [width,height] of [[1240,616],[1000,576]]) {
        window.setSize(width,height);
        for (const tab of ['news']) {
          await run(`(async () => { await setActiveTab('${tab}'); await new Promise(resolve=>setTimeout(resolve,750)); })()`);
          const screenshot = await window.webContents.capturePage();
          fs.writeFileSync(path.join(process.env.TODO_UI_AUDIT_DIR, `${tab}-${width}.png`), screenshot.toPNG());
          await run("document.querySelector('[data-news-read-mode=original]').click()");
          await run("(async () => { await new Promise(resolve => setTimeout(resolve, 150)); await Promise.all([...document.querySelectorAll('#news-article-body img')].map(image=>image.decode())); })()");
          const layout = await run(`(() => {
            const viewport = document.getElementById('news-article-body').getBoundingClientRect();
            const outside = [...document.querySelectorAll('#news-detail button, #news-detail input, #news-detail a')].filter(node => {
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && (rect.right > innerWidth || rect.bottom > innerHeight);
            }).map(node => node.id || node.textContent);
            return {height:viewport.height,width:viewport.width,outside};
          })()`);
          assert.ok(layout.height >= 240, 'The original article keeps a useful reading viewport');
          assert.deepEqual(layout.outside, []);
          fs.writeFileSync(path.join(process.env.TODO_UI_AUDIT_DIR, `original-${width}.png`), (await window.webContents.capturePage()).toPNG());
          await run("document.querySelector('[data-news-read-mode=summary]').click()");
        }
      }
    }
    assert.deepEqual(unexpectedNetwork, [], 'Document rendering must not contact source websites or image hosts');
    assert.deepEqual(errors, [], 'News workflow must not produce renderer errors');
    console.log('AI news Electron checks passed: inline document, stale promises, retry, complete text and images, safe rendering, favorites, notes, cooldown, offline recovery');
  } finally { window.destroy(); }
}
main().then(() => app.quit(), (error) => { console.error(error); app.exit(1); });
