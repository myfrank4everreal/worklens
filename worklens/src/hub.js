// Workstation · Overview, Content, Sites & stores. Owns /api/hub (the at-a-glance page),
// /api/content (one row per video moving from idea to posted), /api/sites (the websites the person
// runs, with a cached "is it up / latest post" check) and /api/stores (where they sell or host a
// community). Nothing here calls a social platform: posting stays a click the person makes, and
// marking an item posted feeds the same brand_posts day-log the Brands screen uses.
import { db, getSetting, setSetting } from './db.js';
import { brandsOverview, localDay, logToWorkLens } from './brands.js';
import { workstationSummary } from './workstation.js';
import { accountMetrics } from './social.js';

export const STAGES = {
  idea: 'Idea', prompt: 'Prompt ready', generated: 'Generated', edited: 'Edited', scheduled: 'Scheduled', posted: 'Posted'
};
export const STORE_PLATFORMS = ['Gumroad', 'Skool', 'Shopify', 'Etsy', 'Patreon', 'Stan Store', 'Whop', 'Discord', 'Ko-fi', 'Other'];
const KINDS = ['store', 'community', 'both'];
const CHECK_TTL = 30 * 60 * 1000;

const text = (v, max) => String(v ?? '').trim().slice(0, max);

function cleanUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}

// "#a, b  #c" → "#a #b #c": one tag per word, de-duplicated, case kept as typed.
export function cleanHashtags(raw) {
  const seen = new Set(), out = [];
  for (const word of String(raw || '').split(/[\s,]+/)) {
    const tag = word.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (tag && !seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); out.push(`#${tag}`); }
  }
  return out.join(' ').slice(0, 2000);
}

// datetime-local value ("2026-11-04T18:30") kept as the person's local wall-clock time.
function cleanWhen(raw) {
  const value = String(raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? value : null;
}

function localNow() {
  const d = new Date();
  return `${localDay(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// First run only: the two sites the person runs as editor in chief.
export function seedHub() {
  if (getSetting('sites_seeded') === 'true') return;
  if (!db.prepare('SELECT COUNT(*) AS n FROM sites').get().n) {
    const mafrex = db.prepare("SELECT id FROM brands WHERE lower(name)='mafrex ai'").get()?.id || null;
    const add = db.prepare('INSERT INTO sites(name,url,role,brand_id) VALUES(?,?,?,?)');
    add.run('Tapcordng', 'https://tapcordng.com/', 'Editor in chief', null);
    add.run('Mafrex AI', 'https://mafrexai.com/', 'Editor in chief', mafrex);
  }
  setSetting('sites_seeded', 'true');
}

// ---------- Content ----------
function accountIds(raw) {
  const ids = (Array.isArray(raw) ? raw : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return [];
  const known = new Set(db.prepare(`SELECT id FROM brand_accounts WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.id));
  return [...new Set(ids.filter(id => known.has(id)))];
}

function contentRow(row) {
  return { ...row, accounts: JSON.parse(row.accounts || '[]'), stage_label: STAGES[row.stage] || row.stage, overdue: row.stage === 'scheduled' && !!row.scheduled_at && row.scheduled_at < localNow() };
}

function contentFields(data, current = {}) {
  const pick = (key, fn) => data[key] !== undefined ? fn(data[key]) : current[key];
  const fields = {
    brand_id: data.brandId !== undefined ? (Number(data.brandId) || null) : current.brand_id ?? null,
    title: pick('title', v => text(v, 160)),
    stage: data.stage !== undefined ? (STAGES[data.stage] ? data.stage : null) : current.stage || 'idea',
    prompt: pick('prompt', v => text(v, 4000)) ?? '',
    caption: pick('caption', v => String(v ?? '').slice(0, 2200)) ?? '',
    hashtags: pick('hashtags', cleanHashtags) ?? '',
    notes: pick('notes', v => text(v, 2000)) ?? '',
    accounts: data.accounts !== undefined ? JSON.stringify(accountIds(data.accounts)) : current.accounts ?? '[]',
    media: pick('media', v => text(v, 500)) ?? '',
    scheduled_at: data.scheduledAt !== undefined ? cleanWhen(data.scheduledAt) : current.scheduled_at ?? null,
    post_url: data.postUrl !== undefined ? cleanUrl(data.postUrl) : current.post_url ?? ''
  };
  if (!fields.title) throw Object.assign(new Error('Give the video a working title.'), { status: 400 });
  if (!fields.stage) throw Object.assign(new Error('Unknown stage.'), { status: 400 });
  if (fields.brand_id && !db.prepare('SELECT 1 FROM brands WHERE id=?').get(fields.brand_id)) fields.brand_id = null;
  // A file attached to an idea means it has been made; a time set on a finished video means it's booked.
  if (data.stage === undefined && fields.media && ['idea', 'prompt'].includes(fields.stage)) fields.stage = 'generated';
  if (data.stage === undefined && fields.scheduled_at && ['generated', 'edited'].includes(fields.stage) && data.scheduledAt) fields.stage = 'scheduled';
  if (fields.stage === 'scheduled' && !fields.scheduled_at) throw Object.assign(new Error('Pick a date and time to schedule it.'), { status: 400 });
  return fields;
}

