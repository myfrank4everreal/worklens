// Workstation · Overview, Content, Sites & stores — three screens over /api/hub, /api/content,
// /api/sites and /api/stores. Self-contained like brands.js (own dialog and request helper);
// app.js's show() still owns which view is visible.
import { reportContext } from '/monitor.js';
import { usePrompt } from '/generate.js';

const hubRoot = document.querySelector('#hubRoot');
const contentRoot = document.querySelector('#contentRoot');
const placesRoot = document.querySelector('#placesRoot');
const dialog = document.querySelector('#hubDialog');
const form = document.querySelector('#hubForm');
const PLATFORM_SHORT = { IG: 'IG', FB: 'FB', Threads: 'TH', TikTok: 'TT', X: 'X', YT: 'YT' };
const STAGE_ORDER = ['idea', 'prompt', 'generated', 'edited', 'scheduled', 'posted'];
const STAGE_HINT = {
  idea: 'Rough ideas to shape', prompt: 'Prompt written, not generated yet', generated: 'Made, needs editing',
  edited: 'Ready, needs a time', scheduled: 'Booked to post', posted: 'Live'
};
// How each selling / community platform is best used. Shown on Sites & stores, per platform.
const STORE_TIPS = {
  Gumroad: ['Sell digital products: prompt packs, LUTs, templates, guides, wallpapers.', 'Put one Gumroad link in every bio and pin it under your best-performing video.', 'Make a separate discount code per platform (TIKTOK10, YT10) so you can see which channel sells.', 'Offer a free or pay-what-you-want product to collect emails, then announce launches to that list.'],
  Skool: ['Host the community and courses in one place; keep a free group as the front door and a paid tier for depth.', 'Turn each week\'s videos into a discussion post and ask one question under it.', 'Run a weekly live call from the Skool calendar and clip it for short-form content.', 'Use levels to unlock bonus lessons; Skool has no public API, so update the member count here by hand.'],
  Shopify: ['Your own storefront for physical products such as Tees Inspired apparel.', 'Connect the Instagram and TikTok shops so products can be tagged in posts.', 'Use print-on-demand apps to avoid holding stock while you test designs.'],
  Etsy: ['Good discovery for print-on-demand tees and digital downloads; buyers search there already.', 'Put your main keyword in the first words of each title and fill in all 13 tags.'],
  Patreon: ['Monthly membership for behind-the-scenes, early cuts and project files.', 'Post a free preview publicly and link the full version.'],
  'Stan Store': ['A link-in-bio storefront built for creators: digital products, bookings and email capture on one page.'],
  Whop: ['Sell access to communities, courses or software with built-in payments and Discord integration.'],
  Discord: ['Free community chat; pair it with Whop or Patreon roles for paid channels.', 'Post new videos in an announcements channel so members see them first.'],
  'Ko-fi': ['Tips, memberships and a small shop with no monthly fee; easy first step before a bigger store.'],
  Other: ['Note what this platform is for and the one number worth tracking.']
};

let hub = null, content = null, places = null, library = [], brandsData = null;
let contentMode = (() => { try { return localStorage.getItem('wl-content-mode') || 'board'; } catch { return 'board'; } })();
let brandFilter = 0, onSubmit = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2200); }
async function request(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}
const isActive = id => document.querySelector(`#${id}`)?.classList.contains('active');
const host = link => { try { return new URL(link).host.replace(/^www\./, ''); } catch { return link; } };
const changed = () => document.dispatchEvent(new CustomEvent('workstation:changed', { detail: { tool: 'content' } }));

function daysAgo(day, today) {
  if (!day) return 'Never logged';
  if (day === today) return 'Today';
  const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}
function when(local) {
  if (!local) return '';
  const d = new Date(local);
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function ago(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}
function duration(s) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }
const tagCount = tags => tags ? tags.split(/\s+/).filter(Boolean).length : 0;

function allAccounts() { return (brandsData?.brands || []).flatMap(b => b.accounts.map(a => ({ ...a, brand: b }))); }
function brandOf(id) { return (brandsData?.brands || []).find(b => b.id === id); }
function accountBadges(ids) {
  const accounts = allAccounts();
  return ids.map(id => accounts.find(a => a.id === id)).filter(Boolean)
    .map(a => `<span class="pf pf-${esc(a.platform)} pf-sm" title="${esc(a.platform_label)} ${esc(a.handle)}">${esc(PLATFORM_SHORT[a.platform] || a.platform)}</span>`).join('');
}

// ---------- Overview ----------
export async function loadHub() {
  try { hub = await request('/api/hub'); brandsData = { brands: hub.brands, platforms: hub.platforms }; renderHub(); }
  catch (error) { hubRoot.innerHTML = `<div class="card empty">Couldn't load the overview: ${esc(error.message)}</div>`; }
}

