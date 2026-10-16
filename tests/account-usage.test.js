const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountUsageService, ACCOUNT_USAGE_LIMITS } = require('../account-usage');

const COST_HEADER = 'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency';
const AMOUNT_HEADER = 'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount';
const day = '2026-10-15';
function harness(options = {}) {
  let stored = options.stored ?? null, time = Date.parse('2026-10-15T12:00:00+08:00'), failed = Boolean(options.writeError);
  const writes = [];
  const service = createAccountUsageService({ now: () => time, readStore: () => { if (options.readError) throw Error('disk'); return stored; }, writeStore: value => { if (failed) throw Error('disk'); stored = structuredClone(value); writes.push(value); } });
  return { service, writes, stored: () => stored, advance: ms => { time += ms; }, failWrites: value => { failed = value; } };
}
function generic(text, extra = {}) {
  return { text, accountId: 'import:moonshot', provider: 'moonshot', currency: 'CNY', mapping: { date: 'date', model: 'model', cost: 'cost', requests: 'requests', inputTokens: 'input', outputTokens: 'output' }, ...extra };
}
function importCSV(h, options) { const preview = h.service.previewImport(options); assert.equal(preview.ok, true, JSON.stringify(preview)); const result = h.service.commitImport({ token: preview.token }); assert.equal(result.ok, true, JSON.stringify(result)); return preview; }
function costFile(rows, range = ['2026-09-16', '2026-10-15']) {
  return { name: `cost-${range[0]}_${range[1]}.csv`, text: `${COST_HEADER}\n${rows.map(row => [row.user || 'synthetic-account', `${row.date || day}T00:00:00+08:00`, `${row.end || '2026-10-16'}T00:00:00+08:00`, row.model || 'deepseek-test', row.wallet || 'Paid', row.cost, row.currency || 'CNY'].join(',')).join('\n')}` };
}
function amountFile(rows, range = ['2026-09-16', '2026-10-15']) {
  return { name: `amount-${range[0]}_${range[1]}.csv`, text: `${AMOUNT_HEADER}\n${rows.map(row => [row.user || 'synthetic-account', `${row.date || day}T00:00:00+08:00`, `${row.end || '2026-10-16'}T00:00:00+08:00`, row.model || 'deepseek-test', 'synthetic-key-name', row.key || 'sk-synthetic-secret-1234', row.type, '0.0001', row.amount].join(',')).join('\n')}` };
}
function official(files, extra = {}) { return { files, accountId: 'deepseek-connection', provider: 'deepseek', ...extra }; }
function importFiles(h, options) { const preview = h.service.previewFiles(options); assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(h.service.commitImport({ token: preview.token }).ok, true); return preview; }

test('CSV inspection handles BOM, supported delimiters, escaped quotes and quoted multiline cells without returning samples', () => {
  const h = harness();
  for (const delimiter of [',', '\t', ';']) {
    const text = `\uFEFFdate${delimiter}model${delimiter}cost${delimiter}remarks\r\n2026/10/15${delimiter}"model ""A"""${delimiter}0.1${delimiter}"line one\r\nline two"\r\n`;
    const result = h.service.inspectCSV(text);
    assert.equal(result.ok, true); assert.equal(result.rowCount, 1);
    assert.equal(result.suggestedMapping.date, 'date'); assert.equal(result.suggestedMapping.cost, 'cost');
    assert.equal(result.sampleRows, undefined); assert.doesNotMatch(JSON.stringify(result), /line one|model A/);
    const preview = h.service.previewImport(generic(text, { mapping: { date: 'date', model: 'model', cost: 'cost' } }));
    assert.equal(preview.ok, true); assert.deepEqual(preview.preview.models, ['model "A"']);
  }
  const suggestion = h.service.inspectCSV('date,prompt_cache_hit_tokens,reasoning_tokens,amount\n2026-10-15,1,2,3');
  assert.equal(suggestion.suggestedMapping.inputTokens, null); assert.equal(suggestion.suggestedMapping.totalTokens, null); assert.equal(suggestion.suggestedMapping.cost, null);
});

