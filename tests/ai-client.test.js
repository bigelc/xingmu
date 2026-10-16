const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIClient, normalizeUsage } = require('../ai-client');
const { SPEECH_MODEL } = require('../ai-providers');
const config = (extra = {}) => ({ provider: 'custom', protocol: 'openai', baseUrl: 'https://api.example/v1', model: 'text-model', apiKey: 'test-only-key', ...extra });
const json = (value, options) => new Response(JSON.stringify(value), options);
const openai = (text = 'translated') => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
function harness(response, options = {}) {
  const calls = [], validations = [];
  return { calls, validations, client: createAIClient({
    fetchImpl: async (url, init) => { calls.push({ url, init }); return typeof response === 'function' ? response(url, init) : json(response); },
    validateUrl: async (url) => { validations.push(url); return options.deny ? null : new URL(url); },
    limits: options.limits,
  }) };
}

test('text requests use the selected protocol, credential header and completed response', async () => {
  const examples = [
    { protocol: 'openai', response: openai(), suffix: '/chat/completions', header: 'Authorization', value: 'Bearer test-only-key' },
    { protocol: 'anthropic', response: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'translated' }] }, suffix: '/messages', header: 'x-api-key', value: 'test-only-key' },
    { protocol: 'gemini', response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'private', thought: true }, { text: 'translated' }] } }] }, suffix: '/models/text-model:generateContent', header: 'x-goog-api-key', value: 'test-only-key' },
  ];
  for (const example of examples) {
    const h = harness(example.response);
    const result = await h.client.complete(config({ protocol: example.protocol }), { system: 'system text', user: 'article text', json: true, maxTokens: 700 });
    assert.equal(result.content, 'translated'); assert.equal(result.finishReason, 'stop');
    const { url, init } = h.calls[0];
    assert.equal(url, `https://api.example/v1${example.suffix}`);
    assert.equal(init.headers[example.header], example.value);
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.doesNotMatch(url, /test-only-key/);
    const body = JSON.parse(init.body);
    assert.ok(init.body.includes('article text') && init.body.includes('system text'));
    assert.equal(body.max_tokens || body.generationConfig?.maxOutputTokens, 700);
    if (example.protocol !== 'openai') assert.equal(init.headers.Authorization, undefined);
  }
});

test('refusal, tool calls, truncated completion and malformed text cannot become a successful translation', async () => {
  for (const [protocol, body] of [
    ['openai', { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }],
    ['openai', { choices: [{ finish_reason: 'stop', message: { content: 'partial', tool_calls: [{}] } }] }],
    ['anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] }],
    ['anthropic', { stop_reason: 'end_turn', content: [{ type: 'tool_use', input: {} }] }],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] }],
  ]) assert.equal((await harness(body).client.complete(config({ protocol }), { system: '', user: 'text' })).error, 'invalid_response');
});

