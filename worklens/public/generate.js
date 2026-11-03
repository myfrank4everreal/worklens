// Workstation · AI clip generation (OpenRouter video). Two pieces: the "OpenRouter video" card in
// Settings (key, default model, monthly cap) and the "Generate clip" panel Studio mounts under its
// timeline. Every job costs money, so the panel always shows the estimate and only submits from
// the confirm dialog; the server re-prices the request and refuses it if the price moved or the
// monthly cap would be passed.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = n => `$${Number(n || 0).toFixed(2)}`;
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2400); }
async function request(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error || 'Request failed'), { body });
  return body;
}
const prettyName = name => String(name).split('/').pop().replace(/^\d{10,}-/, '').replace(/-\d{10,}(?=\.\w+$)/, '').replace(/_/g, ' ');
const OPEN = ['submitting', 'pending', 'queued', 'in_progress', 'processing'];
const LAST_FRAME = '__last-frame';

// ---------- Settings card ----------
const card = document.querySelector('#openrouterVideoCard');
let settings = null;

async function loadSettings() {
  if (!card) return;
  try {
    const [s, m] = await Promise.all([request('/api/openrouter/video-settings'), request('/api/openrouter/video-models').catch(() => ({ models: [] }))]);
    settings = s; renderSettings(m.models);
  } catch (error) { card.querySelector('[data-or-status]').textContent = error.message; }
}

function renderSettings(models) {
  const k = settings.key;
  const status = k.source === 'settings' ? `Key set${k.encrypted ? ' · encrypted on this device' : ' · stored unencrypted (encryption needs the desktop app)'}`
    : k.source === 'env' ? 'Using OPENROUTER_API_KEY from .env' : 'Not set';
  card.querySelector('[data-or-status]').textContent = `${status}${k.unreadable ? ' · the saved key could not be decrypted, save it again' : ''}`;
  card.querySelector('[data-or-clear]').hidden = k.source !== 'settings';
  const select = card.querySelector('[data-or-model]');
  const list = models.length ? models : [{ id: settings.model, name: settings.model }];
  select.innerHTML = list.filter(m => m.id !== 'heygen/avatar-iv').map(m => `<option value="${esc(m.id)}" ${m.id === settings.model ? 'selected' : ''}>${esc(m.name || m.id)}</option>`).join('');
  card.querySelector('[data-or-cap]').value = settings.capUsd;
  card.querySelector('[data-or-spent]').textContent = `${usd(settings.spentUsd)} of ${usd(settings.capUsd)} used this month`;
}

card?.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.orSave !== undefined) {
      const input = card.querySelector('[data-or-key]');
      if (!input.value.trim()) return toast('Paste a key first.');
      settings = { ...settings, ...(await request('/api/openrouter/video-settings', { method: 'PUT', body: JSON.stringify({ apiKey: input.value.trim() }) })) };
      input.value = ''; toast('OpenRouter key saved'); return loadSettings();
    }
    if (b.dataset.orClear !== undefined) {
      await request('/api/openrouter/video-settings', { method: 'PUT', body: JSON.stringify({ apiKey: '' }) });
      toast('Saved key removed'); return loadSettings();
    }
    if (b.dataset.orTest !== undefined) {
      b.disabled = true;
      const r = await request('/api/openrouter/test-key', { method: 'POST' });
      card.querySelector('[data-or-test-result]').textContent = `Key works${r.label ? ` (${r.label})` : ''}. ${r.limitRemaining != null ? `${usd(r.limitRemaining)} credit left on this key.` : r.usage != null ? `${usd(r.usage)} used on this key so far.` : ''}`;
    }
    if (b.dataset.orSaveCap !== undefined) {
      settings = { ...settings, ...(await request('/api/openrouter/video-settings', { method: 'PUT', body: JSON.stringify({ capUsd: Number(card.querySelector('[data-or-cap]').value) }) })) };
      card.querySelector('[data-or-spent]').textContent = `${usd(settings.spentUsd)} of ${usd(settings.capUsd)} used this month`; toast('Spending cap saved');
    }
  } catch (error) { card.querySelector('[data-or-test-result]').textContent = error.message; }
  finally { b.disabled = false; }
});
card?.addEventListener('change', async e => {
  if (!e.target.matches('[data-or-model]')) return;
  await request('/api/openrouter/video-settings', { method: 'PUT', body: JSON.stringify({ model: e.target.value }) }).catch(err => toast(err.message));
  toast('Default video model saved');
});
document.addEventListener('click', e => { if (e.target.closest?.('.nav[data-view="settings"]')) loadSettings(); });

