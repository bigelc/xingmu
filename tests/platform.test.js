const test = require('node:test');
const assert = require('node:assert/strict');
const platform = require('../platform');

test('Windows strip avoids a top taskbar and expanded panel stays in usable desktop', () => {
  const display = { bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, workArea: { x: -1920, y: -152, width: 1920, height: 1032 } };
  assert.deepEqual(platform.panelBounds('win32', display, false), { x: -1060, y: -152, width: 200, height: 38 });
  assert.deepEqual(platform.panelBounds('win32', display, true), { x: -1580, y: -152, width: 1240, height: 616 });
});

test('Windows small scaled desktops leave 24 DIP margins around constrained content', () => {
  const display = { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 48, y: 0, width: 752, height: 560 } };
  assert.deepEqual(platform.panelBounds('win32', display, true), { x: 72, y: 0, width: 704, height: 536 });
});

test('Mac retains notch height and physical top origin', () => {
  const display = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } };
  assert.deepEqual(platform.panelBounds('darwin', display, false), { x: 656, y: 0, width: 200, height: 37 });
  assert.deepEqual(platform.panelBounds('darwin', display, true), { x: 136, y: 0, width: 1240, height: 616 });
});

test('Windows capabilities cannot enable Mac-only integrations', () => {
  assert.deepEqual(platform.capabilities('win32').unavailableHomeModules, ['windows']);
  assert.equal(platform.capabilities('win32').automaticPaste, false);
  assert.equal(platform.capabilities('win32').autoLaunch, true);
  assert.deepEqual(platform.capabilities('darwin').unavailableHomeModules, []);
});

test('platform filtering leaves saved preferences intact and recovers a usable home', () => {
  const registry = ['pomodoro', 'windows', 'recorder', 'note', 'commands'];
  const hidden = ['pomodoro', 'recorder', 'note', 'commands'];
  const before = [...hidden];
  assert.deepEqual(platform.effectiveHiddenModules(hidden, registry, ['windows']), ['windows', 'recorder', 'note', 'commands']);
  assert.deepEqual(hidden, before);
  assert.deepEqual(platform.effectiveHiddenModules(hidden, registry, []), hidden);
});

test('media references use portable separators for both Windows and Mac workspace files', () => {
  assert.equal(platform.portableMediaPath('recordings', 'C:\\Users\\me\\recordings\\recording-123.webm'), 'recordings/recording-123.webm');
  assert.equal(platform.portableMediaPath('clipboard-images', '/Users/me/clipboard-images/clip-123.png'), 'clipboard-images/clip-123.png');
});