// Posted: stamp it, and log a post today on each account it went to, so Brands' "posted today"
// and the Timeline agree with the pipeline.
export function markPosted(item) {
  db.prepare("UPDATE content_items SET stage='posted', posted_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(new Date().toISOString(), item.id);
  const today = localDay();
  for (const accountId of JSON.parse(item.accounts || '[]')) {
    const account = db.prepare('SELECT * FROM brand_accounts WHERE id=?').get(accountId);
    if (!account) continue;
    const added = db.prepare('INSERT OR IGNORE INTO brand_posts(account_id,posted_on,note) VALUES(?,?,?)').run(account.id, today, item.title.slice(0, 300));
    if (added.changes) logToWorkLens(account, db.prepare('SELECT * FROM brands WHERE id=?').get(account.brand_id), `Posted "${item.title}"`);
  }
}

function listContent() {
  return db.prepare('SELECT * FROM content_items ORDER BY COALESCE(scheduled_at, updated_at) DESC, id DESC').all().map(contentRow);
}

// ---------- Sites ----------
function firstMatch(xml, re) { const m = xml.match(re); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; }

// Latest post from the site's RSS/Atom feed. WordPress serves one at /feed, which is the default.
async function latestPost(site) {
  const feed = site.feed_url || new URL('feed', site.url.endsWith('/') ? site.url : `${site.url}/`).toString();
  const res = await fetch(feed, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'WorkLens site check' } });
  if (!res.ok) return null;
  const xml = (await res.text()).slice(0, 500000);
  const item = firstMatch(xml, /<item[\s>]([\s\S]*?)<\/item>/i) || firstMatch(xml, /<entry[\s>]([\s\S]*?)<\/entry>/i);
  if (!item) return null;
  const title = firstMatch(item, /<title[^>]*>([\s\S]*?)<\/title>/i).replace(/&amp;/g, '&').replace(/&#8217;/g, '’').replace(/&#8211;/g, '–');
  const link = firstMatch(item, /<link>([\s\S]*?)<\/link>/i) || (item.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
  const when = firstMatch(item, /<pubDate>([\s\S]*?)<\/pubDate>/i) || firstMatch(item, /<(?:updated|published)>([\s\S]*?)<\/(?:updated|published)>/i);
  const date = when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString() : null;
  return title ? { title: title.slice(0, 300), url: cleanUrl(link), at: date } : null;
}

// No feed (common on Next.js sites): read sitemap.xml for a page count and the newest <lastmod>,
// and flag a sitemap that lists pages on another domain, which search engines won't trust.
async function sitemapInfo(site) {
  const res = await fetch(new URL('/sitemap.xml', site.url).toString(), { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'WorkLens site check' } });
  if (!res.ok) return { pages: null, warning: 'No sitemap.xml found.', newest: null };
  const xml = (await res.text()).slice(0, 2000000);
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
  const siteHost = new URL(site.url).host.replace(/^www\./, '');
  const foreign = [...new Set(locs.map(l => { try { return new URL(l).host.replace(/^www\./, ''); } catch { return ''; } }).filter(h => h && h !== siteHost))];
  const mods = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map(m => ({ loc: firstMatch(m[1], /<loc>([\s\S]*?)<\/loc>/i), mod: firstMatch(m[1], /<lastmod>([\s\S]*?)<\/lastmod>/i) }))
    .filter(u => u.mod && !Number.isNaN(Date.parse(u.mod))).sort((a, b) => Date.parse(b.mod) - Date.parse(a.mod));
  return {
    pages: locs.length,
    warning: foreign.length ? `Sitemap lists pages on ${foreign.join(', ')} instead of ${siteHost}.` : '',
    newest: mods[0] ? { title: `Updated: ${new URL(mods[0].loc, site.url).pathname}`, url: cleanUrl(mods[0].loc), at: new Date(mods[0].mod).toISOString() } : null
  };
}

