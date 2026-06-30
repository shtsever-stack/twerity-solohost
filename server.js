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

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function nowIso() {
  return new Date().toISOString();
}

function emptyProfile() {
  const now = nowIso();
  return {
    version: '1.0',
    profileType: 'twerity_ai_twin_local_profile',
    createdAt: now,
    updatedAt: now,
    quickStartCompleted: false,
    quickStart: {},
    preferences: {},
    answers: [],
    journal: [],
    memories: [],
    writingSamples: [],
    chatHistory: [],
    readiness: {
      score: 0,
      level: 'Not started',
      next: 'Answer the Quick Start questions to create your light Twin.'
    }
  };
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
  return profile;
}

function saveProfile(profile) {
  profile.updatedAt = nowIso();
  profile.readiness = calculateReadiness(profile);
  fs.writeFileSync(DATA_FILE, JSON.stringify(encryptJson(profile), null, 2));
  return profile;
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
    text: s.slice(0, 500)
  }));
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
  let next = 'Answer the Quick Start questions to create your light Twin.';
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

  if (profile.memories?.length) {
    lines.push('Local memories:');
    profile.memories.slice(-12).forEach(memory => {
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

async function callModel(messages) {
  if (MODEL_PROVIDER !== 'dmr') {
    throw new Error(`Unsupported model provider: ${MODEL_PROVIDER}`);
  }

  const response = await fetch(`${DMR_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DMR_API_KEY}`
    },
    body: JSON.stringify({
      model: DMR_MODEL,
      messages,
      temperature: 0.65,
      max_tokens: 700
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Model error ${response.status}: ${body.slice(0, 300)}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Model returned no content');
  return content.trim();
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

function buildRecentChatMessages(profile) {
  const history = Array.isArray(profile.chatHistory) ? profile.chatHistory.slice(-8) : [];
  const messages = [];
  history.forEach(item => {
    const userText = cleanText(item.message || item.user || item.content, 1200);
    const assistantText = cleanText(item.reply || item.assistant, 1600);
    if (userText) messages.push({ role: 'user', content: userText });
    if (assistantText) messages.push({ role: 'assistant', content: assistantText });
  });
  return messages;
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Twerity Light',
    version: '0.6.0',
    modelProvider: MODEL_PROVIDER,
    model: DMR_MODEL,
    dmrConfigured: Boolean(DMR_URL)
  });
});

app.post('/api/unlock', (req, res) => {
  const provided = cleanText(req.body?.password, 500);
  if (!APP_PASSWORD || provided === APP_PASSWORD) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Invalid local password' });
});

app.get('/api/profile', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    profile.readiness = calculateReadiness(profile);
    res.json({ ok: true, profile, meta: { app: 'Twerity Light', version: '0.6.0', modelProvider: MODEL_PROVIDER, model: DMR_MODEL } });
  } catch (error) {
    res.status(500).json({ error: 'Could not read local profile. Check your LOCAL_MEMORY_KEY.', details: error.message });
  }
});

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
        profile.memories.push(...extractSimpleMemories(`quick_start:${field}`, value, ['quick-start']));
      }
    }

    saveProfile(profile);
    res.json({ ok: true, profile });
  } catch (error) {
    res.status(500).json({ error: 'Could not save Quick Start profile', details: error.message });
  }
});

app.post('/api/answer', requireAuth, (req, res) => {
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

    profile.memories.push(...extractSimpleMemories(`answer:${category}`, `${question} ${answer}`, [category]));
    saveProfile(profile);
    res.json({ ok: true, saved, profile });
  } catch (error) {
    res.status(500).json({ error: 'Could not save answer', details: error.message });
  }
});

app.post('/api/journal', requireAuth, (req, res) => {
  try {
    const profile = loadProfile();
    const entry = cleanText(req.body?.entry, 8000);
    if (!entry) return res.status(400).json({ error: 'Journal entry is required' });

    const saved = { id: crypto.randomUUID(), createdAt: nowIso(), entry };
    profile.journal.push(saved);
    const learned = extractSimpleMemories('journal', entry, ['journal']);
    profile.memories.push(...learned);
    saveProfile(profile);
    res.json({ ok: true, saved, learned, profile });
  } catch (error) {
    res.status(500).json({ error: 'Could not save journal entry', details: error.message });
  }
});

app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const profile = loadProfile();
    const message = cleanText(req.body?.message, 5000);
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const system = [
      'You are Twerity, a private local AI Twin running on the user device through Pi SoloHost.',
      'Your task is to help the user write, reply, explain, and think in their own style.',
      'Use only the local profile context provided below. Do not claim to know private facts that are not in the profile.',
      'Be practical, clear, and useful. If the profile is still weak, say what would improve it.',
      'Local Twin profile:',
      buildProfileSummary(profile) || 'No local profile yet.'
    ].join('\n\n');

    let reply;
    let usedFallback = false;
    try {
      reply = await callModel([
        { role: 'system', content: system },
        ...buildRecentChatMessages(profile),
        { role: 'user', content: message }
      ]);
    } catch (error) {
      usedFallback = true;
      reply = fallbackReply(profile, message, error);
    }

    profile.chatHistory.push({
      id: crypto.randomUUID(),
      createdAt: nowIso(),
      message,
      reply,
      usedFallback
    });
    if (profile.chatHistory.length > 50) profile.chatHistory = profile.chatHistory.slice(-50);
    saveProfile(profile);

    res.json({ ok: true, reply, usedFallback, model: DMR_MODEL, profile });
  } catch (error) {
    res.status(500).json({ error: 'Chat failed', details: error.message });
  }
});

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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Twerity Light running on port ${PORT}`);
  console.log(`Model provider=${MODEL_PROVIDER}, model=${DMR_MODEL}, dmr=${DMR_URL}`);
});