// ---------- Studio panel ----------
// Studio passes in what the panel needs from the editor: its media list, the selected clip, its
// confirm dialog, and how to add a finished clip to the timeline.
let el = null, hooks = null, models = [], jobs = [], spent = 0, capUsd = 0;
let mode = 'clip', form = { model: '', prompt: '', duration: '', resolution: '', aspectRatio: '9:16', generateAudio: true, startFrame: '', references: [], photo: '', audio: '' };
let quote = null, quoteTimer = null, pollTimer = null, loaded = false;

export async function mountGenerate(container, studioHooks) {
  el = container; hooks = studioHooks;
  if (!loaded) {
    loaded = true;
    el.addEventListener('click', onClick); el.addEventListener('input', onInput); el.addEventListener('change', onInput);
  }
  try {
    const [m, j] = await Promise.all([request('/api/openrouter/video-models'), request('/api/media/generate/jobs')]);
    models = m.models; jobs = j.jobs; spent = j.spentUsd; capUsd = j.capUsd;
    if (!form.model || !models.some(x => x.id === form.model)) form.model = m.defaultModel;
    fitToModel();
  } catch (error) { models = []; el.innerHTML = `<div class="section-title"><h3>Generate clip</h3></div><div class="empty">Couldn't reach OpenRouter's model list: ${esc(error.message)}</div>`; return; }
  render(); requote(); pollJobs();
}

const model = () => models.find(m => m.id === (mode === 'avatar' ? 'heygen/avatar-iv' : form.model));
const images = () => hooks.library().filter(i => i.type.startsWith('image') && !/^\d+-caption-/.test(i.name));
const voiceLines = () => hooks.library().filter(i => i.type.startsWith('audio'));

// Keep duration/resolution/aspect within what the chosen model accepts.
function fitToModel() {
  const m = model(); if (!m) return;
  if (m.durations && !m.durations.includes(Number(form.duration))) form.duration = m.durations.includes(8) ? 8 : m.durations[m.durations.length - 1];
  if (!m.resolutions.includes(form.resolution)) form.resolution = m.resolutions.includes('1080p') ? '1080p' : m.resolutions[0] || '';
  if (m.aspectRatios.length && !m.aspectRatios.includes(form.aspectRatio)) form.aspectRatio = m.aspectRatios.includes('9:16') ? '9:16' : m.aspectRatios[0];
  if (!m.audio) form.generateAudio = false;
}

// What the server prices and submits. "Last frame of the selected clip" is priced with the clip
// itself standing in, and the frame is only extracted when the person confirms.
function payload() {
  const clip = hooks.selectedClip();
  const startFrame = mode === 'avatar' ? form.photo : form.startFrame === LAST_FRAME ? (clip?.src || '') : form.startFrame;
  if (mode === 'avatar') return { kind: 'avatar', startFrame, audio: form.audio, resolution: form.resolution, aspectRatio: form.aspectRatio };
  return { kind: 'clip', model: form.model, prompt: form.prompt, duration: Number(form.duration) || undefined, resolution: form.resolution, aspectRatio: form.aspectRatio, generateAudio: form.generateAudio, startFrame, references: form.references };
}

