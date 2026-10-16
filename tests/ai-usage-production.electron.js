const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const profile = process.env.TODO_TEST_USER_DATA;
app.commandLine.appendSwitch('user-data-dir', profile);
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
fs.writeFileSync(path.join(profile, '.first-run-done'), '1');
fs.writeFileSync(path.join(profile, 'permission-prompt-skipped'), '1');
fs.writeFileSync(path.join(profile, 'ai-settings.json'), JSON.stringify({ version: 1, connections: [], assignments: { translation: null, naming: null, speech: null }, disabledTasks: [] }));
// Native selection is stubbed; every selected file belongs to this isolated profile.
const choices = [], dialogCalls = [];
dialog.showOpenDialog = async (...args) => {
  dialogCalls.push(args.at(-1));
  assert.ok(choices.length, 'A rejected request must not open a native file picker');
  const choice = choices.shift();
  return typeof choice === 'function' ? choice() : { canceled: !choice, filePaths: choice ? [choice] : [] };
};
function zipFixture(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(text); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4);
    header.writeUInt32LE(crc,14); header.writeUInt32LE(bytes.length,18); header.writeUInt32LE(bytes.length,22); header.writeUInt16LE(filename.length,26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6);
    directory.writeUInt32LE(crc,16); directory.writeUInt32LE(bytes.length,20); directory.writeUInt32LE(bytes.length,24); directory.writeUInt16LE(filename.length,28); directory.writeUInt32LE(offset,42);
    local.push(header,filename,bytes); central.push(directory,filename); offset+=header.length+filename.length+bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
