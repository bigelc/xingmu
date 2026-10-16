const fs = require('node:fs/promises');
const path = require('node:path');
const unzipper = require('unzipper');

const MAX_BYTES = 5 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  return value >>> 0;
});
function decode(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('invalid_encoding'); }
}

// The main process supplies only a path selected in its native file dialog.
// ZIP contents stay in memory; no archive path is ever written to disk.
async function readUsageImportFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!['.csv', '.zip'].includes(extension)) throw new Error('unsupported_file');
  const handle = await fs.open(filePath, 'r');
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('unsupported_file');
    if (stat.size > MAX_BYTES || stat.size === 0) throw new Error('file_too_large');
    const buffer = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const result = await handle.read(buffer, read, buffer.length - read, null);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (read > stat.size) throw new Error('file_too_large');
    bytes = buffer.subarray(0, read);
  } finally { await handle.close(); }
  if (extension === '.csv') return [{ name: path.basename(filePath), text: decode(bytes) }];
  let directory;
  try { directory = await unzipper.Open.buffer(bytes); }
  catch { throw new Error('invalid_zip'); }
  if (!directory.files.length || directory.files.length > 20) throw new Error('invalid_zip');
  const entries = directory.files.filter((entry) => entry.type === 'File' && /\.csv$/i.test(entry.path));
  if (!entries.length || entries.length > 4) throw new Error('invalid_zip');
  let total = 0;
  const files = [];
  for (const entry of entries) {
    if (entry.flags & 1 || entry.path.includes('..') || /[\\\u0000]/.test(entry.path) || entry.path.startsWith('/')) throw new Error('invalid_zip');
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > MAX_BYTES - total) throw new Error('file_too_large');
    const stream = entry.stream();
    const timer = setTimeout(() => stream.destroy(new Error('import_timeout')), 10000);
    const chunks = []; let size = 0; let crc = 0xffffffff;
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_BYTES - total) throw new Error('file_too_large');
        for (const byte of chunk) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
        chunks.push(chunk);
      }
      if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error('invalid_zip');
      total += size;
      files.push({ name: path.basename(entry.path), text: decode(Buffer.concat(chunks, size)) });
    } finally { clearTimeout(timer); stream.destroy(); }
  }
  return files;
}
module.exports = { readUsageImportFile, MAX_USAGE_IMPORT_BYTES: MAX_BYTES };
