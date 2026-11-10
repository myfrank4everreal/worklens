// Workstation · Brands — the Brand Command Center, backed by WorkLens's own database instead of
// a single browser page's memory. Owns the /api/brands and /api/brand-accounts routes; server.js
// hands every /api request here first and carries on with its own routes when this returns false.
//
// Posting state is a per-day log (brand_posts), and every "mark posted" is also written into the
// activities table (source 'workstation'), so it shows up on the Timeline, rolls into episodes,
// and Ask can answer "what did I post this week?" from real evidence.
import { db, getSetting, setSetting } from './db.js';

export const PLATFORMS = {
  IG: { label: 'Instagram', profile: h => `https://instagram.com/${h}` },
  FB: { label: 'Facebook', profile: h => `https://facebook.com/${h}` },
  Threads: { label: 'Threads', profile: h => `https://threads.net/@${h}` },
  TikTok: { label: 'TikTok', profile: h => `https://tiktok.com/@${h}` },
  X: { label: 'X / Twitter', profile: h => `https://x.com/${h}` },
  YT: { label: 'YouTube', profile: h => `https://youtube.com/@${h}` }
};
const DEFAULT_COLOR = '#FF6B35';
const HEX = /^#[0-9a-fA-F]{6}$/;

// The person's own calendar day, not UTC: "posted today" should roll over at their midnight
// (the original page used toISOString(), which flips at 01:00 in West Africa Time).
export function localDay(date = new Date()) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysBetween(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000);
}

// Same thresholds as the Brand Command Center: today → posted, 1–2 days → needs a post, older or
// never → idle.
export function postingStatus(lastPosted, today = localDay()) {
  if (!lastPosted) return { key: 'idle', label: 'Idle' };
  if (lastPosted === today) return { key: 'posted', label: 'Posted Today' };
  return daysBetween(lastPosted, today) <= 2 ? { key: 'needs', label: 'Needs Post' } : { key: 'idle', label: 'Idle' };
}

function normalizeHandle(raw) {
  const clean = String(raw || '').trim().replace(/^@+/, '');
  return clean ? `@${clean}` : '';
}

function defaultLink(platform, handle) {
  return PLATFORMS[platform]?.profile(handle.replace(/^@/, '')) || '';
}

function cleanLink(raw, platform, handle) {
  const value = String(raw || '').trim();
  if (!value || value === 'https://') return defaultLink(platform, handle);
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : defaultLink(platform, handle);
  } catch { return defaultLink(platform, handle); }
}

// First run only: the person's real brands and accounts from their Brand Command Center. Its
// placeholder "Brand 4–7" rows with invented handles are deliberately left out. Guarded by a
// setting rather than "table is empty", so deleting every brand doesn't bring the seed back.
export function seedBrands() {
  if (getSetting('brands_seeded') === 'true') return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM brands').get().n;
  if (!count) {
    const addBrand = db.prepare('INSERT INTO brands(name,color,description,sort) VALUES(?,?,?,?)');
    const addAccount = db.prepare('INSERT INTO brand_accounts(brand_id,platform,handle,link) VALUES(?,?,?,?)');
    const seed = [
      ['Tees Inspired', '#FF6B35', 'Streetwear & culture brand. Main IG + Threads hub.', [['IG', '@tees_inspiredworld'], ['Threads', '@tees_inspiredworld']]],
      ['Mafrex AI', '#6366F1', 'AI tools & tutorials. Short-form content priority.', [['IG', '@mafrexai']]],
      ['Augustin Frank', '#0EA5E9', 'Personal brand: photography, writing, FB community.', [['FB', '@augustin.frank.370']]]
    ];
    seed.forEach(([name, color, description, accounts], i) => {
      const brandId = Number(addBrand.run(name, color, description, i).lastInsertRowid);
      for (const [platform, handle] of accounts) addAccount.run(brandId, platform, handle, defaultLink(platform, handle));
    });
  }
  setSetting('brands_seeded', 'true');
}

