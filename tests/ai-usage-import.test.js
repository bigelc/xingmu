const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readUsageImportFile, MAX_USAGE_IMPORT_BYTES } = require('../ai-usage-import');

function zip(entries) {
  const locals = [], directory = []; let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name), body = Buffer.from(item.text || '');
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(item.declaredSize ?? body.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(item.declaredSize ?? body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, name); locals.push(local, name, body); offset += local.length + name.length + body.length;
  }
  const end = Buffer.alloc(22), central = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
async function withFile(t, name, bytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-reader-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, name); await fs.writeFile(file, bytes); return file;
}
test('usage import reads UTF-8 CSV and bounded ZIP without extracting files', async (t) => {
  const csv = await withFile(t, '账单.csv', '\ufeffdate,cost\n2026-10-15,0.5');
  assert.deepEqual(await readUsageImportFile(csv), [{ name: '账单.csv', text: 'date,cost\n2026-10-15,0.5' }]);
  const archive = await withFile(t, 'usage.zip', zip([{ name: 'cost.csv', text: 'date,cost\n2026-10-15,0.5' }, { name: 'amount.csv', text: 'date,tokens\n2026-10-15,100' }]));
  assert.equal((await readUsageImportFile(archive)).length, 2);
  assert.deepEqual(await fs.readdir(path.dirname(archive)), ['usage.zip']);
});
test('usage import rejects oversized files and decompressed claims', async (t) => {
  const large = await withFile(t, 'large.csv', Buffer.alloc(MAX_USAGE_IMPORT_BYTES + 1));
  await assert.rejects(readUsageImportFile(large), /file_too_large/);
  const bomb = await withFile(t, 'bomb.zip', zip([{ name: 'cost.csv', text: 'a', declaredSize: MAX_USAGE_IMPORT_BYTES + 1 }]));
  await assert.rejects(readUsageImportFile(bomb), /file_too_large/);
});
test('usage import rejects invalid ZIP, traversal, excessive entries and invalid encoding', async (t) => {
  const corrupt = zip([{ name: 'cost.csv', text: 'date,cost\n2026-10-15,0.5' }]);
  corrupt[30 + Buffer.byteLength('cost.csv')] ^= 1;
  for (const [name, bytes, reason] of [
    ['corrupt.zip', corrupt, /invalid_zip/],
    ['broken.zip', Buffer.from('invalid'), /invalid_zip/],
    ['unsafe.zip', zip([{ name: '../cost.csv', text: 'date,cost' }]), /invalid_zip/],
    ['many.zip', zip(Array.from({ length: 21 }, (_, i) => ({ name: `${i}.csv`, text: 'x' }))), /invalid_zip/],
    ['encoding.csv', Buffer.from([0xff, 0xfe, 0]), /invalid_encoding/],
  ]) await assert.rejects(readUsageImportFile(await withFile(t, name, bytes)), reason);
});
