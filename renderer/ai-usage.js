(function initAIUsage() {
  'use strict';
  const page = document.getElementById('ai-usage-page');
  if (!page) return;
  const MIN_REFRESH_MS = 60000, DAY = 86400000;
  const PROVIDERS = { deepseek: 'DeepSeek', moonshot: 'Kimi', qwen: '阿里云百炼', volc: '豆包', zhipu: '智谱', minimax: 'MiniMax', openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini', siliconflow: '硅基流动', openrouter: 'OpenRouter', ollama: 'Ollama', custom: '自定义接口' };
  const FIELDS = { date: '日期', model: '模型', apiKey: 'API Key 名称', currency: '币种', cost: '消费金额', requests: '请求次数', inputTokens: '输入 Token', outputTokens: '输出 Token', totalTokens: '总 Token' };
  const METRICS = ['cost', 'requests', 'inputTokens', 'outputTokens', 'totalTokens'];
  const $ = (id) => document.getElementById(id);
  const text = (value) => typeof value === 'string' ? value.trim().slice(0, 500) : '';
  const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const count = (value) => value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
  const amount = (value, currency = '') => value == null ? '—' : `${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value)}${currency ? ` ${currency}` : ''}`;
  const stamp = (date) => Date.parse(`${date}T00:00:00Z`);
  const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(stamp(date)) && new Date(stamp(date)).toISOString().slice(0, 10) === date;
  const day = (time) => new Date(time).toISOString().slice(0, 10);
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now()));
  let data = null, failure = '', loading = false, period = 'month', accountId = '', modelFilter = '', keyFilter = '', currency = 'CNY', chartMetric = 'cost', grouping = 'model';
  let expanded = $('app')?.classList.contains('expanded') === true;
  let currentTab = document.querySelector('.tab.active')?.dataset.tab || 'home';
  let generation = 0, inFlight = null, pendingReload = false, pendingRefresh = false, lastRefreshAttemptAt = 0, timer = null, activePreviously = false, disposed = false;
  let importState = null, importGeneration = 0;

  function element(tag, className, label) { const node = document.createElement(tag); if (className) node.className = className; if (label !== undefined) node.textContent = label; return node; }
  function dateLabel(value, dateOnly = false) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    const valueDate = new Date(value); if (!Number.isFinite(valueDate.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) }).format(valueDate);
  }
  function metric(value) {
    if (!value || typeof value !== 'object') return null;
    const keys = ['inputTokens', 'outputTokens', 'totalTokens', 'requests', 'unreportedRequests'];
    const result = Object.fromEntries(keys.map((key) => [key, integer(value[key])]));
    return keys.some((key) => result[key] == null) ? null : result;
  }
  function normalize(result) {
    if (!result || result.ok !== true || !metric(result.totals?.today) || !metric(result.totals?.month)) return null;
    const seen = new Set();
    const connections = (Array.isArray(result.connections) ? result.connections : []).filter((item) => {
      if (!item || !text(item.id) || seen.has(item.id)) return false; seen.add(item.id); return true;
    }).map((item) => {
      const balance = item.balance || {};
      return { id: text(item.id), provider: text(item.provider), name: PROVIDERS[item.provider] || '自定义连接', balance: {
        status: ['ready', 'unsupported', 'not_configured', 'error'].includes(balance.status) ? balance.status : 'error',
        amount: typeof balance.amount === 'number' && Number.isFinite(balance.amount) ? balance.amount : null,
        currency: /^[A-Z]{3}$/.test(text(balance.currency)) ? balance.currency : '', updatedAt: dateLabel(balance.updatedAt), stale: balance.stale === true, error: text(balance.error) } };
    });
    const totals = new Map(), ordinals = new Map();
    connections.forEach((item) => totals.set(item.name, (totals.get(item.name) || 0) + 1));
    connections.forEach((item) => { const name = item.name; if (totals.get(name) > 1) { const n = (ordinals.get(name) || 0) + 1; ordinals.set(name, n); item.name = `${name} · ${n}`; } });
    const accountUsage = result.accountUsage;
    const accounts = accountUsage?.ok === true && Array.isArray(accountUsage.accounts) ? accountUsage.accounts.filter((item) => item && text(item.id)).map((item) => ({
      id: text(item.id), provider: text(item.provider), updatedAt: dateLabel(item.updatedAt), importsCount: integer(item.importsCount) || 0,
      rows: (Array.isArray(item.rows) ? item.rows : []).filter((row) => row && validDate(row.date)).map((row) => ({ date: row.date, model: text(row.model), apiKey: text(row.apiKey), apiKeyId: text(row.apiKeyId), currency: /^[A-Z]{3}$/.test(text(row.currency)) ? row.currency : '', ...Object.fromEntries(METRICS.map((key) => [key, key === 'cost' ? number(row[key]) : integer(row[key])])) })),
      coverage: (Array.isArray(item.coverage) ? item.coverage : []).filter((range) => range && validDate(range.startDate) && validDate(range.endDate) && range.startDate <= range.endDate).map((range) => ({ startDate: range.startDate, endDate: range.endDate, currency: /^[A-Z]{3}$/.test(text(range.currency)) ? range.currency : '', metrics: Array.isArray(range.metrics) ? range.metrics.filter((key) => METRICS.includes(key)) : [] })),
    })) : [];
    return { connections, accounts, accountError: text(accountUsage?.storageError) || (accountUsage && accountUsage.ok !== true ? 'unavailable' : ''),
      totals: { today: metric(result.totals.today), month: metric(result.totals.month) }, models: (Array.isArray(result.models) ? result.models : []).map((row) => ({ provider: text(row.provider), model: text(row.model) || '未提供模型名', today: metric(row.today), month: metric(row.month) })),
      startedAt: dateLabel(result.startedAt, true), updatedAt: dateLabel(result.updatedAt), storageError: text(result.storageError), sessionOnly: result.storageError === 'store_unreadable' };
  }
  function tokens(value) { return !value ? '—' : value.unreportedRequests > 0 && value.totalTokens === 0 ? '未知' : `${value.unreportedRequests > 0 ? '至少 ' : ''}${count(value.totalTokens)}`; }
  function unknownLabel(value) { return value?.unreportedRequests ? `${count(value.unreportedRequests)} 次调用未返回用量` : ''; }
  function errorLabel(code) {
    const errors = { cancelled: '已取消选择文件', invalid_account: '所选账号已不存在，请重新选择', unsupported_file: '请选择 CSV 或 DeepSeek 官方账单 ZIP', unsupported_format: '文件格式暂不支持', unsupported_files: '这些文件暂不支持一起导入', invalid_files: '请重新选择有效账单文件', duplicate_file_type: '同一类型账单重复，请重新导出', invalid_key_column: 'API Key 列无法识别，请选择密钥名称或标识列', mapping_required: '请先对应账单列名', missing_metric: '文件未提供任何可识别的用量或消费指标', mixed_currencies: '同一次导入请使用一种币种的账单', provider_mismatch: '文件供应商与所选账号不一致', range_mismatch: '日期范围应与官方导出文件标明的范围一致', empty_data: '文件中没有可导入的账单数据', storage_limit_reached: '账单记录已达保存上限', invalid_zip: 'ZIP 中没有可识别的账单，请重新从官网导出', invalid_encoding: '文件编码无法识别，请使用 UTF-8 CSV', file_unreadable: '无法读取所选文件，请检查文件权限', import_timeout: '读取文件超时，请重新选择', account_changed: '账号配置已变化，请重新选择文件', account_mismatch: '此账单与所选账号不匹配，请核对账号', file_too_large: '文件过大，请缩小导出日期范围', too_many_rows: '账单行数过多，请缩小日期范围', invalid_csv: 'CSV 格式无法识别，请重新导出', unsupported_interval: '当前只支持按日导出的账单，请在官网选择按日统计', invalid_cost: '账单中有无法识别的费用金额', invalid_mapping: '请选择日期列，以及至少一项用量或消费列', duplicate_mapping: '同一列不能重复对应多个字段', invalid_date: '账单中有无法识别的日期', invalid_number: '账单中有无法识别的数值', invalid_currency: '请选择账单使用的币种', invalid_range: '请检查账单的开始和结束日期', no_data: '文件中没有可导入的账单数据', empty_file: '文件为空', preview_expired: '导入预览已过期，请重新预览', import_expired: '文件选择已过期，请重新选择', token_expired: '导入预览已过期，请重新预览', invalid_token: '导入预览已失效，请重新预览', save_failed: '账单保存失败，请重试', store_unreadable: '历史账单暂时无法读取，不能视作零消费', invalid_response: '返回数据无法识别，请重试', unavailable: '暂时无法读取，请重试' };
    return errors[code] || '本次操作未完成，请检查文件与字段后重试';
  }
  function balanceText(balance) {
    if (!balance) return { value: '未连接', note: '可导入账单；连接 API 后查询余额', state: 'not_configured' };
    if (balance.status === 'unsupported') return { value: '暂不支持', note: '此服务暂未接入官方余额查询', state: 'unsupported' };
    if (balance.status === 'not_configured') return { value: '未配置密钥', note: '可在 API 配置中补充', state: 'not_configured' };
    const value = balance.amount == null || !balance.currency ? '' : amount(balance.amount, balance.currency);
    if (balance.status === 'ready' && value && !balance.stale) return { value, note: `${balance.updatedAt || '供应商账户余额'}${balance.updatedAt ? ' 更新' : ''}`, state: 'ready' };
    if (balance.stale && value) return { value, note: `上次余额 · ${balance.updatedAt || '时间未知'}${balance.status === 'error' ? '，当前刷新失败' : '，待更新'}`, state: 'stale' };
    return { value: '暂不可用', note: ['auth', 'http_401', 'http_403'].includes(balance.error) ? '密钥或访问权限需检查' : balance.error === 'timeout' ? '查询超时' : '余额暂时读取失败', state: 'error' };
  }
  function accounts() {
    const entries = (data?.connections || []).map((connection) => ({ ...connection, imported: data.accounts.find((item) => item.id === connection.id) }));
    for (const imported of data?.accounts || []) if (!entries.some((item) => item.id === imported.id)) entries.push({ id: imported.id, provider: imported.provider, name: `${PROVIDERS[imported.provider] || '账号'} · 已导入账单`, imported });
    if (!entries.length) entries.push({ id: 'import:deepseek', provider: 'deepseek', name: 'DeepSeek · 账单导入' });
    return entries;
  }
  function selected() { return accounts().find((item) => item.id === accountId) || accounts()[0]; }
  function hasImported(account) { return !!(account?.rows.length || account?.coverage.length); }
  function keyOf(row) { return row.apiKeyId || row.apiKey; }
  function option(value, label) { const node = element('option', '', label); node.value = value; return node; }
  function setOptions(select, values, current, placeholder) {
    select.replaceChildren(...(placeholder ? [option('', placeholder)] : []), ...values.map(([id, label]) => option(id, label)));
    select.value = values.some(([id]) => id === current) ? current : placeholder ? '' : values[0]?.[0] || '';
    return select.value;
  }
  function range() {
    if (period === 'custom') { const start = $('ai-usage-start-date').value, end = $('ai-usage-end-date').value; return validDate(start) && validDate(end) && start <= end ? { start, end } : null; }
    const end = today(); return { start: day(stamp(end) - (period === 'today' ? 0 : period === 'week' ? 6 : 29) * DAY), end };
  }
  function covered(account, field, dates) {
    if (!dates) return false;
    // Coverage does not carry a currency dimension; never infer zeroes across currencies.
    if (new Set((account?.rows || []).map((row) => row.currency)).size > 1 && !(account?.coverage || []).some((item) => item.currency)) return false;
    let cursor = stamp(dates.start);
    for (const span of (account?.coverage || []).filter((item) => item.metrics.includes(field) && (!item.currency || item.currency === currency)).sort((a, b) => a.startDate.localeCompare(b.startDate))) {
      if (stamp(span.endDate) < cursor) continue;
      if (stamp(span.startDate) > cursor) break;
      cursor = Math.max(cursor, stamp(span.endDate) + DAY);
      if (cursor > stamp(dates.end)) return true;
    }
    return false;
  }
  function rowsFor(account, dates, filters = true) { return (account?.rows || []).filter((row) => (!dates || (row.date >= dates.start && row.date <= dates.end)) && row.currency === currency && (!filters || ((!modelFilter || row.model === modelFilter) && (!keyFilter || keyOf(row) === keyFilter)))); }
  function summarize(account, field, dates, rows, filters = true) {
    const values = rows.map((row) => row[field]).filter((value) => value != null);
    const unassigned = filters && (modelFilter || keyFilter) && rowsFor(account, dates, false).some((row) => row[field] != null && ((!modelFilter || !row.model || row.model === modelFilter) && (!keyFilter || !keyOf(row) || keyOf(row) === keyFilter)) && ((modelFilter && !row.model) || (keyFilter && !keyOf(row))));
    const complete = covered(account, field, dates) && !unassigned;
    const hasField = (account?.rows || []).some((row) => row.currency === currency && row[field] != null) || (account?.coverage || []).some((span) => (!span.currency || span.currency === currency) && span.metrics.includes(field));
    const sum = values.length ? values.reduce((total, value) => total + value, 0) : complete && hasField ? 0 : null;
    return { value: Number.isFinite(sum) ? sum : null, partial: !complete, unassigned };
  }
  function formatted(summary, field) { if (summary.value == null) return '—'; return `${summary.partial ? '至少 ' : ''}${field === 'cost' ? amount(summary.value, currency || '币种未知') : count(summary.value)}`; }
  function metricCard(label, value, note) { const card = element('div', 'ai-usage-metric'); card.append(element('span', '', label), element('strong', '', value)); if (note) card.append(element('small', '', note)); return card; }
  function renderAccount() {
    const choices = accounts();
    if (!choices.some((item) => item.id === accountId)) accountId = choices.find((item) => item.provider === 'deepseek')?.id || choices[0].id;
    setOptions($('ai-usage-account'), choices.map((item) => [item.id, item.name]), accountId);
    const current = selected(), imported = current.imported;
    const models = [...new Set((imported?.rows || []).map((row) => row.model).filter(Boolean))].sort();
    modelFilter = setOptions($('ai-usage-model-filter'), models.map((name) => [name, name]), modelFilter, '全部模型');
    const keys = new Map(); (imported?.rows || []).forEach((row) => { if (keyOf(row)) keys.set(keyOf(row), row.apiKey || '未命名 API Key'); });
    const labels = new Map(); for (const label of keys.values()) labels.set(label, (labels.get(label) || 0) + 1);
    const indices = new Map(); const keyOptions = [...keys].map(([id, label]) => { const n = (indices.get(label) || 0) + 1; indices.set(label, n); return [id, labels.get(label) > 1 ? `${label} · ${n}` : label]; });
    keyFilter = setOptions($('ai-usage-key-filter'), keyOptions, keyFilter, '全部 API Key');
    const currencies = [...new Set([...(imported?.rows || []).map((row) => row.currency), ...(imported?.coverage || []).map((span) => span.currency).filter(Boolean)])].sort();
    if (!currencies.length) currencies.push(current.balance?.currency || 'CNY');
    currency = setOptions($('ai-usage-currency'), currencies.map((id) => [id, id || '币种未知']), currency);
    const balance = balanceText(current.balance); $('ai-usage-balance').textContent = balance.value; $('ai-usage-balance').dataset.state = balance.state; $('ai-usage-balance-note').textContent = balance.note;
    const costs = rowsFor(imported, null, false).map((row) => row.cost).filter((value) => value != null);
    const spans = (imported?.coverage || []).filter((span) => !span.currency || span.currency === currency);
    const importedRange = spans.length ? { start: spans.map((span) => span.startDate).sort()[0], end: spans.map((span) => span.endDate).sort().at(-1) } : null;
    const partialCost = !covered(imported, 'cost', importedRange);
    $('ai-usage-imported-cost').textContent = costs.length || spans.some((span) => span.metrics.includes('cost')) ? `${partialCost ? '至少 ' : ''}${amount(costs.reduce((sum, value) => sum + value, 0), currency || '币种未知')}` : '—';
    $('ai-usage-imported-note').textContent = imported?.importsCount ? `${count(imported.importsCount)} 份账单 · 已知费用项合计，非账号历史总消费` : '尚未导入消费账单';
    $('ai-usage-updated').textContent = imported?.updatedAt ? `${imported.updatedAt} 导入更新` : '账号余额与已导入账单';
    return imported;
  }
  function renderChart(account, dates, rows) {
    const target = $('ai-usage-chart'); target.replaceChildren();
    for (const button of page.querySelectorAll('[data-usage-chart]')) button.setAttribute('aria-pressed', String(button.dataset.usageChart === chartMetric));
    if (!dates || !hasImported(account)) { target.append(element('p', 'ai-usage-empty', dates ? '导入供应商账单后，查看每日消费与用量趋势。' : '请选择有效的日期范围。')); return; }
    const days = Math.round((stamp(dates.end) - stamp(dates.start)) / DAY) + 1, step = Math.max(1, Math.ceil(days / 31));
    const buckets = [];
    for (let offset = 0; offset < days; offset += step) {
      const start = day(stamp(dates.start) + offset * DAY), end = day(Math.min(stamp(dates.end), stamp(start) + (step - 1) * DAY));
      const summary = summarize(account, chartMetric, { start, end }, rows.filter((row) => row.date >= start && row.date <= end)); buckets.push({ start, end, ...summary });
    }
    const maximum = Math.max(0, ...buckets.map((bucket) => bucket.value || 0));
    const bars = element('div', 'ai-usage-bars');
    buckets.forEach((bucket, index) => {
      const bar = element('div', 'ai-usage-bar'); bar.dataset.date = bucket.start; bar.dataset.known = String(bucket.value != null); bar.dataset.partial = String(bucket.partial);
      const label = formatted(bucket, chartMetric); bar.title = `${bucket.start}${bucket.end !== bucket.start ? ` 至 ${bucket.end}` : ''} · ${FIELDS[chartMetric]} ${label}${bucket.value == null ? '（未提供或未覆盖）' : bucket.partial ? '（部分数据）' : ''}`;
      const track = element('div', 'ai-usage-bar-track'), fill = element('span', 'ai-usage-bar-fill');
      fill.style.height = `${bucket.value == null ? 0 : Math.max(bucket.value > 0 ? 2 : 0, bucket.value / (maximum || 1) * 100)}%`; track.append(fill);
      if (bucket.value == null) track.append(element('span', 'ai-usage-bar-unknown', '—'));
      bar.append(track, element('small', '', index % Math.max(1, Math.ceil(buckets.length / 7)) === 0 || index === buckets.length - 1 ? bucket.start.slice(5).replace('-', '/') : '')); bars.append(bar);
    });
    target.append(element('div', 'ai-usage-chart-scale', `${FIELDS[chartMetric]}${chartMetric === 'cost' ? ` · ${currency || '币种未知'}` : ''} · 最大 ${chartMetric === 'cost' ? amount(maximum) : count(maximum)}`), bars);
    target.setAttribute('aria-label', `${dates.start} 至 ${dates.end} ${FIELDS[chartMetric]}趋势；横线表示数据未提供，浅色表示部分数据。`);
  }
  function renderBreakdown(account, dates, rows) {
    const target = $('ai-usage-breakdown'); target.replaceChildren();
    for (const button of page.querySelectorAll('[data-usage-group]')) button.setAttribute('aria-pressed', String(button.dataset.usageGroup === grouping));
    if (!rows.length) { target.append(element('p', 'ai-usage-empty', '此筛选范围暂无已导入明细。')); return; }
    const groups = new Map();
    rows.forEach((row) => { const id = grouping === 'model' ? row.model : keyOf(row); if (!groups.has(id)) groups.set(id, { name: grouping === 'model' ? row.model || '未分模型' : row.apiKey || '未分 API Key', rows: [] }); groups.get(id).rows.push(row); });
    const table = element('table', 'ai-usage-table'), head = element('thead'), tr = element('tr');
    for (const title of [grouping === 'model' ? '模型' : 'API Key', '消费', '请求', 'Token']) tr.append(element('th', '', title)); head.append(tr); table.append(head);
    const body = element('tbody');
    for (const group of groups.values()) {
      const row = element('tr'), name = element('td', 'ai-usage-row-name', group.name); name.title = group.name; row.append(name);
      for (const field of ['cost', 'requests', 'totalTokens']) { const values = group.rows.map((item) => item[field]).filter((value) => value != null); const summary = summarize(account, field, dates, group.rows); if (!values.length) summary.value = null; row.append(element('td', '', formatted(summary, field))); }
      body.append(row);
    }
    table.append(body); target.append(table, element('p', 'ai-usage-source', '明细只合计账单已提供的数值；— 表示未提供，部分日期范围显示“至少”。'));
  }
  function renderLedger(account) {
    const dates = range(), rows = rowsFor(account, dates);
    $('ai-usage-custom-dates').hidden = period !== 'custom';
    for (const button of page.querySelectorAll('[data-usage-period]')) button.setAttribute('aria-pressed', String(button.dataset.usagePeriod === period));
    const summaries = Object.fromEntries(['cost', 'requests', 'totalTokens'].map((field) => [field, summarize(account, field, dates, dates ? rows : [])]));
    $('ai-usage-totals').replaceChildren(...['cost', 'requests', 'totalTokens'].map((field) => metricCard(`周期${field === 'cost' ? '消费' : field === 'requests' ? '请求' : ' Token'}`, formatted(summaries[field], field), summaries[field].unassigned ? field === 'cost' && keyFilter ? '费用文件未分 API Key' : '部分记录未标明此筛选维度' : summaries[field].value == null ? '账单未提供或日期未覆盖' : summaries[field].partial ? '仅包含已导入的部分数据' : '')));
    const partial = Object.values(summaries).some((value) => value.partial);
    $('ai-usage-coverage').textContent = !dates ? '开始日期不能晚于结束日期。' : !hasImported(account) ? '尚无账单数据 · 点击右上角「导入账单」开始；余额不会换算为 Token。' : `${dates.start} 至 ${dates.end} · ${selected().provider === 'deepseek' ? 'GMT+8' : '按导出文件日期，今日按北京时间'} · ${partial ? '部分数据：存在未覆盖日期或未提供指标' : '所选日期已覆盖'}${keyFilter && summaries.cost.unassigned ? ' · 费用文件未分 API Key' : ''}`;
    $('ai-usage-coverage').dataset.state = !hasImported(account) ? 'empty' : partial ? 'partial' : 'complete';
    renderChart(account, dates, rows); renderBreakdown(account, dates, dates ? rows : []);
    const ranges = [...new Set((account?.coverage || []).map((item) => `${item.startDate}—${item.endDate}`))];
    $('ai-usage-source').textContent = hasImported(account) ? `来源：手动导入的供应商账单 · ${selected().provider === 'deepseek' ? '统计时区 GMT+8' : '按导出文件日期'} · ${ranges.length ? `导入范围 ${ranges.join('、')}` : '导入范围未提供'}。仅代表所导入文件，不自动补齐其他日期或 API Key；请在官网选择全部 API Key 后导出。` : '来源：您导入的供应商账单。请在官网选择全部 API Key 后导出，并确认文件属于当前账号。';
  }
  function renderLocal() {
    const todayMetric = data?.totals.today, monthMetric = data?.totals.month;
    $('ai-usage-local-totals').replaceChildren(metricCard('本程序今日 Token', data?.sessionOnly && !todayMetric?.requests ? '—' : tokens(todayMetric), unknownLabel(todayMetric) || '已返回的输入与输出'), metricCard('本程序本月 Token', data?.sessionOnly && !monthMetric?.requests ? '—' : tokens(monthMetric), unknownLabel(monthMetric) || `${data?.startedAt || '启用统计'}起记录`));
    const feedback = $('ai-usage-local-feedback'); feedback.hidden = !data?.storageError;
    feedback.textContent = data?.sessionOnly ? '历史统计暂时无法读取，目前仅显示本次运行的记录，不代表完整日用量或月用量。' : data?.storageError === 'model_details_limited' ? '部分模型明细未展示，总量仍包含这些调用。' : data?.storageError ? '部分本程序统计未能保存，数据可能不完整。' : '';
    $('ai-usage-models').replaceChildren(...(data?.models || []).filter((row) => row.month?.requests).map((row) => { const line = element('div', 'ai-usage-model-row'); line.append(element('span', '', `${PROVIDERS[row.provider] || '自定义服务'} · ${row.model}`), element('strong', '', `${tokens(row.month)} Tokens`)); return line; }));
  }
  function render() {
    const scroll = $('ai-usage-body').scrollTop, account = renderAccount();
    const feedback = $('ai-usage-feedback');
    feedback.textContent = failure ? data ? '本次更新失败，正在显示上次读取的数据。' : '暂时无法读取账号信息，请稍后重试。' : data?.accountError ? errorLabel(data.accountError) : loading && !data ? '正在读取账号余额与已导入账单…' : '';
    feedback.hidden = !feedback.textContent; feedback.dataset.state = failure || data?.accountError ? 'error' : 'loading';
    renderLedger(account); renderLocal(); $('ai-usage-body').scrollTop = scroll;
    const remaining = Math.max(0, lastRefreshAttemptAt + MIN_REFRESH_MS - Date.now());
    $('ai-usage-refresh').disabled = loading || remaining > 0; $('ai-usage-refresh').textContent = loading ? '读取中…' : '刷新';
    $('ai-usage-refresh-note').textContent = '余额可见时每分钟更新；消费与用量随账单导入更新';
    $('ai-usage-import').disabled = !!importState?.busy;
    page.setAttribute('aria-busy', String(loading));
  }
  function visible() { return !disposed && expanded && !document.hidden && currentTab === 'ai-usage' && !$('tab-button-ai-usage')?.hidden && !window.NotchAISettings?.isOpen(); }
  function schedule() { clearTimeout(timer); timer = null; if (!visible() || inFlight) return; timer = setTimeout(() => { timer = null; if (visible()) load({ refresh: true }); }, Math.max(100, lastRefreshAttemptAt + MIN_REFRESH_MS - Date.now())); }
  function load({ refresh = true, forceRead = false } = {}) {
    if (!visible()) return;
    if (inFlight) { if (forceRead) { pendingReload = true; pendingRefresh ||= refresh; } return; }
    const due = !lastRefreshAttemptAt || Date.now() - lastRefreshAttemptAt >= MIN_REFRESH_MS;
    if (data && !due && !forceRead) { render(); schedule(); return; }
    pendingReload = false; pendingRefresh = false;
    const refreshNow = refresh && due; if (refreshNow) lastRefreshAttemptAt = Date.now();
    const epoch = generation; loading = true; render();
    const request = Promise.resolve().then(() => {
      if (generation !== epoch || !visible()) return null;
      if (typeof window.notchAPI?.getAIUsage !== 'function') throw new Error('unavailable');
      return window.notchAPI.getAIUsage({ refresh: refreshNow });
    }).then((result) => { if (disposed || generation !== epoch || !visible()) return; const value = normalize(result); if (!value) throw new Error('invalid_response'); data = value; failure = ''; })
      .catch(() => { if (!disposed && generation === epoch && visible()) failure = 'unavailable'; })
      .finally(() => { if (inFlight !== request) return; inFlight = null; loading = false; if (disposed) return; render(); if (visible() && pendingReload) { const refreshNext = pendingRefresh; pendingReload = false; load({ refresh: refreshNext, forceRead: true }); } else schedule(); });
    inFlight = request;
  }
  function cancelImport() { importGeneration += 1; importState = null; $('ai-usage-import-panel').hidden = true; $('ai-usage-import-panel').replaceChildren(); $('ai-usage-import').disabled = false; }
  function importCurrent(epoch, selectedId) { return !disposed && visible() && importGeneration === epoch && selectedId === accountId && importState; }
  function importChanged() { if (!importState || importState.busy) return; importGeneration += 1; importState.token = ''; importState.preview = null; importState.error = ''; }
  function fieldInput(label, id, type, value) { const wrapper = element('label', 'ai-usage-import-field'); wrapper.append(element('span', '', label)); const input = element('input'); input.id = id; input.type = type; input.value = value || ''; wrapper.append(input); return wrapper; }
  function renderImport() {
    const panel = $('ai-usage-import-panel'); panel.hidden = !importState; if (!importState) return;
    panel.replaceChildren(); const state = importState;
    const heading = element('div', 'ai-usage-section-head'); heading.append(element('h3', '', state.fileName || '选择账单文件'));
    const cancel = element('button', 'workspace-button compact', '取消'); cancel.id = 'ai-usage-import-cancel'; cancel.type = 'button'; cancel.addEventListener('click', cancelImport); heading.append(cancel); panel.append(heading);
    panel.append(element('p', 'ai-usage-import-note', `导入至 ${selected().name}。请在供应商官网选择全部 API Key 后导出；此处只显示文件所包含的数据。支持 DeepSeek 官方 ZIP 或 CSV。`));
    if (!state.importId) { panel.append(element('p', 'ai-usage-import-note', state.error ? errorLabel(state.error) : '等待选择文件…')); return; }
    if (state.format !== 'deepseek') {
      const mapping = element('div', 'ai-usage-mapping');
      for (const [field, label] of Object.entries(FIELDS)) {
        const wrapper = element('label', 'ai-usage-import-field'); wrapper.append(element('span', '', `${label}${field === 'date' ? ' *' : ''}`));
        const select = element('select'); select.id = `ai-usage-map-${field}`; select.dataset.mappingField = field;
        setOptions(select, state.headers.map((header) => [header, header]), state.mapping[field] || '', field === 'date' ? '请选择日期列' : '不导入'); select.disabled = !!state.busy;
        select.addEventListener('change', () => { importChanged(); state.mapping[field] = select.value; renderImport(); }); wrapper.append(select); mapping.append(wrapper);
      }
      panel.append(mapping);
    } else panel.append(element('p', 'ai-usage-import-detected', '已识别 DeepSeek 官方账单，消费与用量文件将按原始维度合并。'));
    const options = element('div', 'ai-usage-import-options');
    const currencyField = element('label', 'ai-usage-import-field'); currencyField.append(element('span', '', '默认币种')); const select = element('select'); select.id = 'ai-usage-import-currency'; setOptions(select, ['CNY', 'USD'].map((id) => [id, id]), state.currency); select.disabled = !!state.busy; select.addEventListener('change', () => { importChanged(); state.currency = select.value; renderImport(); }); currencyField.append(select); options.append(currencyField);
    for (const [key, label] of [['startDate', '账单开始日期'], ['endDate', '账单结束日期']]) {
      const wrapper = fieldInput(label, `ai-usage-import-${key}`, 'date', state[key]); const input = wrapper.querySelector('input'); input.disabled = !!state.busy;
      input.addEventListener('change', () => { importChanged(); state[key] = input.value; renderImport(); }); options.append(wrapper);
    }
    panel.append(options, element('p', 'ai-usage-import-note', '日期可留空自动识别。填写导出时选择的完整日期范围；没有提供的指标会显示为未知。'));
    const confirmation = element('label', 'ai-usage-import-confirmation'), check = element('input'); check.id = 'ai-usage-import-confirm'; check.type = 'checkbox'; check.checked = state.confirmed; check.disabled = !!state.busy; check.addEventListener('change', () => { state.confirmed = check.checked; $('ai-usage-import-commit').disabled = !state.token || !state.confirmed || !!state.busy; }); confirmation.append(check, element('span', '', '我确认此账单属于当前所选账号')); panel.append(confirmation);
    const status = element('p', 'ai-usage-import-preview'); status.id = 'ai-usage-import-preview'; status.setAttribute('role', 'status');
    if (state.error) status.textContent = errorLabel(state.error);
    else if (state.busy) status.textContent = state.busy === 'commit' ? '正在保存账单…' : '正在检查账单…';
    else if (state.preview) {
      const preview = state.preview, values = preview.metrics || {};
      const previewTotals = `费用 ${number(values.cost) == null ? '未知' : amount(values.cost, text(preview.currency) || state.currency)} · 请求 ${integer(values.requests) == null ? '未知' : count(values.requests)} · Token ${integer(values.totalTokens) == null ? '未知' : count(values.totalTokens)}`;
      status.textContent = `${count(integer(preview.rowCount))} 条 · ${text(preview.startDate)} 至 ${text(preview.endDate)} · ${previewTotals}${preview.replaceNotice ? `。${typeof preview.replaceNotice === 'string' ? text(preview.replaceNotice) : '重复范围将以本次账单替换，请确认。'}` : ''}`;
      for (const warning of Array.isArray(preview.warnings) ? preview.warnings : []) status.append(element('span', 'ai-usage-import-warning', warningLabel(warning)));
    } else status.textContent = '预览后确认保存；尚未写入账单。';
    panel.append(status); const actions = element('div', 'ai-usage-import-buttons');
    const previewButton = element('button', 'workspace-button compact', '预览导入'); previewButton.id = 'ai-usage-import-preview-button'; previewButton.type = 'button'; previewButton.disabled = !!state.busy; previewButton.addEventListener('click', previewImport);
    const commit = element('button', 'workspace-button compact primary', '确认导入'); commit.id = 'ai-usage-import-commit'; commit.type = 'button'; commit.disabled = !state.token || !state.confirmed || !!state.busy; commit.addEventListener('click', commitImport); actions.append(previewButton, commit); panel.append(actions);
  }
  function warningLabel(value) { const code = typeof value === 'string' ? value : text(value?.code); return ({ missing_metrics: '部分用量指标未提供，将显示为未知。', partial_data: '此文件仅包含部分数据。', missing_api_key: '费用文件未分 API Key，不能分摊到单个 Key。', duplicate_rows: '重复记录将合并或替换。' })[code] || (/^[a-z_]+$/.test(code) ? '部分字段不完整，请核对原始账单。' : text(code)); }
  async function chooseImport() {
    if (!visible()) return; cancelImport();
    const epoch = importGeneration, selectedId = accountId;
    importState = { busy: 'choose', error: '', mapping: {}, headers: [], currency: 'CNY', startDate: '', endDate: '', confirmed: false }; renderImport(); render(); $('ai-usage-body').scrollTop = 0;
    try {
      const result = await window.notchAPI?.chooseAIUsageImport?.({ accountId: selectedId }); if (!importCurrent(epoch, selectedId)) return;
      if (!result?.ok) { if (result?.error === 'cancelled' || result?.cancelled) { cancelImport(); return; } throw new Error(result?.error || 'unavailable'); }
      if (!text(result.importId)) throw new Error('invalid_response');
      importState = { ...importState, importId: text(result.importId), fileName: text(result.fileName), format: result.format === 'deepseek' ? 'deepseek' : 'csv', headers: (Array.isArray(result.headers) ? result.headers : []).map(text).filter(Boolean), mapping: { ...(result.suggestedMapping || {}) }, startDate: validDate(result.detectedRange?.startDate) ? result.detectedRange.startDate : '', endDate: validDate(result.detectedRange?.endDate) ? result.detectedRange.endDate : '', busy: '', error: '' };
      renderImport(); render(); if (importState.format === 'deepseek') previewImport();
    } catch (error) { if (importCurrent(epoch, selectedId)) { importState.busy = ''; importState.error = text(error.message); renderImport(); render(); } }
  }
  async function previewImport() {
    const state = importState; if (!state || state.busy || !state.importId || !visible()) return;
    if (state.format !== 'deepseek' && (!state.mapping.date || !METRICS.some((field) => state.mapping[field]))) { state.error = 'invalid_mapping'; renderImport(); return; }
    if ((state.startDate && !validDate(state.startDate)) || (state.endDate && !validDate(state.endDate)) || (state.startDate && state.endDate && state.startDate > state.endDate)) { state.error = 'invalid_range'; renderImport(); return; }
    const epoch = ++importGeneration, selectedId = accountId; state.busy = 'preview'; state.error = ''; state.token = ''; renderImport(); render();
    try {
      const payload = { importId: state.importId, currency: state.currency, ...(state.format === 'deepseek' ? {} : { mapping: state.mapping }), ...(state.startDate ? { startDate: state.startDate } : {}), ...(state.endDate ? { endDate: state.endDate } : {}) };
      const result = await window.notchAPI?.previewAIUsageImport?.(payload); if (!importCurrent(epoch, selectedId)) return;
      if (!result?.ok || !text(result.token) || !result.preview) throw new Error(result?.error || 'invalid_response');
      state.token = result.token; state.preview = result.preview; state.busy = '';
      if (!state.startDate && validDate(result.preview.startDate)) state.startDate = result.preview.startDate;
      if (!state.endDate && validDate(result.preview.endDate)) state.endDate = result.preview.endDate;
      renderImport(); render();
    } catch (error) { if (importCurrent(epoch, selectedId)) { state.busy = ''; state.error = text(error.message); renderImport(); render(); } }
  }
  async function commitImport() {
    const state = importState; if (!state?.token || state.busy || !state.confirmed || !visible()) return;
    const epoch = ++importGeneration, selectedId = accountId; state.busy = 'commit'; state.error = ''; renderImport(); render();
    try { const result = await window.notchAPI?.commitAIUsageImport?.({ token: state.token }); if (!importCurrent(epoch, selectedId)) return; if (!result?.ok) throw new Error(result?.error || 'save_failed'); cancelImport(); generation += 1; load({ refresh: false, forceRead: true }); }
    catch (error) { if (importCurrent(epoch, selectedId)) { state.busy = ''; state.error = text(error.message); state.token = ''; renderImport(); render(); } }
  }
  function syncActivity() {
    const active = visible();
    if (!active) { clearTimeout(timer); timer = null; if (activePreviously) { generation += 1; loading = false; } if (importState) cancelImport(); }
    else if (!activePreviously) { if (inFlight) { pendingReload = true; pendingRefresh = true; } else load({ refresh: true, forceRead: true }); }
    activePreviously = active; render();
  }
  $('ai-usage-configure').addEventListener('click', () => { cancelImport(); window.NotchAISettings?.open(); syncActivity(); });
  $('ai-usage-import').addEventListener('click', chooseImport);
  $('ai-usage-refresh').addEventListener('click', () => load({ refresh: true }));
  $('ai-usage-account').addEventListener('change', (event) => { cancelImport(); accountId = event.target.value; modelFilter = ''; keyFilter = ''; currency = 'CNY'; render(); });
  $('ai-usage-model-filter').addEventListener('change', (event) => { modelFilter = event.target.value; render(); });
  $('ai-usage-key-filter').addEventListener('change', (event) => { keyFilter = event.target.value; render(); });
  $('ai-usage-currency').addEventListener('change', (event) => { currency = event.target.value; render(); });
  for (const id of ['ai-usage-start-date', 'ai-usage-end-date']) $(id).addEventListener('change', render);
  page.addEventListener('click', (event) => {
    const dates = event.target.closest('[data-usage-period]'), chart = event.target.closest('[data-usage-chart]'), group = event.target.closest('[data-usage-group]');
    if (dates) { const previous = range(); period = dates.dataset.usagePeriod; if (period === 'custom' && !$('ai-usage-start-date').value) { $('ai-usage-start-date').value = previous?.start || today(); $('ai-usage-end-date').value = previous?.end || today(); } render(); }
    else if (chart) { chartMetric = chart.dataset.usageChart; render(); }
    else if (group) { grouping = group.dataset.usageGroup; render(); }
  });
  document.addEventListener('notch:modechange', (event) => { expanded = !!event.detail?.expanded; syncActivity(); });
  document.addEventListener('notch:tabchange', (event) => { currentTab = event.detail?.tab || 'home'; syncActivity(); });
  document.addEventListener('notch:featureschange', syncActivity);
  document.addEventListener('visibilitychange', syncActivity);
  document.addEventListener('notch:ai-settings-changed', () => { cancelImport(); generation += 1; data = null; failure = ''; pendingReload = true; pendingRefresh = true; lastRefreshAttemptAt = 0; render(); if (visible() && !inFlight) load({ refresh: true, forceRead: true }); });
  const settingsObserver = new MutationObserver(syncActivity), settingsBackdrop = $('transcription-settings-backdrop');
  if (settingsBackdrop) settingsObserver.observe(settingsBackdrop, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('pagehide', () => { disposed = true; generation += 1; cancelImport(); clearTimeout(timer); timer = null; settingsObserver.disconnect(); });
  window.NotchAIUsage = Object.freeze({ isActive: visible, refresh: () => load({ refresh: true, forceRead: true }) });
  render(); syncActivity();
})();
