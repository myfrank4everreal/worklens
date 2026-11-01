// Workstation · Studio — a light 9:16 video editor over /api/media. One video track (clips and
// stills, then an optional end card), timed captions drawn to PNG in the browser, and any number
// of audio lines (voice, music). The preview plays the timeline live in the page; Export hands the
// same timeline to the ffmpeg render engine (src/media/render.js). Self-contained like voice.js and
// announces changes with the shared `workstation:changed` event.
import { reportContext } from '/monitor.js';
const root = document.querySelector('#studioRoot');
const dialog = document.querySelector('#studioDialog');
const form = document.querySelector('#studioForm');
const W = 1080, H = 1920, X0 = 10;
// Caption layout in output pixels. "bottom" sits above the caption/handle area of IG and TikTok.
const CAPTION = { sizes: { s: 56, m: 76, l: 104 }, y: { top: 330, center: 960, bottom: 1440 } };
const FOLDER = { uploads: 'Upload', voice: 'Voice line', renders: 'Export', frames: 'Frame' };

let project = null, projects = [], library = [], renders = [], brands = [];
let filter = 'all', selected = null, pps = 40;
let t = 0, playing = false, base = null, drag = null;
let saveTimer = null, pollTimer = null, exporting = false, onSubmit = null;
let videoEl, imgEl, capEl;
const audioEls = new Map();
const captionCache = new Map();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2400); }
async function request(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}
const changed = () => document.dispatchEvent(new CustomEvent('workstation:changed', { detail: { tool: 'studio' } }));
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const snap = v => Math.round(v * 20) / 20;
const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const mediaUrl = src => `/api/media/file?path=${encodeURIComponent(src)}`;
// Uploads carry a leading timestamp and voice lines a trailing one; neither helps a person.
const prettyName = name => String(name).split('/').pop().replace(/^\d{10,}-/, '').replace(/-\d{10,}(?=\.\w+$)/, '').replace(/_/g, ' ');
const kindOf = item => item.type.startsWith('video') ? 'video' : item.type.startsWith('image') ? 'image' : 'audio';
const isCaptionFile = item => /^\d+-caption-/.test(item.name);
const mb = bytes => bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

const blank = () => ({ width: W, height: H, fps: 30, clips: [], captions: [], audio: [], clipAudio: { keep: true, volume: 1 }, endCard: null });
const tl = () => project.timeline;
const isActive = () => document.querySelector('#studio')?.classList.contains('active');
// Tells WorkLens what's being edited; the brand link puts the time on that brand's project.
function report() {
  if (!project || !isActive()) return;
  const brand = brands.find(b => b.id === project.brandId);
  reportContext({ tool: 'studio', label: `Editing "${project.title}"${brand ? ` · ${brand.name}` : ''}`, studioProjectId: project.id });
}
const clipLen = c => c.kind === 'image' ? c.duration : Math.max(0.1, (c.out ?? c.srcDuration) - c.in);
const audioLen = a => Math.max(0.1, (a.out ?? a.srcDuration) - a.in);

function segments() {
  const out = []; let start = 0;
  for (const clip of tl().clips) { const len = clipLen(clip); out.push({ clip, start, len }); start += len; }
  const end = tl().endCard;
  if (end?.src) out.push({ clip: { ...end, kind: 'image', id: 'end' }, start, len: end.duration, end: true });
  return out;
}
const total = () => segments().reduce((s, x) => s + x.len, 0);

// ---------- loading and saving ----------
export async function loadStudio() {
  if (!root.dataset.ready) shell();
  try {
    await document.fonts.load('800 76px Inter').catch(() => {});
    const [p, lib, r, b] = await Promise.all([request('/api/media/projects'), request('/api/media/library'), request('/api/media/renders'), request('/api/brands').catch(() => ({ brands: [] }))]);
    projects = p.projects; library = lib.items; renders = r.renders; brands = b.brands;
    if (!project) { if (projects[0]) await openProject(projects[0].id); else await newProject(); }
    renderAll(); poll(); report();
  } catch (error) { toast(`Couldn't load Studio: ${error.message}`); }
}

async function openProject(id) {
  pause();
  const row = await request(`/api/media/projects/${id}`);
  project = { id: row.id, title: row.title, brandId: row.brand_id || null, timeline: { ...blank(), ...row.timeline } };
  t = 0; selected = null; report();
}
async function newProject() {
  const { id } = await request('/api/media/projects', { method: 'POST', body: JSON.stringify({ title: 'Untitled video', timeline: blank() }) });
  projects = (await request('/api/media/projects')).projects;
  await openProject(id);
}

function scheduleSave() {
  setSaveState('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}
async function saveNow(keepalive = false) {
  clearTimeout(saveTimer); saveTimer = null;
  if (!project) return;
  try {
    await fetch(`/api/media/projects/${project.id}`, { method: 'PUT', keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: project.title, brandId: project.brandId, timeline: project.timeline }) });
    setSaveState('Saved');
  } catch { setSaveState('Not saved'); }
}
function setSaveState(text) { const el = root.querySelector('[data-save-state]'); if (el) el.textContent = text; }
window.addEventListener('pagehide', () => { if (saveTimer) saveNow(true); });

