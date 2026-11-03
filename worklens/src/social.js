// Workstation · Connections — real numbers from the platforms, through their official APIs.
// Owns /api/social/*. Four providers:
//   youtube   Google OAuth (the person's own Google Cloud client) → channel stats, uploads with
//             their privacy and scheduled publish time, 28-day analytics, and uploading a
//             Content item as a video (private or scheduled).
//   instagram A long-lived token pasted from the Meta app dashboard (Instagram API with Instagram
//             Login) → followers, media and per-post insights. Refreshed before it expires.
//   tiktok    TikTok Login Kit OAuth with PKCE (the person's own developer app) → profile stats
//             and the video list with counts. Posting stays manual (needs TikTok's audit).
//   gumroad   A pasted access token → products and this month's sales, written onto the
//             Gumroad row in Sites & stores.
// Every sync stores a daily snapshot, so the account page can show a trend that outlives any
// platform's own retention. Nothing here posts publicly without the person's click.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { db, getSetting, setSetting } from './db.js';
import { localDay } from './brands.js';
import { resolveMedia } from './media/api.js';

const port = Number(process.env.WORKLENS_PORT || 4317);
// Tests point every platform host at one local mock: https://host/path → <mock>/host/path.
const MOCK = process.env.WORKLENS_SOCIAL_MOCK || '';
const ep = u => MOCK ? `${MOCK}/${u.replace(/^https?:\/\//, '')}` : u;
const redirectUri = provider => `http://localhost:${port}/api/social/callback/${provider}`;
const SYNC_MS = 6 * 60 * 60 * 1000;
const IG = 'https://graph.instagram.com/v23.0';
export const PROVIDERS = {
  youtube: { label: 'YouTube', platform: 'YT', oauth: true },
  instagram: { label: 'Instagram', platform: 'IG', oauth: false },
  tiktok: { label: 'TikTok', platform: 'TikTok', oauth: true },
  gumroad: { label: 'Gumroad', platform: null, oauth: false }
};

// ---------- secrets ----------
// Same scheme as the OpenRouter key (media/generate.js): Electron's safeStorage when the desktop
// app is running, plain text under `npm start`.
const safe = () => { const s = globalThis.worklensSafeStorage; try { return s?.isEncryptionAvailable() ? s : null; } catch { return null; } };
function getSecret(key) {
  const value = getSetting(key, '');
  if (value.startsWith('safe:')) { try { return safe()?.decryptString(Buffer.from(value.slice(5), 'base64')) || ''; } catch { return ''; } }
  return value.startsWith('plain:') ? value.slice(6) : '';
}
function setSecret(key, value) {
  if (!value) return setSetting(key, '');
  const s = safe();
  setSetting(key, s ? `safe:${s.encryptString(value).toString('base64')}` : `plain:${value}`);
}
const tokensOf = id => { try { return JSON.parse(getSecret(`social_tokens_${id}`) || '{}'); } catch { return {}; } };
const saveTokens = (id, tokens) => setSecret(`social_tokens_${id}`, JSON.stringify(tokens));

function appCreds(provider) {
  if (provider === 'youtube') return { id: getSetting('google_client_id', ''), secret: getSecret('google_client_secret') };
  if (provider === 'tiktok') return { id: getSetting('tiktok_client_key', ''), secret: getSecret('tiktok_client_secret') };
  return { id: '', secret: '' };
}

// ---------- http ----------
async function fetchJson(url, options = {}, label = 'Request') {
  const res = await fetch(ep(url), { signal: AbortSignal.timeout(30000), ...options });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  const apiError = data.error && typeof data.error === 'object' && data.error.code && data.error.code !== 'ok' ? data.error : null;
  if (!res.ok || apiError || data.success === false) {
    const e = data.error;
    const detail = (typeof e === 'string' ? (data.error_description || e) : e?.message) || data.message || data.raw || res.statusText;
    const err = new Error(`${label} (${res.status}): ${detail}`);
    err.status = res.status;
    err.auth = res.status === 401 || /invalid[_ ]?(grant|token)|expired|access_token_invalid|OAuthException/i.test(`${detail} ${e?.type || ''} ${e?.code || ''}`);
    throw err;
  }
  return data;
}
const form = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const iso = secs => new Date(Date.now() + Number(secs || 0) * 1000).toISOString();

// ---------- connections ----------
const connRow = id => db.prepare('SELECT * FROM social_connections WHERE id=?').get(id);

