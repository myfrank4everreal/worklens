// Workstation · Voice screen — character voice profiles, single lines, side-by-side voice
// comparison, and the history of generated clips. Backed by /api/voice; self-contained like
// brands.js and announces changes with the shared `workstation:changed` event.
const root = document.querySelector('#voiceRoot');
const dialog = document.querySelector('#voiceDialog');
const form = document.querySelector('#voiceForm');
const COMPARE_DEFAULT = ['am_onyx', 'am_michael', 'am_fenrir', 'am_adam'];
const SAMPLE = "Loyalty isn't proven when things are easy. It's proven when staying costs you something.";
let data = null, busy = false, onSubmit = null;
let draft = { profileId: '', voice: '', speed: 1, text: SAMPLE };
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
const changed = () => document.dispatchEvent(new CustomEvent('workstation:changed', { detail: { tool: 'voice' } }));

export async function loadVoice() {
  root.innerHTML = root.innerHTML || '<div class="card empty">Loading voice engine…</div>';
  try {
    data = await request('/api/voice');
    if (!draft.profileId && data.profiles[0]) draft.profileId = String(data.profiles[0].id);
    render();
  } catch (error) { root.innerHTML = `<div class="card empty">Couldn't load Voice: ${esc(error.message)}</div>`; }
}

function render() {
  const ready = data.ready;
  root.innerHTML = `
    <div class="section-head"><div><span class="eyebrow">STUDIO TOOL · VOICE</span><h2>Voice</h2></div>
      <span class="engine-chip ${ready ? 'ok' : 'warn'}"><i></i>${ready ? `Kokoro ready · ${esc(data.model)}` : 'Voice engine not ready'}</span></div>
    ${ready ? '' : `<div class="card engine-missing"><span class="eyebrow">SETUP NEEDED</span><h3>Kokoro can't run yet</h3><p>${esc(data.error)}</p>
      <p class="hint">The model downloads to <code>%USERPROFILE%\\.kokoro</code>. Once it's there, press <strong>Check again</strong>.</p><button data-voice-act="reload">Check again</button></div>`}
    <div class="voice-grid">
      <div class="card voice-say">
        <div class="section-title"><h3>Say a line</h3></div>
        <label>Character</label>
        <select name="profileId" data-draft="profileId"><option value="">Custom voice…</option>${data.profiles.map(p => `<option value="${p.id}" ${String(p.id) === draft.profileId ? 'selected' : ''}>${esc(p.name)} · ${esc(p.voice_label)}</option>`).join('')}</select>
        ${draft.profileId ? '' : `<label>Voice</label><select data-draft="voice" ${ready ? '' : 'disabled'}>${ready ? voiceOptions(draft.voice || 'am_onyx') : '<option>Engine not ready</option>'}</select>
        <label>Speed <span class="mono" data-speed-out>${Number(draft.speed).toFixed(2)}×</span></label><input type="range" min="0.6" max="1.4" step="0.05" value="${draft.speed}" data-draft="speed">`}
        <label>Line</label><textarea rows="4" maxlength="2000" data-draft="text" placeholder="What should they say?">${esc(draft.text)}</textarea>
        <div class="voice-actions"><span class="mono hint">${draft.text.trim().split(/\s+/).filter(Boolean).length} words</span><button class="primary" data-voice-act="generate" ${ready && !busy ? '' : 'disabled'}>${busy === 'generate' ? 'Generating…' : 'Generate'}</button></div>
      </div>
      <div class="card voice-profiles">
        <div class="section-title"><h3>Characters</h3><button data-voice-act="new-profile" ${ready ? '' : 'disabled'}>+ New</button></div>
        ${data.profiles.length ? data.profiles.map(p => `<div class="profile-row"><span class="profile-avatar">${esc(p.name.slice(0, 1))}</span><div class="profile-main"><strong>${esc(p.name)}</strong><small>${esc(p.voice_label)} · ${Number(p.speed).toFixed(2)}×</small>${p.notes ? `<small class="faint">${esc(p.notes)}</small>` : ''}</div><button class="icon-btn" title="Edit" data-profile-edit="${p.id}" ${ready ? '' : 'disabled'}>✎</button><button class="icon-btn danger" title="Delete" data-profile-delete="${p.id}">🗑</button></div>`).join('') : '<div class="empty">No characters yet.</div>'}
        <p class="hint">Give each character one permanent voice so every video sounds like the same person.</p>
      </div>
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
      ${data.clips.length ? data.clips.map(c => `<div class="clip-row"><div class="clip-main"><strong>${esc(c.text)}</strong><small>${esc(c.profile_name || label(c.voice))} · ${Number(c.seconds).toFixed(1)}s · ${new Date(c.created_at + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small></div>${c.url ? `<audio controls preload="none" src="${esc(c.url)}"></audio>` : '<small class="faint">file missing</small>'}<button class="icon-btn danger" title="Delete" data-clip-delete="${c.id}">🗑</button></div>`).join('') : '<div class="empty">Generated lines appear here, ready to drop into Studio.</div>'}
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
  return `<label>Character name</label><input name="name" maxlength="60" required value="${esc(p.name || '')}" placeholder="e.g. Frank Madu">
    <label>Voice</label><select name="voice">${voiceOptions(p.voice || 'am_onyx')}</select>
    <label>Speed</label><input name="speed" type="number" min="0.5" max="2" step="0.05" value="${p.speed ?? 1}">
    <label>Notes</label><input name="notes" maxlength="300" value="${esc(p.notes || '')}" placeholder="Personality, accent, use">`;
}

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
  if (e.target.dataset.draft === 'profileId') { draft.profileId = e.target.value; render(); }
  if (e.target.dataset.compareVoice !== undefined) compare.voices[Number(e.target.dataset.compareVoice)] = e.target.value;
});

