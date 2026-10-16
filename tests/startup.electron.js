const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const profile = process.env.TODO_TEST_USER_DATA;
app.commandLine.appendSwitch('user-data-dir', profile);
// The production bootstrap may inspect encrypted legacy settings on this Mac.
// Use Chromium's test keychain so a regression test never prompts for user keys.
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');
// Keep startup tests inside their isolated profile without OS prompts or login-item changes.
fs.writeFileSync(path.join(profile, '.first-run-done'), '1');
fs.writeFileSync(path.join(profile, 'permission-prompt-skipped'), '1');
fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({version:1, localStorage:{
  'notch-home-note':'Recovered workspace note',
  'notch-home-order-v3':JSON.stringify(['music', 'commands', 'recorder', 'mirror', 'pomodoro', 'windows', 'note', 'ai-usage']),
  'notch-home-widget-sizes-v2':JSON.stringify({music:'medium',pomodoro:'mini',windows:'large',recorder:'small',mirror:'medium',note:'medium',commands:'mini','ai-usage':'small'}),
  'notch-home-hidden-modules-v1':JSON.stringify(['music','mirror','note']),
  'notch-home-modules-version':'2',
  'notch-recordings':JSON.stringify([{id:'startup-recording',createdAt:1788709776699,durationMs:1558,transcript:'',audioPath:'recordings/retained.webm',mimeType:'audio/webm',title:'Saved recording',category:'未分类'}]),
}}));
const errors = [];
setTimeout(() => { console.error('Production startup timed out', errors); app.exit(1); }, 25000);
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(`${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  contents.once('did-finish-load', () => {
    if (!contents.getURL().endsWith('/renderer/index.html')) return;
    setTimeout(async () => {
      try {
        const state = await contents.executeJavaScript(`({home:!!window.NotchHome,workspace:!!window.NotchWorkspace,note:document.getElementById('home-note').value,recordings:document.querySelectorAll('.recording-item').length})`);
        assert.deepEqual(errors, []);
        assert.deepEqual(state, {home:true,workspace:true,note:'Recovered workspace note',recordings:1});
        const recoveredHome = await contents.executeJavaScript(`({
          order: [...document.querySelectorAll('#home-bento [data-home-module]')].sort((a,b) => Number(a.style.order)-Number(b.style.order)).map(tile => tile.dataset.homeModule),
          hidden: JSON.parse(localStorage.getItem('notch-home-hidden-modules-v1')),
          sizes: Object.keys(JSON.parse(localStorage.getItem('notch-home-widget-sizes-v2'))).sort(),
          area: [...document.querySelectorAll('#home-bento [data-home-module]:not([hidden])')].reduce((sum,tile) => sum + Number(tile.dataset.layoutWidth)*Number(tile.dataset.layoutHeight),0),
        })`);
        assert.deepEqual(recoveredHome.order, ['commands','recorder','pomodoro','windows','note','news'], 'Workspace recovery preserves the old relative order');
        assert.deepEqual(recoveredHome.hidden, ['note'], 'Workspace recovery preserves retained visibility preferences');
        assert.deepEqual(recoveredHome.sizes, ['commands','news','note','pomodoro','recorder','windows']);
        assert.equal(recoveredHome.area, 48);
        const migratedUsage = await contents.executeJavaScript(`(async()=>({enabled:(await window.notchAPI.getAppSettings()).features['ai-usage'],marker:localStorage.getItem('notch-ai-usage-workspace-migration-v1'),oldCard:!!document.getElementById('home-ai-usage')}))()`);
        assert.deepEqual(migratedUsage, {enabled:true,marker:'complete',oldCard:false}, 'A previously enabled usage card migrates from recovered workspace data to the optional workspace tab');
        console.log('Production workspace recovery checks passed');
        app.quit();
      } catch (error) { console.error(error); app.exit(1); }
    }, 2000);
  });
});
require('../main.js');