function upsertConnection(provider, externalId, fields) {
  const existing = db.prepare('SELECT * FROM social_connections WHERE provider=? AND external_id=?').get(provider, String(externalId));
  const row = { brand_account_id: null, store_id: null, name: '', handle: '', avatar: '', expires_at: null, ...existing, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
  if (existing) {
    db.prepare("UPDATE social_connections SET brand_account_id=?,store_id=?,name=?,handle=?,avatar=?,expires_at=?,status='ok',last_error='' WHERE id=?")
      .run(row.brand_account_id, row.store_id, row.name, row.handle, row.avatar, row.expires_at, existing.id);
    return existing.id;
  }
  return Number(db.prepare('INSERT INTO social_connections(provider,brand_account_id,store_id,external_id,name,handle,avatar,expires_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(provider, row.brand_account_id, row.store_id, String(externalId), row.name, row.handle, row.avatar, row.expires_at).lastInsertRowid);
}

// One connection per brand account: linking a channel to an account unlinks whatever was there.
function linkAccount(connectionId, accountId) {
  if (!accountId) return;
  db.prepare('UPDATE social_connections SET brand_account_id=NULL WHERE brand_account_id=? AND id!=?').run(accountId, connectionId);
  db.prepare('UPDATE social_connections SET brand_account_id=? WHERE id=?').run(accountId, connectionId);
}

function fail(id, error) {
  db.prepare('UPDATE social_connections SET status=?, last_error=? WHERE id=?').run(error.auth ? 'expired' : 'error', String(error.message || error).slice(0, 400), id);
}

function snapshot(id, values) {
  db.prepare(`INSERT INTO social_snapshots(connection_id,day,followers,views,likes,posts,extra) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(connection_id,day) DO UPDATE SET followers=excluded.followers,views=excluded.views,likes=excluded.likes,posts=excluded.posts,extra=excluded.extra`)
    .run(id, localDay(), values.followers ?? null, values.views ?? null, values.likes ?? null, values.posts ?? null, JSON.stringify(values.extra || {}));
}

function savePosts(id, posts) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`INSERT INTO social_posts(connection_id,external_id,title,caption,url,thumb,status,published_at,scheduled_at,views,likes,comments,shares,extra,synced_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,external_id) DO UPDATE SET title=excluded.title,caption=excluded.caption,url=excluded.url,thumb=excluded.thumb,
    status=excluded.status,published_at=excluded.published_at,scheduled_at=excluded.scheduled_at,views=excluded.views,likes=excluded.likes,comments=excluded.comments,shares=excluded.shares,extra=excluded.extra,synced_at=excluded.synced_at`);
  for (const p of posts) stmt.run(id, String(p.id), p.title || '', p.caption || '', p.url || '', p.thumb || '', p.status || 'published', p.publishedAt || null, p.scheduledAt || null,
    p.views ?? null, p.likes ?? null, p.comments ?? null, p.shares ?? null, JSON.stringify(p.extra || {}), now);
  // Gone from the platform (deleted, or fell off the synced page) and not seen this sync.
  if (posts.length) db.prepare(`DELETE FROM social_posts WHERE connection_id=? AND synced_at<? AND external_id NOT IN (${posts.map(() => '?').join(',')}) AND (published_at IS NULL OR published_at >= ?)`)
    .run(id, now, ...posts.map(p => String(p.id)), posts.map(p => p.publishedAt).filter(Boolean).sort()[0] || now);
}

// ---------- OAuth (YouTube, TikTok) ----------
const pending = new Map();

function startOAuth(provider, accountId) {
  const creds = appCreds(provider);
  if (!creds.id || !creds.secret) throw Object.assign(new Error(`Add your ${PROVIDERS[provider].label} app credentials in Settings → Social connections first.`), { status: 400 });
  const state = b64url(crypto.randomBytes(18));
  const verifier = b64url(crypto.randomBytes(48));
  const digest = crypto.createHash('sha256').update(verifier).digest();
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60000) pending.delete(k);
  pending.set(state, { provider, accountId: Number(accountId) || null, verifier, at: Date.now() });
  if (provider === 'youtube') {
    return ep('https://accounts.google.com/o/oauth2/v2/auth') + '?' + form({
      client_id: creds.id, redirect_uri: redirectUri('youtube'), response_type: 'code', access_type: 'offline', prompt: 'consent select_account', state,
      scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.upload',
      code_challenge: b64url(digest), code_challenge_method: 'S256', include_granted_scopes: 'true'
    });
  }
  // TikTok's desktop Login Kit expects the PKCE challenge as hex, not base64url.
  return ep('https://www.tiktok.com/v2/auth/authorize/') + '?' + form({
    client_key: creds.id, redirect_uri: redirectUri('tiktok'), response_type: 'code', state,
    scope: 'user.info.basic,user.info.profile,user.info.stats,video.list',
    code_challenge: digest.toString('hex'), code_challenge_method: 'S256'
  });
}