export async function checkSite(site) {
  const started = Date.now();
  let status = null, error = '';
  try {
    const res = await fetch(site.url, { signal: AbortSignal.timeout(15000), redirect: 'follow', headers: { 'User-Agent': 'WorkLens site check' } });
    status = res.status;
    await res.body?.cancel();
  } catch (e) { error = e.name === 'TimeoutError' ? 'No answer within 15 seconds.' : (e.cause?.code || e.message || 'Unreachable'); }
  const ms = Date.now() - started;
  let post = null, map = { pages: null, warning: '', newest: null };
  if (status && status < 400) {
    try { post = await latestPost(site); } catch {}
    try { map = await sitemapInfo(site); } catch {}
    post = post || map.newest;
  }
  db.prepare(`UPDATE sites SET checked_at=?, status=?, response_ms=?, check_error=?, pages=COALESCE(?,pages), site_warning=?,
      latest_title=COALESCE(?,latest_title), latest_url=COALESCE(?,latest_url), latest_at=COALESCE(?,latest_at) WHERE id=?`)
    .run(new Date().toISOString(), status, status ? ms : null, error.slice(0, 200), map.pages, status && status < 400 ? map.warning : '', post?.title ?? null, post?.url ?? null, post?.at ?? null, site.id);
}

let checking = null;
// Re-check stale sites in the background; callers get the cached rows straight away.
function refreshStaleSites() {
  if (checking) return checking;
  const stale = db.prepare('SELECT * FROM sites').all().filter(s => !s.checked_at || Date.now() - Date.parse(s.checked_at) > CHECK_TTL);
  if (!stale.length) return Promise.resolve();
  checking = Promise.allSettled(stale.map(checkSite)).finally(() => { checking = null; });
  return checking;
}

const siteRow = s => ({ ...s, up: s.status ? s.status < 400 : s.checked_at ? false : null });
const listSites = () => db.prepare('SELECT * FROM sites ORDER BY id').all().map(siteRow);

function siteFields(data, current = {}) {
  const url = data.url !== undefined ? cleanUrl(data.url) : current.url;
  if (!url) throw Object.assign(new Error('Enter the site address.'), { status: 400 });
  const name = data.name !== undefined ? text(data.name, 80) : current.name;
  return {
    name: name || new URL(url).host.replace(/^www\./, ''),
    url,
    role: data.role !== undefined ? text(data.role, 80) : current.role ?? '',
    brand_id: data.brandId !== undefined ? (Number(data.brandId) || null) : current.brand_id ?? null,
    feed_url: data.feedUrl !== undefined ? cleanUrl(data.feedUrl) : current.feed_url ?? '',
    notes: data.notes !== undefined ? text(data.notes, 1000) : current.notes ?? ''
  };
}

// ---------- Stores ----------
const listStores = () => db.prepare(`SELECT s.*, EXISTS(SELECT 1 FROM social_connections c WHERE c.store_id=s.id) AS connected FROM stores s ORDER BY s.id`).all();

function storeFields(data, current = {}) {
  const platform = data.platform !== undefined ? (STORE_PLATFORMS.includes(data.platform) ? data.platform : 'Other') : current.platform;
  const name = data.name !== undefined ? text(data.name, 80) : current.name;
  if (!name) throw Object.assign(new Error('Give it a name, e.g. "Tees Inspired shop".'), { status: 400 });
  return {
    platform, name,
    url: data.url !== undefined ? cleanUrl(data.url) : current.url ?? '',
    kind: data.kind !== undefined ? (KINDS.includes(data.kind) ? data.kind : 'store') : current.kind ?? 'store',
    brand_id: data.brandId !== undefined ? (Number(data.brandId) || null) : current.brand_id ?? null,
    metric_label: data.metricLabel !== undefined ? text(data.metricLabel, 40) : current.metric_label ?? '',
    metric_value: data.metricValue !== undefined ? text(data.metricValue, 40) : current.metric_value ?? '',
    notes: data.notes !== undefined ? text(data.notes, 2000) : current.notes ?? ''
  };
}

// ---------- Overview ----------
function lastWork() {
  const row = db.prepare(`SELECT app_name, window_title, captured_at FROM activities WHERE source='workstation'
    AND app_name NOT IN ('Workstation · Overview','Workstation · WorkLens','Workstation · Content','Workstation · Sites & stores')
    ORDER BY captured_at DESC LIMIT 1`).get();
  return row ? { tool: row.app_name.replace(/^Workstation · /, ''), label: row.window_title, at: row.captured_at } : null;
}

