const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['main.js', 'main-services.js', 'preload.js', 'build/afterPack.js'];
for (const dir of ['renderer', 'scripts']) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (name.endsWith('.js')) files.push(`${dir}/${name}`);
  }
}
for (const file of files) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
console.log(`Syntax checked: ${files.length} JavaScript files`);