test('Qwen hybrid models use non-thinking non-streaming requests without an incompatible JSON mode', async () => {
  for (const model of ['qwen-plus', 'qwen-turbo', 'qwen3-32b']) {
    const h = harness(openai('{"segments":[]}'));
    const result = await h.client.complete(config({ provider: 'qwen', model, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', region: 'beijing' }), { system: 'Return JSON.', user: 'Text to translate', json: true });
    assert.equal(result.ok, true, model);
    const body = JSON.parse(h.calls[0].init.body);
    assert.equal(body.stream, false);
    assert.equal(body.enable_thinking, false, model);
    assert.equal(body.response_format, undefined, 'JSON output is requested by the prompt without assuming every Qwen model accepts JSON mode');
    assert.equal(h.calls.length, 1);
  }
  for (const model of ['qwen3-235b-a22b-thinking-2507', 'qwen3.7-plus']) {
    const h = harness(openai());
    const result = await h.client.complete(config({ provider: 'qwen', model, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }), { system: '', user: 'Text to translate' });
    assert.equal(result.error, 'unsupported_model', model);
    assert.equal(h.calls.length, 0, 'Thinking-only models must not produce an unsupported paid request');
  }
});

test('compatible gateways receive portable JSON prompts without provider-specific JSON or thinking flags', async () => {
  for (const provider of ['custom', 'minimax', 'volc', 'moonshot', 'zhipu', 'openrouter']) {
    const h = harness(openai('{"segments":[]}'));
    const result = await h.client.complete(config({ provider }), { system: 'Return JSON.', user: 'Text to translate', json: true });
    assert.equal(result.ok, true, provider);
    const body = JSON.parse(h.calls[0].init.body);
    assert.equal(body.response_format, undefined, provider);
    assert.equal(body.enable_thinking, undefined, provider);
    assert.equal(body.thinking, undefined, provider);
    assert.equal(body.messages[0].content, 'Return JSON.');
  }
});

test('model discovery lists candidates without inferring ASR or image generation as text support', async () => {
  const ids = ['text-model', SPEECH_MODEL, 'gpt-image-1', 'seedream-4', 'cogview-4', 'music-generation', 'text-embedding-3-small'];
  const h = harness({ data: [...ids.map(id => ({ id })), { id: 'metadata-image', output_modalities: ['image'] }] });
  const result = await h.client.discoverModels(config());
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.find(m => m.id === 'text-model').capabilities, ['translation', 'naming']);
  assert.equal(result.models.find(m => m.id === 'text-model').capabilitySource, 'unverified');
  for (const model of result.models.filter(m => m.id !== 'text-model')) assert.deepEqual(model.capabilities, [], model.id);
  assert.equal(h.calls[0].init.method, 'GET'); assert.equal(h.calls[0].init.body, undefined);
  const qwen = await harness({ data: [{ id: 'qwen-plus' }] }).client.discoverModels(config({ provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', region: 'beijing' }));
  assert.equal(qwen.models.find(m => m.id === SPEECH_MODEL).capabilitySource, 'adapter');
});

test('Gemini and Anthropic pagination stays on the configured endpoint and deduplicates models', async () => {
  for (const protocol of ['gemini', 'anthropic']) {
    let page = 0;
    const h = harness(() => {
      page++;
      if (protocol === 'gemini') return json({ models: [{ name: 'models/text-model', supportedGenerationMethods: ['generateContent'] }], ...(page === 1 ? { nextPageToken: 'https://attacker.example/steal' } : {}) });
      return json({ data: [{ id: 'text-model' }], has_more: page === 1, last_id: 'https://attacker.example/steal' });
    });
    const result = await h.client.discoverModels(config({ protocol }));
    assert.equal(result.models.length, 1); assert.equal(h.calls.length, 2);
    assert.equal(new URL(h.calls[1].url).origin, 'https://api.example');
    assert.equal(new URL(h.calls[1].url).pathname, '/v1/models');
  }
});

test('private destinations, redirected credentials and missing keys fail before unsafe work', async () => {
  const denied = harness(openai(), { deny: true });
  assert.equal((await denied.client.complete(config(), { system: '', user: 'text' })).error, 'unsafe_endpoint');
  assert.equal(denied.calls.length, 0);
  const missing = harness(openai());
  assert.equal((await missing.client.discoverModels(config({ apiKey: '' }))).error, 'not_configured');
  assert.equal(missing.calls.length, 0);
  const redirect = harness(() => new Response(null, { status: 302, headers: { Location: 'https://attacker.example' } }));
  assert.equal((await redirect.client.complete(config(), { system: '', user: 'text' })).error, 'unsafe_endpoint');
  assert.equal(redirect.calls.length, 1, 'No authenticated redirect is followed');
  const auth = harness(() => new Response(null, { status: 401 }));
  assert.equal((await auth.client.discoverModels(config())).error, 'auth');
  assert.equal(auth.calls.length, 1, 'Auth failures do not silently retry another provider');
});

test('only an explicit local Ollama connection may bypass public HTTPS validation', async () => {
  const local = harness({ models: [{ name: 'local-text' }] }, { deny: true });
  const result = await local.client.discoverModels(config({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '' }));
  assert.equal(result.ok, true); assert.equal(local.calls[0].url, 'http://127.0.0.1:11434/api/tags');
  assert.equal(local.calls[0].init.headers.Authorization, undefined); assert.equal(local.validations.length, 0);
  for (const extra of [{ provider: 'custom', baseUrl: 'http://127.0.0.1:11434' }, { provider: 'ollama', baseUrl: 'http://192.168.1.2:11434' }, { provider: 'ollama', baseUrl: 'https://private.example' }]) {
    const h = harness({ models: [] }, { deny: true });
    assert.equal((await h.client.discoverModels(config(extra))).error, 'unsafe_endpoint'); assert.equal(h.calls.length, 0);
  }
});

test('size and time limits apply to response streams and stalled validation', async () => {
  const large = harness(openai('x'.repeat(1024)), { limits: { responseBytes: 64 } });
  assert.equal((await large.client.complete(config(), { system: '', user: 'text' })).error, 'response_too_large');
  const slow = createAIClient({ validateUrl: () => new Promise(() => {}), fetchImpl: () => { throw Error('must not fetch'); }, limits: { timeoutMs: 10 } });
  assert.equal((await slow.complete(config(), { system: '', user: 'text' })).error, 'timeout');
});

test('provider-reported usage includes billable cache and thinking counts without double counting subsets', () => {
  assert.deepEqual(normalizeUsage('openai', { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } }), { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  assert.deepEqual(normalizeUsage('anthropic', { usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 13, cache_read_input_tokens: 5 } }), { inputTokens: 29, outputTokens: 7, totalTokens: 36 });
  assert.deepEqual(normalizeUsage('gemini', { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 28, toolUsePromptTokenCount: 4, thoughtsTokenCount: 6, cachedContentTokenCount: 5 } }), { inputTokens: 15, outputTokens: 13, totalTokens: 28 });
  assert.deepEqual(normalizeUsage('openai', { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, 'An explicitly reported zero remains different from an unknown count');
  for (const value of [{}, { usage: null }, { usage: { prompt_tokens: 11, completion_tokens: 7 } }, { usage: { prompt_tokens: '11', completion_tokens: 7, total_tokens: 18 } }, { usage: { prompt_tokens: -1, completion_tokens: 7, total_tokens: 6 } }, { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 7, total_tokens: Number.MAX_SAFE_INTEGER + 7 } }]) {
    assert.equal(normalizeUsage('openai', value), null, 'Missing or malformed usage must not be rendered as zero');
  }
});

test('usage observes completed model requests once even when text validation fails, but not model discovery', async () => {
  const observations = [];
  let response = { ...openai(), usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } };
  const client = createAIClient({ validateUrl: async url => new URL(url), fetchImpl: async () => json(response), onUsage: value => observations.push(value) });
  const selected = config({ id: 'recorded-connection' });
  assert.equal((await client.complete(selected, { system: 'private prompt', user: 'private article' })).ok, true);
  assert.deepEqual(observations, [{ connectionId: 'recorded-connection', provider: 'custom', model: 'text-model', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }]);
  assert.doesNotMatch(JSON.stringify(observations), /test-only-key|private prompt|private article/);
  response = { choices: [{ finish_reason: 'length', message: { content: 'incomplete' } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
  assert.equal((await client.complete(selected, { system: '', user: 'text' })).error, 'invalid_response');
  assert.equal(observations.length, 2, 'An already billed response is still counted when output is unusable');
  response = openai();
  assert.equal((await client.complete(selected, { system: '', user: 'text' })).ok, true);
  assert.equal(observations.at(-1).usage, null);
  response = { data: [{ id: 'text-model' }] };
  assert.equal((await client.discoverModels(selected)).ok, true);
  assert.equal(observations.length, 3, 'Listing models is not a completion usage event');
});

test('a throwing, rejected or unfinished usage observer cannot fail or delay the model result', { timeout: 1000 }, async () => {
  for (const onUsage of [() => { throw Error('ledger unavailable'); }, () => Promise.reject(Error('ledger unavailable')), () => new Promise(() => {})]) {
    const client = createAIClient({ validateUrl: async url => new URL(url), fetchImpl: async () => json(openai()), onUsage });
    assert.equal((await client.complete(config({ id: 'local-test' }), { system: '', user: 'text' })).content, 'translated');
  }
  await new Promise(resolve => setImmediate(resolve));
});
