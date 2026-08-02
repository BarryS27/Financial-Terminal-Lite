// providers/ai.js — AI Chat integration (localhost-first, zero cloud by default)
// PageAssist features extracted: model config, streaming, conversation history.
// No external backends. User owns their models and data.

import { register } from '../core/registry.js';
import { get, set } from '../core/storage.js';
import { expose, emit } from '../core/bus.js';

const KEY_CONFIG   = 'c.ai.config';
const KEY_HISTORY  = 'c.ai.history';

const DEFAULT_CONFIG = {
  enabled:     true,
  provider:    'ollama',          // 'ollama' | 'openai-compat' | 'custom'
  baseUrl:     'http://127.0.0.1:11434',
  model:       '',                // filled in by user
  apiKey:      '',                // optional, for OpenAI-compat providers
  systemPrompt: 'You are a helpful, concise assistant embedded in a browser extension.',
  maxTokens:   2048,
  temperature: 0.7,
  streamEnabled: true,
};

async function getConfig() {
  return { ...DEFAULT_CONFIG, ...(await get(KEY_CONFIG) || {}) };
}

async function setConfig(patch) {
  const merged = { ...(await getConfig()), ...patch };
  await set(KEY_CONFIG, merged);
  return merged;
}

// ── Model listing ─────────────────────────────────────────────────────────────
async function listModels(config) {
  const cfg = config || await getConfig();
  if (!cfg.enabled) return [];

  try {
    if (cfg.provider === 'ollama') {
      const r = await fetch(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return [];
      const data = await r.json();
      return (data.models || []).map(m => ({ id: m.name, name: m.name, size: m.size }));
    }
    if (cfg.provider === 'openai-compat') {
      const r = await fetch(`${cfg.baseUrl}/v1/models`, {
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return [];
      const data = await r.json();
      return (data.data || []).map(m => ({ id: m.id, name: m.id }));
    }
  } catch {}
  return [];
}

// ── Chat completion (streaming) ───────────────────────────────────────────────
async function* streamChat(messages, config) {
  const cfg = config || await getConfig();
  if (!cfg.enabled || !cfg.model) throw new Error('AI not configured');

  const payload = cfg.provider === 'ollama'
    ? { model: cfg.model, messages, stream: true, options: { temperature: cfg.temperature } }
    : { model: cfg.model, messages, stream: true, max_tokens: cfg.maxTokens, temperature: cfg.temperature };

  const endpoint = cfg.provider === 'ollama'
    ? `${cfg.baseUrl}/api/chat`
    : `${cfg.baseUrl}/v1/chat/completions`;

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const r = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`AI request failed: ${r.status}`);

  const reader = r.body.getReader();
  const dec    = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const stripped = line.startsWith('data: ') ? line.slice(6) : line;
      if (!stripped || stripped === '[DONE]') continue;
      try {
        const json = JSON.parse(stripped);
        // Ollama format
        const content = json.message?.content
          // OpenAI format
          ?? json.choices?.[0]?.delta?.content
          ?? '';
        if (content) yield content;
      } catch {}
    }
  }
}

// ── Conversation history ──────────────────────────────────────────────────────
async function getHistory() { return (await get(KEY_HISTORY)) || []; }

async function addMessage(role, content, conversationId = 'default') {
  const h = await getHistory();
  const entry = { id: `msg_${Date.now()}`, conversationId, role, content, ts: Date.now() };
  h.push(entry);
  // Keep last 200 messages
  if (h.length > 200) h.splice(0, h.length - 200);
  await set(KEY_HISTORY, h);
  return entry;
}

async function getConversation(id = 'default') {
  const h = await getHistory();
  return h.filter(m => m.conversationId === id);
}

async function clearConversation(id = 'default') {
  const h = await getHistory();
  await set(KEY_HISTORY, h.filter(m => m.conversationId !== id));
}

// ── Init ──────────────────────────────────────────────────────────────────────
export { streamChat };

export async function init() {
  register('ai', async (q) => {
    const match = t => !q || t.toLowerCase().includes(q.toLowerCase());
    const cfg = await getConfig();
    const items = [];
    if (match('ai chat assistant model'))
      items.push({ id: 'ai:open-panel', title: 'AI: Open chat panel',
        desc: cfg.model ? `Model: ${cfg.model}` : 'Configure a model to start chatting',
        emoji: '🤖', type: 'action' });
    if (match('ai settings model configure'))
      items.push({ id: 'ai:open-options', title: 'AI: Settings',
        desc: 'Configure models, providers, system prompt', emoji: '⚙️', type: 'action' });
    return items;
  });

  expose('ai', {
    getConfig,
    setConfig,
    listModels:       () => listModels(),
    streamChat,
    getHistory,
    getConversation,
    addMessage,
    clearConversation,
    isAvailable:      async () => {
      const cfg = await getConfig();
      if (!cfg.enabled || !cfg.model) return false;
      try {
        const r = await fetch(cfg.provider === 'ollama'
          ? `${cfg.baseUrl}/api/tags`
          : `${cfg.baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch { return false; }
    },
  });
}

export const handlers = {
  'ai:get-config':     async () => ({ ok: true, config: await getConfig() }),
  'ai:set-config':     async msg => ({ ok: true, config: await setConfig(msg.patch) }),
  'ai:list-models':    async () => ({ ok: true, models: await listModels() }),
  'ai:get-history':    async msg => ({ ok: true, messages: await getConversation(msg.conversationId) }),
  'ai:clear-history':  async msg => { await clearConversation(msg.conversationId); return { ok: true }; },
  'ai:add-message':    async msg => { const m = await addMessage(msg.role, msg.content, msg.conversationId); return { ok: true, message: m }; },
  'ai:open-panel':     async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/ai.html') });
    return { ok: true };
  },
  'ai:open-options':   async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/options.html#ai') });
    return { ok: true };
  },
  // Streaming chat: handled via port connection in background.js
};