function renderHub() {
  if (isActive('hub')) reportContext({ tool: 'hub', label: 'Overview' });
  const h = hub;
  const working = h.current ? `<strong>${esc(h.current.label)}</strong><span>${esc(h.current.tool)} · ${h.current.at ? `last used ${esc(ago(h.current.at))}` : 'open now'}</span>` : '<strong>Nothing open right now</strong><span>Open a tool and it shows here.</span>';
  const pipeline = STAGE_ORDER.filter(s => s !== 'posted').map(s => `<button class="hub-stage" data-open-content="${s}"><strong>${h.stages[s] || 0}</strong><span>${esc(h.stageLabels[s])}</span></button>`).join('')
    + `<button class="hub-stage posted" data-open-content="posted"><strong>${h.postedThisWeek}</strong><span>Posted · 7 days</span></button>`;
  const next = [...h.overdue.map(i => postRow(i, true)), ...h.upcoming.map(i => postRow(i, false))].join('')
    || `<div class="empty">Nothing scheduled. <button class="link-btn" data-open-tool="content">Plan a post</button></div>`;
  hubRoot.innerHTML = `
    <div class="section-head"><div><span class="eyebrow">STUDIO TOOL · AT A GLANCE</span><h2>Overview</h2></div>
      <div class="brand-actions"><button data-hub-act="new-content">+ New idea</button><button data-open-tool="places">Sites & stores</button></div></div>
    <div class="hub-top">
      <div class="card hub-working"><span class="eyebrow">WORKING ON</span>
        <div class="hub-focus">${h.focus ? `<i style="background:${esc(h.focus.color)}"></i><div><strong>${esc(h.focus.name)}</strong><span>Focus project · ${h.focus.openTasks} open task${h.focus.openTasks === 1 ? '' : 's'}</span></div>` : '<div><strong>No focus project</strong><span>Pick one on Today.</span></div>'}</div>
        <div class="hub-now">${working}</div>
        <div class="hub-mini"><span>${duration(h.toolSeconds)} in tools today</span><span>${h.stats.postedToday}/${h.stats.accounts} accounts posted today</span>${h.videoJobsRunning ? `<span class="warn">${h.videoJobsRunning} AI clip${h.videoJobsRunning === 1 ? '' : 's'} generating</span>` : ''}</div>
      </div>
      <div class="card hub-pipeline"><div class="section-title"><h3>Content pipeline</h3><button data-open-tool="content">Open</button></div><div class="hub-stages">${pipeline}</div></div>
      <div class="card hub-next"><div class="section-title"><h3>Next to post</h3><span class="eyebrow">${h.overdue.length ? `${h.overdue.length} OVERDUE` : 'SCHEDULE'}</span></div><div class="hub-list">${next}</div></div>
    </div>
    <div class="section-title hub-section"><h3>Social accounts</h3><span class="eyebrow">${h.stats.brands} BRANDS · ${h.stats.accounts} ACCOUNTS</span><button data-open-tool="brands">Manage</button></div>
    <div class="hub-brands">${h.brands.map(brandCard).join('') || '<div class="card empty">No brands yet.</div>'}</div>
    <div class="hub-bottom">
      <div class="card"><div class="section-title"><h3>Websites</h3><button data-open-tool="places">Manage</button></div><div class="hub-list">${h.sites.map(siteRowHtml).join('') || '<div class="empty">No websites yet.</div>'}</div></div>
      <div class="card"><div class="section-title"><h3>Stores & communities</h3><button data-open-tool="places">Manage</button></div><div class="hub-list">${h.stores.map(storeRowSmall).join('') || `<div class="empty">Add where you sell or host your community (Gumroad, Skool…). <button class="link-btn" data-open-tool="places">Add one</button></div>`}</div></div>
    </div>`;
}

function postRow(i, overdue) {
  const brand = brandOf(i.brand_id);
  return `<button class="hub-row ${overdue ? 'overdue' : ''}" data-edit-content="${i.id}"><i style="background:${esc(brand?.color || 'var(--border-strong)')}"></i>
    <div><strong>${esc(i.title)}</strong><span>${overdue ? 'Overdue · ' : ''}${esc(when(i.scheduled_at))}</span></div><span class="hub-badges">${accountBadges(i.accounts)}</span></button>`;
}

