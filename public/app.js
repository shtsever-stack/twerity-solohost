const qs = (id) => document.getElementById(id);
let localPassword = sessionStorage.getItem('twerityLocalPassword') || '';
let profile = null;
let meta = null;
let sending = false;
let quickIndex = 0;
let trainingIndex = 0;
const quickDraft = {};

const quickStartSteps = [
  {
    key: 'helpWith',
    title: 'What should your AI Twin help you with?',
    help: 'Example: write posts, reply to comments, explain projects, brainstorm ideas.'
  },
  {
    key: 'writingStyle',
    title: 'How would you describe your writing style?',
    help: 'Example: direct, practical, simple, friendly, technical, casual.'
  },
  {
    key: 'topics',
    title: 'What topics do you usually talk about?',
    help: 'Example: Pi Network, apps, games, AI, community, support, business.'
  },
  {
    key: 'answerDepth',
    title: 'Do you prefer short answers or detailed explanations?',
    help: 'Example: short first, then details only when needed.'
  },
  {
    key: 'avoidSaying',
    title: 'What should your Twin avoid saying?',
    help: 'Example: avoid hype, fake promises, complicated language, or too much corporate tone.'
  },
  {
    key: 'writingSample',
    title: 'Paste one message written by you.',
    help: 'A real message helps the Twin learn your sentence rhythm and tone.'
  },
  {
    key: 'importantMemory',
    title: 'What is one important thing your Twin should remember?',
    help: 'Example: my main priority is real utility, not hype.'
  }
];

const questionBank = [
  { category: 'Basic profile', question: 'What are you building right now, and why does it matter?' },
  { category: 'Basic profile', question: 'What are your main goals for the next few months?' },
  { category: 'Basic profile', question: 'What kind of people do you usually speak to?' },
  { category: 'Basic profile', question: 'What topics should your Twin know well?' },
  { category: 'Basic profile', question: 'What should your Twin always remember about your work?' },
  { category: 'Writing style', question: 'Paste a message that sounds like you and explain why.' },
  { category: 'Writing style', question: 'Paste a message that does not sound like you and explain why.' },
  { category: 'Writing style', question: 'How do you usually write announcements?' },
  { category: 'Writing style', question: 'What phrases do you use often?' },
  { category: 'Writing style', question: 'What phrases should your Twin avoid?' },
  { category: 'Writing style', question: 'How should your Twin rewrite overcomplicated text?' },
  { category: 'Difficult questions', question: 'How do you respond when someone criticizes your work?' },
  { category: 'Difficult questions', question: 'How do you explain a project when people are skeptical?' },
  { category: 'Difficult questions', question: 'What do people often misunderstand about your work?' },
  { category: 'Difficult questions', question: 'How should your Twin handle conflict?' },
  { category: 'Difficult questions', question: 'How should your Twin answer when it is not sure?' },
  { category: 'Decision making', question: 'How do you usually decide what to build next?' },
  { category: 'Decision making', question: 'What makes an idea worth your time?' },
  { category: 'Decision making', question: 'What kind of risks do you accept?' },
  { category: 'Decision making', question: 'What kind of promises should your Twin never make?' },
  { category: 'Decision making', question: 'How do you balance speed and quality?' },
  { category: 'Social replies', question: 'How should your Twin reply to a normal user asking for help?' },
  { category: 'Social replies', question: 'How should your Twin reply to a negative comment?' },
  { category: 'Social replies', question: 'How should your Twin reply when someone misunderstands your app?' },
  { category: 'Social replies', question: 'How should your Twin invite people to try a product?' },
  { category: 'Social replies', question: 'How should your Twin ask for feedback?' }
];

