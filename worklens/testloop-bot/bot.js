// TestLoop bot: onboards closed testers over Telegram (Gmail + 2 screenshots, AI-verified),
// collects /feedback, runs the nightly strike/retention pass, and serves the sync API WorkLens
// pulls from. One bot instance serves one app (APP_NAME).
import http from 'node:http';
import crypto from 'node:crypto';
import { testers, feedback, sessions, changesSince, retentionDay, watDay, getKv, setKv } from './store.js';
import { call, send, esc, photoDataUrl, poll } from './telegram.js';
import { verifyScreenshots, scoreFeedback } from './ai.js';

const env = process.env;
for (const key of ['BOT_TOKEN', 'SYNC_TOKEN']) if (!env[key]) { console.error(`Missing ${key} in environment.`); process.exit(1); }
const APP = env.APP_NAME || 'Due soon', SLUG = env.APP_SLUG || 'due-soon';
const DAYS = Number(env.DAYS_REQUIRED) || 14;
const ADMINS = new Set(String(env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const AUTO_APPROVE = env.AUTO_APPROVE !== 'false';
const GMAIL = /[A-Za-z0-9._%+-]+@gmail\.com/i;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const toLogs = html => send(env.LOGS_GROUP_ID, html);
const who = t => t.username || t.name || t.gmail;

const RULES = `<b>${esc(APP)} closed testing: rules</b>
1. Keep the app installed and open it every day for ${DAYS} days.
2. Send feedback at least every 48h: <code>/feedback Device: X Bug: Y</code>
3. Day 7: send a screenshot of the app still installed when the bot asks.
4. No feedback for 48h = 1 strike. 3 strikes = removed.`;

function joinLinks() {
  return [env.PLAY_TEST_LINK && `📲 Join testing on Play: ${esc(env.PLAY_TEST_LINK)}`, env.MAIN_GROUP_INVITE && `👥 Main group: ${esc(env.MAIN_GROUP_INVITE)}`].filter(Boolean).join('\n');
}
function announcement(text) { return `🚀 ${APP.toUpperCase()} UPDATE\n\n${text}\n\n👉 Test in Telegram HQ\n📋 Feedback: /feedback Device: X Bug: Y`; }

// ---------- Commands ----------
const commands = {
  async start(msg, from) {
    const tester = testers.byTelegram(from.id);
    if (tester) return commands.check(msg, from);
    sessions.set(from.id, { step: 'await_gmail' });
    await send(msg.chat.id, `👋 Welcome to the <b>${esc(APP)}</b> closed testing community.\n\nTo join you need:\n1. Your <b>Gmail</b> (the one on your phone's Play Store)\n2. <b>2 screenshots</b>: ${esc(APP)} on Google Play showing <i>Uninstall/Open</i>, and the app open.\n\nSend your Gmail address now.`);
  },
  help: (msg) => send(msg.chat.id, `${RULES}\n\n<b>Commands</b>\n/check: your day and strikes\n/feedback &lt;text&gt;: send feedback (over 10 characters)\n/rules: the short rules`),
  rules: (msg) => send(msg.chat.id, RULES),
  async check(msg, from) {
    const t = testers.byTelegram(from.id);
    if (!t) return send(msg.chat.id, 'You are not registered yet. Send /start to join.');
    if (t.status === 'pending') return send(msg.chat.id, '⏳ Your screenshots are being reviewed. You will get a message here once approved.');
    await send(msg.chat.id, `<b>${esc(who(t))}</b>\nStatus: <b>${esc(t.status.replace('_', ' '))}</b>\nDay: <b>${retentionDay(t, DAYS)}/${DAYS}</b>\nFeedback sent: <b>${feedback.countFor(t.id)}</b>\nStrikes: <b>${t.strikes}/3</b>`);
  },
  async feedback(msg, from, arg) {
    const t = testers.byTelegram(from.id);
    if (!t || t.status === 'pending') return send(msg.chat.id, 'Only verified testers can send feedback. Send /start to join.');
    if (arg.length <= 10) return send(msg.chat.id, 'Feedback must be longer than 10 characters.\nExample: <code>/feedback Device: Tecno Spark 10. Bug: reminder fired twice</code>');
    const rated = await scoreFeedback(APP, arg);
    feedback.add({ testerId: t.id, text: arg, ...rated });
    log('[feedback]', who(t), rated?.score ?? '-');
    await send(msg.chat.id, `✅ Feedback saved${rated?.score ? `. Usefulness score: <b>${rated.score}/5</b>${rated.summary ? `\n<i>${esc(rated.summary)}</i>` : ''}` : '.'}`);
    if (String(msg.chat.id) !== String(env.MAIN_GROUP_ID)) await send(env.MAIN_GROUP_ID, `📋 <b>Feedback</b> from ${esc(who(t))}${rated?.tag ? ` · ${rated.tag}` : ''}\n${esc(arg)}`);
  },
  async announce(msg, from, arg) {
    if (!ADMINS.has(String(from.id))) return send(msg.chat.id, 'Only admins can announce.');
    if (!arg) return send(msg.chat.id, 'Usage: /announce &lt;message&gt;');
    await broadcast(announcement(arg));
    await send(msg.chat.id, '📣 Announcement sent.');
  }
};

// ---------- Onboarding ----------
async function onboarding(msg, from) {
  const session = sessions.get(from.id);
  if (!session) return send(msg.chat.id, testers.byTelegram(from.id) ? 'Send /help for commands.' : 'Send /start to join testing.');
  const gmail = msg.text?.match(GMAIL)?.[0]?.toLowerCase();
  if (session.step === 'await_gmail') {
    if (!gmail) return send(msg.chat.id, 'Please send a valid <b>@gmail.com</b> address.');
    const taken = testers.byGmail(gmail);
    if (taken && taken.telegram_id !== String(from.id)) return send(msg.chat.id, 'That Gmail is already registered by another tester.');
    sessions.set(from.id, { step: 'await_photos', gmail, photos: [] });
    return send(msg.chat.id, `Got <b>${esc(gmail)}</b> ✅\nNow send <b>2 screenshots</b>:\n1. ${esc(APP)} on Google Play showing <i>Uninstall</i> or <i>Open</i>\n2. ${esc(APP)} open on your phone`);
  }
  if (session.step !== 'await_photos') return;
  const fileId = msg.photo?.at(-1)?.file_id || (msg.document?.mime_type?.startsWith('image/') ? msg.document.file_id : null);
  if (!fileId) return send(msg.chat.id, 'Please send the 2 screenshots as photos.');
  const photos = [...session.photos, fileId];
  sessions.set(from.id, { ...session, photos });
  if (photos.length < 2) return send(msg.chat.id, '📸 1/2 received. Send the second screenshot.');
  await send(msg.chat.id, '🔎 Checking your screenshots…');
  await verify(msg, from, session.gmail, photos.slice(0, 2));
}

// Vision verification: valid → active (or queued when AUTO_APPROVE=false), invalid → retry,
// AI unavailable → queued for a human in WorkLens.
async function verify(msg, from, gmail, photoIds) {
  let images;
  try { images = await Promise.all(photoIds.map(photoDataUrl)); }
  catch (error) { log('[verify] download failed', error.message); images = null; }
  const result = images ? await verifyScreenshots(APP, images) : { valid: false, manual: true, reason: 'Could not download screenshots, manual review' };
  if (!result.valid && !result.manual) {
    sessions.set(from.id, { step: 'await_photos', gmail, photos: [] });
    return send(msg.chat.id, `❌ Screenshots rejected: ${esc(result.reason)}\nPlease send 2 new screenshots.`);
  }
  const active = result.valid && AUTO_APPROVE;
  const username = from.username ? `@${from.username}` : '';
  const existing = testers.byGmail(gmail);
  const fields = { telegramId: from.id, username, name: [from.first_name, from.last_name].filter(Boolean).join(' '), gmail, status: active ? 'active' : 'pending', aiReason: result.reason, startedOn: active ? watDay() : null };
  const tester = existing ? (testers.update(existing.id, { telegram_id: String(from.id), status: fields.status, ai_reason: fields.aiReason, started_on: fields.startedOn }), testers.byId(existing.id)) : testers.create(fields);
  sessions.clear(from.id);
  log('[verify]', gmail, fields.status, result.reason);
  for (const id of photoIds) call('sendPhoto', { chat_id: env.LOGS_GROUP_ID, photo: id }).catch(() => {});
  await toLogs(`${active ? '✅ Verified' : '⏳ Needs review'}: <b>${esc(who(tester))}</b> (${esc(gmail)})\n${esc(result.reason)}${active ? '' : '\nApprove or reject in WorkLens → TestLoop.'}`);
  if (active) return send(msg.chat.id, `🎉 <b>Verified!</b> Day 1/${DAYS} starts today.\n\n${joinLinks()}\n\n${RULES}`);
  await send(msg.chat.id, '⏳ Thanks! Your screenshots need a quick manual check. You will get a message here once approved.');
}

// Day-7 retention proof: a photo from a tester marked need_proof clears it.
async function retentionProof(msg, tester) {
  const fileId = msg.photo?.at(-1)?.file_id;
  testers.update(tester.id, { status: tester.strikes ? `strike_${Math.min(2, tester.strikes)}` : 'active', proof_day7: 1 });
  if (fileId) call('sendPhoto', { chat_id: env.LOGS_GROUP_ID, photo: fileId, caption: `Day 7 proof: ${who(tester)}` }).catch(() => {});
  await send(msg.chat.id, '✅ Retention proof received. Keep going!');
}

async function onUpdate(update) {
  const msg = update.message;
  if (!msg?.from || msg.from.is_bot) return;
  const from = msg.from, text = msg.text || msg.caption || '';
  const command = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  if (command && commands[command[1].toLowerCase()]) {
    // In groups only the shared commands answer; onboarding happens in private chat.
    if (msg.chat.type !== 'private' && ['start'].includes(command[1].toLowerCase())) return send(msg.chat.id, 'Message me privately to join: tap my name, then Start.');
    return commands[command[1].toLowerCase()](msg, from, command[2].trim());
  }
  if (msg.chat.type !== 'private') return;
  const tester = testers.byTelegram(from.id);
  if (tester?.status === 'need_proof' && msg.photo) return retentionProof(msg, tester);
  return onboarding(msg, from);
}

// ---------- Announcements (Telegram main group + optional WhatsApp) ----------
async function broadcast(text) {
  await send(env.MAIN_GROUP_ID, esc(text));
  const recipients = String(env.WHATSAPP_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID || !recipients.length) return;
  for (const to of recipients) {
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
      });
      if (!r.ok) log('[whatsapp]', to, r.status, await r.text());
    } catch (error) { log('[whatsapp]', to, error.message); }
  }
}