async function refreshLibrary() { library = (await request('/api/media/library')).items; renderLibrary(); renderInspector(); }
async function refreshRenders() {
  const before = new Map(renders.map(r => [r.id, r.status]));
  renders = (await request('/api/media/renders')).renders;
  for (const r of renders) {
    if (before.get(r.id) !== 'running' || r.status === 'running') continue;
    if (r.status === 'done') { toast(`Export finished: ${r.title || `Render ${r.id}`}`); changed(); refreshLibrary(); }
    if (r.status === 'failed') toast(`Export failed: ${r.error.slice(0, 120)}`);
  }
  renderExports(); poll();
}
function poll() {
  clearTimeout(pollTimer);
  if (renders.some(r => r.status === 'running')) pollTimer = setTimeout(() => refreshRenders().catch(() => poll()), 1000);
}

// ---------- layout ----------
function shell() {
  root.dataset.ready = '1';
  root.innerHTML = `
    <div class="section-head studio-head"><div><span class="eyebrow">STUDIO TOOL · VIDEO EDITOR</span><h2>Studio</h2></div>
      <div class="studio-head-actions"><select data-st-project aria-label="Video project"></select><button data-st-act="new">+ New</button><button class="icon-btn danger" title="Delete this project" data-st-act="delete-project">🗑</button>
        <span class="save-state mono" data-save-state></span><button class="primary" data-st-act="export">Export video</button></div></div>
    <div class="studio-top">
      <div class="card studio-preview">
        <div class="stage" data-stage><video playsinline preload="auto"></video><img class="stage-img" alt=""><div class="stage-captions"></div><div class="stage-empty">Add a clip from Media to start</div></div>
        <div class="transport"><button class="primary" data-st-act="play" title="Play / pause (Space)">▶</button><span class="mono" data-time>0:00.0 / 0:00.0</span><span class="eyebrow">1080×1920</span></div>
      </div>
      <div class="card studio-inspector" data-inspector></div>
      <div class="card studio-library" data-drop>
        <div class="section-title"><h3>Media</h3><label class="upload-btn">Upload<input type="file" multiple accept="video/*,image/*,audio/*" hidden data-upload></label></div>
        <div class="lib-filters">${['all', 'video', 'image', 'audio'].map(f => `<button class="chip-btn" data-filter="${f}">${{ all: 'All', video: 'Video', image: 'Images', audio: 'Audio' }[f]}</button>`).join('')}</div>
        <div class="lib-list" data-library></div>
        <p class="hint">Drop files here. Voice lines from the Voice tool show up under Audio.</p>
      </div>
    </div>
    <div class="card studio-timeline">
      <div class="tl-toolbar">
        <button data-st-act="split" title="Split the clip at the playhead (S)">✂ Split</button>
        <button data-st-act="caption">+ Caption</button>
        <button data-st-act="preset" title="Adds a hook caption and an end card">Brand 9:16 preset</button>
        <span class="tl-spacer"></span>
        <span class="eyebrow">ZOOM</span><button data-st-act="zoom-out" title="Zoom out">−</button><button data-st-act="zoom-in" title="Zoom in">+</button>
      </div>
      <div class="tl-body"><div class="tl-labels" data-tl-labels></div><div class="tl-scroll" data-tl-scroll><div class="tl-inner" data-tl></div></div></div>
    </div>
    <div class="card studio-exports"><div class="section-title"><h3>Exports</h3><span class="eyebrow">H.264 · AAC · LOGGED TO WORKLENS</span></div><div data-exports></div></div>`;
  videoEl = root.querySelector('.stage video');
  imgEl = root.querySelector('.stage-img');
  capEl = root.querySelector('.stage-captions');
  videoEl.addEventListener('loadedmetadata', () => { if (videoEl.pendingTime != null) { videoEl.currentTime = videoEl.pendingTime; videoEl.pendingTime = null; } });
}

function renderAll() { renderHead(); renderInspector(); renderLibrary(); renderTimeline(); renderExports(); syncPreview(); }

function renderHead() {
  root.querySelector('[data-st-project]').innerHTML = projects.map(p => `<option value="${p.id}" ${p.id === project.id ? 'selected' : ''}>${esc(p.id === project.id ? project.title : p.title)}</option>`).join('');
  const btn = root.querySelector('[data-st-act="export"]');
  btn.disabled = exporting; btn.textContent = exporting ? 'Preparing…' : 'Export video';
}

function renderLibrary() {
  root.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  const items = library.filter(i => !isCaptionFile(i) && (filter === 'all' || kindOf(i) === filter));
  root.querySelector('[data-library]').innerHTML = items.length ? items.map(i => {
    const kind = kindOf(i);
    const thumb = kind === 'video' ? `<video src="${esc(i.url)}#t=0.5" preload="metadata" muted></video>` : kind === 'image' ? `<img src="${esc(i.url)}" loading="lazy" alt="">` : '<span>♪</span>';
    return `<div class="lib-item"><div class="lib-thumb">${thumb}</div><div class="lib-main"><strong title="${esc(prettyName(i.name))}">${esc(prettyName(i.name))}</strong><small>${FOLDER[i.folder] || i.folder} · ${mb(i.size)}</small></div><button data-add="${esc(i.path)}" title="${kind === 'audio' ? 'Add at the playhead' : 'Add to the end of the video track'}">+ Add</button></div>`;
  }).join('') : `<div class="empty">${library.length ? 'Nothing of this type yet.' : 'Upload clips, images or music to begin.'}</div>`;
}

function selectedItem() {
  if (!selected) return null;
  if (selected.kind === 'end') return tl().endCard;
  const list = { clip: tl().clips, caption: tl().captions, audio: tl().audio }[selected.kind];
  return list.find(x => x.id === selected.id) || null;
}