function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (localPassword) headers['x-app-password'] = localPassword;
  return fetch(path, { ...options, headers }).then(async (res) => {
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data.error || data.details || data || `HTTP ${res.status}`);
    return data;
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setMessage(id, text, type = '') {
  const el = qs(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = `message ${type}`;
}

function quickComplete() {
  return Boolean(profile?.quickStartCompleted || (profile?.readiness?.quickAnswered || 0) >= 5);
}

function exportUnlocked() {
  return quickComplete() && Number(profile?.readiness?.score || 0) >= 15;
}

function canAccess(tab) {
  if (tab === 'overview') return true;
  if (tab === 'start') return !quickComplete();
  if (tab === 'export') return exportUnlocked();
  return quickComplete();
}

function setTab(name) {
  if (!canAccess(name)) name = quickComplete() ? 'overview' : 'start';
  document.querySelectorAll('.tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
  const panel = qs(`tab-${name}`);
  if (panel) panel.classList.add('active');
  if (name === 'ask') scrollChatToBottom();
}

function updateGates() {
  document.querySelectorAll('.tab').forEach(btn => {
    const tab = btn.dataset.tab;
    btn.classList.toggle('hidden', !canAccess(tab));
  });
  document.querySelectorAll('.gated-panel').forEach(panel => {
    const tab = panel.id.replace('tab-', '');
    panel.classList.toggle('hidden', !canAccess(tab));
  });
}

function renderProfile() {
  if (!profile) return;
  const r = profile.readiness || {};
  const score = Number(r.score || 0);
  qs('readinessScore').textContent = `${score}%`;
  qs('readinessScoreMini').textContent = `${score}%`;
  qs('readinessBar').style.width = `${score}%`;
  qs('readinessLevel').textContent = r.level || 'Not started';
  qs('readinessNext').textContent = r.next || '';
  qs('modelName').textContent = meta?.model ? meta.model : 'Docker Model Runner';

  qs('metricAnswers').textContent = String((profile.answers || []).length);
  qs('metricJournal').textContent = String((profile.journal || []).length);
  qs('metricMemories').textContent = String((profile.memories || []).length);
  qs('metricChats').textContent = String((profile.chatHistory || []).length);

  Object.assign(quickDraft, profile.quickStart || {}, quickDraft);
  renderQuickStart();
  renderTrainingQuestion();
  renderMemories();
  renderUnlockPath();
  renderNextAction();
  renderChatHistory();
  updateGates();
}

function renderUnlockPath() {
  const root = qs('unlockPath');
  if (!root) return;
  const steps = quickComplete()
    ? [
        { title: 'Improve Twin', body: 'Answer deeper questions to refine style, priorities and replies.', done: (profile?.answers || []).length > 7, current: (profile?.answers || []).length <= 7 },
        { title: 'Private Journal', body: 'Add real context and local memories when you want.', done: (profile?.journal || []).length > 0, current: !(profile?.journal || []).length },
        { title: 'Export Profile', body: 'Download manually when your profile is useful.', done: exportUnlocked(), current: !exportUnlocked() }
      ]
    : [
        { title: 'Start Twin', body: 'Answer the focused Quick Start flow.', done: false, current: true },
        { title: 'Improve Twin', body: 'Unlock deeper questions after Quick Start.', done: false, current: false },
        { title: 'Private Journal', body: 'Add real context and local memories.', done: false, current: false },
        { title: 'Export Profile', body: 'Download manually when your profile is useful.', done: false, current: false }
      ];
  root.innerHTML = steps.map((s, i) => `
    <div class="unlock-step ${s.done ? 'done' : ''} ${s.current ? 'current' : ''}">
      <div class="badge">${s.done ? '✓' : i + 1}</div>
      <div><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.body)}</span></div>
    </div>
  `).join('');
}

function renderNextAction() {
  const title = qs('nextActionTitle');
  const text = qs('nextActionText');
  const btn = qs('nextActionBtn');
  if (!quickComplete()) {
    title.textContent = 'Create your Twerity Light Twin';
    text.textContent = 'Answer a short sequence of focused questions. You get value immediately after the first setup.';
    btn.textContent = 'Start now';
    btn.dataset.target = 'start';
    return;
  }
  if ((profile?.answers || []).length < 12) {
    title.textContent = 'Make it sound more like you';
    text.textContent = 'Add deeper answers about style, criticism, decisions and social replies.';
    btn.textContent = 'Improve Twin';
    btn.dataset.target = 'improve';
    return;
  }
  if (!(profile?.journal || []).length) {
    title.textContent = 'Add real context with Journal';
    text.textContent = 'Journal entries help your Twin understand what you are working on and how you think.';
    btn.textContent = 'Open Journal';
    btn.dataset.target = 'journal';
    return;
  }
  title.textContent = 'Test your Twin';
  text.textContent = 'Ask it to write, reply or explain something in your own style.';
  btn.textContent = 'Ask Twin';
  btn.dataset.target = 'ask';
}

function renderMemories() {
  const memoryList = qs('memoryList');
  if (!memoryList) return;
  const memories = (profile?.memories || []).slice(-8).reverse();
  memoryList.innerHTML = memories.length
    ? memories.map(m => `<div class="memory-item">${escapeHtml(m.text)}</div>`).join('')
    : '<p class="muted">No memories yet. Start with the first focused question.</p>';
}

function renderQuickStart() {
  const step = quickStartSteps[quickIndex];
  qs('quickStartPill').textContent = `Question ${quickIndex + 1}/${quickStartSteps.length}`;
  qs('quickStartStepLabel').textContent = `Step ${quickIndex + 1}`;
  qs('quickStartQuestion').textContent = step.title;
  qs('quickStartHelp').textContent = step.help;
  qs('quickStartAnswer').value = quickDraft[step.key] || '';
  qs('quickPrev').disabled = quickIndex === 0;
  qs('quickNext').classList.toggle('hidden', quickIndex === quickStartSteps.length - 1);
  qs('saveQuickStart').classList.toggle('hidden', quickIndex !== quickStartSteps.length - 1);
  qs('quickStartDots').innerHTML = quickStartSteps.map((_, i) => `<div class="wizard-dot ${i < quickIndex ? 'done' : ''} ${i === quickIndex ? 'active' : ''}"></div>`).join('');
}

function persistCurrentQuickAnswer() {
  const step = quickStartSteps[quickIndex];
  quickDraft[step.key] = qs('quickStartAnswer').value;
}

function moveQuick(delta) {
  persistCurrentQuickAnswer();
  quickIndex = Math.max(0, Math.min(quickStartSteps.length - 1, quickIndex + delta));
  renderQuickStart();
  qs('quickStartAnswer').focus();
}

function findNextTrainingIndex() {
  const answered = new Set((profile?.answers || []).map(a => `${a.category}::${a.question}`));
  const idx = questionBank.findIndex(q => !answered.has(`${q.category}::${q.question}`));
  return idx >= 0 ? idx : ((profile?.answers || []).length % questionBank.length);
}

function renderTrainingQuestion() {
  trainingIndex = Math.max(0, Math.min(trainingIndex, questionBank.length - 1));
  if (!questionBank[trainingIndex] || !profile) trainingIndex = findNextTrainingIndex();
  const item = questionBank[trainingIndex] || questionBank[0];
  qs('trainingCategory').textContent = item.category;
  qs('trainingQuestion').textContent = item.question;
  qs('trainingCounter').textContent = `${(profile?.answers || []).filter(a => a.category !== 'Quick Start').length} deeper answers saved`;
}

function nextTrainingQuestion(random = false) {
  if (random) {
    trainingIndex = Math.floor(Math.random() * questionBank.length);
  } else {
    trainingIndex = (trainingIndex + 1) % questionBank.length;
  }
  qs('questionAnswer').value = '';
  renderTrainingQuestion();
}

function renderChatHistory() {
  const root = qs('chatMessages');
  if (!root) return;
  const history = profile?.chatHistory || [];
  if (!history.length) {
    root.innerHTML = '<div class="empty-chat">Your Twin is ready for a first test after Quick Start.</div>';
    return;
  }
  root.innerHTML = history.map(item => `
    <div class="message-row user">
      <div class="bubble">${escapeHtml(item.message || '')}</div>
    </div>
    <div class="message-row assistant">
      <div class="bubble">${escapeHtml(item.reply || '')}${item.usedFallback ? '<div class="fallback-note">Fallback response</div>' : ''}</div>
    </div>
  `).join('');
  scrollChatToBottom();
}

function appendPendingMessage(message) {
  const root = qs('chatMessages');
  if (!root) return;
  if (root.querySelector('.empty-chat')) root.innerHTML = '';
  root.insertAdjacentHTML('beforeend', `
    <div class="message-row user"><div class="bubble">${escapeHtml(message)}</div></div>
    <div class="message-row assistant pending"><div class="bubble">Thinking locally...</div></div>
  `);
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const root = qs('chatMessages');
  if (root) root.scrollTop = root.scrollHeight;
}

async function loadProfile() {
  const data = await api('/api/profile');
  profile = data.profile;
  meta = data.meta || meta;
  trainingIndex = findNextTrainingIndex();
  renderProfile();
}

async function unlock() {
  const password = qs('passwordInput').value;
  try {
    await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    }).then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Invalid password');
      return data;
    });
    localPassword = password;
    sessionStorage.setItem('twerityLocalPassword', password);
    qs('lockScreen').classList.add('hidden');
    qs('mainApp').classList.remove('hidden');
    await loadProfile();
    setTab(quickComplete() ? 'overview' : 'start');
  } catch (error) {
    setMessage('lockMessage', error.message, 'err');
  }
}