function requote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    const data = payload();
    if (form.startFrame === LAST_FRAME && mode === 'clip' && hooks.selectedClip()?.kind !== 'video') { quote = { error: 'Select a video clip on the timeline to start from its last frame.' }; return renderQuote(); }
    try { quote = await request('/api/media/generate/estimate', { method: 'POST', body: JSON.stringify({ ...data, prompt: data.prompt || '…' }) }); }
    catch (error) { quote = { error: error.message }; }
    renderQuote();
  }, 250);
}

const opt = (value, label, current) => `<option value="${esc(value)}" ${String(value) === String(current) ? 'selected' : ''}>${esc(label)}</option>`;
function render() {
  const m = model();
  const tabs = `<div class="lib-filters gen-tabs">${[['clip', 'Clip'], ['avatar', 'Talking head']].map(([k, l]) => `<button class="chip-btn ${mode === k ? 'active' : ''}" data-gen-mode="${k}">${l}</button>`).join('')}</div>`;
  const shared = m ? `<div><label>Resolution</label><select data-g="resolution">${m.resolutions.map(r => opt(r, r, form.resolution)).join('')}</select></div>
    <div><label>Aspect ratio</label><select data-g="aspectRatio">${m.aspectRatios.map(r => opt(r, r, form.aspectRatio)).join('')}</select></div>` : '';
  const imageOptions = current => images().map(i => opt(i.path, prettyName(i.name), current)).join('');
  const fields = mode === 'avatar'
    ? `<p class="hint">HeyGen Avatar IV animates one photo to a voice line, lip-synced, in one take. The clip is as long as the voice line (about $0.05 a second).</p>
      <div class="gen-grid"><div><label>Photo</label><select data-g="photo"><option value="">Pick an image…</option>${imageOptions(form.photo)}</select></div>
        <div><label>Voice line</label><select data-g="audio"><option value="">Pick a voice line…</option>${voiceLines().map(i => opt(i.path, prettyName(i.name), form.audio)).join('')}</select></div>${shared}</div>`
    : `<label>Prompt</label><textarea data-g="prompt" rows="3" maxlength="4000" placeholder="Describe the shot: who, where, what happens, camera, and any spoken line.">${esc(form.prompt)}</textarea>
      <div class="gen-grid">
        <div><label>Model</label><select data-g="model">${models.filter(x => x.id !== 'heygen/avatar-iv').map(x => opt(x.id, x.name, form.model)).join('')}</select></div>
        <div><label>Seconds</label><select data-g="duration" ${m?.durations ? '' : 'disabled'}>${(m?.durations || [form.duration]).map(d => opt(d, `${d}s`, form.duration)).join('')}</select></div>
        ${shared}
        <div><label>Start frame</label><select data-g="startFrame"><option value="">None (text only)</option>${opt(LAST_FRAME, 'Last frame of the selected clip', form.startFrame)}${m?.frameImages?.length === 0 ? '' : imageOptions(form.startFrame)}</select></div>
        <div><label>Sound</label><label class="check-row"><input type="checkbox" data-g="generateAudio" ${form.generateAudio ? 'checked' : ''} ${m?.audio ? '' : 'disabled'}> ${m?.audio ? 'Generate audio (voice, sound)' : 'This model is silent'}</label></div>
      </div>
      <label>Reference images <small class="muted">(up to 4, e.g. crew sheets)</small></label>
      <div class="gen-refs">${images().length ? images().slice(0, 40).map(i => `<label class="gen-ref ${form.references.includes(i.path) ? 'on' : ''}" title="${esc(prettyName(i.name))}"><input type="checkbox" data-gen-ref="${esc(i.path)}" ${form.references.includes(i.path) ? 'checked' : ''}><img src="${esc(i.url)}" alt="" loading="lazy"></label>`).join('') : '<span class="hint">Upload images to Media to use them as references.</span>'}</div>`;
  el.innerHTML = `<div class="section-title"><h3>Generate clip</h3><span class="eyebrow">OPENROUTER · PAID PER SECOND</span></div>
    ${tabs}${fields}
    <div class="gen-quote" data-gen-quote></div>
    <div class="gen-jobs" data-gen-jobs></div>`;
  renderQuote(); renderJobs();
}

