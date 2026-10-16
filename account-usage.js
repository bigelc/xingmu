const { createHash, randomBytes } = require('node:crypto');

const ACCOUNT_USAGE_LIMITS = Object.freeze({ csvBytes: 5 * 1024 * 1024, csvRows: 50000, columns: 128, files: 8, storeBytes: 16 * 1024 * 1024, storedRows: 50000, accounts: 100, coverage: 2000, previews: 4, previewMs: 10 * 60 * 1000 });
const METRICS = ['cost', 'requests', 'inputTokens', 'outputTokens', 'totalTokens'];
const USAGE_METRICS = METRICS.slice(1);
const FIELDS = ['date', 'model', 'apiKey', 'cost', 'currency', ...USAGE_METRICS];
const SCALE = 100000000n;
const MAX_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const COST_HEADERS = ['user_id', 'start_time_iso', 'end_time_iso', 'model', 'wallet_type', 'cost', 'currency'];
const AMOUNT_HEADERS = ['user_id', 'start_time_iso', 'end_time_iso', 'model', 'api_key_name', 'api_key', 'type', 'price', 'amount'];
const AMOUNT_TYPES = ['request_count', 'output_tokens', 'input_cache_miss_tokens', 'input_cache_hit_tokens'];
const fail = (code, line, field) => { const error = new Error(code); error.code = code; if (line) error.line = line; if (field) error.field = field; throw error; };
const resultError = (error) => ({ ok: false, error: error?.code || 'invalid_input', ...(error?.line ? { line: error.line } : {}), ...(error?.field ? { field: error.field } : {}) });
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_:.-]{1,120}$/.test(value);
const providerId = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const textValue = (value, limit = 240) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const currencyValue = (value) => ['CNY', 'USD'].includes(value);
const timestampValid = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));

