const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'twin-profile.enc.json');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const LOCAL_MEMORY_KEY = process.env.LOCAL_MEMORY_KEY || '';
const MODEL_PROVIDER = (process.env.TWERITY_MODEL_PROVIDER || 'dmr').toLowerCase();
const DMR_URL = (process.env.TWERITY_DMR_URL || 'http://modelrunner.docker.internal:12434/engines/v1').replace(/\/$/, '');
const DMR_MODEL = process.env.TWERITY_DMR_MODEL || 'ai/gemma3:1B-Q4_K_M';
const DMR_API_KEY = process.env.TWERITY_DMR_API_KEY || 'docker-model-runner';
const APP_VERSION = '0.10.0';

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function nowIso() {
  return new Date().toISOString();
}

function emptyProfile() {
  const now = nowIso();
  return {
    version: '2.0',
    profileType: 'twerity_ai_twin_local_profile',
    createdAt: now,
    updatedAt: now,
    quickStartCompleted: false,
    quickStart: {},
    preferences: { temperature: 0.65, answerLength: 'balanced', model: '', providers: [], activeProviderId: 'dmr' },
    aiQuality: null,
    dailyPrompt: null,
    answers: [],
    journal: [],
    memories: [],
    writingSamples: [],
    sessions: [],
    readiness: {
      score: 0,
      level: 'Not started',
      next: 'Answer the Quick Start questions to create your Twin.'
    }
  };
}

function migrateProfile(profile) {
  if (!Array.isArray(profile.sessions)) profile.sessions = [];
  if (Array.isArray(profile.chatHistory) && profile.chatHistory.length && !profile.sessions.length) {
    const messages = [];
    profile.chatHistory.forEach(item => {
      if (item.message) messages.push({ id: crypto.randomUUID(), role: 'user', content: item.message, ts: item.createdAt || nowIso() });
      if (item.reply) messages.push({ id: crypto.randomUUID(), role: 'assistant', content: item.reply, ts: item.createdAt || nowIso(), usedFallback: Boolean(item.usedFallback) });
    });
    profile.sessions.push({
      id: crypto.randomUUID(),
      title: 'Earlier chat',
      pinned: false,
      createdAt: profile.chatHistory[0]?.createdAt || nowIso(),
      updatedAt: nowIso(),
      messages
    });
  }
  delete profile.chatHistory;
  (profile.memories || []).forEach(m => {
    if (typeof m.pinned !== 'boolean') m.pinned = false;
  });
  if (!profile.preferences || typeof profile.preferences !== 'object') profile.preferences = {};
  if (typeof profile.preferences.temperature !== 'number') profile.preferences.temperature = 0.65;
  if (!['short', 'balanced', 'detailed'].includes(profile.preferences.answerLength)) profile.preferences.answerLength = 'balanced';
  if (typeof profile.preferences.model !== 'string') profile.preferences.model = '';
  if (!Array.isArray(profile.preferences.providers)) profile.preferences.providers = [];
  if (typeof profile.preferences.activeProviderId !== 'string' || !profile.preferences.activeProviderId) {
    profile.preferences.activeProviderId = 'dmr';
  }
  if (profile.aiQuality === undefined) profile.aiQuality = null;
  if (profile.dailyPrompt === undefined) profile.dailyPrompt = null;
  profile.version = '2.0';
  return profile;
}

function keyBytes() {
  const key = LOCAL_MEMORY_KEY || 'unsafe-dev-key-change-me';
  return crypto.createHash('sha256').update(key).digest();
}

function encryptJson(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const payload = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encryption: 'aes-256-gcm',
    createdAt: nowIso(),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptJson(box) {
  const iv = Buffer.from(box.iv, 'base64');
  const tag = Buffer.from(box.tag, 'base64');
  const encrypted = Buffer.from(box.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function loadProfile() {
  if (!fs.existsSync(DATA_FILE)) return emptyProfile();
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const profile = decryptJson(raw);
  if (!profile.version) return emptyProfile();
  return migrateProfile(profile);
}

function saveProfile(profile) {
  profile.updatedAt = nowIso();
  profile.readiness = calculateReadiness(profile);
  fs.writeFileSync(DATA_FILE, JSON.stringify(encryptJson(profile), null, 2));
  return profile;
}

const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// Keep the last few encrypted profile snapshots before risky operations
// (import, bulk feed, memory consolidation).
function snapshotProfile(reason) {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `twin-profile-${stamp}-${reason}.enc.json`));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.enc.json')).sort();
    while (files.length > 5) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (_) { /* snapshots are best effort */ }
}

function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const provided = req.header('x-app-password') || '';
  if (provided === APP_PASSWORD) return next();
  return res.status(401).json({ error: 'Invalid local password' });
}

function cleanText(value, max = 3000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function normalizeMemoryText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9ăâîșț ]/gi, '').replace(/\s+/g, ' ').trim();
}

function pushUniqueMemories(profile, candidates) {
  const existing = new Set((profile.memories || []).map(m => normalizeMemoryText(m.text)));
  const added = [];
  for (const memory of candidates) {
    const key = normalizeMemoryText(memory.text);
    if (!key || key.length < 8 || existing.has(key)) continue;
    existing.add(key);
    profile.memories.push(memory);
    added.push(memory);
  }
  return added;
}

function extractSimpleMemories(source, text, tags = []) {
  const clean = cleanText(text, 4000);
  if (!clean) return [];

  const sentences = clean
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  const priority = sentences.filter(s => {
    const lower = s.toLowerCase();
    return lower.includes('i prefer') ||
      lower.includes('i like') ||
      lower.includes('i avoid') ||
      lower.includes('i build') ||
      lower.includes('my goal') ||
      lower.includes('my priority') ||
      lower.includes('important') ||
      lower.includes('remember') ||
      lower.includes('i want') ||
      lower.includes('i usually') ||
      lower.includes('i am working') ||
      lower.includes('i work');
  });

  const selected = (priority.length ? priority : sentences).slice(0, 4);
  return selected.map(s => ({
    id: crypto.randomUUID(),
    createdAt: nowIso(),
    source,
    tags,
    pinned: false,
    text: s.slice(0, 500)
  }));
}

