(function initAISettings() {
  'use strict';
  const backdrop = document.getElementById('transcription-settings-backdrop');
  const body = document.getElementById('ai-settings-body');
  const note = document.getElementById('transcription-settings-note');
  const saveButton = document.getElementById('transcription-settings-save');
  if (!backdrop || !body || !note || !saveButton) return;

  const CAPABILITIES = { translation: '新闻翻译', naming: '命名与分组', speech: '实时语音转写' };
  const LABELS = { deepseek: 'DeepSeek', qwen: '千问 · 阿里云百炼', volc: '豆包 · 火山引擎', zhipu: 'GLM · 智谱', moonshot: 'Kimi · 月之暗面', minimax: 'MiniMax', openai: 'OpenAI', anthropic: 'Claude · Anthropic', gemini: 'Gemini · Google', siliconflow: '硅基流动', openrouter: 'OpenRouter', ollama: 'Ollama · 本地 / 自托管', custom: '自定义接口 / 公司网关' };
  const GROUPS = { deepseek: '国内', qwen: '国内', volc: '国内', zhipu: '国内', moonshot: '国内', minimax: '国内', openai: '海外', anthropic: '海外', gemini: '海外', siliconflow: '聚合平台', openrouter: '聚合平台', ollama: '本地与自定义', custom: '本地与自定义' };
  const string = (value) => typeof value === 'string' ? value : '';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const button = (label, action, extra = '', className = '') => `<button type="button" class="ai-button ${className}" data-ai-action="${action}" ${extra}>${label}</button>`;
  const uid = () => `ai-${window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  let providers = [];
  let connections = [];
  let assignments = {};
  let activeId = '';
  let manualCapability = '';
  let recommendation = null;
  let loaded = false;
  let saving = false;
  let generation = 0;
  let requestSequence = 0;
  let opener = null;
  let secureStorage = true;
  const secrets = new Map();
  const requests = new Map();
  const revisions = new Map();
  const discovery = new Map();
  const disabledCapabilities = new Set();
  const advancedOpen = new Set();

  const isOpen = () => !backdrop.hidden;
  const active = () => connections.find((connection) => connection.id === activeId);
  const providerFor = (connection) => providers.find((provider) => provider.id === connection?.provider);
  const providerLabel = (connection) => LABELS[connection?.provider] || providerFor(connection)?.name || '新连接';
  const connectionLabel = (connection) => `${connections.indexOf(connection) + 1}. ${providerLabel(connection)}`;
  const identity = (connection) => JSON.stringify([connection.provider, connection.baseUrl, connection.protocol, connection.region, connection.workspaceId]);
  const modelKey = (connectionId, model) => JSON.stringify([connectionId, model]);
  const needsKey = (connection) => providerFor(connection)?.requiresApiKey !== false;
  const hasCredential = (connection) => !!connection?.provider && (!needsKey(connection) || !!secrets.get(connection.id) || (connection.hasApiKey && !connection.needsReentry));
  const assignmentKey = (capability) => assignments[capability] ? modelKey(assignments[capability].connectionId, assignments[capability].model) : disabledCapabilities.has(capability) ? '__off__' : '';
  const qwenBaseUrl = (connection) => `https://${connection.workspaceId ? `${connection.workspaceId}.${connection.region === 'singapore' ? 'ap-southeast-1' : 'cn-beijing'}.maas.aliyuncs.com` : connection.region === 'singapore' ? 'dashscope-intl.aliyuncs.com' : 'dashscope.aliyuncs.com'}/compatible-mode/v1`;
  const modelStatus = (model) => model?.capabilitySource === 'adapter' ? '内置适配 · 账号权限未验证' : model?.manual ? '手动配置 · 未测试' : model?.capabilitySource === 'unverified' ? '接口返回的模型 · 任务能力未测试' : '模型列表已读取 · 实际调用未测试';
  const canRecommend = (model) => !model.manual || model.capabilitySource === 'adapter';

  function setStatus(message, state = '') {
    note.textContent = message;
    note.dataset.state = state;
    note.classList.toggle('error', state === 'error');
    note.classList.toggle('success', state === 'success');
  }
  function errorLabel(error) {
    const labels = {
      not_configured: '请填写 API Key，或使用已保存的密钥。', missing_api_key: '请填写 API Key。',
      auth: '密钥未通过身份验证，请检查供应商、API Key 和地域后重试。', unauthorized: '密钥未通过身份验证，请检查后重试。',
      http_401: 'API Key 未通过身份验证，请重新填写。', http_403: '当前账号没有访问权限，请检查密钥权限与地域。',
      forbidden: '当前账号没有访问权限，请检查密钥权限与地域。', quota: '服务额度不足或请求过于频繁，请稍后重试。',
      network: '连接服务失败，请检查网络和接口地址后重试。', network_error: '连接服务失败，请检查网络和接口地址后重试。',
      timeout: '连接超时，请稍后重试。', unsafe_endpoint: '接口地址不可用，请检查地址和访问范围。', invalid_endpoint: '接口地址格式不正确，请检查后重试。',
      invalid_url: '接口地址格式不正确，请检查后重试。', invalid_protocol: '当前接口协议不受支持。', unsupported_provider: '当前供应商配置不受支持。',
      invalid_provider: '请选择模型供应商。', invalid_workspace: '工作空间 ID 格式不正确。',
      unsupported_models: '此接口不提供可读取的模型列表，可手动填写模型 ID。', models_unavailable: '未取得模型列表，可重试或手动填写模型 ID。',
      invalid_response: '服务未返回可识别的模型列表，可重试或手动填写模型 ID。', response_too_large: '模型列表超过读取上限，可手动填写模型 ID。',
      invalid_assignment: '任务中的模型与连接不匹配，请重新选择。', invalid_model: '模型配置无效，请检查模型 ID 与任务能力。',
      invalid_models: '模型 ID 格式不正确，请使用接口提供的 ID，不含空格。', invalid_api_key: 'API Key 格式不正确，请检查是否包含换行或多余字符。',
      invalid_region: '当前地域不受支持，请重新选择。', settings_unreadable: '保存的配置暂时无法读取，请重试。',
      unsupported_capability: '该连接尚未适配这项任务，请选择其他模型或连接。', unsupported_task: '所选模型尚未适配这项任务，请重新选择。',
      secure_storage_unavailable: '系统安全存储不可用，密钥未保存。请检查系统钥匙串后重试。',
      save_failed: '配置未能保存，请重试。', busy: '服务正在处理其他请求，请稍后重试。',
      unavailable: '当前版本暂时无法读取 AI 配置，请重新打开应用后重试。',
    };
    return labels[string(error)] || '操作未完成，请检查连接配置后重试。';
  }
  function normalizeModels(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : []).filter((model) => {
      if (!model || !string(model.id).trim() || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    }).map((model) => ({ id: model.id, name: string(model.name) || model.id,
      capabilities: (Array.isArray(model.capabilities) ? model.capabilities : []).filter((capability) => Object.hasOwn(CAPABILITIES, capability)),
      capabilitySource: ['metadata', 'adapter', 'unverified'].includes(model.capabilitySource) ? model.capabilitySource : 'unverified',
      ...(model.manual ? { manual: true } : {}),
    }));
  }
  function readConfig(config) {
    providers = (Array.isArray(config.providers) ? config.providers : []).filter((provider) => provider && string(provider.id)).map((provider) => ({ ...provider }));
    connections = (Array.isArray(config.connections) ? config.connections : []).filter((connection) => connection && string(connection.id)).map((connection) => ({
      id: connection.id, provider: string(connection.provider), baseUrl: string(connection.baseUrl), protocol: string(connection.protocol) || 'openai',
      region: string(connection.region) || 'beijing', workspaceId: string(connection.workspaceId), hasApiKey: connection.hasApiKey === true,
      needsReentry: connection.needsReentry === true, models: normalizeModels(connection.models),
    }));
    assignments = {};
    for (const capability of Object.keys(CAPABILITIES)) {
      const item = config.assignments?.[capability];
      assignments[capability] = item && string(item.connectionId) && string(item.model) ? { connectionId: item.connectionId, model: item.model } : null;
    }
    disabledCapabilities.clear();
    for (const capability of Array.isArray(config.disabledTasks) ? config.disabledTasks : []) if (Object.hasOwn(CAPABILITIES, capability) && !assignments[capability]) disabledCapabilities.add(capability);
    secureStorage = config.secureStorage !== false;
    if (!connections.length) connections.push(newConnection());
    if (!connections.some((connection) => connection.id === activeId)) activeId = connections[0].id;
    loaded = true;
  }
  function newConnection() {
    return { id: uid(), provider: '', baseUrl: '', protocol: 'openai', region: 'beijing', workspaceId: '', hasApiKey: false, needsReentry: false, models: [] };
  }
  function clearAssignments(connection) {
    for (const capability of Object.keys(CAPABILITIES)) if (assignments[capability]?.connectionId === connection.id) assignments[capability] = null;
  }
  function invalidate(connection, credentials = false) {
    revisions.set(connection.id, (revisions.get(connection.id) || 0) + 1);
    requests.delete(connection.id);
    discovery.delete(connection.id);
    clearAssignments(connection);
    connection.models = [];
    recommendation = null;
    manualCapability = '';
    if (credentials) {
      secrets.delete(connection.id);
      connection.hasApiKey = false;
      connection.needsReentry = false;
    }
  }
  function supportsManual(connection, capability) {
    if (!hasCredential(connection)) return false;
    return capability !== 'speech';
  }
  function candidates(capability) {
    return connections.filter(hasCredential).flatMap((connection) => connection.models
      .filter((model) => model.capabilities.includes(capability))
      .map((model) => ({ ...model, connectionId: connection.id, connectionName: connectionLabel(connection), key: modelKey(connection.id, model.id) })));
  }
  function providerOptions(connection) {
    const groups = new Map();
    for (const provider of providers) {
      const group = GROUPS[provider.id] || provider.group || '其他';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(provider);
    }
    return '<option value="">请选择</option>' + [...groups].map(([group, entries]) => `<optgroup label="${esc(group)}">${entries.map((provider) => `<option value="${esc(provider.id)}"${provider.id === connection.provider ? ' selected' : ''}>${esc(LABELS[provider.id] || provider.name || provider.id)}</option>`).join('')}</optgroup>`).join('');
  }
  function connectionForm(connection) {
    const provider = providerFor(connection);
    const progress = discovery.get(connection.id);
    const pending = requests.has(connection.id);
    const fields = !connection.provider ? '' : `<section class="ai-section">
      <div class="ai-between"><h3><span class="ai-step">2</span>${needsKey(connection) ? '填写 API Key' : '连接本地服务'}</h3><span class="ai-small">${progress?.ok ? '已读取模型列表' : connection.hasApiKey && !connection.needsReentry ? '密钥已保存' : ''}</span></div>
      ${needsKey(connection) ? `<div class="ai-key-row"><input id="ai-key" type="password" aria-label="API Key" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="8192" /><button id="ai-connect" class="ai-button ${connection.models.length ? '' : 'ai-primary'}" data-ai-action="connect" type="button"${pending ? ' disabled' : ''}>${pending ? '读取中…' : connection.models.length ? '刷新模型' : '连接并读取'}</button></div><p class="ai-hint">${connection.needsReentry ? '已保存的密钥无法解密，请重新填写。' : connection.hasApiKey ? '留空使用已保存的密钥；填写新值将在保存配置时替换。' : '密钥仅在保存配置时加密写入本机，不会回显。'}</p>` : ''}
      <details class="ai-advanced"${advancedOpen.has(connection.id) || connection.provider === 'custom' || connection.provider === 'ollama' ? ' open' : ''}><summary>高级连接设置</summary>
        <label class="ai-field"><span>接口地址</span><input id="ai-base-url" type="text" inputmode="url" value="${esc(connection.baseUrl)}" maxlength="2048" autocomplete="off" spellcheck="false" /></label>
        ${connection.provider === 'custom' ? `<label class="ai-field"><span>接口协议</span><select id="ai-protocol" aria-label="接口协议">${[['openai', 'OpenAI 兼容 · 文本'], ['anthropic', 'Anthropic Messages'], ['gemini', 'Gemini API']].map(([value, label]) => `<option value="${value}"${connection.protocol === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>` : `<p class="ai-hint">${esc(provider?.protocol === 'anthropic' ? 'Anthropic Messages' : provider?.protocol === 'gemini' ? 'Gemini API' : 'OpenAI 兼容接口')}</p>`}
        ${connection.provider === 'qwen' ? `<label class="ai-field"><span>地域</span><select id="ai-region" aria-label="百炼地域"><option value="beijing"${connection.region !== 'singapore' ? ' selected' : ''}>北京</option><option value="singapore"${connection.region === 'singapore' ? ' selected' : ''}>新加坡</option></select></label><label class="ai-field"><span>工作空间 ID</span><input id="ai-workspace-id" value="${esc(connection.workspaceId)}" maxlength="128" autocomplete="off" spellcheck="false" /></label>` : ''}
        <p class="ai-hint">更改地址、协议或地域后，需要重新连接并分配任务。</p>
        ${button('删除此连接', 'remove', '', 'ai-link ai-remove')}
      </details>
      ${!needsKey(connection) ? `<div class="ai-local-connect">${button(pending ? '读取中…' : '连接并读取', 'connect', `id="ai-connect"${pending ? ' disabled' : ''}`, 'ai-primary')}</div>` : ''}
      ${progress ? `<p class="ai-connection-feedback" data-state="${progress.ok ? 'success' : 'error'}">${esc(progress.message)}</p>` : ''}
      ${button('手动填写模型 ID', 'show-manual', `id="ai-show-manual"${!hasCredential(connection) ? ' disabled' : ''}`, 'ai-link')}
    </section>`;
    return `<div class="ai-between"><h3><span class="ai-step">1</span>选择模型供应商</h3>${button('＋ 添加连接', 'add', 'id="ai-add-connection"', 'ai-link')}</div>
      ${connections.length > 1 ? `<div id="ai-connection-tabs" class="ai-connection-tabs" aria-label="服务连接">${connections.map((item) => `<button type="button" data-ai-action="connection" data-id="${esc(item.id)}" aria-pressed="${item.id === connection.id}">${esc(connectionLabel(item))}</button>`).join('')}</div>` : ''}
      <select id="ai-provider" class="ai-provider" aria-label="模型供应商">${providerOptions(connection)}</select>${fields}`;
  }
  function modelRow(capability) {
    const value = assignmentKey(capability);
    const models = candidates(capability);
    let options = '<option value="">请选择</option>';
    for (const connection of connections) {
      const entries = models.filter((model) => model.connectionId === connection.id);
      if (!entries.length) continue;
      options += `<optgroup label="${esc(connectionLabel(connection))}">${entries.map((model) => `<option value="${esc(model.key)}"${value === model.key ? ' selected' : ''}>${esc(model.name)}${model.capabilitySource === 'adapter' ? ' · 内置适配' : model.manual ? ' · 手动 / 未测试' : ''}</option>`).join('')}</optgroup>`;
    }
    if (value && value !== '__off__' && !models.some((model) => model.key === value)) options += `<option selected disabled value="${esc(value)}">原模型不可用，请重新选择</option>`;
    options += `<option value="__off__"${value === '__off__' ? ' selected' : ''}>暂不启用</option>`;
    if (supportsManual(active(), capability)) options += '<option value="__manual__">手动填写模型 ID…</option>';
    return `<div class="ai-model-row"><label for="ai-model-${capability}">${CAPABILITIES[capability]}</label><div class="ai-model-control"><select id="ai-model-${capability}" data-ai-capability="${capability}">${options}</select>
      ${manualCapability === capability ? `<div class="ai-manual"><input id="ai-manual-id" type="text" aria-label="${CAPABILITIES[capability]}模型 ID" maxlength="200" autocomplete="off" spellcheck="false" />${button('添加模型', 'manual', `data-cap="${capability}"`)}</div><p class="ai-hint">添加到 ${esc(connectionLabel(active()))}；仅保存模型 ID，首次调用时才能确认是否可用。</p>` : ''}
      ${models.some((model) => model.key === value) ? `<p class="ai-hint ai-model-status">${modelStatus(models.find((model) => model.key === value))}</p>` : ''}
      ${capability === 'speech' && !models.length ? '<p class="ai-hint">暂无已适配的实时语音模型，可添加百炼连接。录音仍可保存在本机。</p>' : ''}</div></div>`;
  }
  function recommendationView() {
    if (!recommendation) return '';
    return `<div class="ai-recommendation"><p>优先选取已声明能力或内置适配的候选，仅填空项。</p>${Object.keys(CAPABILITIES).map((capability) => `<div><span>${CAPABILITIES[capability]}</span><span>${assignments[capability] || disabledCapabilities.has(capability) ? '保留当前选择' : esc(recommendation[capability]?.name || '暂无候选')}</span></div>`).join('')}<p class="ai-hint">依据接口目录匹配任务，尚未测试实际调用或比较质量。</p><div class="ai-recommendation-actions">${button('收起', 'dismiss', '', 'ai-link')}${button('填入空项', 'apply', 'id="ai-apply-recommendation"')}</div></div>`;
  }
  function render() {
    const scroll = body.scrollTop;
    const focused = body.contains(document.activeElement) ? document.activeElement.id : '';
    const selection = focused && document.activeElement.tagName === 'INPUT' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const manualDraft = body.querySelector('#ai-manual-id')?.value || '';
    if (!loaded) {
      body.innerHTML = '<p class="ai-empty">正在读取配置…</p>';
      saveButton.disabled = true;
      return;
    }
    const tasksVisible = connections.some((connection) => connection.models.length) || !!manualCapability || connections.some((connection) => discovery.has(connection.id));
    body.innerHTML = `<fieldset class="ai-settings-controls"${saving ? ' disabled' : ''}>${connectionForm(active())}${tasksVisible ? `<section class="ai-section ai-task-section"><div class="ai-between"><h3><span class="ai-step">3</span>分配任务</h3>${button('帮我选', 'recommend', `id="ai-recommend"${Object.keys(CAPABILITIES).some((capability) => candidates(capability).some(canRecommend)) ? '' : ' disabled'}`, 'ai-link')}</div>${recommendationView()}${Object.keys(CAPABILITIES).map(modelRow).join('')}</section>` : ''}</fieldset>`;
    const keyInput = body.querySelector('#ai-key');
    if (keyInput) keyInput.value = secrets.get(activeId) || '';
    const manualInput = body.querySelector('#ai-manual-id');
    if (manualInput) manualInput.value = manualDraft;
    body.scrollTop = scroll;
    if (focused) {
      const target = document.getElementById(focused);
      target?.focus({ preventScroll: true });
      if (selection && target?.type !== 'url') { try { target.setSelectionRange(...selection); } catch {} }
    }
    saveButton.disabled = saving || requests.size > 0;
    saveButton.textContent = saving ? '保存中…' : '保存配置';
  }
  function publicConnection(connection, includeModels = false) {
    const result = { id: connection.id, provider: connection.provider, baseUrl: connection.baseUrl, protocol: connection.protocol, region: connection.region, workspaceId: connection.workspaceId };
    if (includeModels) result.models = connection.models;
    if (secrets.get(connection.id)) result.apiKey = secrets.get(connection.id);
    return result;
  }
  async function connect() {
    const connection = active();
    if (!connection?.provider || saving || requests.has(connection.id)) return;
    if (!hasCredential(connection)) { setStatus('请填写 API Key。', 'error'); body.querySelector('#ai-key')?.focus(); return; }
    const token = ++requestSequence;
    const epoch = generation;
    const revision = revisions.get(connection.id) || 0;
    const targetIdentity = identity(connection);
    requests.set(connection.id, token);
    setStatus('正在读取模型列表…', 'loading');
    render();
    try {
      if (typeof window.notchAPI?.discoverAIModels !== 'function') throw new Error('unavailable');
      const result = await window.notchAPI.discoverAIModels({ connection: publicConnection(connection) });
      if (!isOpen() || epoch !== generation || requests.get(connection.id) !== token || revision !== (revisions.get(connection.id) || 0)
        || !connections.includes(connection) || identity(connection) !== targetIdentity) return;
      if (!result?.ok) throw new Error(string(result?.error) || 'network');
      const models = normalizeModels(result.models);
      for (const manual of connection.models.filter((model) => model.manual)) if (!models.some((model) => model.id === manual.id)) models.push(manual);
      connection.models = models;
      const message = (models.length ? '已读取模型列表；文字与语音的实际调用尚未测试。' : '接口未返回模型，可手动填写模型 ID；实际调用尚未测试。')
        + (result.warnings?.includes('model_list_truncated') ? '目录较长，仅展示已读取部分，其他模型可手动添加。' : '');
      discovery.set(connection.id, { ok: true, message });
      recommendation = null;
      if (activeId === connection.id) setStatus(message);
    } catch (failure) {
      if (!isOpen() || epoch !== generation || requests.get(connection.id) !== token || revision !== (revisions.get(connection.id) || 0)) return;
      const message = errorLabel(failure?.message);
      discovery.set(connection.id, { ok: false, message });
      if (activeId === connection.id) setStatus(message, 'error');
    } finally {
      if (requests.get(connection.id) === token) requests.delete(connection.id);
      if (isOpen() && epoch === generation) render();
    }
  }
  async function save() {
    if (!loaded || saving || requests.size) return;
    const selected = connections.filter((connection) => connection.provider);
    for (const connection of selected) {
      if (!hasCredential(connection)) { activeId = connection.id; render(); setStatus(`${providerLabel(connection)} 需要填写 API Key。`, 'error'); return; }
      if (!string(connection.baseUrl).trim()) { activeId = connection.id; advancedOpen.add(connection.id); render(); setStatus('请填写接口地址。', 'error'); return; }
    }
    for (const capability of Object.keys(CAPABILITIES)) {
      const assignment = assignments[capability];
      if (assignment && !candidates(capability).some((model) => model.connectionId === assignment.connectionId && model.id === assignment.model)) {
        setStatus(`${CAPABILITIES[capability]}的模型不可用，请重新选择。`, 'error'); return;
      }
    }
    const epoch = generation;
    saving = true;
    setStatus('正在安全保存配置…', 'loading');
    render();
    try {
      if (typeof window.notchAPI?.saveAISettings !== 'function') throw new Error('unavailable');
      const result = await window.notchAPI.saveAISettings({ connections: selected.map((connection) => publicConnection(connection, true)), assignments, disabledTasks: [...disabledCapabilities] });
      if (!result?.ok) throw new Error(string(result?.error) || 'save_failed');
      document.dispatchEvent(new CustomEvent('notch:ai-settings-changed'));
      if (!isOpen() || epoch !== generation) return;
      secrets.clear();
      readConfig(result);
      setStatus('配置已保存。密钥加密保存在本机，输入框不回显。', 'success');
    } catch (failure) {
      if (isOpen() && epoch === generation) setStatus(errorLabel(failure?.message), 'error');
    } finally {
      if (epoch === generation) { saving = false; if (isOpen()) render(); }
    }
  }
  async function open() {
    if (isOpen()) return;
    opener = document.activeElement;
    generation += 1;
    const epoch = generation;
    secrets.clear(); requests.clear(); revisions.clear(); discovery.clear(); disabledCapabilities.clear(); advancedOpen.clear();
    manualCapability = ''; recommendation = null; loaded = false; saving = false;
    backdrop.hidden = false;
    setStatus('正在读取配置…', 'loading');
    render();
    try {
      if (typeof window.notchAPI?.getAISettings !== 'function') throw new Error('unavailable');
      const result = await window.notchAPI.getAISettings();
      if (!isOpen() || epoch !== generation) return;
      if (!result?.ok) throw new Error(string(result?.error) || 'unavailable');
      readConfig(result);
      setStatus(!secureStorage ? '系统安全存储暂不可用，新密钥将无法保存。' : result.migrated ? '已载入原有配置，可继续选择模型或添加连接。' : '选择供应商，连接后自行分配任务。', !secureStorage ? 'error' : '');
      render();
      body.querySelector('#ai-provider')?.focus({ preventScroll: true });
    } catch (failure) {
      if (!isOpen() || epoch !== generation) return;
      body.innerHTML = `<p class="ai-empty">暂时未能读取配置。</p>${button('重试', 'retry-open')}`;
      setStatus(errorLabel(failure?.message), 'error');
    }
  }
  function close() {
    if (!isOpen()) return;
    generation += 1;
    const keyInput = body.querySelector('#ai-key');
    if (keyInput) keyInput.value = '';
    secrets.clear(); requests.clear(); revisions.clear(); discovery.clear();
    connections = []; assignments = {}; loaded = false; saving = false; recommendation = null; manualCapability = '';
    body.replaceChildren();
    backdrop.hidden = true;
    if (document.getElementById('app')?.classList.contains('expanded') && opener?.isConnected) opener.focus({ preventScroll: true });
  }

  body.addEventListener('input', (event) => {
    if (saving || !['ai-key', 'ai-base-url', 'ai-workspace-id'].includes(event.target.id)) return;
    const connection = active();
    if (!connection) return;
    const value = event.target.value.trim();
    if (event.target.id === 'ai-key') {
      if (value) secrets.set(connection.id, value); else secrets.delete(connection.id);
      invalidate(connection);
      setStatus('密钥输入已更新，请重新读取模型；保存前不会写入本机。');
    } else {
      const field = event.target.id === 'ai-base-url' ? 'baseUrl' : 'workspaceId';
      if (connection[field] === value) return;
      invalidate(connection, true);
      connection[field] = value;
      if (field === 'workspaceId' && connection.provider === 'qwen') connection.baseUrl = qwenBaseUrl(connection);
      setStatus('连接信息已更改，旧密钥与相关任务不会复用。请重新填写密钥并连接。');
    }
    render();
  });
  body.addEventListener('toggle', (event) => {
    if (!event.target.classList.contains('ai-advanced') || !active()) return;
    if (event.target.open) advancedOpen.add(activeId); else advancedOpen.delete(activeId);
  }, true);
  body.addEventListener('change', (event) => {
    if (saving) return;
    const element = event.target;
    const connection = active();
    if (!connection) return;
    if (element.id === 'ai-provider') {
      if (element.value === connection.provider) return;
      invalidate(connection, true);
      connection.provider = element.value;
      const provider = providerFor(connection);
      connection.baseUrl = string(provider?.defaultBaseUrl);
      connection.protocol = string(provider?.protocol) || 'openai';
      connection.region = 'beijing'; connection.workspaceId = '';
      setStatus(connection.provider ? '请填写此供应商的 API Key，再连接并读取模型。' : '请选择模型供应商。');
    } else if (['ai-base-url', 'ai-protocol', 'ai-region', 'ai-workspace-id'].includes(element.id)) {
      const field = { 'ai-base-url': 'baseUrl', 'ai-protocol': 'protocol', 'ai-region': 'region', 'ai-workspace-id': 'workspaceId' }[element.id];
      if (connection[field] === element.value.trim()) return;
      invalidate(connection, true);
      connection[field] = element.value.trim();
      if (['region', 'workspaceId'].includes(field) && connection.provider === 'qwen') connection.baseUrl = qwenBaseUrl(connection);
      setStatus('连接信息已更改，旧密钥与相关任务不会复用。请重新填写密钥并连接。');
    } else if (element.id === 'ai-key') {
      // The input handler keeps the secret only in this dialog's memory.
      return;
    } else if (element.dataset.aiCapability) {
      const capability = element.dataset.aiCapability;
      if (element.value === '__manual__') { manualCapability = capability; render(); body.querySelector('#ai-manual-id')?.focus(); return; }
      const model = candidates(capability).find((candidate) => candidate.key === element.value);
      assignments[capability] = model ? { connectionId: model.connectionId, model: model.id } : null;
      if (element.value === '__off__') disabledCapabilities.add(capability); else disabledCapabilities.delete(capability);
      recommendation = null; manualCapability = '';
      setStatus('已更新任务选择，点击保存配置后生效。');
    } else return;
    render();
  });
  body.addEventListener('click', (event) => {
    const control = event.target.closest('[data-ai-action]');
    if (!control || control.disabled || saving) return;
    const action = control.dataset.aiAction;
    const connection = active();
    if (action === 'retry-open') { close(); open(); return; }
    if (action === 'connect') { connect(); return; }
    if (action === 'connection') { activeId = control.dataset.id; manualCapability = ''; setStatus('已切换连接；任务分配保持不变。'); }
    else if (action === 'add') {
      let empty = connections.find((item) => !item.provider);
      if (!empty) { empty = newConnection(); connections.push(empty); }
      activeId = empty.id; manualCapability = ''; setStatus('请选择新连接的供应商。已有任务分配保持不变。');
    } else if (action === 'remove') {
      clearAssignments(connection); secrets.delete(connection.id); requests.delete(connection.id); discovery.delete(connection.id);
      connections = connections.filter((item) => item !== connection);
      if (!connections.length) connections.push(newConnection());
      activeId = connections[0].id; manualCapability = ''; recommendation = null;
      setStatus('连接已从本次编辑移除，保存配置后生效。');
    } else if (action === 'show-manual') {
      if (!hasCredential(connection)) { setStatus('请先填写连接所需的 API Key。', 'error'); return; }
      manualCapability = 'translation';
      setStatus('可手动填写模型 ID；不会自动测试或发送文章内容。');
    } else if (action === 'manual') {
      const capability = control.dataset.cap;
      const id = body.querySelector('#ai-manual-id')?.value.trim();
      if (!id) { setStatus('请填写模型 ID。', 'error'); return; }
      if (/[\s\u0000-\u001f\u007f]/.test(id)) { setStatus('模型 ID 不能包含空格或换行。', 'error'); return; }
      if (!supportsManual(connection, capability)) { setStatus('当前连接不支持手动配置这项任务。', 'error'); return; }
      let model = connection.models.find((item) => item.id === id);
      if (model && !model.capabilities.includes(capability)) { setStatus('此模型未适配这项任务，请选择其他模型。', 'error'); return; }
      if (!model) { model = { id, name: id, capabilities: ['translation', 'naming'], capabilitySource: 'unverified', manual: true }; connection.models.push(model); }
      assignments[capability] = { connectionId: connection.id, model: id };
      disabledCapabilities.delete(capability); manualCapability = ''; recommendation = null;
      setStatus('手动模型已加入本次配置，实际调用尚未测试。');
    } else if (action === 'recommend') {
      recommendation = {};
      for (const capability of Object.keys(CAPABILITIES)) {
        const options = candidates(capability).filter(canRecommend);
        recommendation[capability] = options.find((model) => ['metadata', 'adapter'].includes(model.capabilitySource)) || options[0] || null;
      }
    } else if (action === 'dismiss') recommendation = null;
    else if (action === 'apply') {
      for (const capability of Object.keys(CAPABILITIES)) {
        const model = recommendation?.[capability];
        if (!assignments[capability] && !disabledCapabilities.has(capability) && model && candidates(capability).some((candidate) => candidate.key === model.key)) assignments[capability] = { connectionId: model.connectionId, model: model.id };
      }
      recommendation = null;
      setStatus('仅填入了空项，原有选择与暂不启用的任务保持不变。');
    } else return;
    render();
    if (action === 'show-manual') { body.querySelector('#ai-manual-id')?.focus(); body.querySelector('.ai-task-section')?.scrollIntoView({ block: 'nearest' }); }
  });
  saveButton.addEventListener('click', save);
  document.getElementById('transcription-settings-close').addEventListener('click', close);
  document.getElementById('transcription-settings-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...backdrop.querySelectorAll('button,input,select,summary,[tabindex]')].filter((control) => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.addEventListener('notch:modechange', (event) => { if (!event.detail?.expanded) close(); });
  document.addEventListener('notch:tabchange', close);
  document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
  window.addEventListener('pagehide', close);
  window.NotchAISettings = { open, close, isOpen };
})();