// ---------- Nightly pass, 21:00 WAT (20:00 UTC) ----------
async function nightly() {
  const today = watDay();
  if (getKv('nightly_ran') === today) return;
  setKv('nightly_ran', today);
  const quietSince = new Date(Date.now() - 48 * 3600000).toISOString();
  for (const t of testers.all()) {
    if (!['active', 'need_proof', 'strike_1', 'strike_2'].includes(t.status) || !t.started_on) continue;
    const day = retentionDay(t, DAYS);
    if (day >= DAYS) {
      testers.update(t.id, { status: 'completed' });
      await send(t.telegram_id, `🏁 You completed ${DAYS} days of testing ${esc(APP)}. Thank you!`);
      continue;
    }
    const last = feedback.lastFor(t.id);
    const startedLongAgo = Date.parse(`${t.started_on}T00:00:00Z`) < Date.now() - 48 * 3600000;
    if (startedLongAgo && (!last || last < quietSince)) {
      const strikes = t.strikes + 1;
      const status = strikes >= 3 ? 'removed' : `strike_${strikes}`;
      testers.update(t.id, { strikes, status });
      await send(t.telegram_id, strikes >= 3 ? '⛔ 3 strikes: you have been removed from the testing group.' : `⚠️ Strike ${strikes}/3: no feedback in 48h. Send <code>/feedback</code> today.`);
      await toLogs(`⚠️ ${esc(who(t))}: strike ${strikes}/3${strikes >= 3 ? ' (removed, take them off the Play testers list)' : ''}`);
      continue;
    }
    if (day === 7 && !t.proof_day7 && t.status !== 'need_proof') {
      testers.update(t.id, { status: 'need_proof' });
      await send(t.telegram_id, `📸 Day 7! Send a screenshot showing ${esc(APP)} is still installed (Play Store page with <i>Uninstall/Open</i>).`);
    }
  }
  await send(env.MAIN_GROUP_ID, `⏰ <b>Daily Check: ${esc(APP)}</b>\nTesters with no feedback in 48h get 1 strike. Send /feedback now. Day 7 testers: send your retention proof!`);
  log('[nightly] done');
}
setInterval(() => { const d = new Date(); if (d.getUTCHours() >= 20) nightly().catch(e => log('[nightly]', e.message)); }, 60000);

