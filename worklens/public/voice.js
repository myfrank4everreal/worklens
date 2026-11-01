// Workstation · Voice screen — character voice profiles, single lines, side-by-side voice
// comparison, and the history of generated clips. Backed by /api/voice; self-contained like
// brands.js and announces changes with the shared `workstation:changed` event.
import { reportContext } from '/monitor.js';
const root = document.querySelector('#voiceRoot');
const dialog = document.querySelector('#voiceDialog');
const form = document.querySelector('#voiceForm');
const COMPARE_DEFAULT = ['am_onyx', 'am_michael', 'am_fenrir', 'am_adam'];
const SAMPLE = "Loyalty isn't proven when things are easy. It's proven when staying costs you something.";
let data = null, busy = false, onSubmit = null;
let draft = { profileId: '', engine: 'kokoro', voice: '', speed: 1, text: SAMPLE };
let compare = { voices: [...COMPARE_DEFAULT], text: SAMPLE, results: [] };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2400); }
async function request(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}
const label = id => data?.voices.find(v => v.id === id)?.label || id;
const voiceOptions = selected => data.voices.map(v => `<option value="${v.id}" ${v.id === selected ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
// Two engines: Kokoro (built in, Apache-2.0) and VoiceStudio (separate app, for cloned/designed voices).
const vs = () => data.voicestudio || { ready: false, voices: [], models: [], url: '' };
const engineReady = engine => engine === 'voicestudio' ? vs().ready : data.ready;
const anyReady = () => data.ready || vs().ready;
const defaultVoice = engine => engine === 'voicestudio' ? vs().voices[0]?.id || '' : 'am_onyx';
const optionsFor = (engine, selected) => engine === 'voicestudio'
  ? vs().voices.map(v => `<option value="${esc(v.id)}" ${v.id === selected ? 'selected' : ''}>${esc(v.label)}</option>`).join('')
  : voiceOptions(selected);
const currentEngine = () => data.profiles.find(p => String(p.id) === draft.profileId)?.engine || draft.engine;
const changed = () => document.dispatchEvent(new CustomEvent('workstation:changed', { detail: { tool: 'voice' } }));

export async function loadVoice() {
  root.innerHTML = root.innerHTML || '<div class="card empty">Loading voice engine…</div>';
  try {
    data = await request('/api/voice');
    if (!draft.profileId && data.profiles[0]) draft.profileId = String(data.profiles[0].id);
    render(); report();
  } catch (error) { root.innerHTML = `<div class="card empty">Couldn't load Voice: ${esc(error.message)}</div>`; }
}

function report() {
  if (!document.querySelector('#voice')?.classList.contains('active')) return;
  const profile = data?.profiles.find(p => String(p.id) === draft.profileId);
  reportContext({ tool: 'voice', label: profile ? `Voice lines for ${profile.name}` : 'Voice lines' });
}

