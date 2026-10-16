const { createPublicHttpsValidator } = require('./news-network');
const { isLocalOllama, modelCapabilities, supportsSpeech, SPEECH_MODEL } = require('./ai-providers');
const AI_CLIENT_LIMITS = Object.freeze({ timeoutMs: 60000, responseBytes: 256 * 1024, modelBytes: 2 * 1024 * 1024, maxModels: 1000, maxPages: 5 });
const failure = (error) => ({ ok: false, error });
function endpointFor(config, operation = 'complete') {
  try {
    if (typeof config?.baseUrl !== 'string' || config.baseUrl.length > 4096) return null;
    const base = new URL(config.baseUrl);
    if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !isLocalOllama(config, base.href))) return null;
    const root = base.href.replace(/\/+$/, '').replace(/\/(?:chat\/completions|messages)$/, '');
    if (config.provider === 'ollama') return operation === 'models' ? `${root.replace(/\/v1$/, '')}/api/tags` : `${root.replace(/\/v1$/, '')}/v1/chat/completions`;
    if (operation === 'models') return `${root}/models`;
    if (config.protocol === 'anthropic') return `${root}/messages`;
    if (config.protocol === 'gemini') return `${root}/models/${encodeURIComponent(String(config.model || '').replace(/^models\//, ''))}:generateContent`;
    return `${root}/chat/completions`;
  } catch { return null; }
}
function authHeaders(config) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (config.protocol === 'anthropic') { headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else if (config.protocol === 'gemini') headers['x-goog-api-key'] = config.apiKey;
  else if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.provider === 'qwen' && config.workspaceId) headers['X-DashScope-WorkSpace'] = config.workspaceId;
  return headers;
}
function requestBody(config, { system, user, json = false, maxTokens = 8192 }) {
  if (config.protocol === 'anthropic') return { model: config.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], stream: false };
  if (config.protocol === 'gemini') return { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) } };
  return {
    model: config.model, stream: false,
    ...(config.provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    // Compatibility does not imply JSON-mode support. Other providers receive
    // the JSON instructions in the prompt and are checked just as strictly.
    ...(json && ['openai', 'deepseek', 'siliconflow', 'ollama'].includes(config.provider) ? { response_format: { type: 'json_object' } } : {}),
    ...(config.provider === 'qwen' && /^qwen(?:-(?:plus|turbo|flash|max)|3(?:[.-]|$))/i.test(config.model) ? { enable_thinking: false } : {}),
    ...(new URL(config.baseUrl).hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
}
function normalizeCompletion(config, body) {
  if (config.protocol === 'anthropic') {
    if (body.stop_reason !== 'end_turn' || !Array.isArray(body.content) || body.content.some((part) => part.type !== 'text' && part.type !== 'thinking' && part.type !== 'redacted_thinking')) throw new Error('invalid_response');
    return body.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
  }
  if (config.protocol === 'gemini') {
    if (!Array.isArray(body.candidates) || body.candidates.length !== 1 || body.candidates[0].finishReason !== 'STOP' || body.promptFeedback?.blockReason) throw new Error('invalid_response');
    const parts = body.candidates[0].content?.parts;
    if (!Array.isArray(parts) || parts.some((part) => typeof part.text !== 'string')) throw new Error('invalid_response');
    return parts.filter((part) => !part.thought).map((part) => part.text).join('');
  }
  if (!Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('invalid_response');
  const choice = body.choices[0];
  if (choice.finish_reason !== 'stop' || choice.message?.refusal || choice.message?.tool_calls?.length || typeof choice.message?.content !== 'string') throw new Error('invalid_response');
  return choice.message.content;
}
function normalizeUsage(protocol, body) {
  const usage = protocol === 'gemini' ? body?.usageMetadata : body?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  const optional = (key) => usage[key] === undefined ? 0 : usage[key];
  let inputTokens, outputTokens, totalTokens;
  if (protocol === 'anthropic') {
    const values = [usage.input_tokens, optional('cache_creation_input_tokens'), optional('cache_read_input_tokens'), usage.output_tokens];
    if (!values.every(count)) return null;
    inputTokens = values[0] + values[1] + values[2];
    outputTokens = values[3]; totalTokens = inputTokens + outputTokens;
  } else if (protocol === 'gemini') {
    const values = [usage.promptTokenCount, optional('toolUsePromptTokenCount'), usage.candidatesTokenCount, optional('thoughtsTokenCount'), usage.totalTokenCount];
    if (!values.every(count)) return null;
    inputTokens = values[0] + values[1]; outputTokens = values[2] + values[3]; totalTokens = values[4];
  } else {
    // Cached prompt tokens and reasoning tokens are already included in these totals.
    inputTokens = usage.prompt_tokens; outputTokens = usage.completion_tokens; totalTokens = usage.total_tokens;
  }
  if (![inputTokens, outputTokens, totalTokens, inputTokens + outputTokens].every(count) || totalTokens < inputTokens + outputTokens) return null;
  return { inputTokens, outputTokens, totalTokens };
}
function createAIClient({ fetchImpl = globalThis.fetch, validateUrl = createPublicHttpsValidator(), onUsage, limits: overrides = {} } = {}) {
  const limits = Object.fromEntries(Object.entries(AI_CLIENT_LIMITS).map(([key, value]) => [key, Number.isInteger(overrides[key]) && overrides[key] > 0 ? Math.min(value, overrides[key]) : value]));
  async function request(config, url, { body, signal, maxBytes = limits.responseBytes } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, limits.timeoutMs);
    const bounded = (work) => new Promise((resolve, reject) => {
      if (controller.signal.aborted) return reject(new Error('timeout'));
      const onAbort = () => reject(new Error('timeout'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(work).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', onAbort));
    });
    let reader;
    try {
      if (!url) return failure('unsafe_endpoint');
      if ((config.provider !== 'ollama' && !config.apiKey) || /[\u0000-\u001f\u007f]/.test(config.apiKey || '')) return failure('not_configured');
      if (!isLocalOllama(config, url) && !await bounded(() => validateUrl(url))) return failure('unsafe_endpoint');
      const response = await bounded(() => fetchImpl(url, { method: body ? 'POST' : 'GET', headers: authHeaders(config), ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', credentials: 'omit', signal: controller.signal }));
      if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) { void response.body?.cancel?.().catch(() => {}); return failure('unsafe_endpoint'); }
      if (!response.ok) {
        void response.body?.cancel?.().catch(() => {});
        return failure([401, 403].includes(response.status) ? 'auth' : [402, 429].includes(response.status) ? 'quota' : [404, 405, 501].includes(response.status) ? 'models_unavailable' : response.status >= 500 ? 'network' : 'invalid_response');
      }
      if (Number(response.headers?.get?.('content-length')) > maxBytes) { void response.body?.cancel?.().catch(() => {}); return failure('response_too_large'); }
      if (!response.body?.getReader) return failure('invalid_response');
      reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      while (true) {
        const chunk = await bounded(() => reader.read());
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error('response_too_large');
        chunks.push(Buffer.from(chunk.value));
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { return failure('invalid_response'); }
      return { ok: true, data, bytes };
    } catch (error) {
      return failure(controller.signal.aborted || error?.message === 'timeout' ? 'timeout' : ['response_too_large', 'invalid_response'].includes(error?.message) ? error.message : 'network');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
      controller.abort();
    }
  }
  async function complete(config, options) {
    if (!config?.model || !options || typeof options.system !== 'string' || typeof options.user !== 'string') return failure('not_configured');
    if (!modelCapabilities(config, config.model).includes('translation')) return failure('unsupported_model');
    const endpoint = endpointFor(config);
    if (!endpoint) return failure('unsafe_endpoint');
    const result = await request(config, endpoint, { body: requestBody(config, options), signal: options.signal, maxBytes: Math.min(options.maxBytes || limits.responseBytes, limits.responseBytes) });
    if (!result.ok) return result;
    // Usage is observational: even a truncated/unusable completion may have been billed.
    // Neither slow observers nor storage failures may delay or change the AI result.
    try { Promise.resolve(onUsage?.({ connectionId: config.id, provider: config.provider, model: config.model, usage: normalizeUsage(config.protocol, result.data) })).catch(() => {}); } catch {}
    try {
      const content = normalizeCompletion(config, result.data);
      return typeof content === 'string' && content.trim() ? { ok: true, content, finishReason: 'stop', bytes: result.bytes } : failure('invalid_response');
    } catch { return failure('invalid_response'); }
  }
  async function discoverModels(config) {
    let url = endpointFor(config, 'models');
    if (!url) return failure('unsafe_endpoint');
    const models = []; const seen = new Set();
    let more = false;
    for (let page = 0; page < limits.maxPages; page += 1) {
      const result = await request(config, url, { maxBytes: limits.modelBytes });
      if (!result.ok) return result;
      const rows = config.provider === 'ollama' || config.protocol === 'gemini' ? result.data.models : result.data.data;
      if (!Array.isArray(rows)) return failure('invalid_response');
      for (const row of rows) {
        const id = config.provider === 'ollama' ? row.name || row.model : config.protocol === 'gemini' ? String(row.name || '').replace(/^models\//, '') : row.id;
        if (typeof id !== 'string' || !id || id.length > 240 || /[\s\u0000-\u001f]/.test(id) || seen.has(id)) continue;
        seen.add(id);
        models.push({ id, name: String(row.displayName || row.display_name || row.name || id).slice(0, 240), capabilities: modelCapabilities(config, id, row), capabilitySource: row.architecture?.output_modalities || row.output_modalities || row.supportedGenerationMethods ? 'metadata' : 'unverified' });
        if (models.length >= limits.maxModels) break;
      }
      const next = config.protocol === 'gemini' ? result.data.nextPageToken : config.protocol === 'anthropic' && result.data.has_more ? result.data.last_id : '';
      more = Boolean(next);
      if (!more || models.length >= limits.maxModels) break;
      if (typeof next !== 'string' || next.length > 2048) return failure('invalid_response');
      const nextUrl = new URL(endpointFor(config, 'models'));
      nextUrl.searchParams.set(config.protocol === 'gemini' ? 'pageToken' : 'after_id', next);
      url = nextUrl.href;
    }
    if (supportsSpeech(config) && !seen.has(SPEECH_MODEL)) models.push({ id: SPEECH_MODEL, name: 'Qwen 实时语音转写（内置适配）', capabilities: ['speech'], manual: true, capabilitySource: 'adapter' });
    return { ok: true, models, ...(more ? { warnings: ['model_list_truncated'] } : {}) };
  }
  return { complete, discoverModels };
}
module.exports = { createAIClient, AI_CLIENT_LIMITS, endpointFor, normalizeCompletion, normalizeUsage };
