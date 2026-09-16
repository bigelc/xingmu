const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

function harness() {
  const requests = [];
  const handlers = new Map();
  const frame = {};
  const contents = { mainFrame: frame };
  const mainWindow = { webContents: contents, isDestroyed: () => false, setBounds() {}, setIgnoreMouseEvents() {}, setAlwaysOnTop() {} };
  const context = vm.createContext({
    process: { platform: 'darwin', pid: 101 },
    currentMode: 'collapsed', mainWindow, previousPasteTarget: { pid: 202, bundleId: 'test.editor', path: '/Synthetic Editor.app' },
    returnToWorkGeneration: 0, pendingFocusReturn: null,
    setTimeout, Date, hideWhenCollapsed: false,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    requestRendererCollapse: () => { context.collapseRequests += 1; }, collapseRequests: 0,
    cancelCollapseWatchdog() {}, getBoundsForMode: () => ({}), syncHoverSpacePolling() {},
    windowPinned: false, publishWindowState() {},
    execFile: (file, args, options, callback) => {
      const request = { file, args, options, callback, killed: false };
      requests.push(request);
      return { kill: () => { request.killed = true; } };
    },
  });
  vm.runInContext(section('function isMainRenderer(event)', 'function prepareMainRendererForQuit'), context);
  vm.runInContext(section('function applyMode(mode, display)', '// 纯重新定位'), context);
  vm.runInContext(section('function waitForCollapsedPanel(', 'function pasteToPreviousApp'), context);
  vm.runInContext('globalThis.nativeReturnScript = RETURN_TO_WORK_JXA;', context);
  return {
    context, requests,
    invoke: (event = { sender: contents, senderFrame: frame }, payload) => handlers.get('window:return-to-work')(event, payload),
    script: context.nativeReturnScript,
  };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('return to work accepts only the main window and its main frame', async () => {
  const h = harness();
  const foreign = await h.invoke({ sender: {}, senderFrame: {} });
  assert.equal(foreign.reason, 'forbidden');
  const subframe = await h.invoke({ sender: h.context.mainWindow.webContents, senderFrame: {} });
  assert.equal(subframe.reason, 'forbidden');
  assert.equal(h.context.collapseRequests, 0);
  assert.equal(h.requests.length, 0);
});

test('focus return waits for collapse and activates only the cached identity', async () => {
  const h = harness();
  h.context.currentMode = 'expanded';
  const resultPromise = h.invoke(undefined, { pid: 999, bundleId: 'untrusted.target' });
  await nextTurn();
  assert.equal(h.requests.length, 0);
  h.context.applyMode('collapsed');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].file, '/usr/bin/osascript');
  assert.deepEqual(Array.from(h.requests[0].args.slice(4)), ['202', 'test.editor', '/Synthetic Editor.app', '101']);
  h.requests[0].callback(null, 'ok');
  assert.equal((await resultPromise).returned, true);
});

test('reopening the panel cancels both a pending collapse wait and an in-flight activator', async () => {
  const waiting = harness();
  waiting.context.currentMode = 'expanded';
  const waitingResult = waiting.invoke();
  waiting.context.applyMode('expanded');
  waiting.context.applyMode('collapsed');
  assert.equal((await waitingResult).reason, 'cancelled');
  assert.equal(waiting.requests.length, 0);

  const running = harness();
  const runningResult = running.invoke();
  await nextTurn();
  assert.equal(running.requests.length, 1);
  running.context.applyMode('expanded');
  assert.equal(running.requests[0].killed, true);
  assert.equal((await runningResult).reason, 'cancelled');
  running.requests[0].callback(null, 'ok');
  assert.equal(running.context.currentMode, 'expanded');
});

test('missing cached targets and unavailable native activation degrade without launching anything', async () => {
  const missing = harness();
  missing.context.previousPasteTarget = null;
  assert.equal((await missing.invoke()).reason, 'no_cached_target');
  assert.equal(missing.requests.length, 0);
  const unavailable = harness();
  const result = unavailable.invoke();
  await nextTurn();
  unavailable.requests[0].callback(new Error('Synthetic native failure'), '');
  assert.equal((await result).returned, false);
});

function runNativeScript(script, { frontmostPid = 101, targetPid = 202, targetPath = '/Synthetic Editor.app', terminated = false } = {}) {
  let activations = 0;
  const target = {
    isNil: () => false, terminated, bundleIdentifier: 'test.editor', bundleURL: { path: targetPath },
    activateWithOptions: () => { activations += 1; return true; },
  };
  const context = vm.createContext({
    ObjC: { import() {}, unwrap: (value) => value },
    $: {
      NSRunningApplication: { runningApplicationWithProcessIdentifier: (pid) => pid === targetPid ? target : null },
      NSWorkspace: { sharedWorkspace: { frontmostApplication: { processIdentifier: frontmostPid } } },
      NSApplicationActivateIgnoringOtherApps: 1,
    },
  });
  vm.runInContext(script, context);
  return { result: context.run(['202', 'test.editor', '/Synthetic Editor.app', '101']), activations: () => activations };
}

test('AppKit script verifies the cached process and does not steal focus after another app becomes active', () => {
  const { script } = harness();
  assert.doesNotMatch(script, /System Events|keystroke|keyCode|launchApplication|openApplication/);
  let result = runNativeScript(script);
  assert.equal(result.result, 'ok');
  assert.equal(result.activations(), 1);
  result = runNativeScript(script, { frontmostPid: 303 });
  assert.equal(result.result, 'superseded');
  assert.equal(result.activations(), 0);
  result = runNativeScript(script, { targetPath: '/Different Application.app' });
  assert.equal(result.result, 'missing');
  assert.equal(result.activations(), 0);
  result = runNativeScript(script, { terminated: true });
  assert.equal(result.result, 'missing');
  assert.equal(result.activations(), 0);
});