// Second seed: the TikTok and YouTube accounts and the Coded Film brand, added once to existing
// databases too. Matches brands by name and skips any platform + handle already present, so
// accounts the person removed or re-added by hand aren't duplicated.
export function seedBrandAccounts() {
  if (getSetting('brand_accounts_seeded_v2') === 'true') return;
  const seed = [
    ['Tees Inspired', '#FF6B35', 'Streetwear & culture brand. Main IG + Threads hub.', [['TikTok', '@teesinspired'], ['IG', '@tees_inspiredworld'], ['YT', '@tees_inspired']]],
    ['Mafrex AI', '#6366F1', 'AI tools & tutorials. Short-form content priority.', [['IG', '@mafrexai'], ['TikTok', '@mafrexplore'], ['YT', '@mafrexai']]],
    ['Coded Film', '#8B5CF6', 'Film brand: short films and cinematic clips.', [['TikTok', '@codedfilm'], ['IG', '@codedfilm'], ['YT', '@codedfilm']]]
  ];
  const findBrand = db.prepare('SELECT id FROM brands WHERE lower(name)=lower(?)');
  const hasAccount = db.prepare('SELECT 1 FROM brand_accounts WHERE platform=? AND lower(handle)=lower(?)');
  const addBrand = db.prepare('INSERT INTO brands(name,color,description,sort) VALUES(?,?,?,(SELECT COALESCE(MAX(sort),-1)+1 FROM brands))');
  const addAccount = db.prepare('INSERT INTO brand_accounts(brand_id,platform,handle,link) VALUES(?,?,?,?)');
  for (const [name, color, description, accounts] of seed) {
    const brandId = findBrand.get(name)?.id ?? Number(addBrand.run(name, color, description).lastInsertRowid);
    for (const [platform, handle] of accounts) if (!hasAccount.get(platform, handle)) addAccount.run(brandId, platform, handle, defaultLink(platform, handle));
  }
  setSetting('brand_accounts_seeded_v2', 'true');
}

// Third seed: the football brand, Community Info (called Pitch Prophet until 2026-11-08; an existing
// Pitch Prophet row is renamed, keeping its history). No accounts yet: the person creates the handles
// and adds them in the Brand Command Center. Added once; deleting it by hand keeps it deleted.
const SPORTS_BRAND = 'Community Info';
const brandByName = name => db.prepare('SELECT id FROM brands WHERE lower(name)=lower(?)').get(name);
export function seedSportsBrand() {
  const legacy = brandByName('Pitch Prophet');
  if (legacy && !brandByName(SPORTS_BRAND)) db.prepare('UPDATE brands SET name=? WHERE id=?').run(SPORTS_BRAND, legacy.id);
  if (getSetting('brand_sports_seeded_v1') !== 'true') {
    if (!brandByName(SPORTS_BRAND)) {
      db.prepare('INSERT INTO brands(name,color,description,sort) VALUES(?,?,?,(SELECT COALESCE(MAX(sort),-1)+1 FROM brands))')
        .run(SPORTS_BRAND, '#16A34A', 'Football brand: daily data-driven match analysis and predictions (YouTube 16:9), plus shorts on TikTok/IG/YT.');
    }
    setSetting('brand_sports_seeded_v1', 'true');
  }
  // Four posts a day: 11:00 daily analysis and 13:00 teaser go out before the afternoon kick-offs,
  // 17:00 and 19:00 carry the evergreen shorts. Set once; the person can change the setting.
  const brand = brandByName(SPORTS_BRAND);
  if (brand && getSetting('brand_sports_slots_v1') !== 'true') {
    if (!getSetting(`poster_slots_${brand.id}`)) setSetting(`poster_slots_${brand.id}`, '09:00,10:00,11:00,12:00,13:00,15:00,17:00,18:00,19:00,21:00');
    setSetting('brand_sports_slots_v1', 'true');
  }
}

export function logToWorkLens(account, brand, action) {
  const platform = PLATFORMS[account.platform]?.label || account.platform;
  db.prepare('INSERT OR IGNORE INTO activities(captured_at,app_name,window_title,project_id,duration_seconds,confidence,source) VALUES(?,?,?,?,?,?,?)')
    .run(new Date().toISOString(), 'Workstation · Brands', `${action} on ${platform}: ${account.handle} (${brand.name})`, brand.project_id || null, 0, brand.project_id ? 1 : 0, 'workstation');
}

export function brandsOverview() {
  const today = localDay();
  const brands = db.prepare('SELECT * FROM brands ORDER BY sort, id').all();
  const accounts = db.prepare(`
    SELECT a.*, (SELECT MAX(posted_on) FROM brand_posts p WHERE p.account_id = a.id) AS last_posted,
           (SELECT COUNT(*) FROM brand_posts p WHERE p.account_id = a.id AND p.posted_on >= ?) AS posts_7d
    FROM brand_accounts a ORDER BY a.id`).all(localDay(new Date(Date.now() - 6 * 86400000)));
  let postedToday = 0;
  const byBrand = new Map(brands.map(b => [b.id, []]));
  for (const account of accounts) {
    const status = postingStatus(account.last_posted, today);
    if (status.key === 'posted') postedToday++;
    byBrand.get(account.brand_id)?.push({ ...account, status: status.key, status_label: status.label, platform_label: PLATFORMS[account.platform]?.label || account.platform });
  }
  return {
    today,
    platforms: Object.fromEntries(Object.entries(PLATFORMS).map(([key, p]) => [key, p.label])),
    stats: { brands: brands.length, accounts: accounts.length, postedToday },
    brands: brands.map(b => ({ ...b, accounts: byBrand.get(b.id) || [] }))
  };
}

function idFrom(pathname, index) { return Number(pathname.split('/')[index]); }

