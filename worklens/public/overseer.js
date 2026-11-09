// WorkLens · Overseer screen and voice loop. Clap, press Ctrl+Alt+J, or click the orb; say what you
// want; Whisper on this PC turns it into text; the overseer's Claude session reads every session and
// WorkLens's records (read-only) and answers; a short spoken summary is read aloud and the detail
// stays on screen.
import { reportContext } from '/monitor.js';

const root = document.querySelector('#overseerRoot');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`wl-overseer-${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`wl-overseer-${key}`, JSON.stringify(value)); } catch {} }
};
function toast(text) { const el = document.querySelector('#toast'); if (!el) return; el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
function ago(isoText) {
  if (!isoText) return '';
  const mins = Math.round((Date.now() - Date.parse(isoText)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// ---------- state ----------
let status = { settings: { name: 'Jarvis', model: 'sonnet', ttsEngine: 'system', voice: 'bm_george' }, claude: true, speech: {} };
let board = { sessions: [], counts: {} };
let thread = store.get('thread', []).slice(-20);
let phase = 'idle'; // idle | listening | transcribing | thinking | speaking
let phaseNote = '';
let openSession = null, openDetail = null;
let clapOn = store.get('clap', false);
let systemVoice = store.get('system-voice', '');
let rendered = false;

const PHASE_TEXT = { idle: 'Ready', listening: 'Listening…', transcribing: 'Working out what you said…', thinking: 'Checking your sessions…', speaking: 'Speaking' };

// ---------- markdown for the detail panel (escaped first, so nothing in a reply becomes HTML) ----------
function md(text) {
  const lines = esc(text).split('\n');
  let html = '', inList = false;
  const inline = s => s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(bullet[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    const head = line.match(/^#{1,4}\s+(.*)$/);
    if (head) html += `<h4>${inline(head[1])}</h4>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

// ---------- rendering ----------
function sessionCard(s) {
  const open = openSession === s.id;
  const note = s.state === 'waiting' && s.ask ? `<p class="ov-ask">${esc(s.ask)}</p>` : s.recap ? `<p class="ov-recap">${esc(s.recap)}</p>` : s.lastReply ? `<p class="ov-recap">${esc(s.lastReply.slice(0, 220))}</p>` : '';
  const turns = open && openDetail?.id === s.id ? `<div class="ov-turns">${openDetail.turns.map(t => `<div class="ov-turn ${t.role}"><span>${t.role === 'user' ? 'You' : 'Session'}</span><div>${esc(t.text)}</div></div>`).join('') || '<p class="hint">No readable turns.</p>'}</div>` : open ? '<p class="hint">Loading…</p>' : '';
  return `<article class="ov-session ${open ? 'open' : ''}" data-ov-session="${esc(s.id)}">
    <div class="ov-session-top"><span class="ov-dot s-${esc(s.state)}"></span><strong>${esc(s.title)}</strong><span class="ov-time">${esc(ago(s.lastActivityAt))}</span></div>
    <div class="ov-meta">${esc(s.project)}${s.startedByTitle ? ` · started by ${esc(s.startedByTitle)}` : ''}</div>
    ${note}${turns}
  </article>`;
}

function renderBoard() {
  const el = root.querySelector('[data-ov-board]');
  if (!el) return;
  const groups = [
    ['waiting', 'Waiting on you'],
    ['working', 'Working now'],
    ['idle', 'Recently finished']
  ];
  el.innerHTML = groups.map(([state, label]) => {
    const list = board.sessions.filter(s => s.state === state).slice(0, state === 'idle' ? 12 : 40);
    return `<div class="ov-col"><div class="ov-col-head"><span class="ov-dot s-${state}"></span>${label}<em>${board.counts[state] || 0}</em></div>${list.map(sessionCard).join('') || '<p class="hint">None.</p>'}</div>`;
  }).join('');
}

function renderThread() {
  const el = root.querySelector('[data-ov-thread]');
  if (!el) return;
  el.innerHTML = thread.length ? thread.map((m, i) => m.role === 'user'
    ? `<div class="ov-msg user">${esc(m.text)}</div>`
    : `<div class="ov-msg assistant${m.error ? ' error' : ''}">${m.spoken ? `<p class="ov-spoken">${esc(m.spoken)}</p>` : m.pending ? '<p class="hint">…</p>' : ''}${m.detail ? `<div class="ov-detail">${md(m.detail)}</div>` : ''}${m.error ? `<p>${esc(m.error)}</p>` : ''}${m.spoken && !m.pending ? `<button class="ov-replay" data-ov-replay="${i}" title="Say it again">Replay</button>` : ''}</div>`).join('')
    : `<p class="hint">Try "what's waiting on me?", "what's still running?" or "how far is the video edit?".</p>`;
  el.scrollTop = el.scrollHeight;
}