function dateValue(value, line) {
  const match = /^(\d{4})([-/])(\d{2})\2(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):?(\d{2}))?)?$/.exec(String(value).trim());
  if (!match) fail('invalid_date', line, 'date');
  const [, year, , month, day, hour, minute, second, , zoneHour, zoneMinute] = match;
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number(year) < 1 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso || (hour !== undefined && (+hour > 23 || +minute > 59 || +(second || 0) > 59)) || (zoneHour !== undefined && (+zoneHour > 14 || +zoneMinute > 59 || (+zoneHour === 14 && +zoneMinute !== 0)))) fail('invalid_date', line, 'date');
  return iso;
}
function strictDay(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && dateValue(value) === value; }
function dayAfter(value, offset = 1) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); }
function reportDay(start, end, line) {
  const date = dateValue(start, line);
  const midnight = /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?\+08:00$/;
  if (!midnight.test(start) || !midnight.test(end) || dateValue(end, line) !== dayAfter(date)) fail('unsupported_interval', line, 'date');
  return date;
}
function parseCount(value, line, field) {
  value = String(value).trim();
  if (!value) return null;
  if (value.length > 128) fail('invalid_number', line, field);
  if (!/^\d+(?:\.0+)?$/.test(value) || !count(Number(value))) fail('invalid_number', line, field);
  return Number(value);
}
function costUnits(value, line) {
  value = String(value).trim();
  if (!value) return null;
  if (value.length > 128) fail('invalid_cost', line, 'cost');
  if (!/^\d+(?:\.\d+)?$/.test(value)) fail('invalid_cost', line, 'cost');
  const [rawWhole, rawFraction = ''] = value.split('.');
  const whole = rawWhole.replace(/^0+(?=\d)/, ''); const fraction = rawFraction.replace(/0+$/, '');
  if (fraction.length > 8) fail('invalid_cost', line, 'cost');
  if (whole.length > 8) fail('numeric_overflow', line, 'cost');
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
  if (units > MAX_INTEGER) fail('numeric_overflow', line, 'cost');
  return units.toString();
}
const publicCost = (units) => units === null ? null : Number(BigInt(units)) / Number(SCALE);
function addCount(a, b, field, line) { if (a === null || b === null) return null; const sum = a + b; if (!count(sum)) fail('numeric_overflow', line, field); return sum; }
function addCost(a, b, line) { if (a === null || b === null) return null; const sum = BigInt(a) + BigInt(b); if (sum > MAX_INTEGER) fail('numeric_overflow', line, 'cost'); return sum.toString(); }
function keyIdentity(accountId, value, line) {
  value = String(value || '').trim();
  if (!value) return { apiKey: '', apiKeyId: null };
  if (value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid_key_column', line, 'apiKey');
  return { apiKey: value.length > 8 ? `••••${value.slice(-4)}` : '••••', apiKeyId: createHash('sha256').update(JSON.stringify([accountId, value])).digest('hex') };
}

// Parse CSV without evaluating cells, retaining physical line numbers for errors.
function parseCSV(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > ACCOUNT_USAGE_LIMITS.csvBytes) fail('file_too_large');
  text = text.replace(/^\uFEFF/, '');
  if (!text.trim()) fail('empty_file');
  if (text.includes('\0')) fail('invalid_csv');
  let quoted = false; const separators = { ',': 0, '\t': 0, ';': 0 };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
    else if (!quoted && (char === '\r' || char === '\n')) break;
    else if (!quoted && Object.hasOwn(separators, char)) separators[char]++;
  }
  const delimiter = Object.keys(separators).sort((a, b) => separators[b] - separators[a])[0];
  if (!separators[delimiter]) fail('invalid_headers', 1);
  const records = []; let cells = [], cell = '', inQuote = false, closedQuote = false, line = 1, recordLine = 1;
  const finishCell = () => { cells.push(cell); cell = ''; closedQuote = false; if (cells.length > ACCOUNT_USAGE_LIMITS.columns) fail('too_many_columns', recordLine); };
  const finishRecord = () => { finishCell(); if (!(cells.length === 1 && cells[0].trim() === '')) records.push({ cells, line: recordLine }); cells = []; if (records.length > ACCOUNT_USAGE_LIMITS.csvRows + 1) fail('too_many_rows', recordLine); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuote) {
      if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { inQuote = false; closedQuote = true; } }
      else if (char === '\r' || char === '\n') { if (char === '\r' && text[i + 1] === '\n') i++; cell += '\n'; line++; }
      else cell += char;
    } else if (char === delimiter) finishCell();
    else if (char === '\r' || char === '\n') { finishRecord(); if (char === '\r' && text[i + 1] === '\n') i++; line++; recordLine = line; }
    else if (char === '"') { if (cell || closedQuote) fail('invalid_csv', line); inQuote = true; }
    else { if (closedQuote) { if (char !== ' ') fail('invalid_csv', line); } else cell += char; }
  }
  if (inQuote) fail('invalid_csv', recordLine);
  if (cell || cells.length || closedQuote) finishRecord();
  if (!records.length) fail('empty_file');
  const headers = records.shift().cells.map(value => value.trim());
  if (headers.some(value => !value || !textValue(value, 240)) || new Set(headers).size !== headers.length) fail('invalid_headers', 1);
  for (const record of records) if (record.cells.length !== headers.length) fail('column_count_mismatch', record.line);
  return { headers, records };
}
function suggestMapping(headers) {
  const aliases = {
    date: ['date', 'day', 'start_time_iso', '日期', '统计日期', '时间'], model: ['model', 'model_name', '模型', '模型名称'], apiKey: ['api_key', 'apikey', 'api key', '密钥'],
    cost: ['cost', 'total_cost', '费用', '金额', '消费金额'], currency: ['currency', '币种', '货币'], requests: ['requests', 'request_count', '请求数', '请求次数'],
    inputTokens: ['inputtokens', 'input_tokens', 'prompt_tokens', '输入token', '输入tokens', '输入token数'], outputTokens: ['outputtokens', 'output_tokens', 'completion_tokens', '输出token', '输出tokens', '输出token数'], totalTokens: ['totaltokens', 'total_tokens', '总token', '总tokens', '总token数'],
  };
  return Object.fromEntries(FIELDS.map(field => [field, headers.find(header => aliases[field].includes(header.trim().toLowerCase())) ?? null]));
}
function detectFormat(headers) {
  if (COST_HEADERS.every(header => headers.includes(header))) return 'deepseek-cost';
  if (AMOUNT_HEADERS.every(header => headers.includes(header))) return 'deepseek-amount';
  return 'generic';
}
function parseFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > ACCOUNT_USAGE_LIMITS.files) fail('invalid_files');
  let totalBytes = 0, totalRows = 0; const ranges = [];
  const parsed = files.map((file, index) => {
    if (!file || typeof file.text !== 'string' || (file.name !== undefined && !textValue(file.name, 255))) fail('invalid_files');
    totalBytes += Buffer.byteLength(file.text, 'utf8'); if (totalBytes > ACCOUNT_USAGE_LIMITS.csvBytes) fail('file_too_large');
    const csv = parseCSV(file.text); totalRows += csv.records.length;
    if (totalRows > ACCOUNT_USAGE_LIMITS.csvRows) fail('too_many_rows');
    const format = detectFormat(csv.headers);
    const range = /(?:^|[\/\\])(?:cost|amount)-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$/i.exec(file.name || '');
    if (range && format !== 'generic') {
      if (!strictDay(range[1]) || !strictDay(range[2]) || range[1] > range[2]) fail('invalid_range');
      ranges.push({ startDate: range[1], endDate: range[2] });
    }
    return { ...csv, index, format };
  });
  const format = parsed.every(file => file.format !== 'generic') ? 'deepseek' : 'generic';
  if (format === 'generic' && parsed.length !== 1) fail('unsupported_files');
  if (format === 'generic' && !parsed[0].records.length) fail('empty_data');
  if (new Set(parsed.map(file => file.format)).size !== parsed.length && parsed.length > 1) fail('duplicate_file_type');
  if (ranges.some(range => range.startDate !== ranges[0].startDate || range.endDate !== ranges[0].endDate)) fail('range_mismatch');
  return { parsed, format, rowCount: totalRows, detectedRange: ranges[0] || null };
}
function mappingIndexes(mapping, headers) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).some(field => !FIELDS.includes(field))) fail('invalid_mapping');
  const output = {}; const used = new Set();
  for (const field of FIELDS) {
    const value = mapping[field];
    if (value === undefined || value === null || value === '') { output[field] = null; continue; }
    const index = typeof value === 'string' ? headers.indexOf(value) : Number.isInteger(value) ? value : -1;
    if (index < 0 || index >= headers.length || used.has(index)) fail('invalid_mapping', undefined, field);
    output[field] = index; used.add(index);
  }
  if (output.date === null || !METRICS.some(field => output[field] !== null)) fail('mapping_required');
  return output;
}
function baseRow(date, model, key, currency, group) {
  return { date, model, ...key, currency, group, costUnits: null, requests: null, inputTokens: null, outputTokens: null, totalTokens: null };
}
const rowKey = (row) => JSON.stringify([row.group, row.date, row.model, row.apiKeyId, row.currency]);
function aggregateRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = rowKey(row); const existing = grouped.get(key);
    if (!existing) grouped.set(key, { ...row });
    else if (row.group === 'cost') existing.costUnits = addCost(existing.costUnits, row.costUnits);
    else for (const field of USAGE_METRICS) existing[field] = addCount(existing[field], row[field], field);
  }
  return [...grouped.values()].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
}
function genericRows(file, options) {
  const indexes = mappingIndexes(options.mapping, file.headers);
  const hasCost = indexes.cost !== null; const hasUsage = USAGE_METRICS.some(field => indexes[field] !== null);
  const rows = [];
  for (const record of file.records) {
    const value = field => indexes[field] === null ? '' : record.cells[indexes[field]].trim();
    const date = dateValue(value('date'), record.line); const model = value('model');
    if (!textValue(model)) fail('invalid_model', record.line, 'model');
    const currency = value('currency') || options.currency;
    if (!currencyValue(currency) || (options.currency && currency !== options.currency)) fail('invalid_currency', record.line, 'currency');
    const key = keyIdentity(options.accountId, value('apiKey'), record.line);
    if (hasCost) rows.push({ ...baseRow(date, model, key, currency, 'cost'), costUnits: costUnits(value('cost'), record.line) });
    if (hasUsage) {
      const row = baseRow(date, model, key, currency, 'usage');
      for (const field of USAGE_METRICS) row[field] = parseCount(value(field), record.line, field);
      if (row.totalTokens === null && row.inputTokens !== null && row.outputTokens !== null) row.totalTokens = addCount(row.inputTokens, row.outputTokens, 'totalTokens', record.line);
      if (row.totalTokens !== null && row.inputTokens !== null && row.outputTokens !== null && row.totalTokens < addCount(row.inputTokens, row.outputTokens, 'totalTokens', record.line)) fail('inconsistent_total', record.line, 'totalTokens');
      rows.push(row);
    }
  }
  return aggregateRows(rows);
}
function deepseekRows(parsed, options) {
  if (options.provider !== 'deepseek') fail('provider_mismatch');
  const currencies = new Set();
  for (const file of parsed.filter(file => file.format === 'deepseek-cost')) {
    const index = file.headers.indexOf('currency');
    for (const record of file.records) { const currency = record.cells[index].trim(); if (!currencyValue(currency)) fail('invalid_currency', record.line, 'currency'); currencies.add(currency); }
  }
  if (currencies.size > 1) fail('mixed_currencies');
  const currency = options.currency || [...currencies][0] || 'CNY';
  if (!currencyValue(currency) || (currencies.size && !currencies.has(currency))) fail('invalid_currency');
  const costs = []; const usage = new Map();
  for (const file of parsed) {
    const indexes = Object.fromEntries(file.headers.map((header, index) => [header, index]));
    for (const record of file.records) {
      const value = field => record.cells[indexes[field]].trim();
      const date = reportDay(value('start_time_iso'), value('end_time_iso'), record.line); const model = value('model');
      if (!model || !textValue(model)) fail('invalid_model', record.line, 'model');
      if (file.format === 'deepseek-cost') {
        if (!['Paid', 'Granted'].includes(value('wallet_type'))) fail('unsupported_wallet_type', record.line);
        const units = costUnits(value('cost'), record.line); if (units === null) fail('missing_metric', record.line, 'cost');
        costs.push({ ...baseRow(date, model, { apiKey: '', apiKeyId: null }, currency, 'cost'), costUnits: units });
      } else {
        const type = value('type'); if (!AMOUNT_TYPES.includes(type)) fail('unsupported_usage_type', record.line);
        const amount = parseCount(value('amount'), record.line, 'amount'); if (amount === null) fail('missing_metric', record.line, 'amount');
        const row = baseRow(date, model, keyIdentity(options.accountId, value('api_key'), record.line), currency, 'usage');
        const key = rowKey(row);
        if (!usage.has(key)) usage.set(key, { row, values: Object.fromEntries(AMOUNT_TYPES.map(name => [name, 0])) });
        const entry = usage.get(key); entry.values[type] = addCount(entry.values[type], amount, type, record.line);
      }
    }
  }
  const usageRows = [...usage.values()].map(({ row, values }) => {
    row.requests = values.request_count; row.outputTokens = values.output_tokens;
    row.inputTokens = addCount(values.input_cache_hit_tokens, values.input_cache_miss_tokens, 'inputTokens');
    row.totalTokens = addCount(row.inputTokens, row.outputTokens, 'totalTokens'); return row;
  });
  return aggregateRows([...costs, ...usageRows]);
}
function sourceAccountId(parsed, provider) {
  const userIds = new Set();
  for (const file of parsed) {
    const index = file.headers.indexOf('user_id');
    for (const record of file.records) {
      const value = record.cells[index].trim();
      if (!value || !textValue(value, 240)) fail('invalid_account', record.line);
      userIds.add(value);
      if (userIds.size > 1) fail('account_mismatch', record.line);
    }
  }
  return userIds.size ? createHash('sha256').update(JSON.stringify([provider, [...userIds][0]])).digest('hex') : null;
}
function metricsFor(rows) {
  const output = Object.fromEntries(METRICS.map(field => [field, null]));
  for (const field of METRICS) {
    const relevant = rows.filter(row => row.group === (field === 'cost' ? 'cost' : 'usage'));
    if (!relevant.length) continue;
    if (field === 'cost') output.cost = publicCost(relevant.reduce((sum, row) => addCost(sum, row.costUnits), '0'));
    else output[field] = relevant.reduce((sum, row) => addCount(sum, row[field], field), 0);
  }
  return output;
}
function checkRowTotals(rows) {
  const totals = new Map();
  for (const row of rows) {
    if (!totals.has(row.currency)) totals.set(row.currency, { costUnits: '0', ...Object.fromEntries(USAGE_METRICS.map(field => [field, 0])) });
    const total = totals.get(row.currency);
    if (row.costUnits !== null) total.costUnits = addCost(total.costUnits, row.costUnits);
    for (const field of USAGE_METRICS) if (row[field] !== null) total[field] = addCount(total[field], row[field], field);
  }
}
function normalizeCoverage(coverage) {
  const sorted = coverage.sort((a, b) => JSON.stringify([a.group, a.currency, a.metrics]).localeCompare(JSON.stringify([b.group, b.currency, b.metrics])) || a.startDate.localeCompare(b.startDate));
  const result = [];
  for (const entry of sorted) {
    const last = result.at(-1);
    if (last && last.group === entry.group && last.currency === entry.currency && JSON.stringify(last.metrics) === JSON.stringify(entry.metrics) && entry.startDate <= dayAfter(last.endDate)) {
      if (entry.endDate > last.endDate) last.endDate = entry.endDate;
    } else result.push({ ...entry, metrics: [...entry.metrics] });
  }
  return result;
}
function replaceCoverage(previous, current) {
  let coverage = previous.map(entry => ({ ...entry, metrics: [...entry.metrics] }));
  for (const next of current) {
    coverage = coverage.flatMap(old => {
      if (old.group !== next.group || old.currency !== next.currency || old.endDate < next.startDate || old.startDate > next.endDate) return [old];
      const pieces = [];
      if (old.startDate < next.startDate) pieces.push({ ...old, endDate: dayAfter(next.startDate, -1) });
      if (old.endDate > next.endDate) pieces.push({ ...old, startDate: dayAfter(next.endDate) });
      return pieces;
    });
    coverage.push(next);
  }
  return normalizeCoverage(coverage);
}
function createAccountUsageService({ readStore = () => null, writeStore = () => {}, now = Date.now } = {}) {
  let store; let storageError; let blocked = false; const previews = new Map();
  const timestamp = () => new Date(now()).toISOString();
  function validateStore(saved) {
    if (!saved || saved.version !== 1 || !Array.isArray(saved.accounts) || saved.accounts.length > ACCOUNT_USAGE_LIMITS.accounts || Buffer.byteLength(JSON.stringify(saved)) > ACCOUNT_USAGE_LIMITS.storeBytes) fail('store_unreadable');
    const ids = new Set(); let rowCount = 0, coverageCount = 0;
    const accounts = saved.accounts.map(account => {
      if (!identifier(account?.id) || ids.has(account.id) || !providerId(account.provider) || !timestampValid(account.updatedAt) || !count(account.importsCount) || account.importsCount < 1 || !Array.isArray(account.rows) || !Array.isArray(account.coverage) || !(account.sourceAccountId === null || /^[a-f0-9]{64}$/.test(account.sourceAccountId))) fail('store_unreadable');
      ids.add(account.id); rowCount += account.rows.length; coverageCount += account.coverage.length;
      const keys = new Set();
      const rows = account.rows.map(row => {
        if (!row || !strictDay(row.date) || !textValue(row.model) || !currencyValue(row.currency) || !['cost', 'usage'].includes(row.group) || !(row.apiKeyId === null ? row.apiKey === '' : /^[a-f0-9]{64}$/.test(row.apiKeyId) && /^••••[^\u0000-\u001f\u007f]{0,4}$/.test(row.apiKey)) || !USAGE_METRICS.every(field => row[field] === null || count(row[field]))) fail('store_unreadable');
        if (row.costUnits !== null && (typeof row.costUnits !== 'string' || row.costUnits.length > 16 || !/^(0|[1-9]\d*)$/.test(row.costUnits) || BigInt(row.costUnits) > MAX_INTEGER)) fail('store_unreadable');
        if ((row.group === 'cost' && USAGE_METRICS.some(field => row[field] !== null)) || (row.group === 'usage' && row.costUnits !== null)) fail('store_unreadable');
        if (row.totalTokens !== null && row.inputTokens !== null && row.outputTokens !== null && row.totalTokens < addCount(row.inputTokens, row.outputTokens, 'totalTokens')) fail('store_unreadable');
        const key = rowKey(row); if (keys.has(key)) fail('store_unreadable'); keys.add(key);
        return { ...baseRow(row.date, row.model, { apiKey: row.apiKey, apiKeyId: row.apiKeyId }, row.currency, row.group), costUnits: row.costUnits, ...Object.fromEntries(USAGE_METRICS.map(field => [field, row[field]])) };
      });
      const coverage = account.coverage.map(entry => {
        if (!entry || !strictDay(entry.startDate) || !strictDay(entry.endDate) || entry.startDate > entry.endDate || !currencyValue(entry.currency) || !['cost', 'usage'].includes(entry.group) || !Array.isArray(entry.metrics) || new Set(entry.metrics).size !== entry.metrics.length || entry.metrics.some(field => !(entry.group === 'cost' ? ['cost'] : USAGE_METRICS).includes(field))) fail('store_unreadable');
        return { startDate: entry.startDate, endDate: entry.endDate, currency: entry.currency, group: entry.group, metrics: [...entry.metrics] };
      });
      const coverageByGroup = new Map();
      for (const entry of coverage) {
        const key = `${entry.group}:${entry.currency}`;
        if (!coverageByGroup.has(key)) coverageByGroup.set(key, []);
        coverageByGroup.get(key).push(entry);
      }
      for (const entries of coverageByGroup.values()) {
        entries.sort((a, b) => a.startDate.localeCompare(b.startDate));
        for (let index = 1; index < entries.length; index++) if (entries[index].startDate <= entries[index - 1].endDate) fail('store_unreadable');
      }
      for (const row of rows) {
        const entries = coverageByGroup.get(`${row.group}:${row.currency}`) || [];
        let low = 0, high = entries.length - 1, match = null;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (entries[middle].startDate <= row.date) { match = entries[middle]; low = middle + 1; } else high = middle - 1;
        }
        if (!match || match.endDate < row.date || match.metrics.some(field => row[field === 'cost' ? 'costUnits' : field] === null)) fail('store_unreadable');
      }
      checkRowTotals(rows);
      return { id: account.id, provider: account.provider, sourceAccountId: account.sourceAccountId, updatedAt: account.updatedAt, importsCount: account.importsCount, rows, coverage: normalizeCoverage(coverage) };
    });
    if (rowCount > ACCOUNT_USAGE_LIMITS.storedRows || coverageCount > ACCOUNT_USAGE_LIMITS.coverage) fail('store_unreadable');
    return { version: 1, accounts };
  }
  function load() {
    if (store) return;
    try { const saved = readStore(); store = saved == null ? { version: 1, accounts: [] } : validateStore(saved); }
    catch { store = { version: 1, accounts: [] }; blocked = true; storageError = 'store_unreadable'; }
  }
  function inspectCSV(text) {
    try { const csv = parseCSV(text); if (!csv.records.length) fail('empty_data'); return { ok: true, headers: csv.headers, suggestedMapping: suggestMapping(csv.headers), rowCount: csv.records.length }; }
    catch (error) { return resultError(error); }
  }
  function inspectFiles(files) {
    try {
      const parsed = parseFiles(files);
      return { ok: true, format: parsed.format, requiresMapping: parsed.format === 'generic', detectedRange: parsed.detectedRange, rowCount: parsed.rowCount, files: parsed.parsed.map(file => ({ index: file.index, format: file.format, headers: file.headers, rowCount: file.records.length })), ...(parsed.format === 'generic' ? { headers: parsed.parsed[0].headers, suggestedMapping: suggestMapping(parsed.parsed[0].headers) } : {}) };
    } catch (error) { return resultError(error); }
  }
  function prunePreviews() { for (const [token, preview] of previews) if (preview.expiresAt <= now()) previews.delete(token); }
  function previewFiles(options = {}) {
    try {
      load(); if (blocked) fail('store_unreadable');
      if (!options || !identifier(options.accountId) || !providerId(options.provider)) fail('invalid_account');
      const existing = store.accounts.find(account => account.id === options.accountId);
      if (existing && existing.provider !== options.provider) fail('provider_mismatch');
      const parsed = parseFiles(options.files);
      const sourceId = parsed.format === 'deepseek' ? sourceAccountId(parsed.parsed, options.provider) : null;
      if (sourceId && existing?.sourceAccountId && sourceId !== existing.sourceAccountId) fail('account_mismatch');
      const rows = parsed.format === 'deepseek' ? deepseekRows(parsed.parsed, options) : genericRows(parsed.parsed[0], options);
      if (!rows.length && (!parsed.detectedRange && (!options.startDate || !options.endDate))) fail('empty_data');
      const currencies = new Set(rows.map(row => row.currency)); if (currencies.size > 1) fail('mixed_currencies');
      const currency = rows[0]?.currency || options.currency || 'CNY'; const dates = rows.map(row => row.date).sort();
      const startDate = options.startDate || parsed.detectedRange?.startDate || dates[0]; const endDate = options.endDate || parsed.detectedRange?.endDate || dates.at(-1);
      if (!strictDay(startDate) || !strictDay(endDate) || startDate > endDate || (dates.length && (dates[0] < startDate || dates.at(-1) > endDate))) fail('invalid_range');
      if (parsed.detectedRange && (startDate !== parsed.detectedRange.startDate || endDate !== parsed.detectedRange.endDate)) fail('range_mismatch');
      const groups = parsed.format === 'deepseek' ? [...new Set(parsed.parsed.map(file => file.format === 'deepseek-cost' ? 'cost' : 'usage'))].sort() : [...new Set(rows.map(row => row.group))]; const metrics = metricsFor(rows);
      checkRowTotals(rows);
      if (parsed.format === 'deepseek') {
        for (const group of groups) if (!rows.some(row => row.group === group)) for (const field of group === 'cost' ? ['cost'] : USAGE_METRICS) metrics[field] = 0;
      }
      if (METRICS.every(field => metrics[field] === null) && rows.every(row => row.costUnits === null && USAGE_METRICS.every(field => row[field] === null))) fail('missing_metric');
      const coverage = groups.map(group => ({ startDate, endDate, currency, group, metrics: (group === 'cost' ? ['cost'] : USAGE_METRICS).filter(field => metrics[field] !== null) }));
      const warnings = [];
      if (!parsed.detectedRange && !options.startDate && !options.endDate) warnings.push('统计范围根据文件中出现的日期确定，未记录的日期不代表完整账户历史。');
      if (groups.includes('usage') && USAGE_METRICS.some(field => metrics[field] === null)) warnings.push('文件未完整提供所有用量字段，缺失统计显示为未知。');
      if (groups.includes('cost') && metrics.cost === null) warnings.push('部分费用为空，费用合计显示为未知。');
      if (parsed.format === 'deepseek' && groups.includes('cost')) warnings.push('费用文件不区分 API Key，按 Key 查看时不能分摊账户费用。');
      const preview = { rowCount: parsed.rowCount, normalizedRowCount: rows.length, startDate, endDate, metrics, currency, models: [...new Set(rows.map(row => row.model))], groups, warnings, replaceNotice: '确认后将替换此账户在该日期范围内已有的同类统计；费用与用量分别替换，不会重复累计。' };
      prunePreviews(); while (previews.size >= ACCOUNT_USAGE_LIMITS.previews) previews.delete(previews.keys().next().value);
      const token = randomBytes(24).toString('hex');
      previews.set(token, { expiresAt: now() + ACCOUNT_USAGE_LIMITS.previewMs, accountId: options.accountId, provider: options.provider, sourceAccountId: sourceId, rows, coverage, startDate, endDate, currency, groups });
      return { ok: true, token, preview };
    } catch (error) { return resultError(error); }
  }
  function previewImport(options = {}) { return previewFiles({ ...options, files: [{ text: options?.text }] }); }
  function commitImport(options = {}) {
    try {
      load(); if (blocked) fail('store_unreadable'); prunePreviews();
      const token = options?.token;
      if (typeof token !== 'string' || !previews.has(token)) fail('preview_expired');
      const pending = previews.get(token); const next = structuredClone(store);
      let account = next.accounts.find(entry => entry.id === pending.accountId);
      if (!account) { account = { id: pending.accountId, provider: pending.provider, sourceAccountId: pending.sourceAccountId, updatedAt: timestamp(), importsCount: 0, rows: [], coverage: [] }; next.accounts.push(account); }
      if (account.provider !== pending.provider) fail('provider_mismatch');
      if (pending.sourceAccountId && account.sourceAccountId && pending.sourceAccountId !== account.sourceAccountId) fail('account_mismatch');
      const previous = JSON.stringify([account.rows, account.coverage, account.sourceAccountId]);
      if (pending.sourceAccountId) account.sourceAccountId = pending.sourceAccountId;
      const kept = account.rows.filter(row => !(pending.groups.includes(row.group) && row.currency === pending.currency && row.date >= pending.startDate && row.date <= pending.endDate));
      account.rows = aggregateRows([...kept, ...pending.rows]); account.coverage = replaceCoverage(account.coverage, pending.coverage);
      checkRowTotals(account.rows);
      if (previous === JSON.stringify([account.rows, account.coverage, account.sourceAccountId])) { previews.delete(token); return { ok: true, duplicate: true }; }
      account.updatedAt = timestamp(); account.importsCount++;
      if (!count(account.importsCount) || next.accounts.length > ACCOUNT_USAGE_LIMITS.accounts || next.accounts.reduce((sum, entry) => sum + entry.rows.length, 0) > ACCOUNT_USAGE_LIMITS.storedRows || next.accounts.reduce((sum, entry) => sum + entry.coverage.length, 0) > ACCOUNT_USAGE_LIMITS.coverage || Buffer.byteLength(JSON.stringify(next)) > ACCOUNT_USAGE_LIMITS.storeBytes) fail('storage_limit_reached');
      try { writeStore(structuredClone(next)); } catch { storageError = 'save_failed'; fail('save_failed'); }
      store = next; storageError = undefined; previews.delete(token); return { ok: true };
    } catch (error) { return resultError(error); }
  }
  function getSnapshot() {
    load();
    return { ok: !blocked, accounts: store.accounts.map(account => ({ id: account.id, provider: account.provider, updatedAt: account.updatedAt, importsCount: account.importsCount, rows: account.rows.map(row => ({ date: row.date, model: row.model, apiKey: row.apiKey, apiKeyId: row.apiKeyId, currency: row.currency, cost: publicCost(row.costUnits), ...Object.fromEntries(USAGE_METRICS.map(field => [field, row[field]])) })), coverage: account.coverage.map(entry => ({ startDate: entry.startDate, endDate: entry.endDate, currency: entry.currency, metrics: [...entry.metrics] })) })), ...(storageError ? { storageError } : {}) };
  }
  return { inspectCSV, inspectFiles, previewImport, previewFiles, commitImport, getSnapshot };
}

module.exports = { createAccountUsageService, ACCOUNT_USAGE_LIMITS };
