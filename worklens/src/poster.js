// Workstation · Posting bot. Every finished video (stage "edited") with a title, description and hashtags
// gets the brand's next free slot (11:00 and 19:00 local, two a day), its own post number for the brand,
// and is uploaded to Telegram once (the bot keeps the file id). It is then queued on the cloud bot
// (brand-poster on Vercel), which sends it to the owner's Telegram at that time even when this PC is off.
// The "✅ Mark as posted" button in Telegram comes back here through /api/sync and moves the card to Posted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, getSetting, setSetting } from './db.js';
import { localDay } from './brands.js';
import { markPosted } from './hub.js';

export const SLOTS = ['11:00', '19:00'];               // inside the 10:00–12:00 and 16:00–22:00 posting windows
const EVERY = 5 * 60000, LEAD = 20 * 60000, TG_MAX = 50 * 1024 * 1024;
const cfg = () => ({ url: (getSetting('poster_url') || '').replace(/\/+$/, ''), secret: getSetting('poster_admin_secret') || '',
  token: getSetting('poster_bot_token') || '', chat: getSetting('poster_chat_id') || '' });
const ready = c => !!(c.url && c.secret && c.token && c.chat);
let last = { at: null, error: '', scheduled: 0 };

// The deploy step writes the bot's generated keys to ~/.brand-poster.json (outside every repo);
// pick them up once so nobody has to copy them by hand.
function adoptKeys() {
  try {
    const k = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.brand-poster.json'), 'utf8'));
    if (!getSetting('poster_url')) setSetting('poster_url', k.URL || 'https://brand-poster.vercel.app');
    if (!getSetting('poster_admin_secret') && k.ADMIN_SECRET) setSetting('poster_admin_secret', k.ADMIN_SECRET);
    if (!getSetting('poster_cron_secret') && k.CRON_SECRET) setSetting('poster_cron_secret', k.CRON_SECRET);
  } catch { /* not deployed from this PC */ }
}

