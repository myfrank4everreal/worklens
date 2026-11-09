// Workstation · Engines — every way the workstation can make a video, with each engine kept visibly
// apart: Lemo-Opuscar's code-made styles and MoneyPrinterTurbo's stock-footage types. Also owns
// the film library (finished films from both engines, by brand and status), which it draws here
// and inside each brand's panel on the Brands screen ([data-brand-videos]).
import { reportContext } from '/monitor.js';
const root = document.querySelector('#enginesRoot');
const ENGINE = {
  lemo: { name: 'Lemo-Opuscar', kind: 'Code-made film', badge: 'CODE-MADE · NO FOOTAGE · $0', note: 'Every frame drawn in code from a style guide. Voice + score + foley made per film.' },
  mpt: { name: 'MoneyPrinterTurbo', kind: 'Stock-footage short', badge: 'STOCK FOOTAGE · AI SCRIPT · API KEYS', note: 'Script from an LLM or you, stock clips from Pexels/Pixabay, TTS voice and burned-in subtitles.' }
};
const STATUS_LABEL = { idea: 'Idea', script: 'Script', rendered: 'Rendered', checked: 'Checked', posted: 'Posted' };
let data = null, films = [], brands = [], projects = [], engineFilter = 'all', query = '', brandFor = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2400); }
async function request(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}
const fmt = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const styleName = f => f.engine === 'lemo' ? (data?.lemo.styles.find(s => s.slug === f.style)?.name || f.style || 'Unknown style') : (data?.mpt.types.find(s => s.slug === f.style)?.name || 'Stock short');
function remember() { try { localStorage.setItem('wl-engines-brand', String(brandFor || '')); } catch {} }
function recall() { try { return Number(localStorage.getItem('wl-engines-brand')) || null; } catch { return null; } }

async function loadAll() {
  const [e, b, p] = await Promise.all([request('/api/engines'), request('/api/brands').catch(() => ({ brands: [] })), request('/api/media/projects').catch(() => ({ projects: [] }))]);
  data = e; brands = b.brands; projects = p.projects;
  films = (await request('/api/engines/films')).films;
  if (brandFor == null) brandFor = recall();
  if (brandFor && !brands.some(x => x.id === brandFor)) brandFor = null;
}

export async function loadEngines() {
  if (!root.dataset.ready) { root.dataset.ready = '1'; root.innerHTML = '<div class="card empty">Looking at both engines…</div>'; }
  try { await loadAll(); render(); if (document.querySelector('#engines')?.classList.contains('active')) reportContext({ tool: 'engines', label: 'Engines' }); }
  catch (error) { root.innerHTML = `<div class="card empty">Couldn't load engines: ${esc(error.message)}</div>`; }
}