async function finishOAuth(provider, code, state) {
  const p = pending.get(state);
  if (!p || p.provider !== provider) throw new Error('This sign-in link has expired. Start again from WorkLens.');
  pending.delete(state);
  const creds = appCreds(provider);
  if (provider === 'youtube') {
    const t = await fetchJson('https://oauth2.googleapis.com/token', { method: 'POST', body: form({ code, client_id: creds.id, client_secret: creds.secret, redirect_uri: redirectUri('youtube'), grant_type: 'authorization_code', code_verifier: p.verifier }) }, 'Google sign-in');
    const tokens = { access: t.access_token, refresh: t.refresh_token, expires: iso(t.expires_in) };
    const ch = (await fetchJson('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true', { headers: { Authorization: `Bearer ${tokens.access}` } }, 'YouTube channel')).items?.[0];
    if (!ch) throw new Error('That Google account has no YouTube channel. Pick the channel\'s account when Google asks.');
    const id = upsertConnection('youtube', ch.id, { name: ch.snippet.title, handle: ch.snippet.customUrl || '', avatar: ch.snippet.thumbnails?.default?.url || '', expires_at: tokens.expires });
    if (!tokens.refresh) tokens.refresh = tokensOf(id).refresh;
    saveTokens(id, tokens); linkAccount(id, p.accountId);
    return id;
  }
  const t = await fetchJson('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_key: creds.id, client_secret: creds.secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri('tiktok'), code_verifier: p.verifier }) }, 'TikTok sign-in');
  const tokens = { access: t.access_token, refresh: t.refresh_token, expires: iso(t.expires_in), refreshExpires: iso(t.refresh_expires_in) };
  const user = (await fetchJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,username,display_name,avatar_url', { headers: { Authorization: `Bearer ${tokens.access}` } }, 'TikTok profile')).data?.user || {};
  const id = upsertConnection('tiktok', user.open_id || t.open_id, { name: user.display_name || '', handle: user.username ? `@${user.username}` : '', avatar: user.avatar_url || '', expires_at: tokens.refreshExpires });
  saveTokens(id, tokens); linkAccount(id, p.accountId);
  return id;
}

// A valid access token, refreshed first when it's within two minutes of expiring.
async function accessToken(conn) {
  const tokens = tokensOf(conn.id);
  if (!tokens.access) throw Object.assign(new Error('Not signed in. Connect the account again.'), { auth: true });
  if (conn.provider === 'instagram' || conn.provider === 'gumroad') return tokens.access;
  if (tokens.expires && Date.parse(tokens.expires) - Date.now() > 120000) return tokens.access;
  if (!tokens.refresh) throw Object.assign(new Error('Sign-in expired. Connect the account again.'), { auth: true });
  const creds = appCreds(conn.provider);
  if (conn.provider === 'youtube') {
    const t = await fetchJson('https://oauth2.googleapis.com/token', { method: 'POST', body: form({ client_id: creds.id, client_secret: creds.secret, refresh_token: tokens.refresh, grant_type: 'refresh_token' }) }, 'Google token refresh');
    Object.assign(tokens, { access: t.access_token, expires: iso(t.expires_in), refresh: t.refresh_token || tokens.refresh });
  } else {
    const t = await fetchJson('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_key: creds.id, client_secret: creds.secret, grant_type: 'refresh_token', refresh_token: tokens.refresh }) }, 'TikTok token refresh');
    Object.assign(tokens, { access: t.access_token, expires: iso(t.expires_in), refresh: t.refresh_token || tokens.refresh, refreshExpires: t.refresh_expires_in ? iso(t.refresh_expires_in) : tokens.refreshExpires });
    db.prepare('UPDATE social_connections SET expires_at=? WHERE id=?').run(tokens.refreshExpires || null, conn.id);
  }
  saveTokens(conn.id, tokens);
  return tokens.access;
}

// ---------- token connections (Instagram, Gumroad) ----------
async function connectInstagram(token, accountId) {
  const me = await fetchJson(`${IG}/me?fields=user_id,username,name,profile_picture_url,followers_count,media_count&access_token=${encodeURIComponent(token)}`, {}, 'Instagram');
  const tokens = { access: token, expires: iso(60 * 86400), checked: new Date().toISOString() };
  // Learn the real expiry (and extend it) when the token is old enough to refresh; a brand-new
  // token can't be refreshed for 24 hours, which is fine.
  try {
    const r = await fetchJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`, {}, 'Instagram refresh');
    Object.assign(tokens, { access: r.access_token, expires: iso(r.expires_in) });
  } catch {}
  const id = upsertConnection('instagram', me.user_id || me.id, { name: me.name || me.username, handle: `@${me.username}`, avatar: me.profile_picture_url || '', expires_at: tokens.expires });
  saveTokens(id, tokens); linkAccount(id, accountId);
  return id;
}

async function refreshInstagram(conn) {
  const tokens = tokensOf(conn.id);
  const left = tokens.expires ? Date.parse(tokens.expires) - Date.now() : 0;
  if (left > 20 * 86400000) return;
  try {
    const r = await fetchJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(tokens.access)}`, {}, 'Instagram refresh');
    Object.assign(tokens, { access: r.access_token, expires: iso(r.expires_in) });
    saveTokens(conn.id, tokens);
    db.prepare('UPDATE social_connections SET expires_at=? WHERE id=?').run(tokens.expires, conn.id);
  } catch (error) { if (left <= 0) throw error; }
}

async function connectGumroad(token, storeId) {
  const user = (await fetchJson(`https://api.gumroad.com/v2/user?access_token=${encodeURIComponent(token)}`, {}, 'Gumroad')).user || {};
  let store = storeId ? db.prepare('SELECT * FROM stores WHERE id=?').get(storeId) : db.prepare("SELECT * FROM stores WHERE platform='Gumroad' ORDER BY id LIMIT 1").get();
  if (!store) {
    const r = db.prepare("INSERT INTO stores(platform,name,url,kind,metric_label) VALUES('Gumroad',?,?,'store','sales this month')").run(user.name || 'Gumroad shop', user.url || '');
    store = db.prepare('SELECT * FROM stores WHERE id=?').get(Number(r.lastInsertRowid));
  }
  const id = upsertConnection('gumroad', user.user_id || user.id || 'me', { name: user.name || 'Gumroad', handle: user.url || '', store_id: store.id });
  saveTokens(id, { access: token });
  db.prepare('UPDATE social_connections SET store_id=NULL WHERE store_id=? AND id!=?').run(store.id, id);
  return id;
}

// ---------- syncs ----------
async function syncYouTube(conn) {
  const token = await accessToken(conn);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const ch = (await fetchJson('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true', auth, 'YouTube channel')).items?.[0];
  if (!ch) throw new Error('Channel not found.');
  db.prepare('UPDATE social_connections SET name=?, handle=?, avatar=? WHERE id=?').run(ch.snippet.title, ch.snippet.customUrl || '', ch.snippet.thumbnails?.default?.url || '', conn.id);
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  let ids = [];
  if (uploads) {
    const list = await fetchJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}`, auth, 'YouTube uploads');
    ids = (list.items || []).map(i => i.contentDetails.videoId);
  }
  const videos = ids.length ? (await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,status,contentDetails&id=${ids.join(',')}`, auth, 'YouTube videos')).items || [] : [];
  savePosts(conn.id, videos.map(v => ({
    id: v.id, title: v.snippet.title, caption: v.snippet.description || '', url: `https://youtu.be/${v.id}`, thumb: v.snippet.thumbnails?.medium?.url || '',
    status: v.status.privacyStatus === 'public' ? 'published' : v.status.publishAt ? 'scheduled' : v.status.privacyStatus,
    publishedAt: v.snippet.publishedAt, scheduledAt: v.status.publishAt || null,
    views: Number(v.statistics?.viewCount ?? 0), likes: Number(v.statistics?.likeCount ?? 0), comments: Number(v.statistics?.commentCount ?? 0),
    extra: { tags: v.snippet.tags || [], duration: v.contentDetails?.duration || '' }
  })));
  const extra = {};
  try {
    const end = localDay(), start = localDay(new Date(Date.now() - 27 * 86400000));
    const r = await fetchJson(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&metrics=views,estimatedMinutesWatched,subscribersGained,subscribersLost`, auth, 'YouTube Analytics');
    const [views, minutes, gained, lost] = r.rows?.[0] || [];
    Object.assign(extra, { views28: views ?? null, minutes28: minutes ?? null, net28: gained != null ? gained - lost : null });
  } catch (error) { extra.analyticsError = error.message.slice(0, 160); }
  snapshot(conn.id, { followers: Number(ch.statistics.subscriberCount), views: Number(ch.statistics.viewCount), posts: Number(ch.statistics.videoCount), likes: videos.reduce((s, v) => s + Number(v.statistics?.likeCount || 0), 0), extra });
}

async function syncInstagram(conn) {
  await refreshInstagram(conn);
  const token = encodeURIComponent(await accessToken(conn));
  const me = await fetchJson(`${IG}/me?fields=user_id,username,name,profile_picture_url,followers_count,follows_count,media_count&access_token=${token}`, {}, 'Instagram');
  db.prepare('UPDATE social_connections SET name=?, handle=?, avatar=? WHERE id=?').run(me.name || me.username, `@${me.username}`, me.profile_picture_url || '', conn.id);
  const media = (await fetchJson(`${IG}/me/media?fields=id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count&limit=50&access_token=${token}`, {}, 'Instagram media')).data || [];
  // Per-post insights (views, shares) are a call each; the latest 25 is enough for the page.
  const insights = {};
  await Promise.all(media.slice(0, 25).map(async m => {
    try {
      const r = await fetchJson(`${IG}/${m.id}/insights?metric=views,reach,shares,saved&access_token=${token}`, {}, 'Instagram insights');
      insights[m.id] = Object.fromEntries((r.data || []).map(d => [d.name, d.values?.[0]?.value ?? d.total_value?.value ?? null]));
    } catch {}
  }));
  savePosts(conn.id, media.map(m => ({
    id: m.id, title: (m.caption || '').split('\n')[0].slice(0, 120), caption: m.caption || '', url: m.permalink, thumb: m.thumbnail_url || (m.media_type === 'IMAGE' ? m.media_url : '') || '',
    status: 'published', publishedAt: m.timestamp ? new Date(m.timestamp).toISOString() : null,
    views: insights[m.id]?.views ?? null, likes: m.like_count ?? null, comments: m.comments_count ?? null, shares: insights[m.id]?.shares ?? null,
    extra: { type: m.media_product_type || m.media_type, reach: insights[m.id]?.reach ?? null, saved: insights[m.id]?.saved ?? null }
  })));
  const views = media.reduce((s, m) => s + Number(insights[m.id]?.views || 0), 0);
  snapshot(conn.id, { followers: me.followers_count ?? null, posts: me.media_count ?? null, likes: media.reduce((s, m) => s + Number(m.like_count || 0), 0), views: views || null, extra: { following: me.follows_count ?? null } });
}

async function syncTikTok(conn) {
  const auth = { headers: { Authorization: `Bearer ${await accessToken(conn)}` } };
  const user = (await fetchJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,username,display_name,avatar_url,follower_count,following_count,likes_count,video_count', auth, 'TikTok profile')).data?.user || {};
  db.prepare('UPDATE social_connections SET name=?, handle=?, avatar=? WHERE id=?').run(user.display_name || conn.name, user.username ? `@${user.username}` : conn.handle, user.avatar_url || conn.avatar, conn.id);
  const videos = [];
  let cursor;
  for (let page = 0; page < 3; page++) {
    const r = (await fetchJson('https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url,view_count,like_count,comment_count,share_count,duration',
      { method: 'POST', headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(cursor ? { max_count: 20, cursor } : { max_count: 20 }) }, 'TikTok videos')).data || {};
    videos.push(...(r.videos || []));
    if (!r.has_more) break;
    cursor = r.cursor;
  }
  savePosts(conn.id, videos.map(v => ({
    id: v.id, title: v.title || (v.video_description || '').split('\n')[0].slice(0, 120), caption: v.video_description || '', url: v.share_url, thumb: v.cover_image_url || '',
    status: 'published', publishedAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
    views: v.view_count ?? null, likes: v.like_count ?? null, comments: v.comment_count ?? null, shares: v.share_count ?? null, extra: { duration: v.duration ?? null }
  })));
  snapshot(conn.id, { followers: user.follower_count ?? null, likes: user.likes_count ?? null, posts: user.video_count ?? null, views: videos.reduce((s, v) => s + Number(v.view_count || 0), 0) || null, extra: { following: user.following_count ?? null } });
}

async function syncGumroad(conn) {
  const token = encodeURIComponent(await accessToken(conn));
  const products = (await fetchJson(`https://api.gumroad.com/v2/products?access_token=${token}`, {}, 'Gumroad products')).products || [];
  const monthStart = `${localDay().slice(0, 8)}01`;
  let sales = [], key = '';
  for (let page = 0; page < 20; page++) {
    const r = await fetchJson(`https://api.gumroad.com/v2/sales?after=${monthStart}${key ? `&page_key=${encodeURIComponent(key)}` : ''}&access_token=${token}`, {}, 'Gumroad sales');
    sales.push(...(r.sales || []));
    if (!r.next_page_key) break;
    key = r.next_page_key;
  }
  sales = sales.filter(s => !s.refunded && !s.chargedback);
  const revenue = sales.reduce((sum, s) => sum + Number(s.price || 0), 0) / 100;
  const currency = (sales[0]?.currency || products[0]?.currency || 'usd').toUpperCase();
  savePosts(conn.id, products.map(p => ({
    id: p.id, title: p.name, caption: p.description ? String(p.description).replace(/<[^>]+>/g, ' ').slice(0, 500) : '', url: p.short_url || '', thumb: p.thumbnail_url || '',
    status: p.published ? 'published' : 'draft', likes: p.sales_count ?? null, views: null,
    extra: { price: p.formatted_price || '', salesUsd: p.sales_usd_cents != null ? p.sales_usd_cents / 100 : null, monthSales: sales.filter(s => s.product_id === p.id).length }
  })));
  snapshot(conn.id, { posts: products.length, likes: sales.length, extra: { revenue, currency, products: products.length } });
  if (conn.store_id) db.prepare("UPDATE stores SET metric_value=?, metric_label=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(`${sales.length} · ${currency === 'USD' ? '$' : `${currency} `}${revenue.toFixed(2)}`, 'sales this month', conn.store_id);
}

const SYNC = { youtube: syncYouTube, instagram: syncInstagram, tiktok: syncTikTok, gumroad: syncGumroad };
const running = new Map();

export function syncConnection(id) {
  if (running.has(id)) return running.get(id);
  const job = (async () => {
    const conn = connRow(id);
    if (!conn) throw new Error('Connection not found.');
    try {
      await SYNC[conn.provider](conn);
      db.prepare("UPDATE social_connections SET status='ok', last_error='', last_sync_at=? WHERE id=?").run(new Date().toISOString(), id);
    } catch (error) { fail(id, error); throw error; }
  })().finally(() => running.delete(id));
  running.set(id, job);
  return job;
}

let timer = null;
export function startSocialSync() {
  if (timer) return;
  const due = () => db.prepare('SELECT id, last_sync_at FROM social_connections').all().filter(c => !c.last_sync_at || Date.now() - Date.parse(c.last_sync_at) > SYNC_MS);
  const tick = () => { for (const c of due()) syncConnection(c.id).catch(() => {}); };
  setTimeout(tick, 60000);
  timer = setInterval(tick, 15 * 60000);
}

// ---------- YouTube upload ----------
// Resumable upload of a Content item's video file. Uploaded private, or private with a
// publishAt when the item has a future post time (YouTube flips it public then). Projects that
// haven't passed YouTube's API audit can only upload private videos; the page says so.
async function uploadToYouTube(contentId, connectionId, privacy) {
  const item = db.prepare('SELECT * FROM content_items WHERE id=?').get(contentId);
  if (!item) throw Object.assign(new Error('Content item not found.'), { status: 404 });
  if (!item.media) throw Object.assign(new Error('Attach a video file to this item first.'), { status: 400 });
  const conn = connRow(connectionId);
  if (!conn || conn.provider !== 'youtube') throw Object.assign(new Error('Pick a connected YouTube channel.'), { status: 400 });
  const file = resolveMedia(item.media);
  if (!/\.(mp4|mov|webm|mkv)$/i.test(file)) throw Object.assign(new Error('That file isn\'t a video.'), { status: 400 });
  const size = fs.statSync(file).size;
  const future = item.scheduled_at && Date.parse(item.scheduled_at) > Date.now() + 15 * 60000;
  const tags = item.hashtags.split(/\s+/).filter(Boolean).map(t => t.replace(/^#/, '')).slice(0, 30);
  const meta = {
    snippet: { title: item.title.slice(0, 100), description: [item.caption, item.hashtags].filter(Boolean).join('\n\n').slice(0, 5000), tags, categoryId: '22' },
    status: { privacyStatus: future ? 'private' : (['private', 'unlisted', 'public'].includes(privacy) ? privacy : 'private'), selfDeclaredMadeForKids: false, ...(future ? { publishAt: new Date(item.scheduled_at).toISOString() } : {}) }
  };
  const token = await accessToken(conn);
  const start = await fetch(ep('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/*' }, body: JSON.stringify(meta)
  });
  if (!start.ok) throw new Error(`YouTube upload (${start.status}): ${(await start.text()).slice(0, 300)}`);
  const location = start.headers.get('location');
  const put = await fetch(location, { method: 'PUT', headers: { 'Content-Length': String(size), 'Content-Type': 'video/*' }, body: fs.createReadStream(file), duplex: 'half' });
  const video = await put.json().catch(() => ({}));
  if (!put.ok || !video.id) throw new Error(`YouTube upload (${put.status}): ${video.error?.message || 'no video id returned'}`);
  const stage = future ? 'scheduled' : item.stage;
  db.prepare('UPDATE content_items SET post_url=?, stage=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(`https://youtu.be/${video.id}`, stage, item.id);
  syncConnection(conn.id).catch(() => {});
  return { videoId: video.id, url: `https://youtu.be/${video.id}`, privacy: video.status?.privacyStatus || meta.status.privacyStatus, publishAt: meta.status.publishAt || null };
}

// ---------- read models ----------
function latestSnapshots(id, days = 120) {
  return db.prepare('SELECT * FROM social_snapshots WHERE connection_id=? ORDER BY day DESC LIMIT ?').all(id, days).reverse().map(s => ({ ...s, extra: JSON.parse(s.extra || '{}') }));
}

function publicConnection(c) {
  if (!c) return null;
  const snaps = latestSnapshots(c.id, 1);
  return { id: c.id, provider: c.provider, label: PROVIDERS[c.provider]?.label, name: c.name, handle: c.handle, avatar: c.avatar, status: c.status, lastError: c.last_error,
    lastSyncAt: c.last_sync_at, expiresAt: c.expires_at, brandAccountId: c.brand_account_id, storeId: c.store_id, latest: snaps[0] || null, syncing: running.has(c.id) };
}

export function listConnections() { return db.prepare('SELECT * FROM social_connections ORDER BY provider, id').all().map(publicConnection); }

// Per brand account: the latest follower count, for the Overview's account rows.
export function accountMetrics() {
  const out = {};
  for (const c of listConnections()) if (c.brandAccountId) out[c.brandAccountId] = { followers: c.latest?.followers ?? null, status: c.status, provider: c.provider };
  return out;
}

const tagsIn = text => [...new Set((String(text || '').match(/#[\p{L}\p{N}_]+/gu) || []))];

export function accountDetail(accountId) {
  const account = db.prepare('SELECT a.*, b.name AS brand_name, b.color AS brand_color FROM brand_accounts a JOIN brands b ON b.id=a.brand_id WHERE a.id=?').get(accountId);
  if (!account) return null;
  const provider = Object.entries(PROVIDERS).find(([, p]) => p.platform === account.platform)?.[0] || null;
  const conn = db.prepare('SELECT * FROM social_connections WHERE brand_account_id=?').get(accountId);
  const posts = conn ? db.prepare('SELECT * FROM social_posts WHERE connection_id=? ORDER BY COALESCE(scheduled_at, published_at) DESC').all(conn.id)
    .map(p => ({ ...p, extra: JSON.parse(p.extra || '{}'), hashtags: tagsIn(`${p.caption} ${p.title}`) })) : [];
  const pipeline = db.prepare('SELECT * FROM content_items ORDER BY COALESCE(scheduled_at, updated_at) DESC').all()
    .filter(i => JSON.parse(i.accounts || '[]').includes(account.id)).map(i => ({ id: i.id, title: i.title, stage: i.stage, caption: i.caption, hashtags: i.hashtags, scheduled_at: i.scheduled_at, posted_at: i.posted_at, post_url: i.post_url, media: i.media }));
  const last = db.prepare('SELECT MAX(posted_on) AS d FROM brand_posts WHERE account_id=?').get(accountId).d;
  return {
    account: { ...account, last_posted: last }, provider, providerLabel: provider ? PROVIDERS[provider].label : null,
    canConnect: Boolean(provider), oauthReady: provider && PROVIDERS[provider].oauth ? Boolean(appCreds(provider).id && appCreds(provider).secret) : true,
    connection: publicConnection(conn), snapshots: conn ? latestSnapshots(conn.id) : [], posts, pipeline
  };
}

function settingsView() {
  return {
    google: { clientId: getSetting('google_client_id', ''), secretSet: Boolean(getSecret('google_client_secret')) },
    tiktok: { clientKey: getSetting('tiktok_client_key', ''), secretSet: Boolean(getSecret('tiktok_client_secret')) },
    redirect: { youtube: redirectUri('youtube'), tiktok: redirectUri('tiktok') },
    encrypted: Boolean(safe())
  };
}

function page(title, message, ok) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;background:#0a0a0b;color:#fafafb;display:grid;place-items:center;height:100vh;margin:0">
    <div style="max-width:440px;text-align:center"><h2 style="color:${ok ? '#a3ff6e' : '#ff5a5a'}">${esc(title)}</h2><p style="color:#9a9aa4;line-height:1.5">${esc(message)}</p></div></body>`;
}

// ---------- routes ----------
async function guarded(res, json, fn) {
  try { return await fn(); }
  catch (error) { return json(res, error.status && error.status < 500 ? error.status : 502, { error: error.message }); }
}

export async function socialApi(req, res, url, { json, body }) {
  const p = url.pathname;
  if (!p.startsWith('/api/social/')) return false;

  if (req.method === 'GET' && p === '/api/social/settings') return json(res, 200, settingsView());
  if (req.method === 'PUT' && p === '/api/social/settings') {
    const data = await body(req);
    if (data.googleClientId !== undefined) setSetting('google_client_id', String(data.googleClientId).trim().slice(0, 300));
    if (data.googleClientSecret) setSecret('google_client_secret', String(data.googleClientSecret).trim().slice(0, 300));
    if (data.tiktokClientKey !== undefined) setSetting('tiktok_client_key', String(data.tiktokClientKey).trim().slice(0, 300));
    if (data.tiktokClientSecret) setSecret('tiktok_client_secret', String(data.tiktokClientSecret).trim().slice(0, 300));
    if (data.clear === 'google') { setSetting('google_client_id', ''); setSecret('google_client_secret', ''); }
    if (data.clear === 'tiktok') { setSetting('tiktok_client_key', ''); setSecret('tiktok_client_secret', ''); }
    return json(res, 200, settingsView());
  }
  if (req.method === 'GET' && p === '/api/social/connections') return json(res, 200, { connections: listConnections() });

  const connect = p.match(/^\/api\/social\/connect\/(youtube|instagram|tiktok|gumroad)$/);
  if (connect && req.method === 'POST') return guarded(res, json, async () => {
    const provider = connect[1];
    const data = await body(req);
    if (PROVIDERS[provider].oauth) return json(res, 200, { authUrl: startOAuth(provider, data.accountId) });
    const token = String(data.token || '').trim();
    if (!token) throw Object.assign(new Error('Paste the access token.'), { status: 400 });
    const id = provider === 'instagram' ? await connectInstagram(token, Number(data.accountId) || null) : await connectGumroad(token, Number(data.storeId) || null);
    await syncConnection(id).catch(() => {});
    return json(res, 201, publicConnection(connRow(id)));
  });

  const callback = p.match(/^\/api\/social\/callback\/(youtube|tiktok)$/);
  if (callback && req.method === 'GET') {
    const send = (status, html) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
    const error = url.searchParams.get('error_description') || url.searchParams.get('error');
    if (error) return send(400, page('Not connected', `${PROVIDERS[callback[1]].label} said: ${error}. Close this tab and try again from WorkLens.`, false));
    try {
      const id = await finishOAuth(callback[1], url.searchParams.get('code') || '', url.searchParams.get('state') || '');
      await syncConnection(id).catch(() => {});
      const c = connRow(id);
      return send(200, page(`${PROVIDERS[c.provider].label} connected`, `${c.name || c.handle} is linked. You can close this tab and go back to WorkLens.`, true));
    } catch (e) { return send(400, page('Not connected', e.message, false)); }
  }

  const conn = p.match(/^\/api\/social\/connections\/(\d+)(\/sync)?$/);
  if (conn) {
    const row = connRow(Number(conn[1]));
    if (!row) return json(res, 404, { error: 'Connection not found.' });
    if (conn[2] && req.method === 'POST') return guarded(res, json, async () => { await syncConnection(row.id); return json(res, 200, publicConnection(connRow(row.id))); });
    if (!conn[2] && req.method === 'PATCH') {
      const data = await body(req);
      if (data.brandAccountId !== undefined) { if (data.brandAccountId) linkAccount(row.id, Number(data.brandAccountId)); else db.prepare('UPDATE social_connections SET brand_account_id=NULL WHERE id=?').run(row.id); }
      return json(res, 200, publicConnection(connRow(row.id)));
    }
    if (!conn[2] && req.method === 'DELETE') {
      setSetting(`social_tokens_${row.id}`, '');
      db.prepare('DELETE FROM social_connections WHERE id=?').run(row.id);
      return json(res, 200, { ok: true });
    }
  }
  if (req.method === 'POST' && p === '/api/social/sync-all') {
    const results = await Promise.allSettled(db.prepare('SELECT id FROM social_connections').all().map(c => syncConnection(c.id)));
    return json(res, 200, { ok: results.filter(r => r.status === 'fulfilled').length, failed: results.filter(r => r.status === 'rejected').length, connections: listConnections() });
  }

  const acct = p.match(/^\/api\/social\/accounts\/(\d+)$/);
  if (acct && req.method === 'GET') {
    const detail = accountDetail(Number(acct[1]));
    return detail ? json(res, 200, detail) : json(res, 404, { error: 'Account not found.' });
  }

  if (req.method === 'POST' && p === '/api/social/youtube/upload') return guarded(res, json, async () => {
    const data = await body(req);
    return json(res, 201, await uploadToYouTube(Number(data.contentId), Number(data.connectionId), data.privacy));
  });
  return json(res, 404, { error: 'Unknown social request.' });
}