function renderQuote() {
  const q = el?.querySelector('[data-gen-quote]'); if (!q) return;
  const month = `${usd(spent)} of ${usd(capUsd)} used this month`;
  if (!quote) { q.innerHTML = `<span class="hint">Working out the price…</span>`; return; }
  if (quote.error) { q.innerHTML = `<span class="hint">${esc(quote.error)}</span><span class="eyebrow">${month}</span><button class="primary" disabled>Generate…</button>`; return; }
  q.innerHTML = `<div><strong>About ${usd(quote.estimate)}</strong> <span class="hint">· ${Number(quote.duration).toFixed(1)}s with ${esc(quote.modelName)}${quote.generateAudio ? ', with audio' : ''}</span>
    ${quote.blocked ? `<p class="err">${esc(quote.blocked)}</p>` : ''}${quote.keySet ? '' : '<p class="err">Add an OpenRouter API key in Settings to generate.</p>'}</div>
    <span class="eyebrow">${month}</span><button class="primary" data-gen-go ${quote.blocked || !quote.keySet || (mode === 'clip' && !form.prompt.trim()) ? 'disabled' : ''}>Generate…</button>`;
}

function renderJobs() {
  const box = el?.querySelector('[data-gen-jobs]'); if (!box) return;
  box.innerHTML = jobs.length ? `<div class="export-grid">${jobs.map(j => {
    const open = OPEN.includes(j.status);
    const price = j.cost != null ? usd(j.cost) : `~${usd(j.estimate)}`;
    const label = open ? `Generating · ${j.status.replace('_', ' ')}` : j.status === 'completed' ? 'Ready · in Media' : j.status[0].toUpperCase() + j.status.slice(1);
    return `<div class="export-card ${open ? 'running' : j.status === 'completed' ? 'done' : 'failed'}"><strong title="${esc(j.prompt)}">${esc(j.kind === 'avatar' ? 'Talking head' : j.prompt || 'Clip')}</strong>
      <small>${esc(j.model)} · ${price}</small><small>${label}</small>
      ${j.url ? `<video controls preload="metadata" src="${esc(j.url)}"></video>` : ''}${j.error ? `<small class="err">${esc(j.error.slice(0, 240))}</small>` : ''}
      <div class="export-actions">${j.path ? `<button data-gen-add="${esc(j.path)}">+ Add</button>` : ''}${open ? '' : `<button data-gen-retry="${j.id}">Retry</button><button class="icon-btn danger" title="Remove from this list (the clip stays in Media)" data-gen-remove="${j.id}">🗑</button>`}</div></div>`;
  }).join('')}</div>` : '<div class="empty">Generated clips appear here and in Media. Each one is logged on your WorkLens timeline with its cost.</div>';
}

async function refreshJobs() {
  const before = new Map(jobs.map(j => [j.id, j.status]));
  const r = await request('/api/media/generate/jobs');
  jobs = r.jobs; spent = r.spentUsd; capUsd = r.capUsd;
  for (const j of jobs) {
    if (!OPEN.includes(before.get(j.id)) || OPEN.includes(j.status)) continue;
    if (j.status === 'completed') { toast('AI clip ready in Media'); hooks.refreshLibrary(); }
    else toast(`Generation ${j.status}: ${(j.error || '').slice(0, 100)}`);
  }
  renderJobs(); renderQuote(); pollJobs();
}
// The server checks OpenRouter every ~25s; the page only has to re-read the job table.
function pollJobs() {
  clearTimeout(pollTimer);
  if (jobs.some(j => OPEN.includes(j.status))) pollTimer = setTimeout(() => refreshJobs().catch(() => pollJobs()), 8000);
}