// ---------- Admin actions from WorkLens ----------
async function adminTester(id, data) {
  const t = testers.byId(id);
  if (!t) return { status: 404, body: { error: 'Tester not found on the bot.' } };
  if (data.action === 'approve') {
    testers.update(t.id, { status: 'active', started_on: t.started_on || watDay() });
    await send(t.telegram_id, `🎉 <b>You're approved!</b> Day 1/${DAYS} starts today.\n\n${joinLinks()}\n\n${RULES}`);
  } else if (data.action === 'reject' || data.action === 'remove') {
    testers.remove(t.id); sessions.clear(t.telegram_id);
    await send(t.telegram_id, data.action === 'reject' ? `❌ Your application wasn't approved${data.reason ? `: ${esc(data.reason)}` : '.'}\nSend /start to try again.` : `You have been removed from ${esc(APP)} testing.`);
  } else {
    const fields = {};
    if (data.status && data.status !== t.status) fields.status = data.status;
    if (data.strikes !== undefined) fields.strikes = Number(data.strikes) || 0;
    if (data.started_on !== undefined) fields.started_on = data.started_on;
    testers.update(t.id, fields);
    if (fields.status === 'need_proof') await send(t.telegram_id, `📸 Please send a screenshot showing ${esc(APP)} is still installed.`);
    if (fields.status?.startsWith('strike_')) await send(t.telegram_id, `⚠️ You received a strike (${fields.status.slice(-1)}/3). Send <code>/feedback</code> to stay in.`);
  }
  log('[admin]', t.id, JSON.stringify(data));
  return { status: 200, body: { ok: true } };
}

