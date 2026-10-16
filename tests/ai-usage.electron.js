const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { PROVIDERS } = require('../ai-providers');
app.setPath('userData', process.env.TODO_TEST_USER_DATA);
const metric = (inputTokens = 0, outputTokens = 0, requests = 0, unreportedRequests = 0) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, requests, unreportedRequests });
const empty = { ok: true, startedAt: '2026-10-15T00:00:00Z', updatedAt: null, totals: { today: metric(), month: metric() }, models: [], connections: [] };
const rich = {
  ...empty, updatedAt: '2026-10-15T08:00:00Z', totals: { today: metric(300,150,32,2), month: metric(600,300,62,2) },
  models: Array.from({length:30}, (_,index) => ({ provider: index % 2 ? 'moonshot' : 'deepseek', model: `model-${String(index).padStart(2,'0')}-${'long-name-'.repeat(12)}`, today: metric(10,5,1), month: metric(20,10,2) })),
  connections: [
    { id: 'cny', provider: 'deepseek', name: 'DeepSeek', balance: { status: 'ready', amount: 12.5, currency: 'CNY', updatedAt: '2026-10-15T08:00:00Z', stale: false } },
    { id: 'usd', provider: 'deepseek', name: 'DeepSeek', balance: { status: 'ready', amount: 4.75, currency: 'USD', updatedAt: '2026-10-15T08:00:00Z', stale: false } },
    { id: 'unsupported', provider: 'qwen', balance: { status: 'unsupported' } },
    { id: 'missing-key', provider: 'anthropic', balance: { status: 'not_configured' } },
    { id: 'debt', provider: 'moonshot', balance: { status: 'ready', amount: -2.5, currency: 'CNY', updatedAt: '2026-10-15T07:00:00Z', stale: true } },
  ],
};
const billRow = (date, overrides = {}) => ({ date, model: 'deepseek-v3', apiKey: '', apiKeyId: null, currency: 'CNY', cost: null, requests: null, inputTokens: null, outputTokens: null, totalTokens: null, ...overrides });
const account = { id:'cny',provider:'deepseek',updatedAt:'2026-10-15T08:00:00Z',importsCount:1,
  rows:[billRow('2026-10-15',{cost:0.03}),billRow('2026-10-15',{apiKey:'••••same',apiKeyId:'key-a',requests:2,inputTokens:100,outputTokens:50,totalTokens:150}),billRow('2026-10-14',{cost:0.02}),billRow('2026-10-14',{apiKey:'••••same',apiKeyId:'key-b',requests:1,inputTokens:70,outputTokens:30,totalTokens:100})],
  coverage:[{startDate:'2026-09-16',endDate:'2026-10-15',currency:'CNY',metrics:['cost','requests','inputTokens','outputTokens','totalTokens']}],
};
rich.accountUsage={ok:true,accounts:[account,{id:'orphan',provider:'deepseek',updatedAt:'2026-10-15T08:00:00Z',importsCount:2,rows:[billRow('2026-10-15',{cost:9,currency:'USD'}),billRow('2026-10-15',{cost:11,currency:'CNY'})],coverage:[{startDate:'2026-10-15',endDate:'2026-10-15',currency:'USD',metrics:['cost']},{startDate:'2026-10-15',endDate:'2026-10-15',currency:'CNY',metrics:['cost']}]}]};
empty.accountUsage={ok:true,accounts:[]};
async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ width:1240, height:616, frame:false, show:false, webPreferences:{ backgroundThrottling:false } });
  const errors = [], network = [];
  window.webContents.on('console-message', details => { if(details.level==='error') errors.push(details.message); });
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (details,callback) => {network.push(details.url); callback({cancel:true});});
  const run = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error(`${error.message}\nRenderer step: ${source.slice(0,600)}\n${errors.join('\n')}`); }
  };
  const change = (selector,value) => run(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const wait = condition => run(`(async()=>{const until=performance.now()+2500;while(!(${condition})){if(performance.now()>until)throw Error('Timed out: '+${JSON.stringify(condition)});await new Promise(resolve=>setTimeout(resolve,10));}})()`);
  async function installAPI(response, { failFeature = false } = {}) {
    await run(`window.usageResponse=${JSON.stringify(response)};window.usageCalls=[];window.usageResolvers=[];window.deferUsage=false;
      window.importCalls=[];window.previewCalls=[];window.commitCalls=[];window.importResolvers=[];window.deferImport=false;window.chooseResponse={ok:true,importId:'csv-1',fileName:'bill.csv',format:'generic',headers:['日期','模型','费用'],suggestedMapping:{date:'日期',model:'模型',cost:'费用'},rowCount:1};window.previewResponse={ok:true,token:'preview-1',preview:{rowCount:1,startDate:'2026-10-15',endDate:'2026-10-15',metrics:{cost:0.08,requests:null,totalTokens:null},currency:'CNY',warnings:[],replaceNotice:'替换所选日期的同类统计'}};
      window.featureCalls=[];window.failFeature=${JSON.stringify(failFeature)};
      window.appSettings=JSON.parse(localStorage.getItem('test-usage-app-settings')||'null')||{features:{'ai-usage':false,clip:false},defaultTab:'home'};
      window.persistAppSettings=()=>{localStorage.setItem('test-usage-app-settings',JSON.stringify(window.appSettings));applyFeatureSettings(structuredClone(window.appSettings));return {ok:true,settings:structuredClone(window.appSettings)};};
      window.notchAPI={
        getAppSettings:async()=>structuredClone(window.appSettings),
        setFeature:async(id,enabled)=>{window.featureCalls.push({id,enabled});if(window.failFeature)return {ok:false};window.appSettings.features[id]=enabled;return window.persistAppSettings();},
        setDefaultTab:async tab=>{window.appSettings.defaultTab=tab;return window.persistAppSettings();},
        getAIUsage:async payload=>{window.usageCalls.push(structuredClone(payload));return window.deferUsage?new Promise(resolve=>window.usageResolvers.push(resolve)):structuredClone(window.usageResponse);},
        chooseAIUsageImport:async payload=>{window.importCalls.push(structuredClone(payload));return structuredClone(window.chooseResponse);},
        previewAIUsageImport:async payload=>{window.previewCalls.push(structuredClone(payload));return window.deferImport?new Promise(resolve=>window.importResolvers.push(resolve)):structuredClone(window.previewResponse);},
        commitAIUsageImport:async payload=>{window.commitCalls.push(structuredClone(payload));if(window.commitResponse?.ok===false)return window.commitResponse;if(window.importedResponse)window.usageResponse=structuredClone(window.importedResponse);return {ok:true};},
        getAISettings:async()=>({ok:true,version:1,providers:${JSON.stringify(PROVIDERS)},connections:[],assignments:{translation:null,naming:null,speech:null},disabledTasks:[],secureStorage:true}),
      };
      // Advance the UI's minute timer locally; short DOM waits and animations
      // still use Chromium's clock. No external network or one-minute sleeps.
      window.usageClock=Date.parse('2026-10-15T08:00:00Z');Date.now=()=>window.usageClock;
      window.usageTimers=new Map();window.usageTimerId=-1000;
      const realSetTimeout=window.setTimeout.bind(window),realClearTimeout=window.clearTimeout.bind(window);
      window.setTimeout=(callback,delay,...args)=>{if(delay>=30000){const id=--window.usageTimerId;window.usageTimers.set(id,{at:window.usageClock+delay,callback:()=>callback(...args)});return id;}return realSetTimeout(callback,delay,...args);};
      window.clearTimeout=id=>{window.usageTimers.delete(id);realClearTimeout(id);};
      window.advanceUsageClock=async milliseconds=>{const until=window.usageClock+milliseconds;for(let i=0;i<20;i++){const next=[...window.usageTimers].filter(([,timer])=>timer.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;window.usageTimers.delete(next[0]);window.usageClock=next[1].at;next[1].callback();await new Promise(resolve=>realSetTimeout(resolve,20));}window.usageClock=until;};applyFeatureSettings(structuredClone(window.appSettings));void 0;`);
  }
  const load = () => window.loadFile(path.join(__dirname,'..','renderer','index.html'));
  const total = "document.querySelector('#ai-usage-totals strong').textContent";
  const localTotal = "document.querySelector('#ai-usage-local-totals strong').textContent";
  const settled = "document.getElementById('ai-usage-page').getAttribute('aria-busy')==='false'";
  try {
    await load(); window.showInactive(); await installAPI(empty);
    assert.equal(await run("document.getElementById('tab-button-ai-usage').hidden"),true);
    assert.equal(await run("document.querySelectorAll('#home-bento [data-home-module]').length"),6);
    await run('setMode(true)'); assert.equal(await run('window.usageCalls.length'),0);
    await run("setActiveTab('settings')"); await wait("!document.querySelector('[data-settings-feature=ai-usage]').checked");
    await click('[data-settings-feature=ai-usage]'); await wait("!document.getElementById('tab-button-ai-usage').hidden");
    assert.equal(await run('window.usageCalls.length'),0);
    await click('#tab-button-ai-usage'); await wait(`window.usageCalls.length===1 && ${settled}`);
    assert.equal(await run("document.getElementById('ai-usage-account').value"),'import:deepseek');
    assert.equal(await run(total),'—','No imported account data is unknown, never zero');
    assert.match(await run("document.getElementById('ai-usage-coverage').textContent"),/尚无账单数据/);
    assert.equal(await run("document.getElementById('ai-usage-local').open"),false,'Local counters stay secondary and collapsed');
    assert.equal(await run(localTotal),'0');
    await load(); await installAPI(rich); await run('setMode(true)');
    assert.equal(await run('window.usageCalls.length'),0);
    await click('#tab-button-ai-usage'); await wait(`${total}==='0.05 CNY' && ${settled}`);
    assert.equal(await run("document.getElementById('ai-usage-account').value"),'cny');
    assert.deepEqual(await run("[...document.querySelectorAll('#ai-usage-totals strong')].map(n=>n.textContent)"),['0.05 CNY','3','250']);
    assert.equal(await run("document.getElementById('ai-usage-balance').textContent"),'12.50 CNY');
    assert.equal(await run("document.getElementById('ai-usage-imported-cost').textContent"),'0.05 CNY');
    assert.match(await run("document.getElementById('ai-usage-imported-note').textContent"),/非账号历史总消费/);
    assert.equal(await run("document.querySelectorAll('#ai-usage-key-filter option').length"),3,'Same masked labels keep distinct stable Key IDs');
    const calls=await run('window.usageCalls.length');
    await change('#ai-usage-key-filter','key-a');
    assert.deepEqual(await run("[...document.querySelectorAll('#ai-usage-totals strong')].map(n=>n.textContent)"),['—','2','150']);
    assert.match(await run("document.getElementById('ai-usage-coverage').textContent"),/费用文件未分 API Key/);
    await change('#ai-usage-key-filter','');
    await click('#ai-usage-period-today'); assert.equal(await run(total),'0.03 CNY');
    await click('#ai-usage-period-custom'); await change('#ai-usage-start-date','2026-09-01'); await change('#ai-usage-end-date','2026-10-15');
    assert.equal(await run(total),'至少 0.05 CNY'); assert.match(await run("document.getElementById('ai-usage-coverage').textContent"),/部分数据/);
    assert.ok(await run("document.querySelectorAll('.ai-usage-bar[data-known=false]').length>0"),'Uncovered days remain unknown in the chart');
    await click('#ai-usage-period-month'); await click('[data-usage-chart=totalTokens]');
    assert.match(await run("document.getElementById('ai-usage-chart').getAttribute('aria-label')"),/总 Token/);
    await click('[data-usage-group=apiKey]'); assert.match(await run("document.getElementById('ai-usage-breakdown').textContent"),/未分 API Key/);
    assert.equal(await run('window.usageCalls.length'),calls,'Local date and dimension filters do not query the network');
    await change('#ai-usage-account','usd'); assert.equal(await run("document.getElementById('ai-usage-balance').textContent"),'4.75 USD'); assert.equal(await run(total),'—');
    await change('#ai-usage-account','debt'); assert.equal(await run("document.getElementById('ai-usage-balance').textContent"),'-2.50 CNY'); assert.doesNotMatch(await run("document.getElementById('ai-usage-balance-note').textContent"),/刷新失败/);
    await change('#ai-usage-account','orphan'); assert.equal(await run("document.getElementById('ai-usage-imported-cost').textContent"),'11.00 CNY');
    await change('#ai-usage-currency','USD'); assert.equal(await run("document.getElementById('ai-usage-imported-cost').textContent"),'9.00 USD');
    assert.equal(await run("document.querySelector('#ai-usage-totals .ai-usage-metric:nth-child(2) strong').textContent"),'—','Cost-only data cannot become zero requests');
    await change('#ai-usage-account','cny');
    await click('#ai-usage-import'); await wait("!!document.getElementById('ai-usage-map-date')");
    assert.equal(await run('window.importCalls.at(-1).accountId'),'cny');
    await change('#ai-usage-map-date',''); await click('#ai-usage-import-preview-button');
    assert.equal(await run('window.previewCalls.length'),0); assert.match(await run("document.getElementById('ai-usage-import-preview').textContent"),/请选择日期列/);
    await change('#ai-usage-map-date','日期'); await click('#ai-usage-import-preview-button');
    await wait("document.getElementById('ai-usage-import-preview').textContent.includes('0') || window.previewCalls.length===1");
    assert.equal(await run("document.getElementById('ai-usage-import-commit').disabled"),true,'Saving requires account ownership confirmation');
    assert.match(await run("document.getElementById('ai-usage-import-preview').textContent"),/费用 0\.08 CNY · 请求 未知 · Token 未知/,'Preview presents known totals and missing metrics before committing');
    await click('#ai-usage-import-confirm');
    const imported=structuredClone(rich);imported.accountUsage.accounts[0]={...account,importsCount:2,rows:[billRow('2026-10-15',{cost:0.08})],coverage:[{startDate:'2026-10-15',endDate:'2026-10-15',currency:'CNY',metrics:['cost']}]};
    await run(`window.importedResponse=${JSON.stringify(imported)};`); await click('#ai-usage-import-commit');
    await wait(`document.getElementById('ai-usage-import-panel').hidden && document.getElementById('ai-usage-imported-cost').textContent==='0.08 CNY' && ${settled}`);
    assert.deepEqual(await run('window.commitCalls.at(-1)'),{token:'preview-1'}); assert.equal(await run('window.usageCalls.at(-1).refresh'),false,'Import refreshes the local snapshot without requerying balances');
    await run("window.chooseResponse={ok:true,importId:'zip-1',fileName:'deepseek.zip',format:'deepseek',rowCount:3,detectedRange:{startDate:'2026-09-16',endDate:'2026-10-15'}};");
    await click('#ai-usage-import'); await wait('window.previewCalls.length===2');
    assert.equal(await run("document.getElementById('ai-usage-map-date')"),null,'Official ZIP skips manual mapping');
    assert.equal(await run('window.previewCalls.at(-1).mapping'),undefined);
    assert.equal(await run('window.previewCalls.at(-1).startDate'),'2026-09-16');
    await click('#ai-usage-import-cancel');
    await run('window.deferImport=true;'); await click('#ai-usage-import'); await wait('window.importResolvers.length===1');
    await change('#ai-usage-account','usd');
    await run('window.importResolvers[0](window.previewResponse)'); await run('new Promise(resolve=>setTimeout(resolve,20))');
    assert.equal(await run("document.getElementById('ai-usage-import-panel').hidden"),true,'Changing account rejects a late import preview');
    await change('#ai-usage-account','cny'); await run(`window.deferImport=false;window.usageResponse=${JSON.stringify(rich)};document.dispatchEvent(new CustomEvent('notch:ai-settings-changed'));`); await wait(`${total}==='0.05 CNY' && ${settled}`);
    assert.equal(await run('window.usageCalls.at(-1).refresh'),true,'New credential identities may refresh immediately');
    await click('#ai-usage-local summary');
    assert.match(await run("document.getElementById('ai-usage-scope').textContent"),/本程序.*不含外部软件与语音转写/);
    assert.equal(await run(localTotal),'至少 450');
    for(const [width,height] of [[1240,616],[1000,576]]) {
      window.setSize(width,height);await run('new Promise(resolve=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)),500))');
      const geometry=await run(`(()=>{const page=document.getElementById('ai-usage-page'),body=document.getElementById('ai-usage-body'),r=page.getBoundingClientRect();body.scrollTop=body.scrollHeight;return{inside:r.top>=document.getElementById('tabs').getBoundingClientRect().bottom&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1,scrollable:body.scrollHeight>body.clientHeight,noHorizontalOverflow:body.scrollWidth<=body.clientWidth+1,controls:[...page.querySelectorAll('.ai-usage-head button,.ai-usage-head select')].every(n=>{const b=n.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&b.bottom<=r.bottom})};})()`);
      assert.equal(geometry.inside,true);assert.equal(geometry.scrollable,true);assert.equal(geometry.noHorizontalOverflow,true);assert.equal(geometry.controls,true);
      await run("document.getElementById('ai-usage-body').scrollTop=0;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      if(process.env.TODO_UI_AUDIT_DIR){fs.mkdirSync(process.env.TODO_UI_AUDIT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TODO_UI_AUDIT_DIR,`ai-usage-account-${width}.png`),(await window.webContents.capturePage()).toPNG());}
    }
    const zeroBill=structuredClone(rich);zeroBill.accountUsage.accounts[0]={...account,rows:[],coverage:[{startDate:'2026-09-16',endDate:'2026-10-15',currency:'CNY',metrics:['cost','requests','inputTokens','outputTokens','totalTokens']}]};
    await run(`window.usageResponse=${JSON.stringify(zeroBill)};document.dispatchEvent(new CustomEvent('notch:ai-settings-changed'));`);await wait(`${total}==='0.00 CNY' && ${settled}`);
    assert.deepEqual(await run("[...document.querySelectorAll('#ai-usage-totals strong')].map(n=>n.textContent)"),['0.00 CNY','0','0'],'Official empty bill coverage means confirmed zero, unlike no import');
    assert.equal(await run("document.getElementById('ai-usage-imported-cost').textContent"),'0.00 CNY');
    assert.doesNotMatch(await run("document.getElementById('ai-usage-coverage').textContent"),/尚无账单数据/);
    assert.equal(await run("document.querySelectorAll('.ai-usage-bar[data-known=false]').length"),0);
    await run(`window.usageResponse=${JSON.stringify(rich)};document.dispatchEvent(new CustomEvent('notch:ai-settings-changed'));`);await wait(`${total}==='0.05 CNY' && ${settled}`);
    const beforePoll=await run('window.usageCalls.length');await run('window.advanceUsageClock(61000)');assert.equal(await run('window.usageCalls.length'),beforePoll+1);
    await click('#ai-usage-configure');await wait('window.NotchAISettings.isOpen()');const coveredCalls=await run('window.usageCalls.length');await run('window.advanceUsageClock(120000)');assert.equal(await run('window.usageCalls.length'),coveredCalls);
    await run('window.NotchAISettings.close()');await wait(`window.usageCalls.length>${coveredCalls} && ${settled}`);
    await run("setActiveTab('news')");const hiddenCalls=await run('window.usageCalls.length');await run('window.advanceUsageClock(120000)');assert.equal(await run('window.usageCalls.length'),hiddenCalls);
    await run("setActiveTab('ai-usage')");await wait(`window.usageCalls.length>${hiddenCalls} && ${settled}`);
    await run("window.deferUsage=true;document.dispatchEvent(new CustomEvent('notch:ai-settings-changed'));");await wait('window.usageResolvers.length===1');
    const pendingCalls=await run('window.usageCalls.length');await run("window.notchAPI.setFeature('ai-usage',false)");await wait("document.querySelector('.tab.active').dataset.tab==='home'");
    await run('window.advanceUsageClock(120000)');assert.equal(await run('window.usageCalls.length'),pendingCalls);
    const outdated=structuredClone(rich);outdated.accountUsage.accounts[0].rows[0].cost=9999;
    await run(`window.usageResolvers[0](${JSON.stringify(outdated)});`);await run('new Promise(resolve=>setTimeout(resolve,20))');assert.doesNotMatch(await run(total),/9,999/);
    await run(`window.deferUsage=false;window.usageResponse=${JSON.stringify(rich)};window.notchAPI.setFeature('ai-usage',true);setActiveTab('ai-usage');`);await wait(`${total}==='0.05 CNY'`);
    await run("setActiveTab('settings')");await wait("!document.querySelector('#settings-default-tab option[value=ai-usage]').disabled");await change('#settings-default-tab','ai-usage');await wait("window.appSettings.defaultTab==='ai-usage'");
    await run('setMode(false)');await run('setMode(true)');await wait("document.querySelector('.tab.active').dataset.tab==='ai-usage'");
    const collapseCalls=await run('window.usageCalls.length');await run('setMode(false)');await run('window.advanceUsageClock(120000)');assert.equal(await run('window.usageCalls.length'),collapseCalls);

    // Reproduce the previous homepage release, including a failed first migration.
    await run(`localStorage.clear();localStorage.setItem('notch-home-modules-version','2');
      localStorage.setItem('notch-home-order-v3',JSON.stringify(['ai-usage','news','commands','note','recorder','windows','pomodoro']));
      localStorage.setItem('notch-home-widget-sizes-v2',JSON.stringify({'ai-usage':'large',news:'medium',commands:'medium',note:'medium',recorder:'medium',windows:'medium',pomodoro:'medium'}));
      localStorage.setItem('notch-home-hidden-modules-v1',JSON.stringify(['note']));`);
    await load();
    await installAPI(empty,{failFeature:true});
    assert.equal(await run("localStorage.getItem('notch-ai-usage-workspace-migration-v1')"),'pending','Failed migration preserves intent for a later launch');
    assert.equal(await run("document.getElementById('tab-button-ai-usage').hidden"),true);
    await load();
    await installAPI(empty);
    await wait("localStorage.getItem('notch-ai-usage-workspace-migration-v1')==='complete'");
    const migrated=await run(`({enabled:!document.getElementById('tab-button-ai-usage').hidden,hidden:JSON.parse(localStorage.getItem('notch-home-hidden-modules-v1')),order:JSON.parse(localStorage.getItem('notch-home-order-v3')),sizes:Object.keys(JSON.parse(localStorage.getItem('notch-home-widget-sizes-v2'))),area:[...document.querySelectorAll('#home-bento [data-home-module]:not([hidden])')].reduce((sum,tile)=>sum+Number(tile.dataset.layoutWidth)*Number(tile.dataset.layoutHeight),0)})`);
    assert.equal(migrated.enabled,true,'Previously enabled homepage usage becomes an enabled workspace feature');
    assert.deepEqual(migrated.hidden,['note']);
    assert.deepEqual(migrated.order,['news','commands','note','recorder','windows','pomodoro']);
    assert.equal(migrated.sizes.length,6);assert.equal(migrated.sizes.includes('ai-usage'),false);assert.equal(migrated.area,48);
    await run("window.notchAPI.setFeature('ai-usage',false)");
    await load();
    await installAPI(empty);
    assert.equal(await run("document.getElementById('tab-button-ai-usage').hidden"),true,'A completed migration never re-enables a subsequently disabled workspace');
    assert.equal(await run('window.featureCalls.length'),0);
    await run("localStorage.clear();localStorage.setItem('notch-home-modules-version','2');localStorage.setItem('notch-home-hidden-modules-v1',JSON.stringify(['ai-usage']));");
    await load();
    await installAPI(empty);
    assert.equal(await run("document.getElementById('tab-button-ai-usage').hidden"),true,'A previously disabled homepage card remains off');
    assert.equal(await run("localStorage.getItem('notch-ai-usage-workspace-migration-v1')"),'complete');
    assert.equal(await run('window.featureCalls.length'),0);
    assert.deepEqual(network,[]);assert.deepEqual(errors,[]);
    console.log('AI account dashboard, import mapping and confirmation, coverage, key attribution, currencies, migration and inactive polling checks passed');
  } finally {window.destroy();app.quit();}
}
main().catch(error=>{console.error(error);app.exit(1);});