async function extractModelMemories(source, text, tags = [], opts = {}) {
  const clean = cleanText(text, 3000);
  if (!clean) return [];
  const prompt = [
    'You extract durable personal memory facts for a private AI twin.',
    'From the text below, extract up to 3 short facts about the user that are worth remembering long-term:',
    'preferences, goals, projects, style rules, important context. Skip small talk and temporary details.',
    'Reply ONLY with a JSON array of short strings in the same language as the text. Reply [] if nothing is worth saving.',
    '',
    'Text:',
    clean
  ].join('\n');

  const content = await callModel([
    { role: 'user', content: prompt }
  ], { temperature: 0.1, max_tokens: 240, timeoutMs: 30000, ...opts });

  const match = content.match(/\[[\s\S]*\]/);
  let items = [];
  if (match) {
    try { items = JSON.parse(match[0]); } catch (_) { items = []; }
  }
  if (!items.length) {
    items = content.split('\n')
      .map(l => l.replace(/^[-*\d.)\s"]+/, '').replace(/["\],]+$/, '').trim())
      .filter(l => l.length > 12 && l.length < 400)
      .slice(0, 3);
  }
  return items
    .filter(t => typeof t === 'string')
    .map(t => cleanText(t, 400))
    .filter(Boolean)
    .slice(0, 3)
    .map(t => ({
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      source,
      tags,
      pinned: false,
      text: t
    }));
}

async function learnMemories(profile, source, text, tags = []) {
  let candidates = [];
  try {
    candidates = await extractModelMemories(source, text, tags, modelOptions(profile));
  } catch (_) {
    candidates = [];
  }
  if (!candidates.length) candidates = extractSimpleMemories(source, text, tags);
  return pushUniqueMemories(profile, candidates);
}

function calculateReadiness(profile) {
  const quick = profile.quickStart || {};
  const quickAnswered = Object.values(quick).filter(v => cleanText(v, 20)).length;
  const answers = Array.isArray(profile.answers) ? profile.answers.length : 0;
  const journals = Array.isArray(profile.journal) ? profile.journal.length : 0;
  const samples = Array.isArray(profile.writingSamples) ? profile.writingSamples.length : 0;
  const memories = Array.isArray(profile.memories) ? profile.memories.length : 0;

  let score = 0;
  score += Math.min(35, quickAnswered * 5);
  score += Math.min(20, answers * 3);
  score += Math.min(20, journals * 5);
  score += Math.min(15, samples * 8);
  score += Math.min(10, Math.floor(memories / 3));
  score = Math.max(0, Math.min(100, score));

  let level = 'Not started';
  let next = 'Answer the Quick Start questions to create your Twin.';
  if (score >= 10) {
    level = 'Light Twin';
    next = 'Add deeper answers or one journal entry to improve memory depth.';
  }
  if (score >= 35) {
    level = 'Useful Twin';
    next = 'Add writing samples and difficult-question answers to improve style accuracy.';
  }
  if (score >= 65) {
    level = 'Strong Twin';
    next = 'Keep journaling and add examples of messages that sound like you.';
  }
  if (score >= 90) {
    level = 'Deep Twin';
    next = 'Your Twin has a strong local profile. Export it when you are ready.';
  }

  return { score, level, next, quickAnswered, answers, journals, samples, memories };
}

function buildProfileSummary(profile) {
  const quick = profile.quickStart || {};
  const lines = [];
  const add = (label, value) => {
    const text = cleanText(value, 800);
    if (text) lines.push(`${label}: ${text}`);
  };

  add('Main purpose', quick.helpWith);
  add('Writing style', quick.writingStyle);
  add('Topics', quick.topics);
  add('Answer preference', quick.answerDepth);
  add('Avoid saying', quick.avoidSaying);
  add('Important memory', quick.importantMemory);

  if (profile.writingSamples?.length) {
    lines.push('Writing samples:');
    profile.writingSamples.slice(-3).forEach((sample, i) => {
      lines.push(`Sample ${i + 1}: ${cleanText(sample.text, 700)}`);
    });
  }

  const memories = profile.memories || [];
  const pinned = memories.filter(m => m.pinned);
  const recent = memories.filter(m => !m.pinned).slice(-12);
  if (pinned.length || recent.length) {
    lines.push('Local memories (pinned first):');
    pinned.slice(-20).forEach(memory => {
      lines.push(`- [pinned] ${cleanText(memory.text, 300)}`);
    });
    recent.forEach(memory => {
      lines.push(`- ${cleanText(memory.text, 300)}`);
    });
  }

  if (profile.answers?.length) {
    lines.push('Recent answered questions:');
    profile.answers.slice(-8).forEach(answer => {
      lines.push(`Q: ${cleanText(answer.question, 180)} A: ${cleanText(answer.answer, 350)}`);
    });
  }

  if (profile.journal?.length) {
    lines.push('Recent journal notes:');
    profile.journal.slice(-5).forEach(entry => {
      lines.push(`- ${cleanText(entry.entry, 450)}`);
    });
  }

  return lines.join('\n').slice(0, 12000);
}

// ---------------------------------------------------------------------------
// Model providers — any OpenAI-compatible API (DMR, Ollama, LM Studio,
// OpenRouter, ...). The DMR provider is built in; extra ones live in the
// encrypted profile, including their API keys.
// ---------------------------------------------------------------------------

function builtInProvider() {
  return { id: 'dmr', label: 'Docker Model Runner (local)', baseUrl: DMR_URL, apiKey: DMR_API_KEY, builtIn: true };
}

function listProviders(profile) {
  return [builtInProvider(), ...(profile.preferences?.providers || [])];
}

function activeProvider(profile) {
  const id = profile.preferences?.activeProviderId || 'dmr';
  return listProviders(profile).find(p => p.id === id) || builtInProvider();
}

function isLocalUrl(url) {
  return /localhost|127\.0\.0\.1|host\.docker\.internal|modelrunner\.docker\.internal|:\/\/10\.|:\/\/192\.168\./i.test(String(url || ''));
}

function providerPublic(p) {
  return {
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    builtIn: Boolean(p.builtIn),
    cloud: !isLocalUrl(p.baseUrl),
    hasKey: Boolean(p.apiKey),
    keyHint: p.apiKey ? `…${String(p.apiKey).slice(-4)}` : ''
  };
}

function modelHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  const key = apiKey === undefined ? DMR_API_KEY : apiKey;
  if (key) headers['Authorization'] = `Bearer ${key}`;
  return headers;
}

async function callModel(messages, options = {}) {
  const baseUrl = String(options.baseUrl || DMR_URL).replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 120000);
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: modelHeaders(options.apiKey),
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model || DMR_MODEL,
        messages,
        temperature: options.temperature ?? 0.65,
        max_tokens: options.max_tokens ?? 700
      })
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Model error ${response.status}: ${body.slice(0, 300)}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Model returned no content');
  return content.trim();
}