function brandCard(b) {
  return `<div class="card hub-brand" style="--brand:${esc(b.color)}"><div class="hub-brand-head"><span class="brand-avatar sm">${esc(b.name.slice(0, 1).toUpperCase())}</span><div><strong>${esc(b.name)}</strong><span>${b.inPipeline} in pipeline</span></div></div>
    ${b.accounts.map(a => `<div class="hub-account"><span class="pf pf-${esc(a.platform)} pf-sm">${esc(PLATFORM_SHORT[a.platform] || a.platform)}</span><a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">${esc(a.handle)}</a><span class="dot-status ${esc(a.status)}" title="${esc(a.status_label)}"></span><small>${esc(daysAgo(a.last_posted, hub.today))}</small></div>`).join('') || '<div class="empty">No accounts.</div>'}</div>`;
}

function siteState(s) {
  if (s.up === null) return ['', 'Checking…'];
  return s.up ? ['up', `Up · ${s.response_ms} ms · checked ${ago(s.checked_at)}`] : ['down', `${s.status ? `HTTP ${s.status}` : esc(s.check_error || 'Unreachable')} · checked ${ago(s.checked_at)}`];
}
function siteRowHtml(s) {
  const [cls, label] = siteState(s);
  return `<div class="hub-site"><span class="dot-status ${cls}"></span><div><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><strong>${esc(host(s.url))}</strong></a><span>${esc(s.role || 'Website')} · ${label}${s.pages ? ` · ${s.pages} pages` : ''}</span>
    ${s.site_warning ? `<span class="warn">⚠ ${esc(s.site_warning)}</span>` : ''}
    ${s.latest_title ? `<span class="hub-latest">Latest: <a href="${esc(s.latest_url || s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.latest_title)}</a>${s.latest_at ? ` · ${esc(ago(s.latest_at))}` : ''}</span>` : ''}</div></div>`;
}
function storeRowSmall(s) {
  return `<div class="hub-site"><span class="store-tag">${esc(s.platform)}</span><div>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><strong>${esc(s.name)}</strong></a>` : `<strong>${esc(s.name)}</strong>`}<span>${esc(s.kind === 'both' ? 'Store + community' : s.kind === 'community' ? 'Community' : 'Store')}${s.metric_value ? ` · ${esc(s.metric_value)} ${esc(s.metric_label)}` : ''}</span></div></div>`;
}

// ---------- Content ----------
export async function loadContent() {
  try {
    const [c, b] = await Promise.all([request('/api/content'), request('/api/brands')]);
    content = c; brandsData = b; renderContent();
  } catch (error) { contentRoot.innerHTML = `<div class="card empty">Couldn't load content: ${esc(error.message)}</div>`; }
}

function renderContent() {
  if (isActive('content')) reportContext({ tool: 'content', label: 'Content pipeline' });
  const items = content.items.filter(i => !brandFilter || i.brand_id === brandFilter);
  const chips = [`<button class="brand-tab ${brandFilter ? '' : 'active'}" data-content-brand="0"><span>All brands</span><em>${content.items.length}</em></button>`,
    ...brandsData.brands.map(b => `<button class="brand-tab ${brandFilter === b.id ? 'active' : ''}" data-content-brand="${b.id}"><i style="background:${esc(b.color)}"></i><span>${esc(b.name)}</span><em>${content.items.filter(i => i.brand_id === b.id).length}</em></button>`)].join('');
  contentRoot.innerHTML = `
    <div class="section-head"><div><span class="eyebrow">STUDIO TOOL · IDEA → POSTED</span><h2>Content</h2></div>
      <div class="brand-actions"><div class="seg"><button class="${contentMode === 'board' ? 'active' : ''}" data-content-mode="board">Board</button><button class="${contentMode === 'schedule' ? 'active' : ''}" data-content-mode="schedule">Schedule</button></div><button class="primary" data-hub-act="new-content">+ New idea</button></div></div>
    <div class="brand-tabs">${chips}</div>
    ${contentMode === 'board' ? board(items) : schedule(items)}`;
}

function board(items) {
  return `<div class="content-board">${STAGE_ORDER.map(stage => {
    const list = items.filter(i => i.stage === stage);
    const shown = stage === 'posted' ? list.slice(0, 12) : list;
    return `<div class="content-col"><div class="content-col-head"><strong>${esc(content.stages[stage])}</strong><em>${list.length}</em></div><small>${STAGE_HINT[stage]}</small>
      ${shown.map(contentCard).join('') || '<div class="content-empty">—</div>'}${list.length > shown.length ? `<small>${list.length - shown.length} older in Schedule</small>` : ''}</div>`;
  }).join('')}</div>`;
}