export async function brandsApi(req, res, url, { json, body }) {
  const { pathname } = url;
  if (!pathname.startsWith('/api/brands') && !pathname.startsWith('/api/brand-accounts')) return false;

  if (req.method === 'GET' && pathname === '/api/brands') return json(res, 200, brandsOverview());

  if (req.method === 'POST' && pathname === '/api/brands') {
    const data = await body(req);
    const name = String(data.name || '').trim().slice(0, 80);
    if (!name) return json(res, 400, { error: 'Brand name is required.' });
    const color = HEX.test(data.color || '') ? data.color : DEFAULT_COLOR;
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM brands').get().next;
    const result = db.prepare('INSERT INTO brands(name,color,description,project_id,sort) VALUES(?,?,?,?,?)')
      .run(name, color, String(data.description || '').slice(0, 300), data.projectId || null, sort);
    return json(res, 201, { id: Number(result.lastInsertRowid) });
  }

  if (/^\/api\/brands\/\d+$/.test(pathname)) {
    const id = idFrom(pathname, 3);
    const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(id);
    if (!brand) return json(res, 404, { error: 'Brand not found.' });
    if (req.method === 'PATCH') {
      const data = await body(req);
      const name = data.name !== undefined ? String(data.name).trim().slice(0, 80) : brand.name;
      if (!name) return json(res, 400, { error: 'Brand name is required.' });
      const color = data.color !== undefined && HEX.test(data.color) ? data.color : brand.color;
      const description = data.description !== undefined ? String(data.description).slice(0, 300) : brand.description;
      const projectId = data.projectId !== undefined ? (data.projectId || null) : brand.project_id;
      db.prepare('UPDATE brands SET name=?,color=?,description=?,project_id=? WHERE id=?').run(name, color, description, projectId, id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM brands WHERE id=?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  if (req.method === 'POST' && /^\/api\/brands\/\d+\/accounts$/.test(pathname)) {
    const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(idFrom(pathname, 3));
    if (!brand) return json(res, 404, { error: 'Brand not found.' });
    const data = await body(req);
    const platform = PLATFORMS[data.platform] ? data.platform : null;
    const handle = normalizeHandle(data.handle).slice(0, 80);
    if (!platform) return json(res, 400, { error: 'Choose a platform.' });
    if (!handle) return json(res, 400, { error: 'Account handle is required.' });
    const result = db.prepare('INSERT INTO brand_accounts(brand_id,platform,handle,link) VALUES(?,?,?,?)')
      .run(brand.id, platform, handle, cleanLink(data.link, platform, handle));
    return json(res, 201, { id: Number(result.lastInsertRowid) });
  }

  const accountMatch = pathname.match(/^\/api\/brand-accounts\/(\d+)(\/posts(\/today)?)?$/);
  if (accountMatch) {
    const account = db.prepare('SELECT * FROM brand_accounts WHERE id=?').get(Number(accountMatch[1]));
    if (!account) return json(res, 404, { error: 'Account not found.' });
    const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(account.brand_id);
    const [, , postsPart, todayPart] = accountMatch;

    if (!postsPart && req.method === 'PATCH') {
      const data = await body(req);
      const platform = data.platform !== undefined && PLATFORMS[data.platform] ? data.platform : account.platform;
      const handle = data.handle !== undefined ? normalizeHandle(data.handle).slice(0, 80) : account.handle;
      if (!handle) return json(res, 400, { error: 'Account handle is required.' });
      const link = data.link !== undefined ? cleanLink(data.link, platform, handle) : account.link;
      db.prepare('UPDATE brand_accounts SET platform=?,handle=?,link=? WHERE id=?').run(platform, handle, link, account.id);
      return json(res, 200, { ok: true });
    }
    if (!postsPart && req.method === 'DELETE') {
      db.prepare('DELETE FROM brand_accounts WHERE id=?').run(account.id);
      return json(res, 200, { ok: true });
    }
    if (postsPart && !todayPart && req.method === 'POST') {
      const data = await body(req);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(data.date || '') ? data.date : localDay();
      if (day > localDay()) return json(res, 400, { error: "Can't log a post for a future day." });
      const result = db.prepare('INSERT OR IGNORE INTO brand_posts(account_id,posted_on,note) VALUES(?,?,?)').run(account.id, day, String(data.note || '').slice(0, 300));
      if (result.changes) logToWorkLens(account, brand, 'Posted');
      return json(res, result.changes ? 201 : 200, { ok: true, alreadyLogged: !result.changes });
    }
    if (todayPart && req.method === 'DELETE') {
      const result = db.prepare('DELETE FROM brand_posts WHERE account_id=? AND posted_on=?').run(account.id, localDay());
      if (result.changes) logToWorkLens(account, brand, 'Undid post');
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 405, { error: 'Unsupported brands request.' });
}