async function callModelStream(messages, onDelta, signal, options = {}) {
  const baseUrl = String(options.baseUrl || DMR_URL).replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: modelHeaders(options.apiKey),
    signal,
    body: JSON.stringify({
      model: options.model || DMR_MODEL,
      messages,
      temperature: options.temperature ?? 0.65,
      max_tokens: options.max_tokens ?? 900,
      stream: true
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Model error ${response.status}: ${body.slice(0, 300)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return full;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch (_) { /* keep-alive or partial line */ }
    }
  }
  return full;
}

function fallbackReply(profile, userMessage, error) {
  const style = cleanText(profile.quickStart?.writingStyle, 200) || 'direct and practical';
  const purpose = cleanText(profile.quickStart?.helpWith, 200) || 'help you write and think in your own style';
  const memories = profile.memories?.slice(-3).map(m => `- ${m.text}`).join('\n') || '- No strong memories yet.';
  return [
    'Local model is not available yet, so I used the light Twin fallback.',
    '',
    `Your current Twin is meant to ${purpose}.`,
    `Current style signal: ${style}.`,
    '',
    'Useful local memories:',
    memories,
    '',
    `Draft answer: ${cleanText(userMessage, 500)}`,
    '',
    `Technical note: ${error.message || String(error)}`
  ].join('\n');
}

const CHAT_MODES = {
  chat: '',
  reply: 'Task mode REPLY: the user message is a comment or message someone else sent them. Write the reply the user would send, in their voice. Output only the reply text.',
  rewrite: 'Task mode REWRITE: the user message is a draft written by the user. Rewrite it in the user\'s voice, keeping the meaning. Output only the rewritten text.',
  post: 'Task mode POST: write a social media post in the user\'s voice about the topic in the user message. Output only the post.',
  explain: 'Task mode EXPLAIN: explain the topic in the user message the way the user would explain it to their audience.'
};

const LENGTH_INSTRUCTIONS = {
  short: 'Keep answers short and to the point.',
  balanced: '',
  detailed: 'Give thorough, detailed answers when useful.'
};

function chatPrefs(profile) {
  const p = profile.preferences || {};
  const provider = activeProvider(profile);
  const temperature = Math.min(1.2, Math.max(0.1, Number(p.temperature) || 0.65));
  const model = cleanText(p.model, 160) || (provider.id === 'dmr' ? DMR_MODEL : undefined);
  const length = ['short', 'balanced', 'detailed'].includes(p.answerLength) ? p.answerLength : 'balanced';
  const max_tokens = length === 'short' ? 350 : length === 'detailed' ? 1200 : 700;
  return { temperature, model, length, max_tokens, provider, baseUrl: provider.baseUrl, apiKey: provider.apiKey };
}

// Options forwarded to every model call so it hits the active provider.
function modelOptions(profile) {
  const c = chatPrefs(profile);
  return { model: c.model, baseUrl: c.baseUrl, apiKey: c.apiKey };
}

function twinScore(profile) {
  const base = Number(profile.readiness?.score || 0);
  const ai = profile.aiQuality && Number.isFinite(Number(profile.aiQuality.score)) ? Number(profile.aiQuality.score) : null;
  return ai === null ? base : Math.round(0.5 * base + 0.5 * ai);
}

function buildSystemPrompt(profile, mode = 'chat', length = 'balanced') {
  const parts = [
    'You are Twerity, a private local AI Twin running on the user device through Pi SoloHost.',
    'Your task is to help the user write, reply, explain, and think in their own style.',
    'Use only the local profile context provided below. Do not claim to know private facts that are not in the profile.',
    'Be practical, clear, and useful. Format answers with Markdown when it helps (lists, short headings, code blocks).',
    'If the profile is still weak, say what would improve it.'
  ];
  if (CHAT_MODES[mode]) parts.push(CHAT_MODES[mode]);
  if (LENGTH_INSTRUCTIONS[length]) parts.push(LENGTH_INSTRUCTIONS[length]);
  parts.push('Local Twin profile:', buildProfileSummary(profile) || 'No local profile yet.');
  return parts.join('\n\n');
}

function getSession(profile, sessionId) {
  return (profile.sessions || []).find(s => s.id === sessionId) || null;
}

function sessionSummary(session) {
  const last = session.messages[session.messages.length - 1];
  return {
    id: session.id,
    title: session.title,
    pinned: Boolean(session.pinned),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    preview: last ? cleanText(last.content, 120) : ''
  };
}

function buildSessionMessages(session, limit = 10) {
  return session.messages.slice(-limit).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: cleanText(m.content, m.role === 'assistant' ? 1600 : 1200)
  }));
}

// Gemma-family chat templates require strictly alternating user/assistant
// roles starting with user. Merge consecutive same-role messages and drop a
// leading assistant message so the local model never rejects the history.
function normalizeAlternating(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') { out.push({ ...m }); continue; }
    const prev = out[out.length - 1];
    if (!prev || prev.role === 'system') {
      if (m.role === 'assistant') continue;
      out.push({ ...m });
    } else if (prev.role === m.role) {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// Health & status
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Twerity Light',
    version: APP_VERSION,
    modelProvider: MODEL_PROVIDER,
    model: DMR_MODEL,
    dmrConfigured: Boolean(DMR_URL)
  });
});

