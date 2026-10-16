const fs = require('node:fs');
const path = require('node:path');

// These historical names are compatibility identifiers, never product labels.
const PRODUCT_DIRECTORY = '醒目-个人效率工作台';
const V1_DIRECTORY = 'TO-DO Panel 二开版';
const OMIT = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Crashpad', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']);

function resolveProfileDirectory({ appData, explicitPath }) {
  if (explicitPath) return path.resolve(explicitPath);
  const current = path.join(appData, PRODUCT_DIRECTORY);
  const previous = path.join(appData, V1_DIRECTORY);
  if (fs.existsSync(current) || !fs.existsSync(previous)) return current;
  let temporary;
  try {
    temporary = fs.mkdtempSync(path.join(appData, '.xingmu-upgrade-'));
    fs.cpSync(previous, temporary, {
      recursive: true,
      filter: (source) => !OMIT.has(path.basename(source)) && !fs.lstatSync(source).isSymbolicLink(),
    });
    fs.renameSync(temporary, current);
    return current;
  } catch (error) {
    // Do not start with an empty profile if an upgrade copy was interrupted.
    console.warn('Xingmu profile upgrade deferred:', error.code || 'copy_failed');
    return previous;
  } finally {
    if (temporary) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* Preserve the source even if cleanup is unavailable. */ }
    }
  }
}

module.exports = { resolveProfileDirectory };