function confirmAndSubmit(estimate, describe, send) {
  hooks.openDialog('Generate with OpenRouter?', `<p class="dialog-note">${describe}</p><p class="dialog-note">This will charge about <strong>${usd(estimate)}</strong> to your OpenRouter credit. This month so far: ${usd(spent)} of your ${usd(capUsd)} cap.</p>`, `Generate · ${usd(estimate)}`, async () => {
    try { await send(); }
    catch (error) {
      // The server re-prices on submit; if the price moved, show the new one instead of charging it.
      if (error.body?.estimate != null) { requote(); throw new Error(`${error.message} New estimate: ${usd(error.body.estimate)}.`); }
      throw error;
    }
    await refreshJobs(); toast('Sent to OpenRouter. It usually takes a minute or two.');
  });
}

async function onClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.genMode) { mode = b.dataset.genMode; fitToModel(); render(); return requote(); }
  if (b.dataset.genAdd) return hooks.addMedia(b.dataset.genAdd);
  if (b.dataset.genRemove) { await request(`/api/media/generate/jobs/${b.dataset.genRemove}`, { method: 'DELETE' }).catch(err => toast(err.message)); return refreshJobs(); }
  if (b.dataset.genRetry) {
    const job = jobs.find(j => j.id === Number(b.dataset.genRetry));
    return confirmAndSubmit(job.estimate, `Run this again with <strong>${esc(job.model)}</strong>: “${esc((job.prompt || 'talking head').slice(0, 160))}”`, () =>
      request(`/api/media/generate/jobs/${job.id}/retry`, { method: 'POST', body: JSON.stringify({ confirmedEstimate: job.estimate }) }));
  }
  if (b.dataset.genGo !== undefined && quote && !quote.error) {
    const data = payload(), estimate = quote.estimate;
    return confirmAndSubmit(estimate, mode === 'avatar' ? `Make a <strong>${Number(quote.duration).toFixed(1)}s</strong> talking-head clip with ${esc(quote.modelName)}.` : `Make a <strong>${quote.duration}s</strong> clip with ${esc(quote.modelName)}: “${esc(form.prompt.slice(0, 160))}”`, async () => {
      if (mode === 'clip' && form.startFrame === LAST_FRAME) {
        const frame = await request('/api/media/last-frame', { method: 'POST', body: JSON.stringify({ src: data.startFrame }) });
        data.startFrame = frame.path; hooks.refreshLibrary();
      }
      await request('/api/media/generate', { method: 'POST', body: JSON.stringify({ ...data, confirmedEstimate: estimate }) });
    });
  }
}

function onInput(e) {
  const t = e.target;
  if (t.dataset.genRef) {
    if (e.type !== 'change') return;
    const path = t.dataset.genRef;
    form.references = t.checked ? [...form.references, path].slice(-4) : form.references.filter(p => p !== path);
    render(); return requote();
  }
  const key = t.dataset.g; if (!key) return;
  form[key] = t.type === 'checkbox' ? t.checked : t.value;
  if (key === 'prompt') { if (e.type === 'input') { clearTimeout(quoteTimer); quoteTimer = setTimeout(requote, 600); } return; }
  if (e.type !== 'change') return;
  if (key === 'model') { fitToModel(); render(); }
  requote();
}

// Content → "Generate in Studio": start the Clip tab from a content item's prompt. Nothing is
// submitted; the person still reviews the cost and confirms.
export function usePrompt(text) { mode = 'clip'; form.prompt = String(text || '').slice(0, 4000); if (el && models.length) { render(); requote(); } }

// Studio's selection changes which clip "last frame" means, so re-price when it does.
export function selectionChanged() { if (el && form.startFrame === LAST_FRAME && mode === 'clip') requote(); }
export function libraryChanged() { if (el && models.length && !el.contains(document.activeElement)) { const scroll = el.querySelector('.gen-refs')?.scrollTop; render(); if (scroll) el.querySelector('.gen-refs').scrollTop = scroll; } }