app.get('/api/status', requireAuth, async (req, res) => {
  const started = Date.now();
  let online = false;
  let detail = '';
  let provider = builtInProvider();
  let model = DMR_MODEL;
  try {
    const profile = loadProfile();
    provider = activeProvider(profile);
    model = chatPrefs(profile).model || '(no model selected)';
  } catch (_) { /* fall back to built-in provider */ }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${String(provider.baseUrl).replace(/\/$/, '')}/models`, { headers: modelHeaders(provider.apiKey), signal: controller.signal });
    clearTimeout(timeout);
    online = response.ok;
    if (!response.ok) detail = `HTTP ${response.status}`;
  } catch (error) {
    detail = error.message || String(error);
  }
  res.json({
    ok: true,
    app: 'Twerity Light',
    version: APP_VERSION,
    modelProvider: provider.id,
    provider: providerPublic(provider),
    model,
    modelOnline: online,
    latencyMs: Date.now() - started,
    detail
  });
});

const unlockFails = new Map();

app.post('/api/unlock', (req, res) => {
  const ip = req.ip || 'local';
  const rec = unlockFails.get(ip) || { count: 0, until: 0 };
  if (rec.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const provided = cleanText(req.body?.password, 500);
  if (!APP_PASSWORD || provided === APP_PASSWORD) {
    unlockFails.delete(ip);
    return res.json({ ok: true });
  }
  rec.count += 1;
  if (rec.count >= 8) {
    rec.until = Date.now() + 5 * 60 * 1000;
    rec.count = 0;
  }
  unlockFails.set(ip, rec);
  return res.status(401).json({ error: 'Invalid local password' });
});

app.get('/api/profile', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    profile.readiness = calculateReadiness(profile);
    const { sessions, ...rest } = profile;
    res.json({
      ok: true,
      profile: { ...rest, twinScore: twinScore(profile), sessions: (sessions || []).map(sessionSummary) },
      meta: {
        app: 'Twerity Light',
        version: APP_VERSION,
        modelProvider: activeProvider(profile).id,
        providerLabel: activeProvider(profile).label,
        model: chatPrefs(profile).model || '(no model selected)'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not read local profile. Check your LOCAL_MEMORY_KEY.', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Quick Start / answers / journal
// ---------------------------------------------------------------------------

app.post('/api/start', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const answers = req.body?.answers || {};
    const fields = ['helpWith', 'writingStyle', 'topics', 'answerDepth', 'avoidSaying', 'writingSample', 'importantMemory'];
    for (const field of fields) {
      profile.quickStart[field] = cleanText(answers[field], 3000);
    }
    profile.quickStartCompleted = true;

    const sample = cleanText(answers.writingSample, 4000);
    if (sample) {
      profile.writingSamples.push({ id: crypto.randomUUID(), createdAt: nowIso(), label: 'Quick Start writing sample', text: sample });
    }

    for (const field of fields) {
      const value = cleanText(answers[field], 3000);
      if (value) {
        profile.answers.push({
          id: crypto.randomUUID(),
          createdAt: nowIso(),
          category: 'Quick Start',
          question: field,
          answer: value
        });
        pushUniqueMemories(profile, extractSimpleMemories(`quick_start:${field}`, value, ['quick-start']));
      }
    }

    saveProfile(profile);
    res.json({ ok: true, profile });
  } catch (error) {
    res.status(500).json({ error: 'Could not save Quick Start profile', details: error.message });
  }
});

app.post('/api/answer', requireAuth, async (req, res) => {
  try {
    const profile = loadProfile();
    const category = cleanText(req.body?.category, 100) || 'Improve Twin';
    const question = cleanText(req.body?.question, 500);
    const answer = cleanText(req.body?.answer, 5000);
    if (!question || !answer) return res.status(400).json({ error: 'Question and answer are required' });

    const saved = { id: crypto.randomUUID(), createdAt: nowIso(), category, question, answer };
    profile.answers.push(saved);

    if (category.toLowerCase().includes('writing')) {
      profile.writingSamples.push({ id: crypto.randomUUID(), createdAt: nowIso(), label: question, text: answer });
    }

    const learned = await learnMemories(profile, `answer:${category}`, `${question} ${answer}`, [category]);
    saveProfile(profile);
    res.json({ ok: true, saved, learned, profile });
  } catch (error) {
    res.status(500).json({ error: 'Could not save answer', details: error.message });
  }
});

app.post('/api/journal', requireAuth, async (req, res) => {
  try {
    const profile = loadProfile();
    const entry = cleanText(req.body?.entry, 8000);
    if (!entry) return res.status(400).json({ error: 'Journal entry is required' });

    const saved = { id: crypto.randomUUID(), createdAt: nowIso(), entry };
    profile.journal.push(saved);
    const learned = await learnMemories(profile, 'journal', entry, ['journal']);
    saveProfile(profile);
    res.json({ ok: true, saved, learned, profile });
  } catch (error) {
    res.status(500).json({ error: 'Could not save journal entry', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

app.get('/api/memories', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    res.json({ ok: true, memories: profile.memories || [] });
  } catch (error) {
    res.status(500).json({ error: 'Could not read memories', details: error.message });
  }
});

app.post('/api/memories', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const text = cleanText(req.body?.text, 500);
    if (!text) return res.status(400).json({ error: 'Memory text is required' });
    const memory = {
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      source: 'manual',
      tags: ['manual'],
      pinned: Boolean(req.body?.pinned),
      text
    };
    const added = pushUniqueMemories(profile, [memory]);
    if (!added.length) return res.status(409).json({ error: 'A very similar memory already exists' });
    saveProfile(profile);
    res.json({ ok: true, memory, memories: profile.memories });
  } catch (error) {
    res.status(500).json({ error: 'Could not save memory', details: error.message });
  }
});

app.patch('/api/memories/:id', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const memory = (profile.memories || []).find(m => m.id === req.params.id);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    if (typeof req.body?.text === 'string') {
      const text = cleanText(req.body.text, 500);
      if (!text) return res.status(400).json({ error: 'Memory text cannot be empty' });
      memory.text = text;
    }
    if (typeof req.body?.pinned === 'boolean') memory.pinned = req.body.pinned;
    memory.updatedAt = nowIso();
    saveProfile(profile);
    res.json({ ok: true, memory, memories: profile.memories });
  } catch (error) {
    res.status(500).json({ error: 'Could not update memory', details: error.message });
  }
});

app.delete('/api/memories/:id', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const before = (profile.memories || []).length;
    profile.memories = (profile.memories || []).filter(m => m.id !== req.params.id);
    if (profile.memories.length === before) return res.status(404).json({ error: 'Memory not found' });
    saveProfile(profile);
    res.json({ ok: true, memories: profile.memories });
  } catch (error) {
    res.status(500).json({ error: 'Could not delete memory', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Chat sessions
// ---------------------------------------------------------------------------

app.get('/api/sessions', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const sessions = (profile.sessions || [])
      .map(sessionSummary)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json({ ok: true, sessions });
  } catch (error) {
    res.status(500).json({ error: 'Could not read sessions', details: error.message });
  }
});

app.post('/api/sessions', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const session = {
      id: crypto.randomUUID(),
      title: cleanText(req.body?.title, 80) || 'New chat',
      pinned: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: []
    };
    profile.sessions.push(session);
    saveProfile(profile);
    res.json({ ok: true, session });
  } catch (error) {
    res.status(500).json({ error: 'Could not create session', details: error.message });
  }
});

app.get('/api/sessions/:id', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const session = getSession(profile, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true, session });
  } catch (error) {
    res.status(500).json({ error: 'Could not read session', details: error.message });
  }
});

app.patch('/api/sessions/:id', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const session = getSession(profile, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (typeof req.body?.title === 'string') {
      const title = cleanText(req.body.title, 80);
      if (title) session.title = title;
    }
    if (typeof req.body?.pinned === 'boolean') session.pinned = req.body.pinned;
    session.updatedAt = nowIso();
    saveProfile(profile);
    res.json({ ok: true, session: sessionSummary(session) });
  } catch (error) {
    res.status(500).json({ error: 'Could not update session', details: error.message });
  }
});

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const before = (profile.sessions || []).length;
    profile.sessions = (profile.sessions || []).filter(s => s.id !== req.params.id);
    if (profile.sessions.length === before) return res.status(404).json({ error: 'Session not found' });
    saveProfile(profile);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not delete session', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------

app.post('/api/chat', requireAuth, async (req, res) => {
  let profile;
  try {
    profile = loadProfile();
  } catch (error) {
    return res.status(500).json({ error: 'Could not read local profile', details: error.message });
  }

  const regenerate = Boolean(req.body?.regenerate);
  const mode = Object.prototype.hasOwnProperty.call(CHAT_MODES, req.body?.mode) ? req.body.mode : 'chat';
  const prefs = chatPrefs(profile);
  if (!prefs.model) {
    return res.status(400).json({ error: `No model selected for "${prefs.provider.label}". Pick one in Settings.` });
  }
  let message = cleanText(req.body?.message, 5000);
  let session = getSession(profile, cleanText(req.body?.sessionId, 80));

  if (!session) {
    session = {
      id: crypto.randomUUID(),
      title: 'New chat',
      pinned: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: []
    };
    profile.sessions.push(session);
  }

  if (regenerate) {
    while (session.messages.length && session.messages[session.messages.length - 1].role === 'assistant') {
      session.messages.pop();
    }
    const lastUser = [...session.messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return res.status(400).json({ error: 'Nothing to regenerate yet' });
    message = lastUser.content;
  } else {
    if (!message) return res.status(400).json({ error: 'Message is required' });
    if (session.title === 'New chat') {
      session.title = message.slice(0, 46) + (message.length > 46 ? '…' : '');
    }
    session.messages.push({ id: crypto.randomUUID(), role: 'user', content: message, ts: nowIso() });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  sseWrite(res, { start: true, sessionId: session.id, title: session.title });

  const upstreamAbort = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      upstreamAbort.abort();
    }
  });

  // History without the user message we just appended (it is sent separately).
  const history = buildSessionMessages(session).slice(0, -1);
  const chatMessages = normalizeAlternating([
    { role: 'system', content: buildSystemPrompt(profile, mode, prefs.length) },
    ...history,
    { role: 'user', content: message }
  ]);

  let reply = '';
  let usedFallback = false;
  try {
    // Accumulate via the callback so a mid-stream abort keeps partial text.
    await callModelStream(chatMessages, (delta) => {
      reply += delta;
      if (!clientGone) sseWrite(res, { delta });
    }, upstreamAbort.signal, { temperature: prefs.temperature, max_tokens: prefs.max_tokens, model: prefs.model, baseUrl: prefs.baseUrl, apiKey: prefs.apiKey });
    if (!reply.trim()) throw new Error('Model returned an empty answer');
  } catch (error) {
    if (!reply.trim() && !clientGone) {
      usedFallback = true;
      reply = fallbackReply(profile, message, error);
      sseWrite(res, { delta: reply });
    }
    // If the client cancelled, keep whatever streamed so far (may be empty).
  }

  if (reply.trim()) {
    session.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: reply,
      ts: nowIso(),
      usedFallback,
      stopped: clientGone || undefined
    });
  }
  if (session.messages.length > 200) session.messages = session.messages.slice(-200);
  session.updatedAt = nowIso();
  saveProfile(profile);

  if (!clientGone) {
    sseWrite(res, {
      done: true,
      sessionId: session.id,
      title: session.title,
      usedFallback,
      model: prefs.model || DMR_MODEL,
      readiness: profile.readiness
    });
    res.end();
  }

  // Learn memories from the user message in the background (best effort).
  if (!usedFallback) {
    setImmediate(async () => {
      try {
        const fresh = loadProfile();
        const added = await learnMemories(fresh, 'chat', message, ['chat']);
        if (added.length) saveProfile(fresh);
      } catch (_) { /* best effort */ }
    });
  }
});

// ---------------------------------------------------------------------------
// Settings & models
// ---------------------------------------------------------------------------

async function fetchProviderModels(provider) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${String(provider.baseUrl).replace(/\/$/, '')}/models`, {
      headers: modelHeaders(provider.apiKey),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    return (json?.data || []).map(m => m.id).filter(Boolean).slice(0, 100);
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/models', requireAuth, async (req, res) => {
  try {
    const profile = loadProfile();
    const requested = cleanText(req.query?.provider, 80);
    const provider = listProviders(profile).find(p => p.id === requested) || activeProvider(profile);
    const fallback = provider.id === 'dmr' ? [DMR_MODEL] : [];
    let models = fallback;
    let detail = '';
    try {
      const found = await fetchProviderModels(provider);
      models = found.length ? found : fallback;
    } catch (error) {
      detail = error.message;
    }
    res.json({
      ok: true,
      provider: providerPublic(provider),
      models,
      defaultModel: provider.id === 'dmr' ? DMR_MODEL : (models[0] || ''),
      detail
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not list models', details: error.message });
  }
});

// Twerity Light is local-only by design: cloud endpoints belong to Twerity.com.
function assertLocalProviderUrl(baseUrl) {
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('Base URL must start with http:// or https://');
  }
  if (!isLocalUrl(baseUrl)) {
    throw new Error('Twerity Light only supports local AI endpoints (Ollama, LM Studio, Docker Model Runner). Cloud models are part of Twerity.com.');
  }
}

app.get('/api/providers', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    res.json({
      ok: true,
      providers: listProviders(profile).map(providerPublic),
      activeProviderId: profile.preferences.activeProviderId || 'dmr'
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not read providers', details: error.message });
  }
});

app.post('/api/providers', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const label = cleanText(req.body?.label, 60);
    const baseUrl = cleanText(req.body?.baseUrl, 300).replace(/\/$/, '');
    const apiKey = cleanText(req.body?.apiKey, 300);
    if (!label || !baseUrl) return res.status(400).json({ error: 'Name and base URL are required' });
    assertLocalProviderUrl(baseUrl);

    const existingId = cleanText(req.body?.id, 80);
    let provider = existingId ? profile.preferences.providers.find(p => p.id === existingId) : null;
    if (provider) {
      provider.label = label;
      provider.baseUrl = baseUrl;
      if (apiKey) provider.apiKey = apiKey;
    } else {
      provider = { id: crypto.randomUUID(), label, baseUrl, apiKey };
      profile.preferences.providers.push(provider);
    }
    saveProfile(profile);
    res.json({ ok: true, provider: providerPublic(provider), providers: listProviders(profile).map(providerPublic) });
  } catch (error) {
    const status = /local AI endpoints|Base URL/.test(error.message) ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});

app.delete('/api/providers/:id', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    if (req.params.id === 'dmr') return res.status(400).json({ error: 'The built-in Docker Model Runner provider cannot be removed' });
    const before = profile.preferences.providers.length;
    profile.preferences.providers = profile.preferences.providers.filter(p => p.id !== req.params.id);
    if (profile.preferences.providers.length === before) return res.status(404).json({ error: 'Provider not found' });
    if (profile.preferences.activeProviderId === req.params.id) {
      profile.preferences.activeProviderId = 'dmr';
      profile.preferences.model = '';
    }
    saveProfile(profile);
    res.json({ ok: true, providers: listProviders(profile).map(providerPublic), activeProviderId: profile.preferences.activeProviderId });
  } catch (error) {
    res.status(500).json({ error: 'Could not delete provider', details: error.message });
  }
});