async function saveQuickStart() {
  persistCurrentQuickAnswer();
  const answers = { ...quickDraft };
  const answeredCount = Object.values(answers).filter(v => String(v || '').trim()).length;
  if (answeredCount < 3) {
    setMessage('startMessage', 'Add at least 3 answers before unlocking the Twin.', 'err');
    return;
  }
  try {
    const data = await api('/api/start', { method: 'POST', body: JSON.stringify({ answers }) });
    profile = data.profile;
    renderProfile();
    setTab('overview');
    setMessage('startMessage', 'Saved. Improve, Journal and Ask Twin are now unlocked.', 'ok');
  } catch (error) {
    setMessage('startMessage', error.message, 'err');
  }
}

async function saveAnswer() {
  const item = questionBank[trainingIndex] || questionBank[0];
  const answer = qs('questionAnswer').value;
  try {
    const data = await api('/api/answer', { method: 'POST', body: JSON.stringify({ category: item.category, question: item.question, answer }) });
    profile = data.profile;
    qs('questionAnswer').value = '';
    trainingIndex = findNextTrainingIndex();
    renderProfile();
    setMessage('improveMessage', 'Answer saved. A new question is ready.', 'ok');
  } catch (error) {
    setMessage('improveMessage', error.message, 'err');
  }
}