function contentCard(i) {
  const brand = brandOf(i.brand_id);
  const idx = STAGE_ORDER.indexOf(i.stage);
  const nextStage = STAGE_ORDER[idx + 1];
  const action = i.stage === 'scheduled' ? `<button data-content-copy="${i.id}">Copy caption</button><button class="primary" data-content-posted="${i.id}">Mark posted</button>`
    : i.stage === 'prompt' && i.prompt ? `<button data-content-generate="${i.id}">Generate in Studio</button>`
    : '';
  return `<div class="card content-card ${i.overdue ? 'overdue' : ''}" style="--brand:${esc(brand?.color || 'var(--border-strong)')}">
    <button class="content-open" data-edit-content="${i.id}"><strong>${esc(i.title)}</strong>
      <span>${brand ? esc(brand.name) : 'No brand'}${i.scheduled_at ? ` · ${i.overdue ? 'overdue · ' : ''}${esc(when(i.scheduled_at))}` : ''}${i.posted_at ? ` · posted ${esc(ago(i.posted_at))}` : ''}</span>
      ${i.caption ? `<p>${esc(i.caption.slice(0, 120))}</p>` : ''}
      <span class="hub-badges">${accountBadges(i.accounts)}${i.hashtags ? `<em>${tagCount(i.hashtags)} tags</em>` : ''}${i.media ? '<em>▶ media</em>' : ''}${i.post_url ? '<em>link</em>' : ''}</span></button>
    <div class="content-actions">${action}${nextStage && i.stage !== 'scheduled' ? `<button class="icon-btn" title="Move to ${esc(content.stages[nextStage])}" data-content-next="${i.id}">→</button>` : ''}</div></div>`;
}

