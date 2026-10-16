const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.TODO_TEST_USER_DATA);
async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(`${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await window.webContents.executeJavaScript(`
      localStorage.clear();
      localStorage.setItem('notch-home-order-v3', JSON.stringify(['music', 'commands', 'recorder', 'mirror', 'pomodoro', 'windows', 'note']));
      localStorage.setItem('notch-home-widget-sizes-v2', JSON.stringify({ music: 'medium', pomodoro: 'mini', windows: 'large', recorder: 'small', mirror: 'medium', note: 'medium', commands: 'mini' }));
      localStorage.setItem('notch-home-hidden-modules-v1', JSON.stringify(['music', 'mirror']));
      localStorage.setItem('notch-recordings', JSON.stringify([{id:'retained-recording',createdAt:1788709776699,durationMs:1558,transcript:'',audioPath:'recordings/retained.webm',mimeType:'audio/webm',title:'Saved recording',category:'未分类'}]));
      document.getElementById('home-note').value = 'Retained note';
      document.getElementById('home-note').dispatchEvent(new Event('input', {bubbles:true}));
    `);
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    const state = await window.webContents.executeJavaScript(`({home:!!window.NotchHome,workspace:!!window.NotchWorkspace,note:document.getElementById('home-note').value,recordings:document.querySelectorAll('.recording-item').length})`);
    assert.deepEqual(errors, [], 'Retained profile must initialize without renderer errors');
    assert.deepEqual(state, {home:true,workspace:true,note:'Retained note',recordings:1});
    const migratedHome = await window.webContents.executeJavaScript(`
      (async () => {
        const tiles = [...document.querySelectorAll('#home-bento [data-home-module]')];
        const cells = [];
        for (const tile of tiles.filter((entry) => !entry.hidden)) {
          const { layoutColumn, layoutRow, layoutWidth, layoutHeight } = tile.dataset;
          for (let row = Number(layoutRow); row < Number(layoutRow) + Number(layoutHeight); row += 1) {
            for (let column = Number(layoutColumn); column < Number(layoutColumn) + Number(layoutWidth); column += 1) {
              cells.push(row * 12 + column);
            }
          }
        }
        const enableRemoved = ['music', 'mirror'].map((id) => window.NotchHome.setModuleVisible(id, true).ok);
        // Probe the retained click handler without opening a permission prompt or using a real microphone.
        let microphoneAttempts = 0;
        const originalAPI = window.notchAPI;
        window.notchAPI = { ensureMicrophone: async () => { microphoneAttempts += 1; return false; } };
        document.getElementById('record-start').click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        window.notchAPI = originalAPI;
        return {
          order: tiles.sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((tile) => tile.dataset.homeModule),
          visible: window.NotchHome.getVisibility().visibleIds,
          hidden: JSON.parse(localStorage.getItem('notch-home-hidden-modules-v1')),
          settings: [...document.querySelectorAll('[data-settings-home-module]')].map((input) => input.dataset.settingsHomeModule),
          removedElements: document.querySelectorAll('#mirror-video, #mirror-stage, #settings-mirror-choose, #music-color-bends').length,
          enableRemoved,
          cells: cells.sort((a, b) => a - b),
          microphoneAttempts,
          recordingActive: window.NotchWorkspace.isRecordingActive(),
        };
      })()
    `);
    assert.deepEqual(migratedHome.order, ['commands', 'recorder', 'pomodoro', 'windows', 'note', 'news'], 'Migration keeps the remaining saved order');
    assert.deepEqual(migratedHome.visible, ['pomodoro', 'windows', 'recorder', 'note', 'commands', 'news']);
    assert.deepEqual(migratedHome.hidden, [], 'Removed homepage module preferences are cleaned up');
    assert.deepEqual(migratedHome.settings, ['news', 'pomodoro', 'recorder', 'windows', 'note', 'commands']);
    assert.equal(migratedHome.removedElements, 0);
    assert.deepEqual(migratedHome.enableRemoved, [false, false]);
    assert.deepEqual(migratedHome.cells, Array.from({ length: 48 }, (_, index) => index), 'Migrated sizes leave no gaps or overlaps');
    assert.equal(migratedHome.microphoneAttempts, 1, 'The retained recording entry still initializes');
    assert.equal(migratedHome.recordingActive, false);
    assert.deepEqual(errors, [], 'Migration and recorder entry must not throw renderer errors');
    console.log('Retained workspace renderer checks passed');
  } finally { window.destroy(); }
}
main().then(() => app.quit(), (error) => { console.error(error); app.exit(1); });