test('mapped metrics preserve unknown fields, derive totals only from complete input/output and sum costs exactly', () => {
  const h = harness();
  const result = importCSV(h, generic('date,model,cost,requests,input,output\n2026-10-15,model-a,0.1,2,10,3\n2026-10-15,model-b,0.2000000000000000,1,4,2'));
  assert.deepEqual(result.preview.metrics, { cost: 0.3, requests: 3, inputTokens: 14, outputTokens: 5, totalTokens: 19 });
  const partial = h.service.previewImport(generic('date,input\n2026-10-15,12', { mapping: { date: 0, inputTokens: 1 } }));
  assert.equal(partial.ok, true); assert.deepEqual(partial.preview.metrics, { cost: null, requests: null, inputTokens: 12, outputTokens: null, totalTokens: null });
  assert.ok(partial.preview.warnings.length);
  const nullable = h.service.previewImport(generic('date,input,output\n2026-10-15,12,3\n2026-10-14,7,', { mapping: { date: 'date', inputTokens: 'input', outputTokens: 'output' } }));
  assert.equal(nullable.preview.metrics.inputTokens, 19); assert.equal(nullable.preview.metrics.outputTokens, null); assert.equal(nullable.preview.metrics.totalTokens, null);
  assert.equal(h.service.getSnapshot().accounts[0].rows.length, 4);
});

