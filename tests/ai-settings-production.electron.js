const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const profile = process.env.TODO_TEST_USER_DATA;
app.commandLine.appendSwitch('user-data-dir', profile);
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
fs.writeFileSync(path.join(profile, '.first-run-done'), '1');
fs.writeFileSync(path.join(profile, 'permission-prompt-skipped'), '1');
fs.writeFileSync(path.join(profile, 'ai-settings.json'), JSON.stringify({ version: 1, connections: [], assignments: { translation: null, naming: null, speech: null }, disabledTasks: [] }));
const errors = [], network = [];
app.on('session-created', session => {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
});
const watchdog = setTimeout(() => { console.error('AI settings production IPC timed out', errors); app.exit(1); }, 25000);
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  contents.once('did-finish-load', async () => {
    if (!contents.getURL().endsWith('/renderer/index.html')) return;
    try {
      const result = await contents.executeJavaScript(`(async () => {
        const initial = await window.notchAPI.getAISettings();
        const saved = await window.notchAPI.saveAISettings({connections:[{
          id:'test-qwen',provider:'qwen',protocol:'openai',apiKey:'production-test-only-key',
          models:[{id:'qwen-plus',capabilities:['translation','naming'],manual:true},{id:'qwen3-asr-flash-realtime',capabilities:['speech'],manual:true}]
        }],assignments:{translation:{connectionId:'test-qwen',model:'qwen-plus'},naming:null,speech:{connectionId:'test-qwen',model:'qwen3-asr-flash-realtime'}},disabledTasks:['naming']});
        const enabled = await window.notchAPI.getTranscriptionConfig();
        const readback = await window.notchAPI.getAISettings();
        const disabled = await window.notchAPI.saveAISettings({connections:readback.connections,assignments:{translation:readback.assignments.translation,naming:null,speech:null},disabledTasks:['naming','speech']});
        const afterDisable = await window.notchAPI.getTranscriptionConfig();
        const obsolete = await window.notchAPI.setTranscriptionConfig({apiKey:'must-not-reactivate'});
        return {initial,saved,readback,enabled,disabled,afterDisable,obsolete};
      })()`);
      assert.equal(result.initial.ok, true); assert.equal(result.initial.connections.length, 0);
      assert.equal(result.saved.ok, true, JSON.stringify(result.saved));
      assert.equal(result.readback.connections[0].hasApiKey, true);
      assert.equal(result.enabled.configured, true); assert.equal(result.enabled.translationConfigured, true); assert.equal(result.enabled.namingConfigured, false);
      assert.equal(result.disabled.ok, true); assert.equal(result.afterDisable.configured, false); assert.equal(result.afterDisable.translationConfigured, true);
      assert.equal(result.obsolete.error, 'use_ai_settings');
      assert.doesNotMatch(JSON.stringify(result), /production-test-only-key|encryptedApiKey|must-not-reactivate/);
      const persisted = fs.readFileSync(path.join(profile, 'ai-settings.json'), 'utf8');
      assert.doesNotMatch(persisted, /production-test-only-key|must-not-reactivate|"apiKey"/);
      assert.ok(JSON.parse(persisted).connections[0].encryptedApiKey);
      assert.deepEqual(JSON.parse(persisted).disabledTasks, ['naming', 'speech']);
      assert.deepEqual(network, [], 'Configuring manual models makes no network or paid model call');
      assert.deepEqual(errors, []);
      console.log('Production AI settings IPC, encrypted persistence and task-off checks passed');
      clearTimeout(watchdog); app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../main.js');