// ---------- film cards (shared by Engines and Brands) ----------
function checkChips(c) {
  if (!c) return '<span class="chk none">Not checked</span>';
  const ok = c.lufs != null && Math.abs(c.lufs + 14) <= 1;
  return `<span class="chk ${ok ? 'ok' : 'bad'}">${c.lufs == null ? '—' : c.lufs.toFixed(1)} LUFS</span><span class="chk ${c.black ? 'bad' : 'ok'}">${c.black} black</span><span class="chk ${c.white ? 'bad' : 'ok'}">${c.white} white</span>`;
}
function filmCard(f) {
  return `<article class="film-card eng-${f.engine}" data-film="${f.id}">
    <div class="film-thumb"><img src="${esc(f.thumb)}" loading="lazy" alt=""><span class="film-dur mono">${fmt(f.duration)}</span><a class="film-play" href="${esc(f.url)}" target="_blank" rel="noopener" title="Play">▶</a></div>
    <div class="film-body">
      <span class="eng-badge">${f.engine === 'lemo' ? 'CODE-MADE' : 'STOCK'}</span>
      <strong title="${esc(f.title)}">${esc(f.title)}</strong>
      <small>${esc(styleName(f))}</small>
      <div class="film-checks">${checkChips(f.checks)}</div>
      <div class="film-row"><select data-film-status aria-label="Status">${data.statuses.map(s => `<option value="${s}" ${f.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
        <select data-film-brand aria-label="Brand"><option value="">No brand</option>${brands.map(b => `<option value="${b.id}" ${f.brand_id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
      <div class="film-row"><button data-film-act="check" title="Loudness and black/white-frame check">Run checks</button><button data-film-act="studio" title="Open a copy in Studio to trim, caption and export">Edit in Studio</button></div>
      ${f.posted_on ? `<small class="mono">Posted ${esc(f.posted_on)}</small>` : ''}
    </div></article>`;
}

// ---------- Engines page ----------
function styleCard(engine, s) {
  const img = engine === 'lemo' && s.poster ? `<img src="/api/engines/poster?slug=${encodeURIComponent(s.slug)}${s.mine ? '&mine=1' : ''}" loading="lazy" alt="">` : `<span class="type-icon">${{ topic: '✦', script: '✎', local: '▤', batch: '⧉', landscape: '▭' }[s.slug] || '▶'}</span>`;
  return `<article class="style-card eng-${engine}">
    <div class="style-poster">${img}</div>
    <div class="style-body"><strong>${esc(s.name)}${s.mine ? ' <span class="mine-badge">MY STYLE</span>' : ''}</strong>${s.skill ? `<small class="used-by" title="Ask Claude Code to use this skill">Skill: ${esc(s.skill)}</small>` : ''}<p>${esc(s.line)}</p>
      <div class="style-uses">${(s.uses || []).slice(0, 3).map(u => `<span>${esc(u)}</span>`).join('')}</div>
      ${s.usedBy.length ? `<small class="used-by" title="${esc(s.usedBy.join(', '))}">Used by ${s.usedBy.length} film${s.usedBy.length === 1 ? '' : 's'}: ${esc(s.usedBy.slice(0, 2).join(', '))}${s.usedBy.length > 2 ? '…' : ''}</small>` : ''}
      <button data-new-video="${engine}:${esc(s.slug)}" data-style-name="${esc(s.name)}">New video${brandFor ? ' for brand' : ''}</button></div></article>`;
}
const matches = s => !query || `${s.name} ${s.line} ${(s.uses || []).join(' ')} ${s.category || ''}`.toLowerCase().includes(query);

function render() {
  const lemo = data.lemo, mpt = data.mpt;
  const groups = {};
  for (const s of lemo.styles.filter(matches)) (groups[s.category] ||= []).push(s);
  // My styles first, then the library's categories.
  const ordered = Object.entries(groups).sort(([a], [b]) => (b === 'My styles') - (a === 'My styles'));
  const mptTypes = mpt.types.filter(matches);
  const showLemo = engineFilter !== 'mpt', showMpt = engineFilter !== 'lemo';
  const unassigned = films.filter(f => !f.brand_id);
  root.innerHTML = `
    <div class="section-head eng-head"><div><span class="eyebrow">STUDIO TOOL · VIDEO ENGINES</span><h2>Engines</h2></div>
      <div class="eng-controls"><label>Making for <select data-eng-brand><option value="">No brand yet</option>${brands.map(b => `<option value="${b.id}" ${b.id === brandFor ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
        <input type="search" data-eng-q placeholder="Search styles and uses…" value="${esc(query)}">
        <div class="lib-filters">${[['all', 'Both'], ['lemo', 'Code-made'], ['mpt', 'Stock footage']].map(([k, l]) => `<button class="chip-btn ${engineFilter === k ? 'active' : ''}" data-eng-filter="${k}">${l}</button>`).join('')}</div></div></div>
    <div class="eng-compare">
      ${['lemo', 'mpt'].map(k => { const e = ENGINE[k], n = k === 'lemo' ? lemo.styles.length : mpt.types.length, made = films.filter(f => f.engine === k).length;
        const state = k === 'lemo' ? (lemo.found ? `<span class="ok">● Found</span> · ${esc(lemo.path)}` : `<span class="bad">● Not found</span> at ${esc(lemo.path)}`)
          : !mpt.found ? `<span class="bad">● Not found</span> at ${esc(mpt.path)}` : !mpt.installed ? '<span class="warn">● Cloned, Python packages not installed</span>'
          : `<span class="ok">● Installed</span> · stock keys: Pexels ${mpt.stockKeys.pexels ? '✓' : '✗'} · Pixabay ${mpt.stockKeys.pixabay ? '✓' : '✗'}`;
        return `<div class="card eng-summary eng-${k}"><span class="eng-badge">${e.badge}</span><h3>${e.name}</h3><p>${e.note}</p>
          <div class="eng-stats"><div><strong>${n}</strong><span>${k === 'lemo' ? 'styles' : 'video types'}</span></div><div><strong>${made}</strong><span>films made</span></div></div>
          <small>${state}</small>${k === 'mpt' && mpt.installed ? `<div class="film-row"><button data-mpt-start>${mpt.webui ? 'Open web UI' : 'Start web UI'}</button></div>` : ''}
          ${k === 'mpt' && mpt.installed && !mpt.stockKeys.pexels && !mpt.stockKeys.pixabay ? '<small class="warn">Add a free Pexels or Pixabay key in its web UI (Basic settings) before making a video.</small>' : ''}</div>`; }).join('')}
    </div>
    ${showLemo ? `<section class="eng-block eng-lemo"><div class="eng-block-head"><span class="eng-badge">CODE-MADE</span><h3>Lemo-Opuscar styles</h3><span class="eyebrow">${lemo.styles.length} STYLES · ${Object.keys(groups).length} CATEGORIES</span></div>
      ${ordered.map(([cat, list]) => `<h4 class="eng-cat">${esc(cat)} <span>${list.length}</span></h4><div class="style-grid">${list.map(s => styleCard('lemo', s)).join('')}</div>`).join('') || '<div class="empty">No style matches that search.</div>'}</section>` : ''}
    ${showMpt ? `<section class="eng-block eng-mpt"><div class="eng-block-head"><span class="eng-badge">STOCK FOOTAGE</span><h3>MoneyPrinterTurbo video types</h3><span class="eyebrow">${mpt.types.length} TYPES</span></div>
      <div class="style-grid">${mptTypes.map(s => styleCard('mpt', s)).join('') || '<div class="empty">No type matches that search.</div>'}</div></section>` : ''}
    <section class="card eng-films"><div class="section-title"><h3>Film library</h3><span class="eyebrow">${films.length} FILMS · ${unassigned.length} WITHOUT A BRAND</span></div>
      <p class="hint">Finished films are picked up from both engines' output folders. Give each one a brand and a status; Brands shows them per brand.</p>
      <div class="film-grid">${films.map(filmCard).join('') || '<div class="empty">No finished films yet.</div>'}</div></section>`;
}

// ---------- the Videos block inside a brand's panel ----------
// One status at a time behind tabs (the same tabs as Content), so the cards get the full width
// instead of five narrow columns. Each brand remembers its last tab.
const STATUS_HINT = {
  idea: 'Planned, not made yet.', script: 'Script written, waiting to be rendered.', rendered: 'Made. Run the check before posting.',
  checked: 'Passed the check: loudness right, no black or white frames. Ready to post.', posted: 'Out on the brand’s accounts.'
};
const videoStage = {};
// Studio projects show as chips above the tabs; past a handful they crowd out the videos, so the
// rest fold behind "Show all".
const STUDIO_SHOWN = 6, studioOpen = new Set();
function stageFor(id, counts) {
  let s = videoStage[id];
  if (s === undefined) { try { s = localStorage.getItem(`wl-video-stage-${id}`); } catch { s = null; } }
  if (!data.statuses.includes(s)) s = data.statuses.find(st => st !== 'posted' && counts[st]) || data.statuses[0];
  return (videoStage[id] = s);
}
function brandVideos(el) {
  const id = Number(el.dataset.brandVideos);
  const mine = films.filter(f => f.brand_id === id), edits = projects.filter(p => p.brand_id === id);
  const counts = Object.fromEntries(data.statuses.map(s => [s, mine.filter(f => f.status === s).length]));
  const stage = stageFor(id, counts), list = mine.filter(f => f.status === stage);
  const tabs = data.statuses.map((s, n) => `<button class="stage-tab ${s === stage ? 'active' : ''} ${s}" data-video-stage="${id}:${s}" role="tab" aria-selected="${s === stage}"><span class="stage-num">${n + 1}</span><span class="stage-name">${STATUS_LABEL[s]}</span><em>${counts[s]}</em></button>`).join('');
  const lemoN = mine.filter(f => f.engine === 'lemo').length;
  el.innerHTML = `<div class="card brand-videos"><div class="section-title"><h3>Videos</h3><span class="eyebrow">${mine.length} FILMS · ${lemoN} CODE-MADE · ${mine.length - lemoN} STOCK · ${edits.length} IN STUDIO</span></div>
    ${edits.length ? `<div class="brand-edits"><span class="eyebrow">IN STUDIO</span>${(studioOpen.has(id) ? edits : edits.slice(0, STUDIO_SHOWN)).map(p => `<button class="chip-btn" data-open-studio="${p.id}">▶ ${esc(p.title)}</button>`).join('')}${edits.length > STUDIO_SHOWN ? `<button class="link-btn" data-studio-more="${id}">${studioOpen.has(id) ? 'Show fewer' : `Show all ${edits.length}`}</button>` : ''}</div>` : ''}
    ${mine.length ? `<div class="stage-tabs" role="tablist">${tabs}</div>
      <p class="stage-hint">${esc(STATUS_HINT[stage])}${list.length ? ` · ${list.length} film${list.length === 1 ? '' : 's'}` : ''}</p>
      ${list.length ? `<div class="film-grid brand-film-grid">${list.map(filmCard).join('')}</div>` : `<div class="empty">No films in ${STATUS_LABEL[stage]}.</div>`}`
    : `<div class="empty">No films for this brand yet. Pick a style in <button class="link-btn" data-open-tool="engines">Engines</button>, or give an existing film this brand in the film library.</div>`}</div>`;
}
async function fillBrandVideos() {
  const slots = document.querySelectorAll('[data-brand-videos]'); if (!slots.length) return;
  try { if (!data) await loadAll(); slots.forEach(brandVideos); } catch (error) { slots.forEach(s => { s.innerHTML = `<div class="card empty">Couldn't load videos: ${esc(error.message)}</div>`; }); }
}
new MutationObserver(() => { if (document.querySelector('[data-brand-videos]:empty')) fillBrandVideos(); }).observe(document.querySelector('#brandsRoot'), { childList: true, subtree: true });

function redrawAll() { if (root.dataset.ready && data) render(); document.querySelectorAll('[data-brand-videos]').forEach(brandVideos); }
function openStudio(id) { document.dispatchEvent(new CustomEvent('studio:open', { detail: { id } })); document.querySelector('.nav[data-view="studio"]')?.click(); }

document.addEventListener('click', async e => {
  const t = e.target;
  if (t.closest?.('.nav[data-view="engines"]')) return loadEngines();
  if (!t.closest?.('#enginesRoot,[data-brand-videos]')) return;
  if (t.dataset.studioMore) {
    const b = Number(t.dataset.studioMore);
    if (studioOpen.has(b)) studioOpen.delete(b); else studioOpen.add(b);
    return document.querySelectorAll(`[data-brand-videos="${b}"]`).forEach(brandVideos);
  }
  const stageTab = t.closest('[data-video-stage]');
  if (stageTab) {
    const [b, s] = stageTab.dataset.videoStage.split(':');
    videoStage[b] = s; try { localStorage.setItem(`wl-video-stage-${b}`, s); } catch {}
    return document.querySelectorAll(`[data-brand-videos="${b}"]`).forEach(brandVideos);
  }
  if (t.dataset.engFilter) { engineFilter = t.dataset.engFilter; return render(); }
  if (t.dataset.openStudio) return openStudio(Number(t.dataset.openStudio));
  if (t.dataset.newVideo) {
    const [engine, style] = t.dataset.newVideo.split(':');
    try { const { id } = await request('/api/engines/new-project', { method: 'POST', body: JSON.stringify({ engine, style, brandId: brandFor, title: `${t.dataset.styleName} · new film` }) }); toast(`Studio project made for ${ENGINE[engine].name}`); return openStudio(id); }
    catch (error) { return toast(error.message); }
  }
  if (t.matches('[data-mpt-start]')) {
    t.disabled = true; t.textContent = data.mpt.webui ? 'Opening…' : 'Starting (~30 s)…';
    try { const { url } = await request('/api/engines/mpt/start', { method: 'POST', body: '{}' }); window.open(url, '_blank', 'noopener'); data.mpt.webui = url; render(); }
    catch (error) { toast(error.message); render(); }
    return;
  }
  const card = t.closest('[data-film]'); if (!card || !t.dataset.filmAct) return;
  const f = films.find(x => x.id === card.dataset.film);
  if (t.dataset.filmAct === 'check') {
    t.disabled = true; t.textContent = 'Checking…';
    try { f.checks = (await request(`/api/engines/films/${f.id}/check`, { method: 'POST', body: '{}' })).checks; if (f.checks.pass && ['idea', 'script', 'rendered'].includes(f.status)) f.status = 'checked'; toast(f.checks.pass ? 'Passed: −14 LUFS, no black or white frames' : 'Check found problems'); }
    catch (error) { toast(error.message); }
    return redrawAll();
  }
  if (t.dataset.filmAct === 'studio') {
    try { const { id } = await request(`/api/engines/films/${f.id}/studio`, { method: 'POST', body: JSON.stringify({ brandId: f.brand_id }) }); openStudio(id); }
    catch (error) { toast(error.message); }
  }
});
document.addEventListener('change', async e => {
  const t = e.target, card = t.closest?.('[data-film]');
  if (t.matches?.('[data-eng-brand]')) { brandFor = Number(t.value) || null; remember(); return render(); }
  if (!card) return;
  const f = films.find(x => x.id === card.dataset.film), patch = {};
  if (t.matches('[data-film-status]')) patch.status = f.status = t.value;
  else if (t.matches('[data-film-brand]')) patch.brandId = f.brand_id = Number(t.value) || null;
  else return;
  try { await request(`/api/engines/films/${f.id}`, { method: 'PATCH', body: JSON.stringify(patch) }); if (patch.status === 'posted') f.posted_on = new Date().toLocaleDateString('en-CA'); redrawAll(); }
  catch (error) { toast(error.message); }
});
document.addEventListener('input', e => { if (e.target.matches?.('[data-eng-q]')) { query = e.target.value.trim().toLowerCase(); const pos = e.target.selectionStart; render(); const q = root.querySelector('[data-eng-q]'); q.focus(); q.setSelectionRange(pos, pos); } });
document.addEventListener('workstation:changed', () => { if (data) loadAll().then(redrawAll).catch(() => {}); });