const sameToken = given => { const a = Buffer.from(String(given)), b = Buffer.from(`Bearer ${env.SYNC_TOKEN}`); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://bot');
  try {
    if (url.pathname === '/health') return reply(res, 200, { ok: true, app: APP });
    if (!sameToken(req.headers.authorization || '')) return reply(res, 401, { error: 'Invalid sync token.' });
    if (req.method === 'GET' && url.pathname === '/sync') {
      const { testers: t, feedback: f, cursor } = changesSince(url.searchParams.get('since'));
      return reply(res, 200, {
        cursor,
        testers: t.map(r => ({ id: r.id, app: SLUG, app_name: APP, username: r.username, name: r.name, gmail: r.gmail, telegram_id: r.telegram_id, status: r.status, strikes: r.strikes, started_on: r.started_on, ai_reason: r.ai_reason })),
        feedback: f.map(r => ({ id: r.id, app: SLUG, app_name: APP, tester_id: r.tester_id, text: r.text, score: r.score, summary: r.summary, tag: r.tag, created_at: r.created_at }))
      });
    }
    const m = url.pathname.match(/^\/admin\/testers\/([\w-]+)$/);
    if (req.method === 'POST' && m) { const r = await adminTester(m[1], await readBody(req)); return reply(res, r.status, r.body); }
    if (req.method === 'POST' && url.pathname === '/admin/announce') {
      const data = await readBody(req);
      if (!data.text) return reply(res, 400, { error: 'text is required' });
      await broadcast(String(data.text).slice(0, 4000));
      return reply(res, 200, { ok: true });
    }
    reply(res, 404, { error: 'Not found' });
  } catch (error) { log('[http]', error.message); reply(res, 500, { error: error.message }); }
}).listen(Number(env.PORT) || 3000, () => log(`[http] sync API on :${Number(env.PORT) || 3000}`));

if (env.DISABLE_POLLING !== 'true') {
  const me = await call('getMe');
  log(`[bot] @${me.username} running for ${APP}`);
  poll(onUpdate);
}