function render() {
  const ready = data.ready;
  root.innerHTML = `
    <div class="section-head"><div><span class="eyebrow">STUDIO TOOL · VOICE</span><h2>Voice</h2></div>
      <div class="engine-chips"><span class="engine-chip ${ready ? 'ok' : 'warn'}"><i></i>${ready ? `Kokoro ready · ${esc(data.model)}` : 'Voice engine not ready'}</span>
        <span class="engine-chip ${vs().ready ? 'ok' : 'off'}"><i></i>${vs().ready ? `VoiceStudio · ${vs().voices.filter(v => v.type !== 'openai_alias').length} voices` : 'VoiceStudio offline'}</span></div></div>
    ${ready ? '' : `<div class="card engine-missing"><span class="eyebrow">SETUP NEEDED</span><h3>Kokoro can't run yet</h3><p>${esc(data.error)}</p>
      <p class="hint">The model downloads to <code>%USERPROFILE%\\.kokoro</code>. Once it's there, press <strong>Check again</strong>.</p><button data-voice-act="reload">Check again</button></div>`}
    <div class="voice-grid">
      <div class="card voice-say">
        <div class="section-title"><h3>Say a line</h3></div>
        <label>Character</label>
        <select name="profileId" data-draft="profileId"><option value="">Custom voice…</option>${data.profiles.map(p => `<option value="${p.id}" ${String(p.id) === draft.profileId ? 'selected' : ''}>${esc(p.name)} · ${esc(p.voice_label)}</option>`).join('')}</select>
        ${draft.profileId ? '' : `<label>Engine</label><select data-draft="engine"><option value="kokoro">Kokoro (built in)</option><option value="voicestudio" ${draft.engine === 'voicestudio' ? 'selected' : ''}>VoiceStudio${vs().ready ? '' : ' (offline)'}</option></select>
        <label>Voice</label><select data-draft="voice" ${engineReady(draft.engine) ? '' : 'disabled'}>${engineReady(draft.engine) ? optionsFor(draft.engine, draft.voice || defaultVoice(draft.engine)) : `<option>${draft.engine === 'voicestudio' ? 'VoiceStudio offline' : 'Engine not ready'}</option>`}</select>
        <label>Speed <span class="mono" data-speed-out>${Number(draft.speed).toFixed(2)}×</span></label><input type="range" min="0.6" max="1.4" step="0.05" value="${draft.speed}" data-draft="speed">`}
        <label>Line</label><textarea rows="4" maxlength="2000" data-draft="text" placeholder="What should they say?">${esc(draft.text)}</textarea>
        <div class="voice-actions"><span class="mono hint">${draft.text.trim().split(/\s+/).filter(Boolean).length} words</span><button class="primary" data-voice-act="generate" ${engineReady(currentEngine()) && !busy ? '' : 'disabled'}>${busy === 'generate' ? 'Generating…' : 'Generate'}</button></div>
      </div>
      <div class="card voice-profiles">
        <div class="section-title"><h3>Characters</h3><button data-voice-act="new-profile" ${anyReady() ? '' : 'disabled'}>+ New</button></div>
        ${data.profiles.length ? data.profiles.map(p => `<div class="profile-row"><span class="profile-avatar">${esc(p.name.slice(0, 1))}</span><div class="profile-main"><strong>${esc(p.name)}</strong><small>${esc(p.voice_label)} · ${Number(p.speed).toFixed(2)}×</small>${p.notes ? `<small class="faint">${esc(p.notes)}</small>` : ''}</div><button class="icon-btn" title="Edit" data-profile-edit="${p.id}" ${anyReady() ? '' : 'disabled'}>✎</button><button class="icon-btn danger" title="Delete" data-profile-delete="${p.id}">🗑</button></div>`).join('') : '<div class="empty">No characters yet.</div>'}
        <p class="hint">Give each character one permanent voice so every video sounds like the same person.</p>
      </div>
    </div>
    <div class="card vs-card ${vs().ready ? 'on' : ''}">
      <div class="section-title"><h3>VoiceStudio</h3><span class="eyebrow">CLONED &amp; DESIGNED VOICES</span></div>
      ${vs().ready
        ? `<p>Connected at <code>${esc(vs().url)}</code>: ${vs().voices.filter(v => v.type !== 'openai_alias').length} voice profiles${vs().models.length ? ` · engines ${esc(vs().models.slice(0, 4).join(', '))}` : ''}. Choose <strong>VoiceStudio</strong> as a character's engine to use them.</p>`
        : `<p>${esc(vs().error || 'Not connected.')}</p><p class="hint">In VoiceStudio, finish <strong>Install local runtime</strong> and leave the app open, then press <strong>Check again</strong>. Kokoro keeps working meanwhile.</p>`}
      <div class="vs-row"><input data-vs-url value="${esc(vs().url)}" aria-label="VoiceStudio address" spellcheck="false"><button data-voice-act="vs-save">Check again</button></div>
      <p class="hint">Licences: the VoiceStudio app is AGPL, and every model has its own terms. Its default OmniVoice model is non-commercial, so check Model Manager before using a line in ads. Clone a voice only with that person's permission.</p>
    </div>
    <div class="card voice-compare">
      <div class="section-title"><h3>Compare voices</h3><span class="eyebrow">SAME LINE · UP TO 4 VOICES</span></div>
      <div class="compare-pickers">${compare.voices.map((v, i) => `<select data-compare-voice="${i}" ${ready ? '' : 'disabled'}>${ready ? voiceOptions(v) : `<option>${esc(v)}</option>`}</select>`).join('')}</div>
      <textarea rows="2" maxlength="600" data-compare-text>${esc(compare.text)}</textarea>
      <div class="voice-actions"><span class="hint">Pick the one that fits, then save it to a character.</span><button class="primary" data-voice-act="compare" ${ready && !busy ? '' : 'disabled'}>${busy === 'compare' ? 'Generating…' : 'Generate all'}</button></div>
      ${compare.results.length ? `<div class="compare-results">${compare.results.map(r => `<div class="compare-card ${r.error ? 'err' : ''}"><strong>${esc(label(r.voice))}</strong>${r.error ? `<small>${esc(r.error)}</small>` : `<audio controls preload="none" src="${esc(r.url)}"></audio><button data-use-voice="${esc(r.voice)}">Use for a character</button>`}</div>`).join('')}</div>` : ''}
    </div>
    <div class="card voice-clips">
      <div class="section-title"><h3>Recent lines</h3><span class="eyebrow">${data.clips.length} SAVED IN THE MEDIA LIBRARY</span></div>
      ${data.clips.length ? data.clips.map(c => `<div class="clip-row"><div class="clip-main"><strong>${esc(c.text)}</strong><small>${esc(c.profile_name || label(c.voice))}${c.engine === 'voicestudio' ? ' · VoiceStudio' : ''} · ${Number(c.seconds).toFixed(1)}s · ${new Date(c.created_at + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small></div>${c.url ? `<audio controls preload="none" src="${esc(c.url)}"></audio>` : '<small class="faint">file missing</small>'}<button class="icon-btn danger" title="Delete" data-clip-delete="${c.id}">🗑</button></div>`).join('') : '<div class="empty">Generated lines appear here, ready to drop into Studio.</div>'}
    </div>`;
}

function openDialog(title, html, save, handler) {
  dialog.querySelector('#voiceDialogTitle').textContent = title;
  dialog.querySelector('#voiceDialogFields').innerHTML = html;
  dialog.querySelector('#voiceDialogSave').textContent = save;
  dialog.querySelector('#voiceDialogSave').classList.toggle('danger', save.startsWith('Delete'));
  onSubmit = handler; dialog.showModal();
  dialog.querySelector('input,select')?.focus();
}
function profileFields(p = {}) {
  const engine = p.engine || (data.ready ? 'kokoro' : 'voicestudio');
  const usable = e => engineReady(e) || p.engine === e;
  return `<label>Character name</label><input name="name" maxlength="60" required value="${esc(p.name || '')}" placeholder="e.g. Frank Madu">
    <label>Engine</label><select name="engine"><option value="kokoro" ${usable('kokoro') ? '' : 'disabled'}>Kokoro (built in)</option><option value="voicestudio" ${engine === 'voicestudio' ? 'selected' : ''} ${usable('voicestudio') ? '' : 'disabled'}>VoiceStudio${vs().ready ? '' : ' (offline)'}</option></select>
    <label>Voice</label><select name="voice">${voiceFieldOptions(engine, p.voice)}</select>
    <div data-model-wrap ${engine === 'voicestudio' ? '' : 'hidden'}><label>VoiceStudio engine</label><select name="model"><option value="">VoiceStudio's default</option>${vs().models.map(m => `<option ${m === p.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}${p.model && !vs().models.includes(p.model) ? `<option selected>${esc(p.model)}</option>` : ''}</select></div>
    <label>Speed</label><input name="speed" type="number" min="0.5" max="2" step="0.05" value="${p.speed ?? 1}">
    <label>Notes</label><input name="notes" maxlength="300" value="${esc(p.notes || '')}" placeholder="Personality, accent, use">`;
}

// A saved VoiceStudio voice stays selectable while VoiceStudio is closed.
function voiceFieldOptions(engine, current) {
  const options = engineReady(engine) ? optionsFor(engine, current || defaultVoice(engine)) : '';
  const known = engine === 'voicestudio' ? vs().voices.some(v => v.id === current) : data.voices.some(v => v.id === current);
  return (options + (current && !known ? `<option value="${esc(current)}" selected>${esc(current)}</option>` : '')) || '<option value="">No voices available</option>';
}
dialog.addEventListener('change', e => {
  if (e.target.name !== 'engine') return;
  dialog.querySelector('select[name=voice]').innerHTML = voiceFieldOptions(e.target.value, '');
  dialog.querySelector('[data-model-wrap]').hidden = e.target.value !== 'voicestudio';
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const save = dialog.querySelector('#voiceDialogSave'); save.disabled = true;
  try { await onSubmit(Object.fromEntries(new FormData(form))); dialog.close(); await loadVoice(); }
  catch (error) { toast(error.message); }
  finally { save.disabled = false; }
});
dialog.addEventListener('click', e => { if (e.target.closest('[data-voice-close]')) dialog.close(); });

root.addEventListener('input', e => {
  const key = e.target.dataset.draft;
  if (key) {
    draft[key] = e.target.value;
    if (key === 'speed') root.querySelector('[data-speed-out]').textContent = `${Number(e.target.value).toFixed(2)}×`;
    if (key === 'text') root.querySelector('.voice-say .hint').textContent = `${draft.text.trim().split(/\s+/).filter(Boolean).length} words`;
  }
  if (e.target.dataset.compareText !== undefined) compare.text = e.target.value;
});
root.addEventListener('change', e => {
  if (e.target.dataset.draft === 'profileId') { draft.profileId = e.target.value; render(); report(); }
  if (e.target.dataset.draft === 'engine') { draft.engine = e.target.value; draft.voice = ''; render(); }
  if (e.target.dataset.compareVoice !== undefined) compare.voices[Number(e.target.dataset.compareVoice)] = e.target.value;
});

root.addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t || busy) return;
  const act = t.dataset.voiceAct;
  if (act === 'reload') return loadVoice();
  if (act === 'vs-save') {
    t.disabled = true; t.textContent = 'Checking…';
    try {
      data.voicestudio = await request('/api/voice/voicestudio', { method: 'PUT', body: JSON.stringify({ url: root.querySelector('[data-vs-url]').value }) });
      toast(data.voicestudio.ready ? 'VoiceStudio connected' : 'VoiceStudio is not reachable yet');
    } catch (error) { toast(error.message); }
    return render();
  }
  if (act === 'generate') {
    if (!draft.text.trim()) return toast('Type a line first.');
    busy = 'generate'; render();
    try {
      const payload = draft.profileId ? { profileId: Number(draft.profileId), text: draft.text } : { engine: draft.engine, voice: draft.voice || defaultVoice(draft.engine), speed: Number(draft.speed), text: draft.text };
      const clip = await request('/api/voice/generate', { method: 'POST', body: JSON.stringify(payload) });
      busy = false; await loadVoice(); changed();
      root.querySelector('.voice-clips audio')?.play().catch(() => {});
      toast(`Line generated (${Number(clip.seconds).toFixed(1)}s)`);
    } catch (error) { busy = false; render(); toast(error.message); }
    return;
  }
  if (act === 'compare') {
    if (!compare.text.trim()) return toast('Type a line to compare.');
    busy = 'compare'; compare.results = []; render();
    const voices = [...new Set(compare.voices)];
    for (const voice of voices) {
      try { const clip = await request('/api/voice/generate', { method: 'POST', body: JSON.stringify({ voice, speed: 1, text: compare.text }) }); compare.results.push({ voice, url: clip.url }); }
      catch (error) { compare.results.push({ voice, error: error.message }); }
      render();
    }
    busy = false; await loadVoice(); changed();
    return;
  }
  if (act === 'new-profile') return openDialog('New character voice', profileFields(), 'Save character', async f => {
    const { id } = await request('/api/voice/profiles', { method: 'POST', body: JSON.stringify(f) }); draft.profileId = String(id); toast(`${f.name} saved`);
  });
  if (t.dataset.useVoice) return openDialog('Use this voice', `<label>Character</label><select name="profileId"><option value="">New character…</option>${data.profiles.map(p => `<option value="${p.id}">${esc(p.name)} (now ${esc(p.voice_label)})</option>`).join('')}</select><label>Name, for a new character</label><input name="name" maxlength="60" placeholder="e.g. Frank Madu"><input type="hidden" name="voice" value="${esc(t.dataset.useVoice)}"><p class="dialog-note">Voice: <strong>${esc(label(t.dataset.useVoice))}</strong></p>`, 'Save', async f => {
    if (f.profileId) await request(`/api/voice/profiles/${f.profileId}`, { method: 'PATCH', body: JSON.stringify({ engine: 'kokoro', voice: f.voice }) });
    else { if (!f.name?.trim()) throw new Error('Name the new character, or pick an existing one.'); await request('/api/voice/profiles', { method: 'POST', body: JSON.stringify({ name: f.name, engine: 'kokoro', voice: f.voice, speed: 1 }) }); }
    toast('Voice saved to character');
  });
  if (t.dataset.profileEdit) { const p = data.profiles.find(x => x.id === Number(t.dataset.profileEdit)); return openDialog(`Edit ${p.name}`, profileFields(p), 'Save changes', async f => { await request(`/api/voice/profiles/${p.id}`, { method: 'PATCH', body: JSON.stringify(f) }); toast('Character updated'); }); }
  if (t.dataset.profileDelete) { const p = data.profiles.find(x => x.id === Number(t.dataset.profileDelete)); return openDialog('Delete character?', `<p class="dialog-note">Delete <strong>${esc(p.name)}</strong>? Lines already generated stay in your library.</p>`, 'Delete character', async () => { await request(`/api/voice/profiles/${p.id}`, { method: 'DELETE' }); if (draft.profileId === String(p.id)) draft.profileId = ''; toast('Character deleted'); }); }
  if (t.dataset.clipDelete) { try { await request(`/api/voice/clips/${t.dataset.clipDelete}`, { method: 'DELETE' }); await loadVoice(); toast('Line deleted'); } catch (error) { toast(error.message); } }
});

document.addEventListener('click', e => { if (e.target.closest?.('.nav[data-view="voice"]')) loadVoice(); });