test('DeepSeek official dual files sum wallets, pivot sparse token types and retain the full export period', () => {
  const h = harness();
  const files = [costFile([{ cost: '0.1234567800000000' }, { cost: '0.0200000000000000', wallet: 'Granted' }]), amountFile([
    { type: 'request_count', amount: 3 }, { type: 'input_cache_miss_tokens', amount: 100 }, { type: 'input_cache_hit_tokens', amount: 20 }, { type: 'output_tokens', amount: 7 },
    { key: 'sk-second-key-1234', type: 'request_count', amount: 2 }, { key: 'sk-second-key-1234', type: 'input_cache_miss_tokens', amount: 30 }, { key: 'sk-second-key-1234', type: 'output_tokens', amount: 4 },
  ])];
  const inspected = h.service.inspectFiles(files);
  assert.equal(inspected.format, 'deepseek'); assert.equal(inspected.requiresMapping, false);
  assert.deepEqual(inspected.detectedRange, { startDate: '2026-09-16', endDate: '2026-10-15' });
  assert.equal(inspected.rowCount, 9);
  const preview = importFiles(h, official(files));
  assert.deepEqual(preview.preview.metrics, { cost: 0.14345678, requests: 5, inputTokens: 150, outputTokens: 11, totalTokens: 161 });
  assert.equal(preview.preview.startDate, '2026-09-16'); assert.equal(preview.preview.endDate, day);
  const account = h.service.getSnapshot().accounts[0];
  assert.equal(account.rows.length, 3); assert.equal(account.rows.find(row => row.cost !== null).apiKeyId, null);
  const keys = account.rows.filter(row => row.requests !== null); assert.equal(keys[0].apiKey, keys[1].apiKey); assert.notEqual(keys[0].apiKeyId, keys[1].apiKeyId);
  assert.deepEqual(account.coverage.map(entry => entry.metrics), [['cost'], ['requests', 'inputTokens', 'outputTokens', 'totalTokens']]);
  for (const value of [JSON.stringify(inspected), JSON.stringify(preview), JSON.stringify(account), JSON.stringify(h.stored())]) assert.doesNotMatch(value, /sk-synthetic-secret|sk-second-key|synthetic-account|synthetic-key-name|user_id"\s*:/);
  assert.match(h.stored().accounts[0].sourceAccountId, /^[a-f0-9]{64}$/);
  const reloaded = harness({ stored: h.stored() }).service.getSnapshot(); assert.deepEqual(reloaded, h.service.getSnapshot());
});

test('official source account mismatch, unknown types, bad wallet and invalid daily intervals fail the whole preview', () => {
  const h = harness();
  const cost = costFile([{ cost: 1 }]); importFiles(h, official([cost]));
  for (const files of [
    [costFile([{ cost: 1, user: 'different-account' }])],
    [cost, amountFile([{ type: 'request_count', amount: 1, user: 'different-account' }])],
    [costFile([{ cost: 1 }, { cost: 2, user: 'different-account' }])],
  ]) assert.equal(h.service.previewFiles(official(files)).error, 'account_mismatch');
  const type = h.service.previewFiles(official([amountFile([{ type: 'unrecognized_new_tokens', amount: 4 }])])); assert.equal(type.error, 'unsupported_usage_type'); assert.equal(type.line, 2);
  assert.equal(h.service.previewFiles(official([costFile([{ cost: 1, wallet: 'Unknown' }])])).error, 'unsupported_wallet_type');
  assert.equal(h.service.previewFiles(official([costFile([{ cost: 1, end: '2026-10-17' }])])).error, 'unsupported_interval');
  assert.equal(h.service.previewFiles(official([cost], { provider: 'moonshot' })).error, 'provider_mismatch');
  assert.equal(h.service.previewFiles(official([cost], { startDate: '2026-10-14' })).error, 'range_mismatch');
  assert.equal(h.writes.length, 1);
});

test('overlap replacement is independent by cost/usage group, idempotent and preserves dates outside the new interval', () => {
  const h = harness();
  const original = generic('date,model,cost,requests,input,output\n2026-10-13,m,0.1,1,10,1\n2026-10-14,m,0.2,2,20,2\n2026-10-15,m,0.3,3,30,3', { startDate: '2026-10-13', endDate: '2026-10-15' });
  importCSV(h, original);
  const duplicate = h.service.previewImport(original);
  assert.deepEqual(h.service.commitImport({ token: duplicate.token }), { ok: true, duplicate: true }); assert.equal(h.writes.length, 1);
  importCSV(h, generic('date,model,cost\n2026-10-14,m,0.9', { mapping: { date: 'date', model: 'model', cost: 'cost' }, startDate: '2026-10-14', endDate: '2026-10-14' }));
  const account = h.service.getSnapshot().accounts[0];
  assert.equal(account.importsCount, 2); assert.equal(account.rows.filter(row => row.cost !== null).length, 3);
  assert.equal(account.rows.find(row => row.date === '2026-10-14' && row.cost !== null).cost, 0.9);
  assert.equal(account.rows.find(row => row.date === '2026-10-14' && row.requests !== null).requests, 2);
  importCSV(h, generic('date,requests\n2026-10-14,9', { mapping: { date: 'date', requests: 'requests' }, startDate: '2026-10-14', endDate: '2026-10-15' }));
  const next = h.service.getSnapshot().accounts[0];
  assert.equal(next.rows.filter(row => row.requests !== null).length, 2);
  assert.equal(next.rows.filter(row => row.cost !== null).length, 3);
  assert.ok(next.coverage.some(entry => entry.startDate === '2026-10-13' && entry.endDate === '2026-10-13' && entry.metrics.includes('totalTokens')));
  assert.ok(next.coverage.some(entry => entry.startDate === '2026-10-14' && entry.endDate === '2026-10-15' && JSON.stringify(entry.metrics) === '["requests"]'));
});

test('separate files do not erase other groups and repeated exports update instead of accumulating', () => {
  const h = harness();
  importFiles(h, official([costFile([{ cost: 0.1 }])]));
  importFiles(h, official([amountFile([{ type: 'request_count', amount: 4 }])]));
  assert.equal(h.service.getSnapshot().accounts[0].rows.length, 2);
  importFiles(h, official([costFile([{ cost: 0.2 }])]));
  const rows = h.service.getSnapshot().accounts[0].rows;
  assert.equal(rows.find(row => row.cost !== null).cost, 0.2); assert.equal(rows.find(row => row.requests !== null).requests, 4);
});

test('recognized empty official tables represent zero for their declared period and replace only that group', () => {
  const h = harness();
  importFiles(h, official([costFile([{ cost: 1 }]), amountFile([{ type: 'request_count', amount: 4 }])]));
  const emptyAmount = amountFile([]);
  const replacement = importFiles(h, official([costFile([{ cost: 0.5 }]), emptyAmount]));
  assert.deepEqual(replacement.preview.metrics, { cost: 0.5, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const snapshot = h.service.getSnapshot(); assert.equal(snapshot.accounts[0].rows.length, 1);
  assert.ok(snapshot.accounts[0].coverage.some(entry => entry.metrics.includes('totalTokens') && entry.startDate === '2026-09-16'));
  const empty = importFiles(h, official([costFile([])])); assert.equal(empty.preview.metrics.cost, 0);
  assert.equal(h.service.getSnapshot().accounts[0].rows.length, 0);
  assert.deepEqual(harness({ stored: h.stored() }).service.getSnapshot(), h.service.getSnapshot());
  assert.equal(h.service.previewFiles(official([{ text: COST_HEADER }])).error, 'empty_data');
});

test('currencies and accounts are never added or replaced across identities', () => {
  const h = harness();
  const options = generic('date,cost\n2026-10-15,1', { mapping: { date: 'date', cost: 'cost' } });
  importCSV(h, options); importCSV(h, { ...options, currency: 'USD' }); importCSV(h, { ...options, accountId: 'other-connection' });
  const snapshot = h.service.getSnapshot(); assert.equal(snapshot.accounts.length, 2); assert.equal(snapshot.accounts[0].rows.length, 2);
  assert.deepEqual(new Set(snapshot.accounts[0].rows.map(row => row.currency)), new Set(['CNY', 'USD']));
  assert.equal(h.service.previewImport({ ...options, provider: 'deepseek' }).error, 'provider_mismatch');
  const mixed = h.service.previewImport(generic('date,cost,currency\n2026-10-15,1,CNY\n2026-10-15,2,USD', { currency: undefined, mapping: { date: 'date', cost: 'cost', currency: 'currency' } }));
  assert.equal(mixed.error, 'mixed_currencies');
});

test('invalid records are not silently dropped and return physical line numbers without raw cell values', () => {
  const h = harness();
  const cases = [
    ['2026-02-30,1', 'invalid_date'], ['2026-1-01,1', 'invalid_date'], ['2026-10-15T24:00:00+08:00,1', 'invalid_date'],
    ['2026-10-15,-1', 'invalid_cost'], ['2026-10-15,0.000000001', 'invalid_cost'], ['2026-10-15,1e3', 'invalid_cost'], ['2026-10-15,90071993', 'numeric_overflow'],
  ];
  for (const [row, code] of cases) {
    const preview = h.service.previewImport(generic(`date,cost\n${row}`, { mapping: { date: 'date', cost: 'cost' } }));
    assert.equal(preview.error, code, row); assert.equal(preview.line, 2);
  }
  const multiline = h.service.previewImport(generic('date,remarks,requests\n2026-10-15,"line one\nline two",1\n2026-10-15,no,-1', { mapping: { date: 'date', requests: 'requests' } }));
  assert.equal(multiline.error, 'invalid_number'); assert.equal(multiline.line, 4);
  for (const number of ['1.5', '-1', 'NaN', '9007199254740992']) assert.equal(h.service.previewImport(generic(`date,requests\n2026-10-15,${number}`, { mapping: { date: 'date', requests: 'requests' } })).error, 'invalid_number');
  const inconsistent = h.service.previewImport(generic('date,input,output,total\n2026-10-15,3,4,5', { mapping: { date: 'date', inputTokens: 'input', outputTokens: 'output', totalTokens: 'total' } }));
  assert.equal(inconsistent.error, 'inconsistent_total'); assert.equal(h.writes.length, 0);
});

test('CSV and mapping structural errors fail explicitly, and counts/date are not inferred from unrelated fields', () => {
  const h = harness();
  for (const text of ['date,cost\n2026-10-15,"bad', 'date,cost\n2026-10-15,1,extra', 'date,date\n2026-10-15,1', 'date,\n2026-10-15,1']) assert.equal(h.service.inspectCSV(text).ok, false);
  assert.equal(h.service.inspectCSV('date,cost').error, 'empty_data');
  assert.equal(h.service.previewImport(generic('date,cost\n2026-10-15,1', { mapping: { date: 'date' } })).error, 'mapping_required');
  assert.equal(h.service.previewImport(generic('date,cost\n2026-10-15,1', { mapping: { date: 'date', cost: 'date' } })).error, 'invalid_mapping');
  assert.equal(h.service.previewImport(generic('date,cost\n2026-10-15,', { mapping: { date: 'date', cost: 'cost' } })).error, 'missing_metric');
  const valid = h.service.previewImport(generic('date,requests\n2024/02/29 23:15:00+08:00,3.000000', { mapping: { date: 'date', requests: 'requests' } }));
  assert.equal(valid.ok, true); assert.equal(valid.preview.startDate, '2024-02-29'); assert.equal(valid.preview.metrics.requests, 3);
});

test('file/row limits and safe integer aggregate limits are enforced before commit', () => {
  const h = harness();
  assert.equal(h.service.inspectCSV('a,b\n' + 'x'.repeat(ACCOUNT_USAGE_LIMITS.csvBytes)).error, 'file_too_large');
  assert.equal(h.service.inspectCSV('date,cost\n' + '2026-10-15,1\n'.repeat(ACCOUNT_USAGE_LIMITS.csvRows + 1)).error, 'too_many_rows');
  assert.equal(h.service.previewImport(generic('date,requests\n2026-10-15,9007199254740991\n2026-10-15,1', { mapping: { date: 'date', requests: 'requests' } })).error, 'numeric_overflow');
  assert.equal(h.service.previewFiles(official([costFile([{ cost: 1 }]), costFile([{ cost: 2 }])])).error, 'duplicate_file_type');
  assert.equal(h.writes.length, 0);
  importCSV(h, generic('date,requests\n2026-10-14,9007199254740991', { mapping: { date: 'date', requests: 'requests' } }));
  const overflow = h.service.previewImport(generic('date,requests\n2026-10-15,1', { mapping: { date: 'date', requests: 'requests' } }));
  assert.equal(overflow.ok, true); assert.equal(h.service.commitImport({ token: overflow.token }).error, 'numeric_overflow'); assert.equal(h.writes.length, 1);
  assert.equal(h.service.commitImport(null).error, 'preview_expired');
});

test('preview tokens expire, are bounded, can be used once and do not persist raw source data', () => {
  const h = harness(); const options = generic('date,cost\n2026-10-15,1', { mapping: { date: 'date', cost: 'cost' } });
  const first = h.service.previewImport(options);
  for (let i = 0; i < ACCOUNT_USAGE_LIMITS.previews; i++) h.service.previewImport(options);
  assert.equal(h.service.commitImport({ token: first.token }).error, 'preview_expired');
  const pending = h.service.previewImport(options); h.advance(ACCOUNT_USAGE_LIMITS.previewMs);
  assert.equal(h.service.commitImport({ token: pending.token }).error, 'preview_expired');
  const fresh = h.service.previewImport(options); assert.equal(h.service.commitImport({ token: fresh.token }).ok, true);
  assert.equal(h.service.commitImport({ token: fresh.token }).error, 'preview_expired');
  assert.doesNotMatch(JSON.stringify(h.stored()), /\btext\b|\bfiles\b|\.csv|\btoken\b|mapping/);
});

test('failed writes leave committed memory unchanged and allow a bounded retry of the same preview', () => {
  const h = harness();
  importCSV(h, generic('date,cost\n2026-10-15,1', { mapping: { date: 'date', cost: 'cost' } }));
  const prior = h.service.getSnapshot().accounts;
  const pending = h.service.previewImport(generic('date,cost\n2026-10-15,2', { mapping: { date: 'date', cost: 'cost' } }));
  h.failWrites(true); assert.equal(h.service.commitImport({ token: pending.token }).error, 'save_failed');
  assert.deepEqual(h.service.getSnapshot().accounts, prior); assert.equal(h.service.getSnapshot().storageError, 'save_failed');
  h.failWrites(false); assert.equal(h.service.commitImport({ token: pending.token }).ok, true);
  assert.equal(h.service.getSnapshot().accounts[0].rows[0].cost, 2); assert.equal(h.service.getSnapshot().storageError, undefined);
});

test('corrupt or unreadable stores are preserved and never overwritten by a fresh import', () => {
  const valid = harness(); importCSV(valid, generic('date,cost\n2026-10-15,1', { mapping: { date: 'date', cost: 'cost' } }));
  const malformed = structuredClone(valid.stored()); malformed.accounts[0].rows[0].apiKey = 'raw-secret';
  for (const options of [{ readError: true }, { stored: { version: 999, accounts: [] } }, { stored: malformed }]) {
    const h = harness(options); const snapshot = h.service.getSnapshot(); assert.equal(snapshot.ok, false); assert.equal(snapshot.storageError, 'store_unreadable');
    assert.equal(h.service.previewImport(generic('date,cost\n2026-10-15,2', { mapping: { date: 'date', cost: 'cost' } })).error, 'store_unreadable');
    assert.equal(h.service.commitImport({ token: 'anything' }).error, 'store_unreadable'); assert.equal(h.writes.length, 0);
  }
});

test('pending imports recheck source account binding when another preview has committed first', () => {
  const h = harness();
  const first = h.service.previewFiles(official([costFile([{ cost: 1, user: 'one' }])]));
  const second = h.service.previewFiles(official([costFile([{ cost: 2, user: 'two' }])]));
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(h.service.commitImport({ token: first.token }).ok, true);
  assert.equal(h.service.commitImport({ token: second.token }).error, 'account_mismatch'); assert.equal(h.writes.length, 1);
});

test('stored completeness claims cannot turn a missing metric into zero', () => {
  const original = harness();
  importCSV(original, generic('date,model,cost,requests,input,output\n2026-10-14,m,1,1,10,2\n2026-10-15,m,2,2,20,3'));
  for (const field of ['costUnits', 'requests', 'inputTokens', 'outputTokens', 'totalTokens']) {
    const damaged = structuredClone(original.stored());
    const group = field === 'costUnits' ? 'cost' : 'usage';
    damaged.accounts[0].rows.find(row => row.date === '2026-10-15' && row.group === group)[field] = null;
    const h = harness({ stored: damaged });
    assert.deepEqual(h.service.getSnapshot(), { ok: false, accounts: [], storageError: 'store_unreadable' }, field);
    assert.equal(h.service.previewImport(generic('date,cost\n2026-10-15,2', { mapping: { date: 'date', cost: 'cost' } })).error, 'store_unreadable');
    assert.equal(h.writes.length, 0);
  }
});

test('legitimate partial metric rows reload when coverage makes no completeness claim for the missing field', () => {
  const h = harness();
  importCSV(h, generic('date,model,cost,requests,input,output\n2026-10-14,m,1,1,10,2\n2026-10-15,m,,2,20,'));
  const account = h.service.getSnapshot().accounts[0];
  assert.deepEqual(account.coverage.map(entry => entry.metrics), [[], ['requests', 'inputTokens']]);
  const reloaded = harness({ stored: h.stored() });
  assert.deepEqual(reloaded.service.getSnapshot(), h.service.getSnapshot());
  assert.equal(reloaded.writes.length, 0);
});
