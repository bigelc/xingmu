// Presets are API entry points, not claims that every model supports every task.
const PROVIDERS = Object.freeze([
  ['deepseek', 'DeepSeek', '国内供应商', 'openai', 'https://api.deepseek.com'],
  ['volc', '豆包 · 火山方舟', '国内供应商', 'openai', 'https://ark.cn-beijing.volces.com/api/v3'],
  ['qwen', '千问 · 阿里云百炼', '国内供应商', 'openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['moonshot', 'Kimi · 月之暗面', '国内供应商', 'openai', 'https://api.moonshot.cn/v1'],
  ['zhipu', 'GLM · 智谱', '国内供应商', 'openai', 'https://open.bigmodel.cn/api/paas/v4'],
  ['minimax', 'MiniMax', '国内供应商', 'openai', 'https://api.minimax.cn/v1'],
  ['openai', 'GPT · OpenAI', '海外供应商', 'openai', 'https://api.openai.com/v1'],
  ['anthropic', 'Claude · Anthropic', '海外供应商', 'anthropic', 'https://api.anthropic.com/v1'],
  ['gemini', 'Gemini · Google', '海外供应商', 'gemini', 'https://generativelanguage.googleapis.com/v1beta'],
  ['siliconflow', '硅基流动 · SiliconFlow', '聚合平台', 'openai', 'https://api.siliconflow.cn/v1'],
  ['openrouter', 'OpenRouter', '聚合平台', 'openai', 'https://openrouter.ai/api/v1'],
  ['ollama', 'Ollama / 自托管', '本地与自定义', 'openai', 'http://localhost:11434'],
  ['custom', '自定义兼容接口', '本地与自定义', 'openai', ''],
].map(([id, name, group, protocol, defaultBaseUrl]) => Object.freeze({
  id, name, group, protocol, defaultBaseUrl, requiresApiKey: id !== 'ollama', supportsSpeech: id === 'qwen',
  ...(id === 'qwen' ? { regions: [{ id: 'beijing', name: '北京' }, { id: 'singapore', name: '新加坡' }] } : {}),
})));
const SPEECH_MODEL = 'qwen3-asr-flash-realtime';
const TEXT_TASKS = ['translation', 'naming'];
function qwenBaseUrl(region = 'beijing', workspaceId = '') {
  const host = workspaceId ? `${workspaceId}.${region === 'singapore' ? 'ap-southeast-1' : 'cn-beijing'}.maas.aliyuncs.com`
    : region === 'singapore' ? 'dashscope-intl.aliyuncs.com' : 'dashscope.aliyuncs.com';
  return `https://${host}/compatible-mode/v1`;
}
function normalizeConnection(input) {
  if (!input || typeof input !== 'object') throw new Error('invalid_connection');
  const provider = PROVIDERS.find((item) => item.id === input.provider);
  if (!provider) throw new Error('invalid_provider');
  const id = typeof input.id === 'string' ? input.id : '';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('invalid_connection');
  const protocol = input.protocol || provider.protocol;
  if (!['openai', 'anthropic', 'gemini'].includes(protocol) || (provider.id !== 'custom' && protocol !== provider.protocol)) throw new Error('invalid_protocol');
  const region = provider.id === 'qwen' ? (input.region || 'beijing') : '';
  if (region && !['beijing', 'singapore'].includes(region)) throw new Error('invalid_region');
  const workspaceId = provider.id === 'qwen' ? String(input.workspaceId || '').trim() : '';
  if (!/^[A-Za-z0-9_-]{0,128}$/.test(workspaceId)) throw new Error('invalid_workspace');
  const raw = String(input.baseUrl || (provider.id === 'qwen' ? qwenBaseUrl(region, workspaceId) : provider.defaultBaseUrl)).trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('unsafe_endpoint'); }
  if (raw.length > 4096 || url.username || url.password || url.search || url.hash) throw new Error('unsafe_endpoint');
  const local = provider.id === 'ollama' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('unsafe_endpoint');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|messages)$/, '');
  return { id, provider: provider.id, protocol, baseUrl: url.href.replace(/\/$/, ''), region, workspaceId };
}
function connectionIdentity(config) {
  return JSON.stringify([config.provider, config.baseUrl, config.protocol, config.region || '', config.workspaceId || '']);
}
function isLocalOllama(config, endpoint) {
  try {
    const base = new URL(config.baseUrl); const url = new URL(endpoint);
    return config.provider === 'ollama' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      && ['http:', 'https:'].includes(base.protocol) && base.origin === url.origin && !url.username && !url.password;
  } catch { return false; }
}
function supportsSpeech(config) {
  return config.provider === 'qwen' && config.protocol === 'openai' && config.baseUrl === qwenBaseUrl(config.region, config.workspaceId);
}
function modelCapabilities(config, id, metadata = {}) {
  if (id === SPEECH_MODEL) return supportsSpeech(config) ? ['speech'] : [];
  // This adapter consumes a completed response. These Bailian models require
  // thinking/streaming and cannot be made non-thinking by a generic toggle.
  if (config.provider === 'qwen' && /(?:thinking|^qwen3\.7-plus(?:-|$))/i.test(id)) return [];
  const output = metadata.architecture?.output_modalities || metadata.output_modalities;
  const methods = metadata.supportedGenerationMethods;
  if (Array.isArray(output) && !output.includes('text')) return [];
  if (Array.isArray(methods) && !methods.includes('generateContent')) return [];
  if (/(?:embed|rerank|whisper|tts|transcri|realtime|asr|dall-e|stable-diffusion|flux|imagen|veo|sora|gpt-image|seedream|cogview|music|hunyuan-video|wan[.-]?\d|hailuo)/i.test(id)) return [];
  return [...TEXT_TASKS];
}
module.exports = { PROVIDERS, SPEECH_MODEL, TEXT_TASKS, qwenBaseUrl, normalizeConnection, connectionIdentity, isLocalOllama, supportsSpeech, modelCapabilities };