async function saveJournal() {
  const entry = qs('journalEntry').value;
  try {
    const data = await api('/api/journal', { method: 'POST', body: JSON.stringify({ entry }) });
    profile = data.profile;
    qs('journalEntry').value = '';
    const learned = data.learned || [];
    qs('learnedBox').classList.remove('hidden');
    qs('learnedBox').innerHTML = learned.length
      ? `<strong>Your Twin learned:</strong>\n${learned.map(m => `- ${escapeHtml(m.text)}`).join('\n')}`
      : 'Journal saved. Add concrete preferences, priorities or examples for stronger memories.';
    renderProfile();
    setMessage('journalMessage', 'Journal entry saved locally.', 'ok');
  } catch (error) {
    setMessage('journalMessage', error.message, 'err');
  }
}

async function askTwin(event) {
  if (event) event.preventDefault();
  if (sending) return;
  const input = qs('chatInput');
  const message = input.value.trim();
  if (!message) return;

  sending = true;
  input.value = '';
  autoGrowChatInput();
  appendPendingMessage(message);

  try {
    const data = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message }) });
    profile = data.profile || profile;
    renderProfile();
  } catch (error) {
    const pending = document.querySelector('.message-row.pending .bubble');
    if (pending) pending.textContent = error.message;
  } finally {
    sending = false;
  }
}

async function downloadProfile() {
  try {
    const res = await fetch('/api/export', { headers: { 'x-app-password': localPassword } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Export failed');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `twerity-twin-profile-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message);
  }
}

function autoGrowChatInput() {
  const input = qs('chatInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(150, input.scrollHeight)}px`;
}

function boot() {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
  document.querySelectorAll('.jump-tab').forEach(btn => btn.addEventListener('click', () => setTab(btn.dataset.target)));
  qs('unlockBtn').addEventListener('click', unlock);
  qs('passwordInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  qs('quickStartAnswer').addEventListener('input', persistCurrentQuickAnswer);
  qs('quickPrev').addEventListener('click', () => moveQuick(-1));
  qs('quickNext').addEventListener('click', () => moveQuick(1));
  qs('saveQuickStart').addEventListener('click', saveQuickStart);
  qs('saveAnswer').addEventListener('click', saveAnswer);
  qs('nextTrainingQuestion').addEventListener('click', () => nextTrainingQuestion(false));
  qs('randomQuestion').addEventListener('click', () => nextTrainingQuestion(true));
  qs('saveJournal').addEventListener('click', saveJournal);
  qs('chatForm').addEventListener('submit', askTwin);
  qs('chatInput').addEventListener('input', autoGrowChatInput);
  qs('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) askTwin(e);
  });
  qs('downloadProfile').addEventListener('click', downloadProfile);
  qs('scrollChatBottom').addEventListener('click', scrollChatToBottom);
  document.querySelectorAll('.prompt-chip').forEach(btn => btn.addEventListener('click', () => {
    qs('chatInput').value = btn.textContent;
    autoGrowChatInput();
    qs('chatInput').focus();
  }));
  document.querySelectorAll('.journal-chip').forEach(btn => btn.addEventListener('click', () => {
    const box = qs('journalEntry');
    box.value = box.value ? `${box.value}\n\n${btn.textContent} ` : `${btn.textContent} `;
    box.focus();
  }));

  renderQuickStart();
  if (localPassword) {
    qs('passwordInput').value = localPassword;
    unlock();
  }
}

boot();