const start='2026-10-15T00:00:00+08:00', end='2026-10-16T00:00:00+08:00';
const costCSV=`user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency\nfixture-private-user,${start},${end},deepseek-chat,Paid,0.1,CNY\n`;
const amountCSV='user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount\n'+[
  ['request_count',2],['input_cache_hit_tokens',50],['input_cache_miss_tokens',100],['output_tokens',30],
].map(([type,amount])=>`fixture-private-user,${start},${end},deepseek-chat,Fixture Key,sk-import-must-stay-private,${type},0,${amount}`).join('\n')+'\n';
const files = Object.fromEntries(['cost','bundle','malformed','oversized','broken','traversal'].map(name=>[name,path.join(profile,name+(['bundle','broken','traversal'].includes(name)?'.zip':'.csv'))]));
fs.writeFileSync(files.cost,costCSV);
fs.writeFileSync(files.bundle,zipFixture([['cost-2026-10-15_2026-10-15.csv',costCSV],['amount-2026-10-15_2026-10-15.csv',amountCSV]]));
fs.writeFileSync(files.malformed,'date,cost\n"unterminated,1');
fs.writeFileSync(files.oversized,Buffer.alloc(5*1024*1024+1,32));
fs.writeFileSync(files.broken,'not a zip');
const escapedName=`outside-${path.basename(profile)}.csv`;
fs.writeFileSync(files.traversal,zipFixture([[`../${escapedName}`,costCSV]]));
const requests = [];
app.on('session-created', session => {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { requests.push(details.url); callback({ cancel: true }); });
});
const watchdog = setTimeout(() => { console.error('AI usage production IPC timed out'); app.exit(1); }, 45000);
let tested = false;
app.on('web-contents-created', (_event, contents) => {
  contents.once('did-finish-load', async () => {
    if (tested || !contents.getURL().endsWith('/renderer/index.html')) return;
    tested = true;
    try {
      const result = await contents.executeJavaScript(`(async () => {
        const importDenied = async () => Promise.all([
          window.notchAPI.chooseAIUsageImport({accountId:'import:deepseek'}),
          window.notchAPI.previewAIUsageImport({importId:'unselected'}),
          window.notchAPI.commitAIUsageImport({token:'unpreviewed'}),
        ]);
        const collapsed = await window.notchAPI.getAIUsage({refresh:true});
        const collapsedImports = await importDenied();
        await setActiveTab('settings');
        await setMode(true);
        const outsidePage = await window.notchAPI.getAIUsage({refresh:true});
        const outsideImports = await importDenied();
        const enabled = await window.notchAPI.setFeature('ai-usage',true);
        applyFeatureSettings(enabled.settings);
        await setActiveTab('ai-usage');
        const malformed = await window.notchAPI.getAIUsage({refresh:'yes'});
        const injected = await window.notchAPI.getAIUsage({refresh:true,url:'https://example.com/steal'});
        const empty = await window.notchAPI.getAIUsage();
        const saved = await window.notchAPI.saveAISettings({connections:[
          {id:'usage-qwen',provider:'qwen',protocol:'openai',apiKey:'usage-fixture-secret',models:[]},
          {id:'usage-custom',provider:'deepseek',protocol:'openai',baseUrl:'https://example.com/v1',apiKey:'must-not-be-sent-to-official',models:[]}
        ],assignments:{translation:null,naming:null,speech:null},disabledTasks:[]});
        const cached = await window.notchAPI.getAIUsage();
        const refreshed = await window.notchAPI.getAIUsage({refresh:true});
        await window.notchAPI.saveAISettings({connections:[],assignments:{translation:null,naming:null,speech:null},disabledTasks:[]});
        const removed = await window.notchAPI.getAIUsage({refresh:true});
        await window.notchAPI.setFeature('ai-usage',false);
        const disabled = await window.notchAPI.getAIUsage({refresh:true});
        const disabledImports = await importDenied();
        const restored = await window.notchAPI.setFeature('ai-usage',true);
        applyFeatureSettings(restored.settings);
        await window.notchAPI.setTab('ai-usage');
        const beforeCollapse = await window.notchAPI.getAIUsage();
        return {collapsed,collapsedImports,outsideImports,disabledImports,beforeCollapse,outsidePage,disabled,malformed,injected,empty,saved,cached,refreshed,removed};
      })()`);
      assert.equal(result.collapsed.error, 'unavailable');
      for (const denied of [...result.collapsedImports,...result.outsideImports,...result.disabledImports]) assert.equal(denied.error,'unavailable');
      assert.equal(dialogCalls.length,0,'Collapsed, inactive and disabled callers cannot select files');
      assert.equal(result.beforeCollapse.ok, true);
      assert.equal(result.outsidePage.error, 'unavailable');
      assert.equal(result.disabled.error, 'unavailable');
      assert.equal(result.malformed.error, 'invalid_request');
      assert.equal(result.injected.error, 'invalid_request');
      assert.equal(result.empty.ok, true);
      assert.deepEqual(result.empty.connections, []);
      assert.equal(result.empty.totals.today.requests, 0);
      assert.equal(result.saved.ok, true, JSON.stringify(result.saved));
      assert.equal(result.refreshed.connections.length, 2);
      for (const connection of result.refreshed.connections) assert.equal(connection.balance.status, 'unsupported');
      assert.deepEqual(result.removed.connections, []);
      assert.doesNotMatch(JSON.stringify(result), /usage-fixture-secret|must-not-be-sent-to-official|encryptedApiKey/);
      assert.deepEqual(requests.filter(url => /deepseek|moonshot|example\.com/.test(url)), [], 'Unsupported/custom connections must never send a balance request');
      const call = (method,payload) => contents.executeJavaScript(`window.notchAPI[${JSON.stringify(method)}](${JSON.stringify(payload)})`);
      const publicResults = [];
      const choose = async file => { choices.push(file); const value=await call('chooseAIUsageImport',{accountId:'import:deepseek'});publicResults.push(value);return value; };
      for (const [method,payload] of [
        ['chooseAIUsageImport',{accountId:'import:deepseek',path:files.cost}],
        ['previewAIUsageImport',{importId:'unselected',path:files.cost}],
        ['previewAIUsageImport',{importId:'unselected',mapping:{cost:42}}],
        ['previewAIUsageImport',{importId:'unselected',currency:'EUR'}],
        ['commitAIUsageImport',{token:'unpreviewed',filePath:files.cost}],
      ]) assert.equal((await call(method,payload)).error,'invalid_request');
      assert.equal((await call('chooseAIUsageImport',{accountId:'missing-account'})).error,'invalid_account');
      assert.equal(dialogCalls.length,0,'Renderer paths and malformed mappings never reach the native picker');
      assert.equal((await choose(null)).error,'cancelled');
      assert.equal((await choose(files.oversized)).error,'file_too_large');
      assert.equal((await choose(files.broken)).error,'invalid_zip');
      assert.equal((await choose(files.traversal)).error,'invalid_zip');
      assert.equal((await choose(files.malformed)).ok,false,'An unclosed CSV quote must not create an import');
      assert.equal(fs.existsSync(path.join(path.dirname(profile),escapedName)),false,'ZIP traversal never writes an extracted file');

      const selected=await choose(files.cost);
      assert.equal(selected.ok,true,JSON.stringify(selected));
      assert.equal(selected.files[0].format,'deepseek-cost');
      assert.equal(selected.requiresMapping,false);
      assert.equal(selected.fileName,path.basename(files.cost));
      assert.equal(selected.path,undefined);assert.equal(selected.files[0].text,undefined);
      const preview=await call('previewAIUsageImport',{importId:selected.importId});publicResults.push(preview);
      assert.equal(preview.ok,true,JSON.stringify(preview));
      assert.equal(preview.preview.metrics.cost,0.1);
      assert.equal(preview.preview.metrics.requests,null,'Cost-only import does not invent a request count');
      const beforeCommit=await call('getAIUsage');
      assert.deepEqual(beforeCommit.accountUsage.accounts,[],'Preview does not write a ledger');
      assert.equal((await call('commitAIUsageImport',{token:preview.token})).ok,true);
      assert.equal((await call('commitAIUsageImport',{token:preview.token})).error,'import_expired','A preview token is consumed once');
      const costOnly=await call('getAIUsage');publicResults.push(costOnly);
      assert.equal(costOnly.accountUsage.accounts.length,1);
      assert.ok(costOnly.accountUsage.accounts[0].rows.length>0);
      assert.equal(costOnly.totals.today.requests,0,'Imported account statistics do not enter local calls');

      const selectedZIP=await choose(files.bundle);
      assert.equal(selectedZIP.ok,true,JSON.stringify(selectedZIP));assert.equal(selectedZIP.files.length,2);
      const zipPreview=await call('previewAIUsageImport',{importId:selectedZIP.importId});publicResults.push(zipPreview);
      assert.equal(zipPreview.ok,true,JSON.stringify(zipPreview));
      assert.equal(zipPreview.preview.metrics.cost,0.1);assert.equal(zipPreview.preview.metrics.requests,2);
      assert.equal(zipPreview.preview.metrics.inputTokens,150);assert.equal(zipPreview.preview.metrics.outputTokens,30);assert.equal(zipPreview.preview.metrics.totalTokens,180);
      assert.equal((await call('commitAIUsageImport',{token:zipPreview.token})).ok,true);
      const imported=await call('getAIUsage');publicResults.push(imported);
      const repeatedFile=await choose(files.bundle);
      const repeatedPreview=await call('previewAIUsageImport',{importId:repeatedFile.importId});
      const repeated=await call('commitAIUsageImport',{token:repeatedPreview.token});
      assert.equal(repeated.ok,true);assert.equal(repeated.duplicate,true);
      assert.deepEqual((await call('getAIUsage')).accountUsage.accounts,imported.accountUsage.accounts,'Repeated imports do not add account usage twice');

      // A different selected source invalidates the old preview even before commit.
      const firstSelection=await choose(files.cost);
      const firstPreview=await call('previewAIUsageImport',{importId:firstSelection.importId});
      await choose(files.bundle);
      assert.equal((await call('commitAIUsageImport',{token:firstPreview.token})).error,'import_expired');
      const configuration={connections:[{id:'ds-import',provider:'deepseek',protocol:'openai',models:[]}],assignments:{translation:null,naming:null,speech:null},disabledTasks:[]};
      assert.equal((await call('saveAISettings',configuration)).ok,true);
      choices.push(files.cost);
      const boundFile=await call('chooseAIUsageImport',{accountId:'ds-import'});
      assert.equal(boundFile.ok,true,JSON.stringify(boundFile));
      configuration.connections[0].baseUrl='https://example.com/v1';
      assert.equal((await call('saveAISettings',configuration)).ok,true);
      assert.equal((await call('previewAIUsageImport',{importId:boundFile.importId})).error,'account_changed','A pending file cannot follow a replaced connection identity');

      configuration.connections[0].apiKey='fixture-account-a-private-key';
      assert.equal((await call('saveAISettings',configuration)).ok,true);
      const accountA=(await call('getAIUsage')).connections.find(row=>row.provider==='deepseek').id;
      choices.push(files.cost);
      const sourceA=await call('chooseAIUsageImport',{accountId:accountA});
      const previewA=await call('previewAIUsageImport',{importId:sourceA.importId});
      assert.equal((await call('commitAIUsageImport',{token:previewA.token})).ok,true);
      configuration.connections[0].apiKey='fixture-account-b-private-key';
      assert.equal((await call('saveAISettings',configuration)).ok,true);
      const afterRotation=await call('getAIUsage');publicResults.push(afterRotation);
      const accountB=afterRotation.connections.find(row=>row.provider==='deepseek').id;
      assert.notEqual(accountA,accountB,'Replacing the credential creates a distinct usage account identity');
      assert.ok(afterRotation.accountUsage.accounts.some(row=>row.id===accountA),'Old account history stays available');
      assert.ok(!afterRotation.accountUsage.accounts.some(row=>row.id===accountB),'The new wallet cannot inherit the old account history');
      assert.doesNotMatch(JSON.stringify(afterRotation),/fixture-account-[ab]-private-key/);

      let returnSelection;
      choices.push(()=>new Promise(resolve=>{returnSelection=resolve;}));
      const choosing=call('chooseAIUsageImport',{accountId:'import:deepseek'});
      while(!returnSelection) await new Promise(resolve=>setTimeout(resolve,5));
      await contents.executeJavaScript("setActiveTab('news')");
      returnSelection({canceled:false,filePaths:[files.cost]});
      assert.equal((await choosing).error,'unavailable','Selection completion rechecks the active-page permission');
      await contents.executeJavaScript("setActiveTab('ai-usage')");
      assert.doesNotMatch(JSON.stringify(publicResults),/sk-import-must-stay-private|fixture-private-user/,'Raw keys and provider account IDs never return through public IPC');
      const stored=fs.readFileSync(path.join(profile,'ai-account-usage.json'),'utf8');
      assert.doesNotMatch(stored,/sk-import-must-stay-private|fixture-private-user/,'Import persists only normalized statistics and safe key identifiers');
      assert.equal(choices.length,0);

      const other = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true } });
      await other.loadURL('data:text/html,<title>Untrusted usage caller</title>');
      const denied = await other.webContents.executeJavaScript(`Promise.all([window.notchAPI.getAIUsage({refresh:true}),window.notchAPI.chooseAIUsageImport({accountId:'import:deepseek'}),window.notchAPI.previewAIUsageImport({importId:'unselected'}),window.notchAPI.commitAIUsageImport({token:'unpreviewed'})])`);
      for(const result of denied) assert.equal(result.error, 'untrusted_sender');
      other.destroy();
      const collapsing=await contents.executeJavaScript(`(async()=>{await window.notchAPI.beginCollapse();return Promise.all([window.notchAPI.getAIUsage(),window.notchAPI.chooseAIUsageImport({accountId:'import:deepseek'}),window.notchAPI.previewAIUsageImport({importId:'unselected'}),window.notchAPI.commitAIUsageImport({token:'unpreviewed'})]);})()`);
      for(const result of collapsing) assert.equal(result.error,'unavailable');
      console.log('Production AI usage IPC, native CSV/ZIP import, preview/commit, deduplication, permission and secret boundary checks passed');
      clearTimeout(watchdog); app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../main.js');