function schedule(items) {
  const dated = items.filter(i => i.scheduled_at || i.posted_at).map(i => ({ ...i, sortKey: i.scheduled_at || i.posted_at.slice(0, 16) }));
  const overdue = dated.filter(i => i.overdue).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const upcoming = dated.filter(i => !i.overdue && i.stage !== 'posted' && i.sortKey >= content.now).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const past = dated.filter(i => i.stage === 'posted').sort((a, b) => b.sortKey.localeCompare(a.sortKey)).slice(0, 30);
  const undated = items.filter(i => !i.scheduled_at && i.stage !== 'posted');
  const byDay = list => {
    const groups = new Map();
    for (const i of list) { const day = i.sortKey.slice(0, 10); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(i); }
    return [...groups].map(([day, list]) => `<div class="sched-day"><span class="eyebrow">${esc(new Date(`${day}T12:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</span>${list.map(schedRow).join('')}</div>`).join('');
  };
  return `<div class="content-schedule">
    ${overdue.length ? `<div class="card"><div class="section-title"><h3>Overdue</h3><span class="eyebrow warn">${overdue.length} PAST THEIR TIME</span></div>${overdue.map(schedRow).join('')}</div>` : ''}
    <div class="card"><div class="section-title"><h3>Coming up</h3><span class="eyebrow">${upcoming.length} SCHEDULED</span></div>${byDay(upcoming) || '<div class="empty">Nothing booked. Set a time on an edited video to schedule it.</div>'}</div>
    <div class="card"><div class="section-title"><h3>Not scheduled yet</h3><span class="eyebrow">${undated.length} IN PROGRESS</span></div>${undated.map(schedRow).join('') || '<div class="empty">Everything in progress has a time.</div>'}</div>
    <div class="card"><div class="section-title"><h3>Posted</h3><span class="eyebrow">LAST ${past.length}</span></div>${byDay(past) || '<div class="empty">Nothing posted from the pipeline yet.</div>'}</div></div>`;
}

function schedRow(i) {
  const brand = brandOf(i.brand_id);
  const time = i.scheduled_at ? new Date(i.scheduled_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  return `<div class="sched-row ${i.overdue ? 'overdue' : ''}"><i style="background:${esc(brand?.color || 'var(--border-strong)')}"></i><span class="mono">${esc(i.stage === 'posted' ? 'posted' : time || content.stages[i.stage])}</span>
    <button class="content-open" data-edit-content="${i.id}"><strong>${esc(i.title)}</strong><span>${esc(i.caption.slice(0, 90) || content.stages[i.stage])}</span></button>
    <span class="hub-badges">${accountBadges(i.accounts)}</span>
    ${i.stage === 'scheduled' ? `<button data-content-copy="${i.id}">Copy</button><button class="primary" data-content-posted="${i.id}">Posted</button>` : i.post_url ? `<a href="${esc(i.post_url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}</div>`;
}

async function loadLibrary() {
  try { library = (await request('/api/media/library')).items.filter(i => /^(video|image)/.test(i.type) && !/^\d+-caption-/.test(i.name)); } catch { library = []; }
}

function findItem(id) { return (content?.items || []).find(i => i.id === id) || [...(hub?.overdue || []), ...(hub?.upcoming || [])].find(i => i.id === id); }

async function editContent(id, preset = {}) {
  if (!brandsData) brandsData = await request('/api/brands');
  if (!content) content = await request('/api/content');
  await loadLibrary();
  const item = id ? findItem(id) || (await request('/api/content')).items.find(i => i.id === id) : null;
  if (id && !item) return toast('That item is gone.');
  const v = item || { title: '', brand_id: preset.brandId || brandFilter || brandsData.brands[0]?.id || null, stage: preset.stage || 'idea', prompt: '', caption: '', hashtags: '', notes: '', accounts: [], media: '', scheduled_at: '', post_url: '' };
  const stages = item ? STAGE_ORDER : STAGE_ORDER.filter(s => s !== 'posted');
  const accounts = brandsData.brands.map(b => `<div class="acct-group" data-acct-brand="${b.id}" ${b.id === v.brand_id ? '' : 'hidden'}>${b.accounts.map(a => `<label class="acct-pick"><input type="checkbox" name="acct" value="${a.id}" ${v.accounts.includes(a.id) || (!item && b.id === v.brand_id) ? 'checked' : ''}><span class="pf pf-${esc(a.platform)} pf-sm">${esc(PLATFORM_SHORT[a.platform] || a.platform)}</span>${esc(a.handle)}</label>`).join('') || '<span class="hint">This brand has no accounts yet.</span>'}</div>`).join('');
  const mediaOpts = `<option value="">None yet</option>${v.media && !library.some(m => m.path === v.media) ? `<option value="${esc(v.media)}" selected>${esc(v.media)}</option>` : ''}${library.map(m => `<option value="${esc(m.path)}" ${m.path === v.media ? 'selected' : ''}>${esc(m.folder)}/${esc(m.name)}</option>`).join('')}`;
  openDialog(item ? 'Edit video' : 'New idea', `
    <label>Working title</label><input name="title" maxlength="160" required value="${esc(v.title)}" placeholder="e.g. 3 AI tools that edit for you">
    <div class="hub-2col"><div><label>Brand</label><select name="brandId" data-acct-switch><option value="">No brand</option>${brandsData.brands.map(b => `<option value="${b.id}" ${b.id === v.brand_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
      <div><label>Stage</label><select name="stage">${stages.map(s => `<option value="${s}" ${s === v.stage ? 'selected' : ''}>${esc(content.stages[s])}</option>`).join('')}</select></div></div>
    <label>Post to</label><div class="acct-list">${accounts}</div>
    <label>Video prompt <small>(for AI generation)</small></label><textarea name="prompt" rows="3" maxlength="4000" placeholder="Shot, subject, camera, spoken line…">${esc(v.prompt)}</textarea>
    <label>Video file</label><select name="media">${mediaOpts}</select>
    <label>Caption <small data-count="caption">${v.caption.length}/2200</small></label><textarea name="caption" rows="4" maxlength="2200" placeholder="Hook first. What to watch for. Call to action.">${esc(v.caption)}</textarea>
    <label>Hashtags <small data-count="hashtags">${tagCount(v.hashtags)} tags</small></label><input name="hashtags" value="${esc(v.hashtags)}" placeholder="#ai #shortfilm #streetwear">
    <div class="hub-2col"><div><label>Post time</label><input type="datetime-local" name="scheduledAt" value="${esc(v.scheduled_at || '')}"></div>
      <div><label>Post link <small>(after posting)</small></label><input type="url" name="postUrl" value="${esc(v.post_url)}" placeholder="https://"></div></div>
    <label>Notes</label><textarea name="notes" rows="2" maxlength="2000">${esc(v.notes)}</textarea>
    <div class="dialog-tools">${v.prompt || !item ? '<button type="button" data-dialog-generate>Generate in Studio</button>' : ''}<button type="button" data-dialog-copy>Copy caption + hashtags</button>${item && item.stage !== 'posted' ? '<button type="button" data-dialog-posted>Mark posted now</button>' : ''}</div>
    ${item ? '<button type="button" class="link-btn danger" data-dialog-delete>Delete this item…</button>' : ''}`,
  item ? 'Save' : 'Add to pipeline', async f => {
    const payload = { ...f, accounts: [...form.querySelectorAll('.acct-group:not([hidden]) input[name=acct]:checked')].map(x => Number(x.value)), brandId: Number(f.brandId) || null };
    delete payload.acct;
    if (item) await request(`/api/content/${item.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await request('/api/content', { method: 'POST', body: JSON.stringify(payload) });
    toast(item ? 'Saved' : 'Added to the pipeline'); changed();
  }, item);
}

async function copyCaption(item) {
  const text = [item.caption, item.hashtags].filter(Boolean).join('\n\n');
  if (!text) return toast('No caption or hashtags yet.');
  try { await navigator.clipboard.writeText(text); toast('Caption and hashtags copied'); } catch { toast("Couldn't reach the clipboard."); }
}

async function markPosted(id) {
  await request(`/api/content/${id}/posted`, { method: 'POST', body: '{}' });
  toast('Marked posted and logged on its accounts'); changed();
}

async function moveNext(id) {
  const item = findItem(id); if (!item) return;
  const next = STAGE_ORDER[STAGE_ORDER.indexOf(item.stage) + 1];
  if (next === 'scheduled' && !item.scheduled_at) return editContent(id);
  if (next === 'posted') return markPosted(id);
  await request(`/api/content/${id}`, { method: 'PATCH', body: JSON.stringify({ stage: next }) });
  changed();
}

function generateInStudio(prompt) {
  if (!prompt.trim()) return toast('Write the prompt first.');
  usePrompt(prompt);
  document.querySelector('.nav[data-view="studio"]')?.click();
  toast('Prompt sent to Studio → Generate clip. Check the cost, then confirm.');
}

// ---------- Sites & stores ----------
export async function loadPlaces() {
  try {
    const [s, st, b] = await Promise.all([request('/api/sites'), request('/api/stores'), request('/api/brands')]);
    places = { sites: s.sites, stores: st.stores, platforms: st.platforms }; brandsData = b; renderPlaces();
  } catch (error) { placesRoot.innerHTML = `<div class="card empty">Couldn't load: ${esc(error.message)}</div>`; }
}

function renderPlaces() {
  if (isActive('places')) reportContext({ tool: 'places', label: 'Sites & stores' });
  const unused = places.platforms.filter(p => p !== 'Other' && !places.stores.some(s => s.platform === p));
  placesRoot.innerHTML = `
    <div class="section-head"><div><span class="eyebrow">STUDIO TOOL · WHERE YOU PUBLISH & SELL</span><h2>Sites & stores</h2></div></div>
    <div class="card"><div class="section-title"><h3>Websites</h3><div class="brand-actions"><button data-places-act="check">Check now</button><button class="primary" data-places-act="add-site">+ Add website</button></div></div>
      <div class="places-list">${places.sites.map(s => `<div class="place-row">${siteRowHtml(s)}<span class="place-meta">${s.brand_id && brandOf(s.brand_id) ? esc(brandOf(s.brand_id).name) : ''}</span><span class="account-tools"><button class="icon-btn" title="Edit" data-site-edit="${s.id}">✎</button><button class="icon-btn danger" title="Remove" data-site-remove="${s.id}">🗑</button></span>${s.notes ? `<p class="place-notes">${esc(s.notes)}</p>` : ''}</div>`).join('') || '<div class="empty">No websites yet.</div>'}</div>
      <p class="hint">Checked every 30 minutes while WorkLens is open. The latest post comes from the site's RSS feed (WordPress: /feed), or else its sitemap.xml.</p></div>
    <div class="card"><div class="section-title"><h3>Stores & communities</h3><button class="primary" data-places-act="add-store">+ Add</button></div>
      <div class="places-list">${places.stores.map(storeRowFull).join('') || '<div class="empty">Nothing yet. Add your Gumroad, Skool or any other place you sell or host a community.</div>'}</div></div>
    ${unused.length ? `<div class="card"><div class="section-title"><h3>Platforms worth knowing</h3><span class="eyebrow">NOT ADDED YET</span></div><div class="tips-grid">${unused.map(p => `<div class="tip"><strong>${esc(p)}</strong><ul>${STORE_TIPS[p].map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`).join('')}</div></div>` : ''}`;
}

function storeRowFull(s) {
  const brand = brandOf(s.brand_id);
  return `<div class="place-row">${storeRowSmall(s)}<span class="place-meta">${brand ? esc(brand.name) : ''}${s.updated_at ? ` · updated ${esc(ago(s.updated_at.replace(' ', 'T') + 'Z'))}` : ''}</span>
    <span class="account-tools"><button class="icon-btn" title="Edit" data-store-edit="${s.id}">✎</button><button class="icon-btn danger" title="Remove" data-store-remove="${s.id}">🗑</button></span>
    ${s.notes ? `<p class="place-notes">${esc(s.notes)}</p>` : ''}
    <details class="place-tips"><summary>How to use ${esc(s.platform)}</summary><ul>${(STORE_TIPS[s.platform] || STORE_TIPS.Other).map(t => `<li>${esc(t)}</li>`).join('')}</ul></details></div>`;
}

const brandPicker = current => `<label>Brand</label><select name="brandId"><option value="">All / none</option>${(brandsData?.brands || []).map(b => `<option value="${b.id}" ${b.id === current ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>`;

function editSite(id) {
  const s = id ? places.sites.find(x => x.id === id) : { name: '', url: '', role: 'Editor in chief', brand_id: null, feed_url: '', notes: '' };
  openDialog(id ? 'Edit website' : 'Add website', `<label>Address</label><input name="url" required value="${esc(s.url)}" placeholder="https://example.com"><label>Name</label><input name="name" maxlength="80" value="${esc(s.name)}"><label>Your role</label><input name="role" maxlength="80" value="${esc(s.role)}">${brandPicker(s.brand_id)}<label>Feed address <small>(optional — defaults to /feed)</small></label><input name="feedUrl" value="${esc(s.feed_url)}" placeholder="https://example.com/feed"><label>Notes</label><textarea name="notes" rows="2" maxlength="1000">${esc(s.notes)}</textarea>`,
  id ? 'Save' : 'Add website', async f => {
    await request(id ? `/api/sites/${id}` : '/api/sites', { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ ...f, brandId: Number(f.brandId) || null }) });
    toast(id ? 'Website saved' : 'Website added');
  });
}

function editStore(id) {
  const s = id ? places.stores.find(x => x.id === id) : { platform: 'Gumroad', name: '', url: '', kind: 'store', brand_id: null, metric_label: '', metric_value: '', notes: '' };
  const tips = p => `<ul class="dialog-tips">${(STORE_TIPS[p] || STORE_TIPS.Other).map(t => `<li>${esc(t)}</li>`).join('')}</ul>`;
  openDialog(id ? 'Edit store or community' : 'Add store or community', `
    <div class="hub-2col"><div><label>Platform</label><select name="platform" data-store-platform>${places.platforms.map(p => `<option ${p === s.platform ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
      <div><label>Type</label><select name="kind">${[['store', 'Store'], ['community', 'Community'], ['both', 'Both']].map(([k, l]) => `<option value="${k}" ${k === s.kind ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <div data-store-tips>${tips(s.platform)}</div>
    <label>Name</label><input name="name" maxlength="80" required value="${esc(s.name)}" placeholder="e.g. Mafrex AI prompt packs"><label>Link</label><input name="url" value="${esc(s.url)}" placeholder="https://">${brandPicker(s.brand_id)}
    <div class="hub-2col"><div><label>Number to track</label><input name="metricValue" maxlength="40" value="${esc(s.metric_value)}" placeholder="e.g. 128"></div><div><label>…of what</label><input name="metricLabel" maxlength="40" value="${esc(s.metric_label)}" placeholder="members, sales, $ this month"></div></div>
    <label>Notes <small>(what you sell or host there, what to do next)</small></label><textarea name="notes" rows="3" maxlength="2000">${esc(s.notes)}</textarea>`,
  id ? 'Save' : 'Add', async f => {
    await request(id ? `/api/stores/${id}` : '/api/stores', { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ ...f, brandId: Number(f.brandId) || null }) });
    toast('Saved');
  });
  form.querySelector('[data-store-platform]').addEventListener('change', e => { form.querySelector('[data-store-tips]').innerHTML = tips(e.target.value); });
}

function confirmRemove(what, url) {
  openDialog(`Remove ${what}?`, `<p class="dialog-note">This only removes it from WorkLens.</p>`, 'Remove', async () => { await request(url, { method: 'DELETE' }); toast('Removed'); });
}

// ---------- Dialog ----------
let dialogItem = null;
function openDialog(title, html, submitLabel, handler, item = null) {
  dialog.querySelector('#hubDialogTitle').textContent = title;
  dialog.querySelector('#hubDialogFields').innerHTML = html;
  dialog.querySelector('#hubDialogSave').textContent = submitLabel;
  dialog.querySelector('#hubDialogSave').classList.toggle('danger', /^(Delete|Remove)/.test(submitLabel));
  onSubmit = handler; dialogItem = item;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('input:not([type=hidden]):not([type=checkbox]),select')?.focus();
}

async function refreshAll() {
  const jobs = [];
  if (isActive('hub') || hub) jobs.push(loadHub());
  if (isActive('content') || content) jobs.push(loadContent());
  if (isActive('places') || places) jobs.push(loadPlaces());
  await Promise.allSettled(jobs);
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!onSubmit) return dialog.close();
  const save = dialog.querySelector('#hubDialogSave');
  save.disabled = true;
  try { await onSubmit(Object.fromEntries(new FormData(form))); dialog.close(); await refreshAll(); }
  catch (error) { toast(error.message); }
  finally { save.disabled = false; }
});
form.addEventListener('input', e => {
  const t = e.target;
  if (t.name === 'caption') form.querySelector('[data-count="caption"]').textContent = `${t.value.length}/2200`;
  if (t.name === 'hashtags') { const n = t.value.split(/[\s,]+/).filter(Boolean).length; const el = form.querySelector('[data-count="hashtags"]'); el.textContent = `${n} tags${n > 30 ? ' · Instagram allows 30' : ''}`; el.classList.toggle('warn', n > 30); }
  // Switching brand shows that brand's accounts, all ticked unless some already were.
  if (t.matches('[data-acct-switch]')) form.querySelectorAll('[data-acct-brand]').forEach(g => {
    g.hidden = g.dataset.acctBrand !== t.value;
    const boxes = [...g.querySelectorAll('input')];
    if (!g.hidden && !boxes.some(b => b.checked)) boxes.forEach(b => { b.checked = true; });
  });
});
dialog.addEventListener('click', async e => {
  if (e.target.closest('[data-hub-close]')) return dialog.close();
  const f = () => Object.fromEntries(new FormData(form));
  if (e.target.closest('[data-dialog-copy]')) return copyCaption({ caption: f().caption, hashtags: f().hashtags });
  if (e.target.closest('[data-dialog-generate]')) { const { prompt } = f(); if (!prompt.trim()) return toast('Write the prompt first.'); dialog.close(); return generateInStudio(prompt); }
  if (e.target.closest('[data-dialog-posted]') && dialogItem) {
    try { await onSubmit(f()); await markPosted(dialogItem.id); dialog.close(); await refreshAll(); } catch (error) { toast(error.message); }
    return;
  }
  if (e.target.closest('[data-dialog-delete]') && dialogItem) { const it = dialogItem; return confirmRemove(`"${it.title}"`, `/api/content/${it.id}`); }
});

async function onClick(e) {
  const t = e.target.closest('button'); if (!t) return;
  try {
    if (t.dataset.hubAct === 'new-content') return editContent(null);
    if (t.dataset.openContent) { brandFilter = 0; contentMode = t.dataset.openContent === 'scheduled' || t.dataset.openContent === 'posted' ? 'schedule' : 'board'; document.querySelector('.nav[data-view="content"]')?.click(); return; }
    if (t.dataset.editContent) return editContent(Number(t.dataset.editContent));
    if (t.dataset.contentBrand !== undefined) { brandFilter = Number(t.dataset.contentBrand); return renderContent(); }
    if (t.dataset.contentMode) { contentMode = t.dataset.contentMode; try { localStorage.setItem('wl-content-mode', contentMode); } catch {} return renderContent(); }
    if (t.dataset.contentCopy) return copyCaption(findItem(Number(t.dataset.contentCopy)));
    if (t.dataset.contentPosted) { t.disabled = true; await markPosted(Number(t.dataset.contentPosted)); return refreshAll(); }
    if (t.dataset.contentNext) { t.disabled = true; await moveNext(Number(t.dataset.contentNext)); return refreshAll(); }
    if (t.dataset.contentGenerate) return generateInStudio(findItem(Number(t.dataset.contentGenerate))?.prompt || '');
    if (t.dataset.placesAct === 'add-site') return editSite(null);
    if (t.dataset.placesAct === 'add-store') return editStore(null);
    if (t.dataset.placesAct === 'check') { t.disabled = true; t.textContent = 'Checking…'; places.sites = (await request('/api/sites/check', { method: 'POST', body: '{}' })).sites; toast('Sites checked'); return renderPlaces(); }
    if (t.dataset.siteEdit) return editSite(Number(t.dataset.siteEdit));
    if (t.dataset.siteRemove) return confirmRemove('this website', `/api/sites/${t.dataset.siteRemove}`);
    if (t.dataset.storeEdit) return editStore(Number(t.dataset.storeEdit));
    if (t.dataset.storeRemove) return confirmRemove('this store', `/api/stores/${t.dataset.storeRemove}`);
  } catch (error) { toast(error.message); t.disabled = false; }
}
[hubRoot, contentRoot, placesRoot].forEach(r => r.addEventListener('click', onClick));

// Load whenever a view is opened, so changes made elsewhere (Brands, Studio) show.
document.addEventListener('click', e => {
  const nav = e.target.closest?.('.nav[data-view]'); if (!nav) return;
  if (nav.dataset.view === 'hub') loadHub();
  if (nav.dataset.view === 'content') loadContent();
  if (nav.dataset.view === 'places') loadPlaces();
});
// Sites are re-checked in the background; pick up the fresh result a little later.
setInterval(() => { if (document.visibilityState === 'visible' && isActive('hub')) loadHub(); }, 60000);
loadHub();
