const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { PROVIDERS, SPEECH_MODEL } = require('../ai-providers');
app.setPath('userData', process.env.TODO_TEST_USER_DATA);
const empty = { ok: true, version: 1, providers: PROVIDERS, connections: [], assignments: { translation: null, naming: null, speech: null }, disabledTasks: [], secureStorage: true, migrated: false };
async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ width: 1240, height: 616, frame: false, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [], network = [];
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
  const run = source => window.webContents.executeJavaScript(source);
  const change = (id, value) => run(`(() => { const el=document.getElementById(${JSON.stringify(id)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const input = (id, value) => run(`(() => { const el=document.getElementById(${JSON.stringify(id)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const wait = condition => run(`(async () => {const until=performance.now()+2500;while(!(${condition})){if(performance.now()>until)throw Error('Timed out: '+${JSON.stringify(condition)});await new Promise(r=>setTimeout(r,10));}})()`);
  async function reset(config = empty) {
    await run(`(async () => { window.NotchAISettings.close(); window.savedConfig=${JSON.stringify(config)}; window.discoverResult={ok:true,models:[{id:'chat-model',name:'文本模型',capabilities:['translation','naming']}]}; window.deferDiscovery=false; window.discoveryResolvers=[]; window.discoverCalls=[]; window.saveCalls=[]; window.changedEvents=0; window.settingsReads=0;
      document.addEventListener('notch:ai-settings-changed',()=>window.changedEvents++);
      window.notchAPI={
        getAISettings:async()=>{window.settingsReads++; return structuredClone(window.savedConfig);},
        discoverAIModels:async payload=>{window.discoverCalls.push(structuredClone(payload));return window.deferDiscovery?new Promise(resolve=>window.discoveryResolvers.push(resolve)):structuredClone(window.discoverResult);},
        saveAISettings:async payload=>{window.saveCalls.push(structuredClone(payload));window.savedConfig={...window.savedConfig,...structuredClone(payload),ok:true,connections:payload.connections.map(({apiKey,...connection})=>({...connection,hasApiKey:!!apiKey||window.savedConfig.connections.some(old=>old.id===connection.id&&old.hasApiKey),needsReentry:false}))};return structuredClone(window.savedConfig);},
      }; await window.NotchAISettings.open(); })()`);
  }
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await run("setMode(true); setActiveTab('settings')");
    window.showInactive();
    await reset();
    assert.equal(await run("document.getElementById('ai-provider').value"), '', 'A fresh profile must not preselect a provider or enable a task');
    await change('ai-provider', 'deepseek');
    await click('#ai-connect');
    assert.equal(await run('window.discoverCalls.length'), 0);
    assert.equal(await run("document.getElementById('transcription-settings-note').dataset.state"), 'error');
    await input('ai-key', 'ui-test-only-key');
    await run("window.discoverResult={ok:false,error:'auth'}");
    await click('#ai-connect');
    await wait("document.getElementById('transcription-settings-note').dataset.state==='error'");
    assert.match(await run("document.getElementById('transcription-settings-note').textContent"), /身份验证/);
    assert.equal(await run("document.querySelector('.ai-connection-feedback').dataset.state"), 'error');
    assert.equal(await run("[...document.querySelectorAll('#ai-model-translation option')].some(option=>option.value.includes('chat-model'))"), false);
    await click('#ai-show-manual'); await input('ai-manual-id', 'company-chat'); await click('[data-ai-action=manual]');
    assert.match(await run("document.getElementById('ai-model-translation').selectedOptions[0].textContent"), /手动.*未测试/);
    assert.equal(await run("document.querySelector('.ai-connection-feedback').dataset.state"), 'error', 'Adding a manual model does not claim the auth failure was fixed');
    await click('#transcription-settings-save'); await wait('window.saveCalls.length===1 && !document.getElementById("transcription-settings-save").disabled');
    assert.equal(await run('window.saveCalls[0].connections[0].apiKey'), 'ui-test-only-key');
    assert.equal(await run('window.saveCalls[0].assignments.speech'), null);
    assert.equal(await run("document.getElementById('ai-key').value"), '', 'Successful save clears the visible key');
    assert.equal(await run('window.changedEvents'), 1);

    await reset(); await change('ai-provider', 'deepseek'); await input('ai-key', 'first-provider-key');
    await run('window.deferDiscovery=true'); await click('#ai-connect');
    assert.equal(await run("document.getElementById('transcription-settings-save').disabled"), true, 'An unfinished connection request cannot be saved');
    await change('ai-provider', 'anthropic');
    assert.equal(await run("document.getElementById('ai-key').value"), '', 'Changing provider does not carry a key to a different service');
    await run("window.discoveryResolvers[0]({ok:true,models:[{id:'stale-model',capabilities:['translation','naming']}]})");
    await run('new Promise(resolve=>setTimeout(resolve,30))');
    assert.equal(await run("document.getElementById('ai-settings-body').textContent.includes('stale-model')"), false);
    await input('ai-key', 'second-provider-key'); await click('#ai-connect');
    await run('window.NotchAISettings.close(); window.discoveryResolvers[1]({ok:true,models:[{id:"closed-model",capabilities:["translation"]}]})');
    await run('new Promise(resolve=>setTimeout(resolve,30))');
    assert.equal(await run("document.getElementById('ai-settings-body').textContent"), '');
    assert.equal(await run('window.NotchAISettings.isOpen()'), false);
    assert.equal(await run("JSON.stringify(localStorage).includes('provider-key')"), false);

    const configured = { ...empty, connections: [
      { id: 'text', provider: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', hasApiKey: true, models: [{ id: 'chat-model', capabilities: ['translation', 'naming'] }] },
      { id: 'asr', provider: 'qwen', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', region: 'beijing', hasApiKey: true, models: [{ id: SPEECH_MODEL, capabilities: ['speech'] }] },
    ], assignments: { translation: null, naming: { connectionId: 'text', model: 'chat-model' }, speech: { connectionId: 'asr', model: SPEECH_MODEL } } };
    await reset(configured);
    await change('ai-model-translation', '__off__'); await click('#ai-recommend'); await click('#ai-apply-recommendation');
    assert.equal(await run("document.getElementById('ai-model-translation').value"), '__off__');
    await click('#transcription-settings-save'); await wait('window.saveCalls.length===1 && !document.getElementById("transcription-settings-save").disabled');
    assert.ok((await run('window.saveCalls[0].disabledTasks')).includes('translation'));
    await run('(async () => {window.NotchAISettings.close(); await window.NotchAISettings.open();})()');
    await click('#ai-recommend'); await click('#ai-apply-recommendation');
    assert.equal(await run("document.getElementById('ai-model-translation').value"), '__off__', 'Explicit off remains off after save and reopen');
    await change('ai-model-translation', ''); await click('#ai-recommend'); await click('#ai-apply-recommendation');
    assert.equal(await run("document.getElementById('ai-model-translation').value"), JSON.stringify(['text', 'chat-model']), 'An empty task may receive a suggested model');
    assert.equal(await run("document.getElementById('ai-model-speech').value"), JSON.stringify(['asr', SPEECH_MODEL]));
    await change('ai-provider', 'openai');
    assert.equal(await run("document.getElementById('ai-model-translation').value"), '');
    assert.equal(await run("document.getElementById('ai-model-naming').value"), '');
    assert.equal(await run("document.getElementById('ai-model-speech').value"), JSON.stringify(['asr', SPEECH_MODEL]), 'Editing one connection preserves another connection’s tasks');
    await click('#transcription-settings-save');
    assert.equal(await run('window.saveCalls.length'), 1, 'An identity change needs a fresh key before it can be saved');

    await reset(); await change('ai-provider', 'deepseek'); await input('ai-key', 'discovery-test-key'); await click('#ai-connect');
    await wait("!!document.querySelector('.ai-connection-feedback[data-state=success]')");
    assert.match(await run("document.querySelector('.ai-connection-feedback').textContent"), /实际调用尚未测试/);
    assert.equal(await run("[...document.getElementById('ai-model-speech').options].some(option=>option.value.includes('chat-model'))"), false);
    await click('#ai-recommend'); await click('#ai-apply-recommendation');
    assert.equal(await run("document.getElementById('ai-model-speech').value"), '', 'Listing text models never enables ASR');
    if (process.env.TODO_UI_AUDIT_DIR) {
      fs.mkdirSync(process.env.TODO_UI_AUDIT_DIR, { recursive: true });
      for (const [width, height] of [[1240,616],[1000,576]]) {
        window.setSize(width,height); await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        fs.writeFileSync(path.join(process.env.TODO_UI_AUDIT_DIR,`ai-settings-${width}.png`),(await window.webContents.capturePage()).toPNG());
      }
    }
    await run('window.NotchAISettings.close()');

    // The compact service card summarizes connections; task choices remain in
    // the settings dialog and must not be confused with connection availability.
    const cardConfig = { ...empty, connections: [
      { id: 'translation-api', provider: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', hasApiKey: true, models: [{ id: 'translation-model', capabilities: ['translation'], manual: true }] },
      { id: 'naming-api', provider: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', hasApiKey: true, models: [{ id: 'naming-model', capabilities: ['naming'] }] },
      { id: 'speech-api', provider: 'qwen', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', region: 'beijing', hasApiKey: true, models: [{ id: SPEECH_MODEL, capabilities: ['speech'], capabilitySource: 'adapter' }] },
    ], assignments: { translation: { connectionId: 'translation-api', model: 'translation-model' }, naming: { connectionId: 'naming-api', model: 'naming-model' }, speech: { connectionId: 'speech-api', model: SPEECH_MODEL } } };
    const card = () => run(`({text:document.getElementById('settings-ai-summary').textContent,state:document.getElementById('settings-ai-summary').dataset.state})`);
    await reset();
    await run("window.NotchAISettings.close(); setActiveTab('todo'); setActiveTab('settings')");
    await wait("document.getElementById('settings-ai-summary').dataset.state==='empty'");
    assert.deepEqual(await card(), { text: '尚未添加连接', state: 'empty' });
    assert.equal(await run("document.getElementById('settings-api-configure').textContent"), '设置');
    assert.equal(await run("document.getElementById('settings-ai-capabilities')"), null, 'The service card no longer repeats task and model lists');

    await reset(cardConfig);
    await run("window.NotchAISettings.close(); setActiveTab('todo'); setActiveTab('settings')");
    await wait("document.getElementById('settings-ai-summary').dataset.state==='ready'");
    assert.deepEqual(await card(), { text: '已添加 3 个连接', state: 'ready' });
    const cardText = await run("document.getElementById('settings-ai-summary').closest('section').textContent");
    assert.match(cardText, /AI 服务/);
    assert.doesNotMatch(cardText, /translation-model|naming-model|qwen3-asr|新闻翻译|命名与分组|实时语音转写|[03]\s*\/\s*3/);

    await click('#settings-api-configure');
    await wait("window.NotchAISettings.isOpen() && !!document.getElementById('ai-model-naming')");
    await change('ai-model-naming', '__off__');
    const readsBeforeSave = await run('window.settingsReads');
    await click('#transcription-settings-save');
    await wait(`window.settingsReads>${readsBeforeSave} && document.getElementById('settings-ai-summary').dataset.state==='ready'`);
    assert.equal(await run('window.savedConfig.assignments.naming'), null);
    assert.deepEqual(await card(), { text: '已添加 3 个连接', state: 'ready' }, 'Disabling one task does not remove a connection');
    await click('[data-ai-action=connection][data-id=naming-api]');
    await click('[data-ai-action=remove]');
    await click('#transcription-settings-save');
    await wait("document.getElementById('settings-ai-summary').textContent==='已添加 2 个连接'");
    assert.equal((await card()).state, 'ready', 'Saving a removed connection immediately updates the service card');

    await run("window.NotchAISettings.close(); setActiveTab('todo'); window.savedConfig.connections[0].hasApiKey=false; window.beforeReturnReads=window.settingsReads; setActiveTab('settings')");
    await wait("document.getElementById('settings-ai-summary').dataset.state==='warning'");
    assert.equal(await run('window.settingsReads > window.beforeReturnReads'), true, 'Returning to settings refreshes connections that changed elsewhere');
    assert.deepEqual(await card(), { text: '已添加 2 个连接 · 需检查配置', state: 'warning' });
    await run("setActiveTab('todo'); window.savedConfig.connections[0].hasApiKey=true; setActiveTab('settings')");
    await wait("document.getElementById('settings-ai-summary').dataset.state==='ready'");
    if (process.env.TODO_UI_AUDIT_DIR) {
      window.setSize(1240,616); await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(process.env.TODO_UI_AUDIT_DIR,'ai-service-card.png'),(await window.webContents.capturePage()).toPNG());
    }

    await run("setActiveTab('todo'); window.savedConfig={ok:false,error:'settings_unreadable'}; setActiveTab('settings')");
    await wait("document.getElementById('settings-ai-summary').dataset.state==='unavailable'");
    assert.deepEqual(await card(), { text: '暂时无法读取连接状态', state: 'unavailable' }, 'Read failure clears the previous connected status instead of claiming no configuration');
    assert.deepEqual(errors, []); assert.deepEqual(network, []);
    console.log('AI settings UI credentials, service card refresh, manual models and stale-request checks passed');
  } finally { window.destroy(); app.quit(); }
}
main().catch(error=>{console.error(error);app.exit(1);});