export function hubOverview() {
  refreshStaleSites();
  const content = listContent();
  const stages = Object.fromEntries(Object.keys(STAGES).map(k => [k, 0]));
  for (const item of content) stages[item.stage] = (stages[item.stage] || 0) + 1;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const now = localNow();
  const scheduled = content.filter(i => i.stage === 'scheduled' && i.scheduled_at).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  const focusId = Number(getSetting('focus_project_id', '')) || null;
  const focus = focusId ? db.prepare('SELECT id,name,color FROM projects WHERE id=?').get(focusId) : null;
  const ws = workstationSummary(localDay());
  const brands = brandsOverview();
  const metrics = accountMetrics();
  const pipelineByBrand = {};
  for (const item of content) if (item.stage !== 'posted' && item.brand_id) pipelineByBrand[item.brand_id] = (pipelineByBrand[item.brand_id] || 0) + 1;
  return {
    today: brands.today,
    now,
    focus: focus ? { ...focus, openTasks: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status!='done'").get(focus.id).n } : null,
    // The Overview itself is open while this is read, so "working on" is the last other tool used.
    current: ws.current && !['Overview', 'Content', 'Sites & stores'].includes(ws.current.tool) ? ws.current : lastWork(),
    toolSeconds: ws.seconds,
    stages,
    stageLabels: STAGES,
    postedThisWeek: content.filter(i => i.stage === 'posted' && i.posted_at >= weekAgo).length,
    overdue: scheduled.filter(i => i.scheduled_at < now),
    upcoming: scheduled.filter(i => i.scheduled_at >= now).slice(0, 6),
    videoJobsRunning: db.prepare("SELECT COUNT(*) AS n FROM video_jobs WHERE status NOT IN ('completed','failed','cancelled','expired')").get().n,
    platforms: brands.platforms,
    brands: brands.brands.map(b => ({ ...b, inPipeline: pipelineByBrand[b.id] || 0, accounts: b.accounts.map(a => ({ ...a, metrics: metrics[a.id] || null })) })),
    stats: brands.stats,
    sites: listSites(),
    stores: listStores()
  };
}

// ---------- Routes ----------
async function guarded(res, json, fn) {
  try { return await fn(); }
  catch (error) { if (error.status) return json(res, error.status, { error: error.message }); throw error; }
}

export async function hubApi(req, res, url, { json, body }) {
  const p = url.pathname;
  if (!['/api/hub', '/api/content', '/api/sites', '/api/stores'].some(prefix => p === prefix || p.startsWith(`${prefix}/`))) return false;

  if (req.method === 'GET' && p === '/api/hub') return json(res, 200, hubOverview());

  if (req.method === 'GET' && p === '/api/content') return json(res, 200, { items: listContent(), stages: STAGES, now: localNow() });
  if (req.method === 'POST' && p === '/api/content') return guarded(res, json, async () => {
    const f = contentFields(await body(req));
    const r = db.prepare('INSERT INTO content_items(brand_id,title,stage,prompt,caption,hashtags,notes,accounts,media,scheduled_at,post_url) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(f.brand_id, f.title, f.stage, f.prompt, f.caption, f.hashtags, f.notes, f.accounts, f.media, f.scheduled_at, f.post_url);
    const item = db.prepare('SELECT * FROM content_items WHERE id=?').get(Number(r.lastInsertRowid));
    if (f.stage === 'posted') markPosted(item);
    return json(res, 201, contentRow(db.prepare('SELECT * FROM content_items WHERE id=?').get(item.id)));
  });
  const contentMatch = p.match(/^\/api\/content\/(\d+)(\/posted)?$/);
  if (contentMatch) {
    const item = db.prepare('SELECT * FROM content_items WHERE id=?').get(Number(contentMatch[1]));
    if (!item) return json(res, 404, { error: 'Content item not found.' });
    if (contentMatch[2] && req.method === 'POST') {
      markPosted(item);
      return json(res, 200, contentRow(db.prepare('SELECT * FROM content_items WHERE id=?').get(item.id)));
    }
    if (!contentMatch[2] && req.method === 'PATCH') return guarded(res, json, async () => {
      const data = await body(req);
      // Moving to Posted goes through markPosted, which also logs the post on each account.
      const postNow = data.stage === 'posted' && item.stage !== 'posted';
      if (postNow) delete data.stage;
      const f = contentFields(data, item);
      db.prepare('UPDATE content_items SET brand_id=?,title=?,stage=?,prompt=?,caption=?,hashtags=?,notes=?,accounts=?,media=?,scheduled_at=?,post_url=?,posted_at=CASE WHEN ?=\'posted\' THEN posted_at ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(f.brand_id, f.title, f.stage, f.prompt, f.caption, f.hashtags, f.notes, f.accounts, f.media, f.scheduled_at, f.post_url, f.stage, item.id);
      // Back to Edited from a later stage = the video was re-made: the posting bot must upload it again.
      if (f.stage === 'edited' && item.stage !== 'edited') db.prepare("UPDATE content_items SET tg_file_id='', scheduled_at=NULL, poster_note='' WHERE id=?").run(item.id);
      const updated = db.prepare('SELECT * FROM content_items WHERE id=?').get(item.id);
      if (postNow) markPosted(updated);
      return json(res, 200, contentRow(db.prepare('SELECT * FROM content_items WHERE id=?').get(item.id)));
    });
    if (!contentMatch[2] && req.method === 'DELETE') {
      db.prepare('DELETE FROM content_items WHERE id=?').run(item.id);
      return json(res, 200, { ok: true });
    }
  }

  if (req.method === 'GET' && p === '/api/sites') { refreshStaleSites(); return json(res, 200, { sites: listSites() }); }
  if (req.method === 'POST' && p === '/api/sites') return guarded(res, json, async () => {
    const f = siteFields(await body(req));
    const r = db.prepare('INSERT INTO sites(name,url,role,brand_id,feed_url,notes) VALUES(?,?,?,?,?,?)').run(f.name, f.url, f.role, f.brand_id, f.feed_url, f.notes);
    const site = db.prepare('SELECT * FROM sites WHERE id=?').get(Number(r.lastInsertRowid));
    await checkSite(site);
    return json(res, 201, siteRow(db.prepare('SELECT * FROM sites WHERE id=?').get(site.id)));
  });
  if (req.method === 'POST' && p === '/api/sites/check') {
    await Promise.allSettled(db.prepare('SELECT * FROM sites').all().map(checkSite));
    return json(res, 200, { sites: listSites() });
  }
  const siteMatch = p.match(/^\/api\/sites\/(\d+)$/);
  if (siteMatch) {
    const site = db.prepare('SELECT * FROM sites WHERE id=?').get(Number(siteMatch[1]));
    if (!site) return json(res, 404, { error: 'Site not found.' });
    if (req.method === 'PATCH') return guarded(res, json, async () => {
      const f = siteFields(await body(req), site);
      db.prepare('UPDATE sites SET name=?,url=?,role=?,brand_id=?,feed_url=?,notes=? WHERE id=?').run(f.name, f.url, f.role, f.brand_id, f.feed_url, f.notes, site.id);
      if (f.url !== site.url || f.feed_url !== site.feed_url) await checkSite(db.prepare('SELECT * FROM sites WHERE id=?').get(site.id));
      return json(res, 200, siteRow(db.prepare('SELECT * FROM sites WHERE id=?').get(site.id)));
    });
    if (req.method === 'DELETE') { db.prepare('DELETE FROM sites WHERE id=?').run(site.id); return json(res, 200, { ok: true }); }
  }

  if (req.method === 'GET' && p === '/api/stores') return json(res, 200, { stores: listStores(), platforms: STORE_PLATFORMS });
  if (req.method === 'POST' && p === '/api/stores') return guarded(res, json, async () => {
    const f = storeFields(await body(req));
    const r = db.prepare('INSERT INTO stores(platform,name,url,kind,brand_id,metric_label,metric_value,notes) VALUES(?,?,?,?,?,?,?,?)')
      .run(f.platform, f.name, f.url, f.kind, f.brand_id, f.metric_label, f.metric_value, f.notes);
    return json(res, 201, { id: Number(r.lastInsertRowid) });
  });
  const storeMatch = p.match(/^\/api\/stores\/(\d+)$/);
  if (storeMatch) {
    const store = db.prepare('SELECT * FROM stores WHERE id=?').get(Number(storeMatch[1]));
    if (!store) return json(res, 404, { error: 'Not found.' });
    if (req.method === 'PATCH') return guarded(res, json, async () => {
      const f = storeFields(await body(req), store);
      db.prepare('UPDATE stores SET platform=?,name=?,url=?,kind=?,brand_id=?,metric_label=?,metric_value=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(f.platform, f.name, f.url, f.kind, f.brand_id, f.metric_label, f.metric_value, f.notes, store.id);
      return json(res, 200, { ok: true });
    });
    if (req.method === 'DELETE') { db.prepare('DELETE FROM stores WHERE id=?').run(store.id); return json(res, 200, { ok: true }); }
  }
  return json(res, 405, { error: 'Unsupported request.' });
}