const num = (key, value, attrs = '') => `<input type="number" step="0.05" data-f="${key}" value="${Number(value).toFixed(2)}" ${attrs}>`;
function renderInspector() {
  const el = root.querySelector('[data-inspector]');
  const item = selectedItem();
  if (!item) selected = null;
  const images = library.filter(i => kindOf(i) === 'image' && !isCaptionFile(i));
  if (!selected) {
    const end = tl().endCard;
    el.innerHTML = `<div class="section-title"><h3>Project</h3><span class="eyebrow">${fmt(total())} TOTAL</span></div>
      <div class="insp-grid"><div><label>Title</label><input data-p="title" maxlength="120" value="${esc(project.title)}"></div>
        <div><label>Brand</label><select data-p="brand"><option value="">No brand</option>${brands.map(b => `<option value="${b.id}" ${b.id === project.brandId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div></div>
      <div class="insp-grid">
        <div><label>Clip sound</label><label class="check-row"><input type="checkbox" data-p="keep" ${tl().clipAudio.keep ? 'checked' : ''}> Keep the clips' own audio</label></div>
        <div><label>Clip volume <span class="mono" data-out="clipvol">${Math.round(tl().clipAudio.volume * 100)}%</span></label><input type="range" min="0" max="1.5" step="0.05" data-p="clipvol" value="${tl().clipAudio.volume}"></div>
        <div><label>End card</label><select data-p="end"><option value="">None</option>${images.map(i => `<option value="${esc(i.path)}" ${end?.src === i.path ? 'selected' : ''}>${esc(prettyName(i.name))}</option>`).join('')}</select></div>
        <div><label>End card seconds</label>${num('end-duration', end?.duration ?? 3, end ? 'data-p="end-duration" min="1" max="10"' : 'disabled')}</div>
      </div>
      <p class="hint">Output: 1080×1920, 30 fps, H.264 + AAC. Each clip is cropped to fill the frame. Select a block on the timeline to edit it.</p>
      <p class="hint">${(() => { const b = brands.find(x => x.id === project.brandId); return b ? (b.project_id ? `Editing time and exports are logged to ${esc(b.name)}'s WorkLens project.` : `${esc(b.name)} isn't linked to a WorkLens project yet (Brands → edit brand), so time is logged unassigned.`) : 'Pick a brand to log editing time and exports to its WorkLens project.'; })()}</p>`;
    return;
  }
  const actions = extra => `<div class="insp-actions">${extra}<button class="danger-text" data-st-act="remove">Delete</button></div>`;
  if (selected.kind === 'clip') {
    const c = item, i = tl().clips.indexOf(c);
    el.innerHTML = `<div class="section-title"><h3>${c.kind === 'image' ? 'Image' : 'Clip'}</h3><span class="eyebrow">${i + 1} OF ${tl().clips.length} · ${clipLen(c).toFixed(1)}s</span></div>
      <p class="insp-name" title="${esc(c.name)}">${esc(c.name)}</p>
      <div class="insp-grid">${c.kind === 'image'
        ? `<div><label>Seconds on screen</label>${num('duration', c.duration, 'min="0.3"')}</div>`
        : `<div><label>Start at (trim in)</label>${num('in', c.in, 'min="0"')}</div><div><label>End at (trim out)</label>${num('out', c.out ?? c.srcDuration, 'min="0"')}</div>`}</div>
      ${c.kind === 'video' ? `<p class="hint">Source is ${c.srcDuration.toFixed(1)}s. Drag a block's edges to trim, or the block itself to reorder.</p>` : ''}
      ${actions(`<button data-st-act="left" ${i === 0 ? 'disabled' : ''}>← Earlier</button><button data-st-act="right" ${i === tl().clips.length - 1 ? 'disabled' : ''}>Later →</button><button data-st-act="split">✂ Split</button>${c.kind === 'video' ? '<button data-st-act="last-frame" title="Save the final frame as an image, e.g. the start frame for the next AI clip">Save last frame</button>' : ''}`)}`;
  } else if (selected.kind === 'caption') {
    const c = item;
    el.innerHTML = `<div class="section-title"><h3>Caption</h3><span class="eyebrow">${(c.end - c.start).toFixed(1)}s ON SCREEN</span></div>
      <label>Text</label><textarea rows="2" maxlength="200" data-f="text">${esc(c.text)}</textarea>
      <div class="insp-grid"><div><label>From</label>${num('start', c.start, 'min="0"')}</div><div><label>To</label>${num('end', c.end, 'min="0"')}</div>
        <div><label>Position</label><select data-f="pos">${['top', 'center', 'bottom'].map(v => `<option ${c.pos === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div><label>Size</label><select data-f="size">${[['s', 'Small'], ['m', 'Medium'], ['l', 'Large']].map(([v, l]) => `<option value="${v}" ${c.size === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      ${actions('')}`;
  } else if (selected.kind === 'audio') {
    const a = item;
    el.innerHTML = `<div class="section-title"><h3>Audio</h3><span class="eyebrow">${audioLen(a).toFixed(1)}s</span></div>
      <p class="insp-name" title="${esc(a.name)}">${esc(a.name)}</p>
      <div class="insp-grid"><div><label>Starts at</label>${num('start', a.start, 'min="0"')}</div><div><label>Volume <span class="mono" data-out="volume">${Math.round(a.volume * 100)}%</span></label><input type="range" min="0" max="2" step="0.05" data-f="volume" value="${a.volume}"></div>
        <div><label>Trim in</label>${num('in', a.in, 'min="0"')}</div><div><label>Trim out</label>${num('out', a.out ?? a.srcDuration, 'min="0"')}</div></div>
      ${actions('<button data-st-act="to-playhead">Start at playhead</button>')}`;
  } else {
    el.innerHTML = `<div class="section-title"><h3>End card</h3><span class="eyebrow">FADES IN · ${item.duration.toFixed(1)}s</span></div>
      <p class="insp-name">${esc(item.name)}</p><div class="insp-grid"><div><label>Seconds</label>${num('duration', item.duration, 'min="1" max="10"')}</div></div>
      ${actions('')}`;
  }
}

function renderTimeline() {
  const segs = segments(), len = total();
  const width = X0 * 2 + Math.max(len + 4, 16) * pps;
  const step = pps >= 70 ? 1 : pps >= 30 ? 2 : pps >= 15 ? 5 : 10;
  let ruler = '';
  for (let s = 0; s * pps < width; s += step) ruler += `<span style="left:${X0 + s * pps}px">${s < 60 ? `${s}s` : fmt(s).replace(/\.0$/, '')}</span>`;
  const sel = (kind, id) => selected?.kind === kind && selected.id === id ? ' sel' : '';
  const block = (cls, kind, id, start, len, label, sub, dx = 0) =>
    `<div class="tl-block ${cls}${sel(kind, id)}${dx ? ' dragging' : ''}" data-block="${kind}" data-id="${id}" style="left:${X0 + start * pps + dx}px;width:${Math.max(6, len * pps)}px"><i class="h l" data-handle="l"></i><span>${esc(label)}</span><small>${sub}</small><i class="h r" data-handle="r"></i></div>`;
  const video = segs.map(s => {
    const dx = drag?.mode === 'move' && drag.kind === 'clip' && drag.id === s.clip.id ? drag.dx * pps : 0;
    return s.end ? block('end', 'end', 'end', s.start, s.len, 'End card', `${s.len.toFixed(1)}s`)
      : block(s.clip.kind, 'clip', s.clip.id, s.start, s.len, s.clip.name, `${s.len.toFixed(1)}s`, dx);
  }).join('');
  const captions = tl().captions.map(c => block('caption', 'caption', c.id, c.start, c.end - c.start, c.text || 'Empty caption', `${(c.end - c.start).toFixed(1)}s`)).join('');
  const audioRows = tl().audio.length ? tl().audio.map(a => `<div class="tl-row audio-row">${block('audio', 'audio', a.id, a.start, audioLen(a), a.name, `${Math.round(a.volume * 100)}%`)}</div>`).join('')
    : '<div class="tl-row audio-row"><span class="tl-hint">Add a voice line or music from Media</span></div>';
  root.querySelector('[data-tl]').innerHTML = `<div class="tl-ruler" data-seek>${ruler}</div>
    <div class="tl-row" data-seek>${video || '<span class="tl-hint">Add clips or images from Media</span>'}</div>
    <div class="tl-row caption-row" data-seek>${captions || '<span class="tl-hint">+ Caption adds text at the playhead</span>'}</div>
    ${audioRows}<div class="tl-playhead" style="left:${X0 + t * pps}px"></div>`;
  root.querySelector('[data-tl]').style.width = `${width}px`;
  root.querySelector('[data-tl-labels]').innerHTML = `<div class="tl-ruler"></div><div class="tl-row">Video</div><div class="tl-row caption-row">Captions</div>${(tl().audio.length ? tl().audio : [null]).map((a, i) => `<div class="tl-row audio-row">${i ? '' : 'Audio'}</div>`).join('')}`;
}

function renderExports() {
  const el = root.querySelector('[data-exports]');
  el.innerHTML = renders.length ? `<div class="export-grid">${renders.map(r => {
    const status = r.status === 'running' ? `Rendering · ${Math.round(r.progress * 100)}%` : r.status === 'done' ? `${Number(r.duration).toFixed(1)}s · ${new Date(r.finished_at + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : r.status === 'failed' ? 'Failed' : 'Cancelled';
    return `<div class="export-card ${r.status}"><strong title="${esc(r.title)}">${esc(r.title || `Render ${r.id}`)}</strong><small>${status}</small>
      ${r.status === 'running' ? `<div class="export-bar"><i style="width:${Math.round(r.progress * 100)}%"></i></div>` : ''}
      ${r.url ? `<video controls preload="metadata" src="${esc(r.url)}"></video>` : ''}${r.status === 'failed' ? `<small class="err">${esc(r.error.slice(0, 200))}</small>` : ''}
      <div class="export-actions">${r.status === 'running' ? `<button data-render-cancel="${r.id}">Cancel</button>`
        : `${r.url ? `<a class="btn-link" href="${esc(r.url)}" download="${esc((r.title || `render-${r.id}`).replace(/[^\w\- ]+/g, '_'))}.mp4">Save as…</a>` : ''}<button class="icon-btn danger" title="Delete export" data-render-delete="${r.id}">🗑</button>`}</div></div>`;
  }).join('')}</div>` : '<div class="empty">Exported videos appear here. Each export is logged on your WorkLens timeline.</div>';
}

// ---------- captions (drawn once, used by both the preview and the export) ----------
function wrapLines(g, text, max) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && g.measureText(next).width > max) { lines.push(line); line = word; } else line = next;
    }
    lines.push(line);
  }
  return lines.filter((l, i, all) => l || all.length === 1);
}
function drawCaption(c) {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const size = CAPTION.sizes[c.size] || CAPTION.sizes.m;
  g.font = `800 ${size}px Inter, "Segoe UI", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const lines = wrapLines(g, c.text, 880);
  const lh = size * 1.2, padX = size * 0.42, boxH = size * 1.34;
  let y = (CAPTION.y[c.pos] ?? CAPTION.y.center) - (lines.length * lh) / 2;
  for (const line of lines) {
    const w = g.measureText(line).width;
    if (w) {
      g.fillStyle = 'rgba(10,10,11,0.8)';
      g.beginPath(); g.roundRect(W / 2 - w / 2 - padX, y + (lh - boxH) / 2, w + padX * 2, boxH, size * 0.24); g.fill();
      g.fillStyle = '#fafafb'; g.fillText(line, W / 2, y + lh / 2 + size * 0.04);
    }
    y += lh;
  }
  return canvas;
}
function captionUrl(c) {
  const key = `${c.text}|${c.pos}|${c.size}`;
  if (!captionCache.has(key)) captionCache.set(key, drawCaption(c).toDataURL('image/png'));
  return captionCache.get(key);
}

// ---------- preview ----------
function syncPreview() {
  if (!videoEl || !project) return;
  const segs = segments(), len = total();
  t = clamp(t, 0, len);
  const seg = segs.find(s => t >= s.start && t < s.start + s.len) || (segs.length && t >= len ? segs[segs.length - 1] : null);
  root.querySelector('.stage-empty').hidden = segs.length > 0;
  if (seg?.clip.kind === 'video') {
    const url = mediaUrl(seg.clip.src);
    const target = seg.clip.in + Math.min(t - seg.start, seg.len - 0.04);
    imgEl.hidden = true; videoEl.hidden = false;
    if (videoEl.dataset.src !== url) { videoEl.dataset.src = url; videoEl.pendingTime = target; videoEl.src = url; }
    else if (videoEl.readyState >= 1 && Math.abs(videoEl.currentTime - target) > (playing ? 0.3 : 0.03)) videoEl.currentTime = target;
    videoEl.muted = !tl().clipAudio.keep; videoEl.volume = clamp(tl().clipAudio.volume, 0, 1);
    if (playing && videoEl.paused) videoEl.play().catch(() => {});
    if (!playing && !videoEl.paused) videoEl.pause();
  } else {
    videoEl.pause(); videoEl.hidden = true;
    imgEl.hidden = !seg;
    if (seg) {
      const url = mediaUrl(seg.clip.src);
      if (imgEl.dataset.src !== url) { imgEl.dataset.src = url; imgEl.src = url; }
      imgEl.style.opacity = seg.end ? clamp((t - seg.start) / 0.4, 0, 1) : 1;
    }
  }
  const active = tl().captions.filter(c => c.text.trim() && t >= c.start && t < c.end);
  const key = active.map(c => `${c.id}|${c.text}|${c.pos}|${c.size}`).join('§');
  if (capEl.dataset.key !== key) { capEl.dataset.key = key; capEl.innerHTML = active.map(c => `<img src="${captionUrl(c)}" alt="">`).join(''); }

  const live = new Set();
  for (const a of tl().audio) {
    live.add(a.id);
    let el = audioEls.get(a.id);
    if (!el) { el = new Audio(); el.preload = 'auto'; audioEls.set(a.id, el); }
    const url = mediaUrl(a.src);
    if (el.dataset.src !== url) { el.dataset.src = url; el.src = url; }
    const local = t - a.start;
    if (local >= 0 && local < audioLen(a)) {
      const target = a.in + local;
      if (el.readyState >= 1 && Math.abs(el.currentTime - target) > (playing ? 0.3 : 0.03)) el.currentTime = target;
      el.volume = clamp(a.volume, 0, 1);
      if (playing && el.paused) el.play().catch(() => {});
      if (!playing && !el.paused) el.pause();
    } else if (!el.paused) el.pause();
  }
  for (const [id, el] of audioEls) if (!live.has(id)) { el.pause(); el.removeAttribute('src'); audioEls.delete(id); }

  root.querySelector('[data-time]').textContent = `${fmt(t)} / ${fmt(len)}`;
  const head = root.querySelector('.tl-playhead'); if (head) head.style.left = `${X0 + t * pps}px`;
  root.querySelector('[data-st-act="play"]').textContent = playing ? '❚❚' : '▶';
}
function play() {
  if (!segments().length) return toast('Add a clip first.');
  if (t >= total() - 0.05) t = 0;
  playing = true; base = { t, at: performance.now() };
  requestAnimationFrame(loop);
}
function loop() {
  if (!playing) return;
  t = base.t + (performance.now() - base.at) / 1000;
  if (t >= total()) { t = total(); playing = false; }
  syncPreview();
  const scroll = root.querySelector('[data-tl-scroll]'), x = X0 + t * pps;
  if (x > scroll.scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = x - 80;
  if (playing) requestAnimationFrame(loop);
}
function pause() {
  if (!playing) return;
  playing = false; videoEl?.pause(); audioEls.forEach(el => el.pause()); syncPreview();
}
function seek(to) { t = clamp(to, 0, total()); if (playing) base = { t, at: performance.now() }; syncPreview(); }

// ---------- editing ----------
function commit({ inspector = true } = {}) { renderTimeline(); if (inspector) renderInspector(); syncPreview(); scheduleSave(); }

function normalize(item, kind) {
  if (kind === 'clip' && item.kind === 'video') {
    item.in = clamp(snap(item.in), 0, item.srcDuration - 0.2);
    if (item.out != null) item.out = clamp(snap(item.out), item.in + 0.2, item.srcDuration);
    if (item.out != null && item.out >= item.srcDuration - 0.01) item.out = null;
  }
  if ((kind === 'clip' && item.kind === 'image') || kind === 'end') item.duration = clamp(snap(item.duration), kind === 'end' ? 1 : 0.3, kind === 'end' ? 10 : 600);
  if (kind === 'caption') { item.start = Math.max(0, snap(item.start)); item.end = Math.max(item.start + 0.2, snap(item.end)); }
  if (kind === 'audio') {
    item.start = Math.max(0, snap(item.start)); item.volume = clamp(Number(item.volume), 0, 2);
    item.in = clamp(snap(item.in), 0, item.srcDuration - 0.2);
    if (item.out != null) item.out = clamp(snap(item.out), item.in + 0.2, item.srcDuration);
    if (item.out != null && item.out >= item.srcDuration - 0.01) item.out = null;
  }
}

async function addMedia(path) {
  const item = library.find(i => i.path === path); if (!item) return;
  const kind = kindOf(item), name = prettyName(item.name);
  try {
    if (kind === 'image') {
      const clip = { id: uid(), src: path, name, kind: 'image', duration: 3 };
      tl().clips.push(clip); selected = { kind: 'clip', id: clip.id };
    } else {
      const info = await request('/api/media/probe', { method: 'POST', body: JSON.stringify({ src: path }) });
      if (!(info.duration > 0.1)) throw new Error('Could not read how long this file is.');
      if (kind === 'video') {
        const clip = { id: uid(), src: path, name, kind: 'video', in: 0, out: null, srcDuration: info.duration };
        tl().clips.push(clip); selected = { kind: 'clip', id: clip.id };
      } else {
        const a = { id: uid(), src: path, name, start: snap(t), in: 0, out: null, volume: 1, srcDuration: info.duration };
        tl().audio.push(a); selected = { kind: 'audio', id: a.id };
      }
    }
    commit(); toast(`${name} added`);
  } catch (error) { toast(error.message); }
}

async function upload(files) {
  for (const file of files) {
    toast(`Uploading ${file.name}…`);
    try {
      const res = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const body = await res.json(); if (!res.ok) throw new Error(body.error || 'Upload failed');
    } catch (error) { toast(`${file.name}: ${error.message}`); }
  }
  await refreshLibrary();
  toast(files.length > 1 ? `${files.length} files uploaded` : 'Uploaded');
}

function split() {
  const seg = segments().find(s => !s.end && t > s.start + 0.15 && t < s.start + s.len - 0.15);
  if (!seg) return toast('Move the playhead inside a clip to split it.');
  const c = seg.clip, local = snap(t - seg.start), list = tl().clips;
  const b = { ...c, id: uid() };
  if (c.kind === 'image') { b.duration = c.duration - local; c.duration = local; }
  else { b.in = c.in + local; c.out = c.in + local; }
  list.splice(list.indexOf(c) + 1, 0, b);
  selected = { kind: 'clip', id: b.id }; commit();
}

function addCaption(text = 'Your text here', opts = {}) {
  const start = opts.start ?? snap(t);
  const c = { id: uid(), text, start, end: start + (opts.length ?? 2.5), pos: opts.pos || 'bottom', size: opts.size || 'm' };
  tl().captions.push(c); selected = { kind: 'caption', id: c.id }; commit();
  root.querySelector('[data-inspector] textarea')?.select();
}

function brandPreset() {
  const notes = [];
  if (!tl().captions.some(c => c.start < 1)) { addCaption('Your hook here', { start: 0, length: Math.min(3, total() || 3), pos: 'top', size: 'l' }); notes.push('hook caption'); }
  if (!tl().endCard) {
    const images = library.filter(i => kindOf(i) === 'image' && !isCaptionFile(i));
    const pick = images.find(i => /end|card|crest|logo|cta/i.test(i.name)) || images[0];
    if (pick) { tl().endCard = { src: pick.path, name: prettyName(pick.name), duration: 3 }; notes.push(`end card (${prettyName(pick.name)})`); }
    else notes.push('no end card yet: upload an image, then pick it under Project');
  }
  commit();
  toast(notes.length ? `Brand 9:16: ${notes.join(', ')}` : 'Preset already applied');
}

function removeSelected() {
  if (!selected) return;
  if (selected.kind === 'end') tl().endCard = null;
  else { const key = { clip: 'clips', caption: 'captions', audio: 'audio' }[selected.kind]; tl()[key] = tl()[key].filter(x => x.id !== selected.id); }
  selected = null; commit();
}

async function exportVideo() {
  if (!tl().clips.length) return toast('Add at least one clip before exporting.');
  await saveNow();
  exporting = true; renderHead();
  try {
    await document.fonts.load('800 76px Inter').catch(() => {});
    const overlays = [];
    for (const c of tl().captions) {
      if (!c.text.trim()) continue;
      const blob = await new Promise(resolve => drawCaption(c).toBlob(resolve, 'image/png'));
      const res = await fetch(`/api/media/upload?folder=frames&name=caption-${c.id}.png`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
      const up = await res.json(); if (!res.ok) throw new Error(up.error || 'Could not prepare a caption.');
      overlays.push({ src: up.path, start: c.start, end: c.end, x: 0, y: 0 });
    }
    const timeline = {
      width: W, height: H, fps: 30, overlays,
      clips: tl().clips.map(c => c.kind === 'image' ? { src: c.src, duration: c.duration } : { src: c.src, in: c.in, out: c.out ?? undefined }),
      audio: tl().audio.map(a => ({ src: a.src, start: a.start, in: a.in, out: a.out ?? undefined, volume: a.volume })),
      clipAudio: tl().clipAudio,
      endCard: tl().endCard?.src ? { src: tl().endCard.src, duration: tl().endCard.duration } : null
    };
    await request('/api/media/renders', { method: 'POST', body: JSON.stringify({ title: project.title, studioProjectId: project.id, timeline }) });
    toast('Export started'); changed();
    await refreshRenders();
    root.querySelector('.studio-exports').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) { toast(`Export failed: ${error.message}`); }
  finally { exporting = false; renderHead(); }
}

function openDialog(title, html, save, handler) {
  dialog.querySelector('#studioDialogTitle').textContent = title;
  dialog.querySelector('#studioDialogFields').innerHTML = html;
  dialog.querySelector('#studioDialogSave').textContent = save;
  onSubmit = handler; dialog.showModal();
}
form.addEventListener('submit', async e => {
  e.preventDefault();
  const save = dialog.querySelector('#studioDialogSave'); save.disabled = true;
  try { await onSubmit(); dialog.close(); } catch (error) { toast(error.message); } finally { save.disabled = false; }
});
dialog.addEventListener('click', e => { if (e.target.closest('[data-studio-close]')) dialog.close(); });

// ---------- events ----------
root.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const act = b.dataset.stAct;
  if (b.dataset.filter) { filter = b.dataset.filter; return renderLibrary(); }
  if (b.dataset.add) return addMedia(b.dataset.add);
  if (b.dataset.renderCancel) { await request(`/api/media/renders/${b.dataset.renderCancel}`, { method: 'DELETE' }).catch(err => toast(err.message)); return refreshRenders(); }
  if (b.dataset.renderDelete) {
    const r = renders.find(x => x.id === Number(b.dataset.renderDelete));
    return openDialog('Delete export?', `<p class="dialog-note">Delete <strong>${esc(r.title || `Render ${r.id}`)}</strong> and its video file? The project stays, so you can export it again.</p>`, 'Delete export', async () => {
      await request(`/api/media/renders/${r.id}`, { method: 'DELETE' }); await refreshRenders(); await refreshLibrary(); toast('Export deleted');
    });
  }
  if (act === 'play') return playing ? pause() : play();
  if (act === 'export') return exportVideo();
  if (act === 'split') return split();
  if (act === 'caption') return addCaption();
  if (act === 'preset') return brandPreset();
  if (act === 'remove') return removeSelected();
  if (act === 'zoom-in' || act === 'zoom-out') { pps = clamp(act === 'zoom-in' ? pps * 1.5 : pps / 1.5, 8, 240); return renderTimeline(); }
  if (act === 'new') { await saveNow(); await newProject(); return renderAll(); }
  if (act === 'delete-project') {
    return openDialog('Delete project?', `<p class="dialog-note">Delete <strong>${esc(project.title)}</strong>? Your media files and finished exports stay in the library.</p>`, 'Delete project', async () => {
      clearTimeout(saveTimer); saveTimer = null;
      await request(`/api/media/projects/${project.id}`, { method: 'DELETE' });
      projects = (await request('/api/media/projects')).projects; project = null;
      if (projects[0]) await openProject(projects[0].id); else await newProject();
      renderAll(); toast('Project deleted');
    });
  }
  const list = tl().clips, item = selectedItem();
  if ((act === 'left' || act === 'right') && item) {
    const i = list.indexOf(item), j = act === 'left' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]]; return commit();
  }
  if (act === 'to-playhead' && item) { item.start = snap(t); return commit(); }
  if (act === 'last-frame' && item) {
    try { await request('/api/media/last-frame', { method: 'POST', body: JSON.stringify({ src: item.src }) }); await refreshLibrary(); toast('Last frame saved to Media (Images)'); }
    catch (error) { toast(error.message); }
  }
});

root.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.p) {
    const v = el.value;
    if (el.dataset.p === 'title') { project.title = v.slice(0, 120); root.querySelector(`[data-st-project] option[value="${project.id}"]`).textContent = project.title || 'Untitled video'; report(); return scheduleSave(); }
    if (el.dataset.p === 'clipvol') { tl().clipAudio.volume = Number(v); root.querySelector('[data-out="clipvol"]').textContent = `${Math.round(v * 100)}%`; syncPreview(); return scheduleSave(); }
    return;
  }
  const key = el.dataset.f, item = selectedItem();
  if (!key || !item) return;
  if (key === 'text') item.text = el.value;
  else if (key === 'pos' || key === 'size') item[key] = el.value;
  else { const n = Number(el.value); if (!Number.isFinite(n)) return; item[key] = n; }
  if (key === 'volume') root.querySelector('[data-out="volume"]').textContent = `${Math.round(item.volume * 100)}%`;
  if (key !== 'text' && el.type !== 'number') normalize(item, selected.kind);
  commit({ inspector: false });
});
root.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.upload !== undefined) { const files = [...el.files]; el.value = ''; if (files.length) upload(files); return; }
  if (el.matches('[data-st-project]')) { saveNow().then(() => openProject(Number(el.value))).then(renderAll).catch(err => toast(err.message)); return; }
  if (el.dataset.p === 'brand') { project.brandId = Number(el.value) || null; report(); renderInspector(); return scheduleSave(); }
  if (el.dataset.p === 'keep') { tl().clipAudio.keep = el.checked; syncPreview(); return scheduleSave(); }
  if (el.dataset.p === 'end') {
    const img = library.find(i => i.path === el.value);
    tl().endCard = img ? { src: img.path, name: prettyName(img.name), duration: tl().endCard?.duration ?? 3 } : null;
    return commit();
  }
  if (el.dataset.p === 'end-duration' && tl().endCard) { tl().endCard.duration = Number(el.value) || 3; normalize(tl().endCard, 'end'); return commit(); }
  // Number fields are clamped once the edit is finished, so typing "1" on the way to "12" works.
  if (el.dataset.f && el.type === 'number' && selectedItem()) { normalize(selectedItem(), selected.kind); commit(); }
});

// Timeline dragging: move captions and audio, trim with block edges, reorder clips, scrub.
root.addEventListener('pointerdown', e => {
  const inner = e.target.closest('[data-tl]'); if (!inner || e.button !== 0) return;
  const blockEl = e.target.closest('[data-block]');
  if (!blockEl) {
    if (!e.target.closest('[data-seek]')) return;
    pause(); drag = { mode: 'seek' }; seekFromEvent(e);
    if (selected) { selected = null; renderTimeline(); renderInspector(); }
    return;
  }
  e.preventDefault();
  const kind = blockEl.dataset.block, id = blockEl.dataset.id;
  selected = { kind, id };
  const item = selectedItem();
  drag = { kind, id, mode: e.target.dataset.handle || 'move', x0: e.clientX, dx: 0, orig: { ...item }, moved: false };
  if (kind === 'end' && drag.mode !== 'r') drag.mode = 'none';
  renderTimeline(); renderInspector();
});
function seekFromEvent(e) {
  const inner = root.querySelector('[data-tl]');
  seek((e.clientX - inner.getBoundingClientRect().left - X0) / pps);
}
document.addEventListener('pointermove', e => {
  if (!drag) return;
  if (drag.mode === 'seek') return seekFromEvent(e);
  const dx = (e.clientX - drag.x0) / pps;
  if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
  if (!drag.moved || drag.mode === 'none') return;
  const item = selectedItem(), o = drag.orig; if (!item) return;
  if (drag.kind === 'clip' && drag.mode === 'move') { drag.dx = dx; return renderTimeline(); }
  if (drag.kind === 'caption') {
    if (drag.mode === 'move') { item.start = Math.max(0, snap(o.start + dx)); item.end = item.start + (o.end - o.start); }
    if (drag.mode === 'l') item.start = clamp(snap(o.start + dx), 0, o.end - 0.2);
    if (drag.mode === 'r') item.end = Math.max(o.start + 0.2, snap(o.end + dx));
  }
  if (drag.kind === 'audio') {
    if (drag.mode === 'move') item.start = Math.max(0, snap(o.start + dx));
    if (drag.mode === 'l') { item.in = clamp(snap(o.in + dx), 0, (o.out ?? o.srcDuration) - 0.2); item.start = Math.max(0, o.start + item.in - o.in); }
    if (drag.mode === 'r') item.out = clamp(snap((o.out ?? o.srcDuration) + dx), item.in + 0.2, item.srcDuration);
  }
  if (drag.kind === 'clip' && item.kind === 'video') {
    if (drag.mode === 'l') item.in = clamp(snap(o.in + dx), 0, (o.out ?? o.srcDuration) - 0.2);
    if (drag.mode === 'r') item.out = clamp(snap((o.out ?? o.srcDuration) + dx), item.in + 0.2, item.srcDuration);
  }
  if ((drag.kind === 'clip' && item.kind === 'image') || drag.kind === 'end') item.duration = Math.max(drag.kind === 'end' ? 1 : 0.3, snap(o.duration + (drag.mode === 'l' ? -dx : dx)));
  normalize(item, drag.kind);
  renderTimeline(); syncPreview();
});
document.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode === 'seek' || !d.moved || d.mode === 'none') return renderTimeline();
  if (d.kind === 'clip' && d.mode === 'move') {
    const list = tl().clips, seg = segments().find(s => s.clip.id === d.id);
    const center = seg.start + seg.len / 2 + d.dx;
    const others = segments().filter(s => !s.end && s.clip.id !== d.id);
    const index = others.filter(s => s.start + s.len / 2 < center).length;
    const item = list.splice(list.indexOf(seg.clip), 1)[0];
    list.splice(index, 0, item);
  }
  commit();
});

const drop = () => root.querySelector('[data-drop]');
root.addEventListener('dragover', e => { if (e.target.closest('[data-drop]') && e.dataTransfer.types.includes('Files')) { e.preventDefault(); drop().classList.add('dragging'); } });
root.addEventListener('dragleave', e => { if (e.target === drop()) drop().classList.remove('dragging'); });
root.addEventListener('drop', e => {
  if (!e.target.closest('[data-drop]')) return;
  e.preventDefault(); drop().classList.remove('dragging');
  const files = [...e.dataTransfer.files]; if (files.length) upload(files);
});

document.addEventListener('keydown', e => {
  if (!document.querySelector('#studio')?.classList.contains('active') || !project || dialog.open) return;
  if (e.target.closest('input,textarea,select,[contenteditable]')) return;
  if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (selected) { e.preventDefault(); removeSelected(); } }
  else if (e.key === 's' || e.key === 'S') split();
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); seek(t + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1)); }
});

document.addEventListener('click', e => {
  const nav = e.target.closest?.('.nav[data-view]'); if (!nav) return;
  if (nav.dataset.view === 'studio') loadStudio(); else pause();
});
// A new voice line or export elsewhere in the workstation should show up in Media.
document.addEventListener('workstation:changed', e => { if (root.dataset.ready && e.detail?.tool !== 'studio') refreshLibrary().catch(() => {}); });