function renderPhase() {
  const orb = root.querySelector('[data-ov-orb]');
  if (!orb) return;
  orb.dataset.phase = phase;
  orb.setAttribute('aria-label', phase === 'idle' ? `Talk to ${status.settings.name}` : 'Stop');
  root.querySelector('[data-ov-phase]').textContent = phaseNote || PHASE_TEXT[phase];
}

function setPhase(next, note = '') { phase = next; phaseNote = note; renderPhase(); }

function render() {
  const s = status.settings;
  const voices = (typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : []).filter(v => /^en/i.test(v.lang));
  root.innerHTML = `
  <div class="section-head"><div><span class="eyebrow">VOICE OVERSEER</span><h2>${esc(s.name)}</h2></div><div class="ov-counts" data-ov-counts></div></div>
  ${status.claude ? '' : '<div class="card ov-warn">Claude Code isn\'t installed or isn\'t on PATH, so questions can\'t be answered. Install it, run <code>claude</code> once and sign in.</div>'}
  <div class="ov-grid">
    <div class="card ov-talk">
      <div class="ov-orb-wrap"><button class="ov-orb" data-ov-orb data-phase="idle"><span></span></button>
        <div><p class="ov-phase" data-ov-phase>Ready</p><p class="hint">Clap${clapOn ? '' : ' (turn on below)'}, press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> or click the circle, then speak.</p></div></div>
      <div class="ov-quick">
        <button data-ov-quick="What's waiting on me?">What's waiting on me?</button>
        <button data-ov-quick="What's still running right now?">What's running?</button>
        <button data-ov-quick="Give me a breakdown of today's activity across all sessions and the content pipeline.">Today's breakdown</button>
      </div>
      <div class="ov-thread" data-ov-thread></div>
      <form class="ov-form" data-ov-form><input data-ov-input type="text" placeholder="Or type a question…" autocomplete="off"><button class="primary" type="submit">Ask</button></form>
      <div class="ov-settings">
        <label class="ov-check"><input type="checkbox" data-ov-clap ${clapOn ? 'checked' : ''}> Wake on clap</label>
        <label>Reply voice <select data-ov-engine>
          ${[['system', 'Windows voice (instant)'], ['kokoro', 'Kokoro (natural, slower)'], ['off', 'Off (text only)']].map(([v, label]) => `<option value="${v}" ${(store.get('mute', false) ? 'off' : s.ttsEngine) === v ? 'selected' : ''}>${label}</option>`).join('')}
        </select></label>
        ${s.ttsEngine === 'system' ? `<label>Voice <select data-ov-system-voice><option value="">Default</option>${voices.map(v => `<option value="${esc(v.name)}" ${v.name === systemVoice ? 'selected' : ''}>${esc(v.name.replace(/^Microsoft /, '').replace(/ - .*$/, ''))}</option>`).join('')}</select></label>` : `<label>Voice <select data-ov-kokoro-voice>${['bm_george', 'bm_lewis', 'bm_daniel', 'am_onyx', 'am_michael', 'af_heart', 'bf_emma', 'bf_isabella'].map(v => `<option ${v === s.voice ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`}
        <label>Model <select data-ov-model>${['haiku', 'sonnet', 'opus'].map(m => `<option value="${m}" ${m === s.model ? 'selected' : ''}>${m[0].toUpperCase() + m.slice(1)}${m === 'sonnet' ? ' (default)' : m === 'haiku' ? ' (fastest)' : ''}</option>`).join('')}</select></label>
        <button class="ov-link" data-ov-new>New conversation</button>
      </div>
    </div>
    <div class="ov-board" data-ov-board></div>
  </div>`;
  rendered = true;
  renderThread(); renderBoard(); renderPhase(); renderCounts();
}

function renderCounts() {
  const el = root.querySelector('[data-ov-counts]');
  if (el) el.innerHTML = `<span class="pill">${board.counts.waiting || 0} waiting</span><span class="pill">${board.counts.working || 0} working</span><span class="pill">${board.counts.total || 0} sessions</span>`;
}

// ---------- data ----------
async function getJson(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
async function loadBoard() {
  try { board = await getJson('/api/overseer/sessions'); renderBoard(); renderCounts(); }
  catch (error) { const el = root.querySelector('[data-ov-board]'); if (el) el.innerHTML = `<div class="card empty">Couldn't read sessions: ${esc(error.message)}</div>`; }
}
export async function loadOverseer() {
  try { status = await getJson('/api/overseer/status'); } catch {}
  render();
  loadBoard();
  if (document.querySelector('#overseer')?.classList.contains('active')) reportContext({ tool: 'overseer', label: status.settings.name });
}
async function saveSettings(patch) {
  try { status.settings = (await getJson('/api/overseer/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })).settings; render(); }
  catch (error) { toast(error.message); }
}

// ---------- microphone: one stream, one processor, used by both the clap detector and the recorder ----------
const mic = { ctx: null, stream: null, node: null, rate: 48000, floor: 0.01, recorder: null, clap: null };

async function openMic() {
  if (mic.node) { if (mic.ctx.state === 'suspended') await mic.ctx.resume(); return true; }
  try {
    mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (error) {
    toast(`Microphone unavailable: ${error.message}`);
    return false;
  }
  mic.ctx = new AudioContext();
  mic.rate = mic.ctx.sampleRate;
  const source = mic.ctx.createMediaStreamSource(mic.stream);
  // A ScriptProcessor runs on audio events, not animation frames, so it keeps working while the
  // WorkLens window is hidden in the tray.
  mic.node = mic.ctx.createScriptProcessor(512, 1, 1);
  const sink = mic.ctx.createGain(); sink.gain.value = 0;
  source.connect(mic.node); mic.node.connect(sink); sink.connect(mic.ctx.destination);
  mic.node.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const level = Math.sqrt(sum / data.length);
    const now = performance.now();
    if (mic.recorder) mic.recorder.push(data, level, now);
    else if (mic.clap) mic.clap(level, now);
    if (!mic.recorder && level < mic.floor * 3) mic.floor = Math.max(0.002, mic.floor + (level - mic.floor) * 0.02);
  };
  if (mic.ctx.state === 'suspended') await mic.ctx.resume();
  return true;
}

function closeMicIfUnused() {
  if (clapOn || mic.recorder || !mic.node) return;
  try { mic.node.disconnect(); mic.stream.getTracks().forEach(t => t.stop()); mic.ctx.close(); } catch {}
  mic.node = null; mic.stream = null; mic.ctx = null;
}

// Clap: quiet just before, a near-instant rise, and a collapse within ~130 ms. Loudness alone is
// not evidence; speech and music fail the "quiet before" or the "fast collapse" test. Same rules as
// Jarvis's clap.ts, measured in time rather than animation frames.
function makeClapDetector(onClap) {
  const history = []; // [time, level]
  let candidate = null, last = -Infinity;
  return (level, now) => {
    history.push([now, level]);
    while (history.length && now - history[0][0] > 400) history.shift();
    if (candidate) {
      if (level < candidate.peak * 0.35 && now - candidate.at < 130) { candidate = null; last = now; onClap(); }
      else if (now - candidate.at > 260) candidate = null;
      else candidate.peak = Math.max(candidate.peak, level);
      return;
    }
    if (now - last < 1200) return;
    if (level < 0.055 || level < mic.floor * 7) return;
    const before = history.find(([t]) => now - t <= 100 && now - t >= 60) || history[0];
    if (!before || before[1] > level * 0.16) return;
    candidate = { at: now, peak: level };
  };
}

async function setClap(on) {
  clapOn = on; store.set('clap', on);
  if (on) {
    if (!(await openMic())) { clapOn = false; store.set('clap', false); render(); return; }
    mic.clap = makeClapDetector(() => { if (phase === 'idle') activate('clap'); });
  } else { mic.clap = null; closeMicIfUnused(); }
}

function beep(up = true) {
  try {
    const ctx = mic.ctx || new AudioContext();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.setValueAtTime(up ? 660 : 520, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(up ? 990 : 390, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.18);
  } catch {}
}

// Records until ~1.1 s of quiet after speech, 25 s at most; gives up after 7 s with no speech.
function record() {
  return new Promise((resolve) => {
    const chunks = [];
    const startAt = performance.now();
    let spokeAt = 0, loudFrames = 0, quietSince = 0;
    const threshold = Math.max(0.018, mic.floor * 4);
    const finish = (audio) => { mic.recorder = null; resolve(audio); };
    mic.recorder = {
      push(data, level, now) {
        chunks.push(new Float32Array(data));
        if (level > threshold) { loudFrames++; quietSince = 0; if (loudFrames >= 3 && !spokeAt) spokeAt = now; }
        else { loudFrames = 0; if (!quietSince) quietSince = now; }
        if (!spokeAt && now - startAt > 7000) return finish(null);
        if (spokeAt && quietSince && now - quietSince > 1100) return finish(chunks);
        if (now - startAt > 25000) return finish(spokeAt ? chunks : null);
      },
      cancel() { finish(null); }
    };
  });
}

function toWav(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / 16000;
  const outLength = Math.floor(total / ratio);
  const flat = new Float32Array(total);
  let offset = 0; for (const c of chunks) { flat.set(c, offset); offset += c.length; }
  const pcm = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio), end = Math.min(total, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = start; j < end; j++) sum += flat[j];
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

// ---------- speaking ----------
const speech = { queue: [], playing: false, audio: null, token: 0 };
function speaking() { return speech.playing || speech.queue.length > 0; }
function stopSpeaking() {
  speech.token++; speech.queue = []; speech.playing = false;
  try { speechSynthesis.cancel(); } catch {}
  if (speech.audio) { try { speech.audio.pause(); } catch {} speech.audio = null; }
}
function cleanForSpeech(text) {
  return text.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[*_#>]+/g, '').replace(/\s+/g, ' ').trim();
}
function say(sentence) {
  const text = cleanForSpeech(sentence);
  if (!text || store.get('mute', false)) return;
  const engine = status.settings.ttsEngine;
  // Kokoro: start synthesising now so it's ready by the time the previous sentence ends.
  const item = { text, engine, audio: engine === 'kokoro' ? fetch('/api/overseer/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then(r => (r.ok ? r.blob() : null)).catch(() => null) : null };
  speech.queue.push(item);
  if (!speech.playing) playNext(speech.token);
}
async function playNext(token) {
  if (token !== speech.token) return;
  const item = speech.queue.shift();
  if (!item) { speech.playing = false; if (phase === 'speaking') setPhase('idle'); return; }
  speech.playing = true;
  setPhase('speaking');
  const done = () => playNext(token);
  if (item.engine === 'kokoro') {
    const blob = await item.audio;
    if (token !== speech.token) return;
    if (blob) {
      const audio = new Audio(URL.createObjectURL(blob));
      speech.audio = audio;
      audio.onended = () => { URL.revokeObjectURL(audio.src); done(); };
      audio.onerror = done;
      audio.play().catch(done);
      return;
    }
  }
  // Windows voice (also the fallback when Kokoro fails).
  try {
    const u = new SpeechSynthesisUtterance(item.text);
    const voice = speechSynthesis.getVoices().find(v => v.name === systemVoice);
    if (voice) u.voice = voice;
    u.rate = Number(status.settings.speed) || 1;
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  } catch { done(); }
}

// ---------- one question, start to finish ----------
async function askOverseer(question) {
  stopSpeaking();
  thread.push({ role: 'user', text: question });
  const reply = { role: 'assistant', spoken: '', detail: '', pending: true };
  thread.push(reply);
  thread = thread.slice(-20);
  renderThread();
  setPhase('thinking');
  let raw = '', spokenUpTo = 0, pastBreak = false;
  const spokenPart = () => { const i = raw.search(/\n\s*---\s*(\n|$)/); return i >= 0 ? raw.slice(0, i) : raw; };
  // Speak each finished sentence as soon as it arrives, instead of waiting for the whole answer.
  const flush = (final) => {
    if (pastBreak && !final) return;
    const part = spokenPart();
    if (part.length < raw.length) pastBreak = true;
    let rest = part.slice(spokenUpTo);
    const re = /[^.!?]*[.!?]+["')\]]*(\s+|$)/g;
    let m, consumed = 0;
    while ((m = re.exec(rest)) && m[0]) { if (!final && m.index + m[0].length === rest.length && !/\s$/.test(m[0])) break; say(m[0]); consumed = m.index + m[0].length; }
    if (final && rest.slice(consumed).trim()) { say(rest.slice(consumed)); consumed = rest.length; }
    spokenUpTo += consumed;
    reply.spoken = cleanForSpeech(part);
    renderThread();
  };
  try {
    const res = await fetch('/api/overseer/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: question }) });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'delta') { raw += ev.text; flush(false); }
        else if (ev.type === 'reset') { raw = ''; spokenUpTo = 0; pastBreak = false; }
        else if (ev.type === 'tool') { if (phase === 'thinking') setPhase('thinking', ev.name === 'read_session' ? 'Reading a session…' : ev.name === 'worklens_overview' ? 'Checking WorkLens…' : 'Checking your sessions…'); }
        else if (ev.type === 'done') { raw = ev.text || raw; reply.detail = ev.detail || ''; flush(true); reply.spoken = ev.spoken || reply.spoken; }
        else if (ev.type === 'error') { reply.error = ev.error; say(`Sorry, that didn't work. ${ev.error.split('.')[0]}.`); }
      }
    }
  } catch (error) {
    reply.error = error.message;
  }
  reply.pending = false;
  store.set('thread', thread.filter(m => !m.pending).slice(-20));
  renderThread();
  if (!speaking()) setPhase('idle');
  if (reply.detail || reply.spoken) loadBoard();
}

async function activate(source = 'button') {
  if (phase === 'speaking') { stopSpeaking(); setPhase('idle'); if (source === 'button') return; }
  if (phase !== 'idle') { if (phase === 'listening') mic.recorder?.cancel(); return; }
  if (!(await openMic())) return;
  fetch('/api/overseer/warm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: status.settings.ttsEngine === 'kokoro' ? ['stt', 'tts'] : ['stt'] }) }).catch(() => {});
  beep(true);
  await new Promise(r => setTimeout(r, 180));
  setPhase('listening');
  const chunks = await record();
  closeMicIfUnused();
  if (!chunks) { setPhase('idle'); beep(false); return; }
  setPhase('transcribing');
  try {
    const result = await getJson('/api/overseer/stt', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: toWav(chunks, mic.rate || 48000) });
    const text = (result.text || '').trim();
    if (!text || text.length < 2) { setPhase('idle', "Didn't catch that"); setTimeout(() => phase === 'idle' && setPhase('idle'), 2500); return; }
    await askOverseer(text);
  } catch (error) {
    setPhase('idle', error.message);
    toast(`Couldn't transcribe: ${error.message}`);
  }
}

// ---------- events ----------
root.addEventListener('click', async (e) => {
  const t = e.target.closest('button, [data-ov-session]');
  if (!t) return;
  if (t.matches('[data-ov-orb]')) return activate('button');
  if (t.dataset.ovQuick) return askOverseer(t.dataset.ovQuick);
  if (t.dataset.ovReplay !== undefined) { const m = thread[Number(t.dataset.ovReplay)]; if (m?.spoken) { stopSpeaking(); say(m.spoken); } return; }
  if (t.matches('[data-ov-new]')) { await fetch('/api/overseer/new', { method: 'POST' }).catch(() => {}); thread = []; store.set('thread', []); renderThread(); toast('Started a new conversation'); return; }
  if (t.dataset.ovSession) {
    const id = t.dataset.ovSession;
    if (openSession === id) { openSession = null; openDetail = null; return renderBoard(); }
    openSession = id; openDetail = null; renderBoard();
    try { const { session } = await getJson(`/api/overseer/sessions/${encodeURIComponent(id)}?turns=6`); if (openSession === id) { openDetail = session; renderBoard(); } }
    catch (error) { toast(error.message); }
  }
});
root.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-ov-form]')) return;
  e.preventDefault();
  const input = root.querySelector('[data-ov-input]');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  askOverseer(text);
});
root.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-ov-clap]')) return setClap(t.checked).then(render);
  if (t.matches('[data-ov-engine]')) {
    if (t.value === 'off') { store.set('mute', true); stopSpeaking(); return; }
    store.set('mute', false);
    return saveSettings({ ttsEngine: t.value });
  }
  if (t.matches('[data-ov-system-voice]')) { systemVoice = t.value; store.set('system-voice', systemVoice); stopSpeaking(); say('This is how I sound.'); return; }
  if (t.matches('[data-ov-kokoro-voice]')) return saveSettings({ voice: t.value });
  if (t.matches('[data-ov-model]')) return saveSettings({ model: t.value });
});

// Ctrl+Alt+J inside the window; the Electron shell sends the same event for the global shortcut,
// which works while WorkLens is hidden in the tray.
document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.altKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); activate('hotkey'); } });
window.addEventListener('overseer:activate', () => activate('hotkey'));
document.addEventListener('click', (e) => { if (e.target.closest?.('.nav[data-view="overseer"]')) loadOverseer(); });
if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener?.('voiceschanged', () => { if (rendered && status.settings.ttsEngine === 'system') render(); });
setInterval(() => { if (document.querySelector('#overseer')?.classList.contains('active') && phase === 'idle') loadBoard(); }, 30000);

loadOverseer();
// The clap listener comes back on its own when WorkLens starts, if it was on.
if (clapOn) setClap(true);