async function bot(path, init = {}) {
  const c = cfg();
  const res = await fetch(`${c.url}${path}`, { ...init, headers: { Authorization: `Bearer ${c.secret}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`Posting bot ${path}: ${data.error || res.status}`);
  return data;
}
async function telegram(method, form) {
  const res = await fetch(`https://api.telegram.org/bot${cfg().token}/${method}`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

// Upload the video once, silently, then delete the message: the file id stays valid for later sends.
async function uploadVideo(file) {
  const size = fs.statSync(file).size;
  if (size > TG_MAX) throw new Error(`The video is ${(size / 1048576).toFixed(0)} MB; Telegram bots accept up to 50 MB.`);
  const form = new FormData();
  form.set('chat_id', cfg().chat); form.set('disable_notification', 'true'); form.set('supports_streaming', 'true');
  form.set('video', await fs.openAsBlob(file), file.split(/[\\/]/).pop());
  const msg = await telegram('sendVideo', form);
  const del = new FormData(); del.set('chat_id', cfg().chat); del.set('message_id', String(msg.message_id));
  await telegram('deleteMessage', del).catch(() => {});
  return (msg.video || msg.document).file_id;
}

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
// The brand's next free slot at least LEAD from now ("YYYY-MM-DDTHH:MM", local wall clock).
export function nextSlot(brandId, now = new Date()) {
  const taken = new Set(db.prepare("SELECT scheduled_at FROM content_items WHERE brand_id=? AND scheduled_at IS NOT NULL AND stage IN ('scheduled','posted')").all(brandId).map(r => r.scheduled_at));
  for (let day = 0; day < 365; day++) for (const s of SLOTS) {
    const d = new Date(now); d.setDate(d.getDate() + day); const [h, m] = s.split(':').map(Number); d.setHours(h, m, 0, 0);
    if (d - now >= LEAD && !taken.has(stamp(d))) return stamp(d);
  }
  throw new Error('No free slot in the next year.');
}

function missing(i) {
  const need = [];
  if (!i.brand_id) need.push('a brand');
  if (!i.title?.trim()) need.push('a title');
  if (!i.caption?.trim()) need.push('a description');
  if (!i.hashtags?.trim()) need.push('hashtags');
  if (!i.media || !fs.existsSync(i.media)) need.push('the video file');
  return need;
}
const note = (id, text) => db.prepare('UPDATE content_items SET poster_note=? WHERE id=?').run(text.slice(0, 300), id);

// Queue every finished video that isn't scheduled yet.
async function scheduleReady() {
  const items = db.prepare("SELECT * FROM content_items WHERE stage='edited' ORDER BY id").all();
  let n = 0;
  for (const i of items) {
    const need = missing(i);
    if (need.length) { note(i.id, `Can't schedule yet: needs ${need.join(', ')}.`); continue; }
    const brand = db.prepare('SELECT name FROM brands WHERE id=?').get(i.brand_id).name;
    const fileId = i.tg_file_id || await uploadVideo(i.media);
    const postNo = i.post_no || (db.prepare('SELECT MAX(post_no) AS n FROM content_items WHERE brand_id=?').get(i.brand_id).n || 0) + 1;
    const at = nextSlot(i.brand_id);
    db.prepare('UPDATE content_items SET tg_file_id=?, post_no=? WHERE id=?').run(fileId, postNo, i.id);
    await bot('/api/queue', { method: 'POST', body: JSON.stringify({ id: `wl-${i.id}`, brand, n: postNo, title: i.title, description: i.caption, hashtags: i.hashtags, fileId, at: new Date(at).toISOString() }) });
    db.prepare("UPDATE content_items SET stage='scheduled', scheduled_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(at, i.id);
    note(i.id, `Queued as ${brand} #${String(postNo).padStart(3, '0')}; Telegram sends it at ${at.replace('T', ' ')}.`);
    n++;
  }
  return n;
}

// Pull states back: posted in Telegram → Posted here; queued posts whose card is gone are removed.
async function syncBack() {
  const { posts } = await bot('/api/sync');
  for (const p of posts) {
    const item = db.prepare('SELECT * FROM content_items WHERE id=?').get(Number(p.id.replace('wl-', '')));
    if (!item) { await bot(`/api/queue?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' }); continue; }
    if (p.status === 'posted' && item.stage !== 'posted') markPosted(item);
    else if (p.status === 'sent' && item.stage === 'scheduled') note(item.id, `Sent to Telegram ${new Date(p.sentAt).toLocaleString()}. Tap "Mark as posted" there once it's up.`);
    else if (p.lastError) note(item.id, `Telegram send failed, retrying: ${p.lastError}`);
  }
}

export async function runPoster() {
  if (!ready(cfg())) return last;
  try { const scheduled = await scheduleReady(); await syncBack(); last = { at: new Date().toISOString(), error: '', scheduled }; }
  catch (e) { last = { at: new Date().toISOString(), error: e.message, scheduled: 0 }; }
  return last;
}
export function startPoster() {
  adoptKeys(); setInterval(() => runPoster().catch(() => {}), EVERY); setTimeout(() => runPoster().catch(() => {}), 15000); }

export async function posterApi(req, res, url, { json, body }) {
  if (!url.pathname.startsWith('/api/poster')) return false;
  if (req.method === 'GET' && url.pathname === '/api/poster') {
    const c = cfg();
    const cron = getSetting('poster_cron_secret');
    return json(res, 200, { configured: ready(c), url: c.url, hasToken: !!c.token, hasSecret: !!c.secret, chatId: c.chat, slots: SLOTS, last,
      cronUrl: c.url && cron ? `${c.url}/api/tick?key=${cron}` : '' });
  }
  if (req.method === 'POST' && url.pathname === '/api/poster/settings') {
    const d = await body(req);
    if (d.url !== undefined) setSetting('poster_url', String(d.url).trim());
    if (d.adminSecret) setSetting('poster_admin_secret', String(d.adminSecret).trim());
    if (d.botToken) setSetting('poster_bot_token', String(d.botToken).trim());
    if (d.chatId !== undefined) setSetting('poster_chat_id', String(d.chatId).trim());
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/poster/run') return json(res, 200, await runPoster());
  // After the token is saved: point Telegram's webhook at the cloud bot (so /start and "Mark as posted" work).
  if (req.method === 'POST' && url.pathname === '/api/poster/webhook') {
    try { return json(res, 200, await bot(`/api/sync?setup=${encodeURIComponent(`${cfg().url}/api/telegram`)}`)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  return false;
}
