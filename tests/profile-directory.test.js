const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProfileDirectory } = require('../profile-directory');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmu-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'TO-DO Panel 二开版');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'workspace.json'), 'retained notes');
  return { root, old };
}

test('upgrade retains v1 files and never modifies the original profile', (t) => {
  const { root, old } = fixture(t);
  fs.mkdirSync(path.join(old, 'Cache'));
  fs.writeFileSync(path.join(old, 'Cache', 'discard'), 'cached');
  const current = resolveProfileDirectory({ appData: root });
  assert.equal(path.basename(current), '醒目-个人效率工作台');
  assert.equal(fs.readFileSync(path.join(current, 'workspace.json'), 'utf8'), 'retained notes');
  assert.equal(fs.readFileSync(path.join(old, 'workspace.json'), 'utf8'), 'retained notes');
  assert.equal(fs.existsSync(path.join(current, 'Cache')), false);
  fs.writeFileSync(path.join(current, 'workspace.json'), 'v2 notes');
  assert.equal(resolveProfileDirectory({ appData: root }), current);
  assert.equal(fs.readFileSync(path.join(current, 'workspace.json'), 'utf8'), 'v2 notes');
});

test('an explicit isolated profile never reads or migrates existing user data', (t) => {
  const { root } = fixture(t);
  const explicitPath = path.join(root, 'isolated');
  assert.equal(resolveProfileDirectory({ appData: root, explicitPath }), explicitPath);
  assert.equal(fs.existsSync(path.join(root, '醒目-个人效率工作台')), false);
});

test('a new install uses the branded directory without touching other apps', (t) => {
  const { root, old } = fixture(t);
  fs.rmSync(old, { recursive: true });
  assert.equal(resolveProfileDirectory({ appData: root }), path.join(root, '醒目-个人效率工作台'));
});