root.addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t || busy) return;
  const act = t.dataset.voiceAct;
  if (act === 'reload') return loadVoice();
  if (act === 'generate') {
    if (!draft.text.trim()) return toast('Type a line first.');
    busy = 'generate'; render();
    try {
      const payload = draft.profileId ? { profileId: Number(draft.profileId), text: draft.text } : { voice: draft.voice || 'am_onyx', speed: Number(draft.speed), text: draft.text };
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
    if (f.profileId) await request(`/api/voice/profiles/${f.profileId}`, { method: 'PATCH', body: JSON.stringify({ voice: f.voice }) });
    else { if (!f.name?.trim()) throw new Error('Name the new character, or pick an existing one.'); await request('/api/voice/profiles', { method: 'POST', body: JSON.stringify({ name: f.name, voice: f.voice, speed: 1 }) }); }
    toast('Voice saved to character');
  });
  if (t.dataset.profileEdit) { const p = data.profiles.find(x => x.id === Number(t.dataset.profileEdit)); return openDialog(`Edit ${p.name}`, profileFields(p), 'Save changes', async f => { await request(`/api/voice/profiles/${p.id}`, { method: 'PATCH', body: JSON.stringify(f) }); toast('Character updated'); }); }
  if (t.dataset.profileDelete) { const p = data.profiles.find(x => x.id === Number(t.dataset.profileDelete)); return openDialog('Delete character?', `<p class="dialog-note">Delete <strong>${esc(p.name)}</strong>? Lines already generated stay in your library.</p>`, 'Delete character', async () => { await request(`/api/voice/profiles/${p.id}`, { method: 'DELETE' }); if (draft.profileId === String(p.id)) draft.profileId = ''; toast('Character deleted'); }); }
  if (t.dataset.clipDelete) { try { await request(`/api/voice/clips/${t.dataset.clipDelete}`, { method: 'DELETE' }); await loadVoice(); toast('Line deleted'); } catch (error) { toast(error.message); } }
});

document.addEventListener('click', e => { if (e.target.closest?.('.nav[data-view="voice"]')) loadVoice(); });