app.post('/api/providers/test', requireAuth, async (req, res) => {
  try {
    const profile = loadProfile();
    const id = cleanText(req.body?.id, 80);
    const stored = id ? listProviders(profile).find(p => p.id === id) : null;
    const baseUrl = cleanText(req.body?.baseUrl, 300).replace(/\/$/, '') || stored?.baseUrl || '';
    const apiKey = cleanText(req.body?.apiKey, 300) || stored?.apiKey || '';
    if (!baseUrl) return res.status(400).json({ error: 'Base URL is required' });
    assertLocalProviderUrl(baseUrl);
    const started = Date.now();
    const models = await fetchProviderModels({ baseUrl, apiKey });
    res.json({ ok: true, models, count: models.length, latencyMs: Date.now() - started });
  } catch (error) {
    const status = /local AI endpoints|Base URL/.test(error.message) ? 400 : 502;
    res.status(status).json({ error: `Connection failed: ${error.message}` });
  }
});

app.post('/api/settings', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const body = req.body || {};
    if (body.temperature !== undefined) {
      profile.preferences.temperature = Math.min(1.2, Math.max(0.1, Number(body.temperature) || 0.65));
    }
    if (['short', 'balanced', 'detailed'].includes(body.answerLength)) {
      profile.preferences.answerLength = body.answerLength;
    }
    if (typeof body.model === 'string') profile.preferences.model = cleanText(body.model, 160);
    if (typeof body.activeProviderId === 'string' && body.activeProviderId) {
      const exists = listProviders(profile).some(p => p.id === body.activeProviderId);
      if (!exists) return res.status(400).json({ error: 'Unknown provider' });
      if (profile.preferences.activeProviderId !== body.activeProviderId) {
        profile.preferences.activeProviderId = body.activeProviderId;
        if (typeof body.model !== 'string') profile.preferences.model = '';
      }
    }
    saveProfile(profile);
    res.json({ ok: true, preferences: { ...profile.preferences, providers: profile.preferences.providers.map(providerPublic) } });
  } catch (error) {
    res.status(500).json({ error: 'Could not save settings', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// AI quality analysis — is the profile actually specific, or just filled in?
// ---------------------------------------------------------------------------

app.post('/api/analyze', requireAuth, async (req, res) => {
  try {
    const profile = loadProfile();
    const summary = buildProfileSummary(profile);
    if (!summary || summary.length < 200) {
      return res.status(400).json({ error: 'Not enough profile data to analyze yet. Complete Quick Start first.' });
    }
    const prompt = [
      'You are a strict evaluator of an "AI twin" user profile. Judge how well this profile would let an AI imitate this specific user.',
      'Score each dimension 0-100. Be harsh: generic or vague statements that could apply to anyone deserve LOW scores.',
      'Calibration anchors — follow them strictly:',
      '- One-word or filler answers like "nice", "be good", "stuff", "things", "ok" → 5-20.',
      '- Short generic sentences without names, projects or examples → 20-40.',
      '- Concrete but partial: some named projects/preferences, few examples → 40-65.',
      '- Rich and distinctive: named projects, real examples, recognizable phrasing → 65-90.',
      'Dimensions:',
      '- style: is the writing style clearly recognizable from the samples?',
      '- depth: are the answers specific and personal, or vague filler?',
      '- coverage: are topics, decisions and difficult situations covered?',
      '- memories: are the stored memories concrete, useful facts?',
      'Reply ONLY with JSON exactly like:',
      '{"style":50,"styleNote":"short reason","depth":50,"depthNote":"short reason","coverage":50,"coverageNote":"short reason","memories":50,"memoriesNote":"short reason","advice":"one or two concrete improvement suggestions"}',
      '',
      'Profile:',
      summary.slice(0, 6000)
    ].join('\n');

    // Small models drift out of JSON format sometimes; retry once.
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const content = await callModel([{ role: 'user', content: prompt }],
        { temperature: attempt === 0 ? 0.1 : 0, max_tokens: 450, timeoutMs: 150000, ...modelOptions(profile) });
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) continue;
      try { parsed = JSON.parse(match[0]); } catch (_) { parsed = null; }
      if (parsed && !Number.isFinite(Number(parsed.style)) && !Number.isFinite(Number(parsed.depth))) parsed = null;
    }
    if (!parsed) throw new Error('Model did not return a valid analysis. Try again or use a larger model.');
    const clamp = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

    // Objective guards: small local models tend to be far too generous, so
    // measurable signals cap the model's scores for thin profiles.
    const wordCount = t => String(t || '').trim().split(/\s+/).filter(Boolean).length;
    const answerTexts = [
      ...Object.values(profile.quickStart || {}),
      ...(profile.answers || []).map(a => a.answer)
    ].filter(t => cleanText(t, 10));
    const avgAnswerWords = answerTexts.length
      ? answerTexts.reduce((s, t) => s + wordCount(t), 0) / answerTexts.length
      : 0;
    const sampleWords = (profile.writingSamples || []).reduce((s, w) => s + wordCount(w.text), 0);
    const memoryList = profile.memories || [];
    const avgMemoryWords = memoryList.length
      ? memoryList.reduce((s, m) => s + wordCount(m.text), 0) / memoryList.length
      : 0;

    const caps = {
      depth: avgAnswerWords < 4 ? 20 : avgAnswerWords < 8 ? 40 : 100,
      coverage: avgAnswerWords < 4 ? 35 : avgAnswerWords < 8 ? 55 : 100,
      style: sampleWords < 25 ? 30 : sampleWords < 80 ? 55 : 100,
      memories: (memoryList.length < 5 || avgMemoryWords < 4) ? 40 : 100
    };
    const applyCap = (key, value) => Math.min(value, caps[key]);

    // Small models sometimes omit dimensions; missing ones inherit the mean
    // of the returned scores instead of unfairly counting as 0.
    const rawScores = {
      style: Number(parsed.style), depth: Number(parsed.depth),
      coverage: Number(parsed.coverage), memories: Number(parsed.memories)
    };
    const present = Object.values(rawScores).filter(Number.isFinite);
    const meanPresent = present.length ? present.reduce((s, v) => s + v, 0) / present.length : 0;
    const dimScore = key => clamp(Number.isFinite(rawScores[key]) ? rawScores[key] : meanPresent);

    const dimensions = [
      { key: 'style', label: 'Style clarity', score: applyCap('style', dimScore('style')), comment: cleanText(parsed.styleNote, 220) },
      { key: 'depth', label: 'Depth & specificity', score: applyCap('depth', dimScore('depth')), comment: cleanText(parsed.depthNote, 220) },
      { key: 'coverage', label: 'Topic coverage', score: applyCap('coverage', dimScore('coverage')), comment: cleanText(parsed.coverageNote, 220) },
      { key: 'memories', label: 'Memory quality', score: applyCap('memories', dimScore('memories')), comment: cleanText(parsed.memoriesNote, 220) }
    ];
    const score = Math.round(dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length);
    const level = score >= 80 ? 'Sounds like you' : score >= 60 ? 'Getting personal' : score >= 40 ? 'Somewhat generic' : 'Vague profile';

    profile.aiQuality = {
      score,
      level,
      dimensions,
      advice: cleanText(parsed.advice, 400),
      analyzedAt: nowIso(),
      model: chatPrefs(profile).model || DMR_MODEL,
      itemsAtAnalysis: {
        answers: profile.answers.length,
        journals: profile.journal.length,
        samples: profile.writingSamples.length,
        memories: profile.memories.length
      }
    };
    saveProfile(profile);
    res.json({ ok: true, aiQuality: profile.aiQuality, twinScore: twinScore(profile), readiness: profile.readiness });
  } catch (error) {
    res.status(500).json({ error: 'Analysis failed', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Daily journal prompt
// ---------------------------------------------------------------------------

const DAILY_FALLBACK_PROMPTS = [
  'What did you work on today, and what part of it felt most like "you"?',
  'What is one decision you made recently, and why did you decide that way?',
  'What message did you write today that sounded exactly like you? Paste it.',
  'What is something people misunderstood about your work this week?',
  'What would you never say publicly, even if it were true?',
  'What small win are you proud of this week?',
  'What is one strong opinion you hold that most people around you do not?',
  'How did you handle the last piece of criticism you received?',
  'What are you avoiding right now, and why?',
  'If your Twin had to answer one question for you every day, which one should it be?'
];

app.get('/api/daily-prompt', requireAuth, async (req, res) => {
  try {
    const profile = loadProfile();
    const today = new Date().toISOString().slice(0, 10);
    if (profile.dailyPrompt?.date === today && profile.dailyPrompt.text) {
      return res.json({ ok: true, prompt: profile.dailyPrompt.text, cached: true });
    }
    let text = '';
    try {
      text = await callModel([{
        role: 'user',
        content: 'Based on this user profile, write ONE short journal question (max 25 words) that would reveal something new and specific about the user. Use the same language as the profile. Reply with only the question.\n\nProfile:\n' + buildProfileSummary(profile).slice(0, 4000)
      }], { temperature: 0.8, max_tokens: 60, timeoutMs: 25000, ...modelOptions(profile) });
      text = cleanText(text.replace(/^["']+|["']+$/g, ''), 240);
    } catch (_) { text = ''; }
    if (!text) text = DAILY_FALLBACK_PROMPTS[Math.floor(Date.now() / 86400000) % DAILY_FALLBACK_PROMPTS.length];
    profile.dailyPrompt = { date: today, text };
    saveProfile(profile);
    res.json({ ok: true, prompt: text });
  } catch (error) {
    res.status(500).json({ error: 'Could not create daily prompt', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Bulk import of the user's own texts ("Feed your Twin")
// ---------------------------------------------------------------------------

app.post('/api/feed', requireAuth, async (req, res) => {
  try {
    const profile = loadProfile();
    const text = cleanText(req.body?.text, 20000);
    if (!text || text.length < 100) {
      return res.status(400).json({ error: 'Paste at least a few real posts or messages (100+ characters).' });
    }
    snapshotProfile('feed');

    const items = text.split(/\n{2,}/).map(s => s.trim()).filter(s => s.length >= 30).slice(0, 20);
    const samples = (items.length ? items : [text]).map((t, i) => ({
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      label: `Imported text ${i + 1}`,
      text: t.slice(0, 1200)
    }));
    profile.writingSamples.push(...samples);
    if (profile.writingSamples.length > 60) profile.writingSamples = profile.writingSamples.slice(-60);

    let styleSummary = '';
    let learned = [];
    try {
      const subset = samples.map(s => s.text).join('\n---\n').slice(0, 4500);
      const content = await callModel([{
        role: 'user',
        content: 'These are real posts/messages written by one user. 1) Describe their writing style in 2-3 concrete sentences (tone, rhythm, typical phrases). 2) Extract up to 5 short durable facts about them. Reply ONLY with JSON: {"styleSummary":"...","facts":["..."]}\n\nTexts:\n' + subset
      }], { temperature: 0.2, max_tokens: 350, timeoutMs: 120000, ...modelOptions(profile) });
      const match = content.match(/\{[\s\S]*\}/);
      const parsed = match ? JSON.parse(match[0]) : {};
      styleSummary = cleanText(parsed.styleSummary, 500);
      const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
        .filter(f => typeof f === 'string')
        .slice(0, 5)
        .map(f => ({ id: crypto.randomUUID(), createdAt: nowIso(), source: 'feed', tags: ['feed'], pinned: false, text: cleanText(f, 400) }))
        .filter(m => m.text);
      learned = pushUniqueMemories(profile, facts);
      if (styleSummary) {
        learned.unshift(...pushUniqueMemories(profile, [{
          id: crypto.randomUUID(), createdAt: nowIso(), source: 'feed:style', tags: ['style'], pinned: true,
          text: `Writing style: ${styleSummary}`
        }]));
      }
    } catch (_) { /* samples are already saved; distillation is best effort */ }

    saveProfile(profile);
    res.json({ ok: true, importedSamples: samples.length, styleSummary, learned, profile });
  } catch (error) {
    res.status(500).json({ error: 'Import failed', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Style calibration — A/B picks that teach the Twin what "sounds like you"
// ---------------------------------------------------------------------------

app.post('/api/calibrate', requireAuth, async (req, res) => {
  try {
    const profile = loadProfile();
    const base = cleanText(req.body?.text, 400) ||
      'We just released an update that fixes the main bugs and adds a small new feature.';
    const content = await callModel([{
      role: 'user',
      content: 'User profile:\n' + buildProfileSummary(profile).slice(0, 3000) +
        '\n\nRewrite this message in the user\'s probable voice, in two DIFFERENT interpretations: A more direct and minimal, B warmer and more expressive. Use the same language as the profile. Reply ONLY with JSON: {"a":"...","b":"..."}\n\nMessage: ' + base
    }], { temperature: 0.9, max_tokens: 300, timeoutMs: 120000, ...modelOptions(profile) });
    const match = content.match(/\{[\s\S]*\}/);
    let parsed = null;
    try { parsed = match ? JSON.parse(match[0]) : null; } catch (_) { parsed = null; }
    if (!parsed?.a || !parsed?.b) throw new Error('Model did not return two variants. Try again.');
    res.json({ ok: true, base, a: cleanText(parsed.a, 600), b: cleanText(parsed.b, 600) });
  } catch (error) {
    res.status(500).json({ error: 'Calibration failed', details: error.message });
  }
});

app.post('/api/calibrate/choose', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const chosen = cleanText(req.body?.chosen, 600);
    const rejected = cleanText(req.body?.rejected, 600);
    if (!chosen) return res.status(400).json({ error: 'Chosen text is required' });
    profile.writingSamples.push({ id: crypto.randomUUID(), createdAt: nowIso(), label: 'Style calibration pick', text: chosen });
    const learned = pushUniqueMemories(profile, [{
      id: crypto.randomUUID(), createdAt: nowIso(), source: 'calibration', tags: ['style'], pinned: true,
      text: `Style preference: sounds like "${chosen.slice(0, 180)}"${rejected ? ` rather than "${rejected.slice(0, 120)}"` : ''}`
    }]);
    saveProfile(profile);
    res.json({ ok: true, learned, profile });
  } catch (error) {
    res.status(500).json({ error: 'Could not save calibration', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Memory consolidation
// ---------------------------------------------------------------------------

app.post('/api/memories/consolidate', requireAuth, async (req, res) => {
  try {
    const profile = loadProfile();
    const loose = (profile.memories || []).filter(m => !m.pinned);
    if (loose.length < 10) {
      return res.status(400).json({ error: 'Consolidation becomes useful from 10+ unpinned memories.' });
    }
    snapshotProfile('consolidate');

    const texts = loose.map(m => m.text);
    const merged = [];
    for (let i = 0; i < texts.length; i += 20) {
      const batch = texts.slice(i, i + 20);
      const content = await callModel([{
        role: 'user',
        content: 'Merge duplicate or overlapping facts in this list. Keep every distinct fact, combine near-duplicates into one clear sentence, drop empty filler. Keep the same language. Reply ONLY with a JSON array of strings.\n\n' + JSON.stringify(batch, null, 1)
      }], { temperature: 0.1, max_tokens: 700, timeoutMs: 150000, ...modelOptions(profile) });
      const match = content.match(/\[[\s\S]*\]/);
      let arr = null;
      try { arr = match ? JSON.parse(match[0]) : null; } catch (_) { arr = null; }
      if (!Array.isArray(arr) || !arr.length) throw new Error('Model returned an invalid merge result. Original memories kept.');
      merged.push(...arr.filter(t => typeof t === 'string').map(t => cleanText(t, 400)).filter(Boolean));
    }
    if (!merged.length || merged.length > texts.length) {
      throw new Error('Merge result looked wrong. Original memories kept.');
    }

    const pinned = profile.memories.filter(m => m.pinned);
    profile.memories = [
      ...pinned,
      ...merged.map(t => ({ id: crypto.randomUUID(), createdAt: nowIso(), source: 'consolidated', tags: ['consolidated'], pinned: false, text: t }))
    ];
    saveProfile(profile);
    res.json({ ok: true, before: texts.length, after: merged.length, memories: profile.memories });
  } catch (error) {
    res.status(500).json({ error: 'Consolidation failed (original memories kept)', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

app.get('/api/export', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const exportProfile = {
      ...profile,
      exportedAt: nowIso(),
      exportNote: 'Readable local export. Upload manually to Twerity only when you decide.'
    };
    const filename = `twerity-twin-profile-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(exportProfile, null, 2));
  } catch (error) {
    res.status(500).json({ error: 'Could not export profile', details: error.message });
  }
});

app.post('/api/import', requireAuth, (req, res) => {
  try {
    const incoming = req.body?.profile;
    if (!incoming || incoming.profileType !== 'twerity_ai_twin_local_profile') {
      return res.status(400).json({ error: 'This file is not a Twerity Twin profile export' });
    }
    snapshotProfile('import');
    const base = emptyProfile();
    const profile = migrateProfile({
      ...base,
      ...incoming,
      version: '2.0',
      quickStart: incoming.quickStart || {},
      answers: Array.isArray(incoming.answers) ? incoming.answers : [],
      journal: Array.isArray(incoming.journal) ? incoming.journal : [],
      memories: Array.isArray(incoming.memories) ? incoming.memories : [],
      writingSamples: Array.isArray(incoming.writingSamples) ? incoming.writingSamples : [],
      sessions: Array.isArray(incoming.sessions) ? incoming.sessions : [],
      chatHistory: Array.isArray(incoming.chatHistory) ? incoming.chatHistory : undefined
    });
    delete profile.exportedAt;
    delete profile.exportNote;
    saveProfile(profile);
    res.json({ ok: true, readiness: profile.readiness });
  } catch (error) {
    res.status(500).json({ error: 'Could not import profile', details: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Twerity Light ${APP_VERSION} running on port ${PORT}`);
  console.log(`Model provider=${MODEL_PROVIDER}, model=${DMR_MODEL}, dmr=${DMR_URL}`);
});
