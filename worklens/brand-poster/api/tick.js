// cron-job.org calls this at the posting slots (…/api/tick?key=CRON_SECRET). Sends every post whose time has come.
import { json, authed, allPosts, savePost, tg, postText, env } from './_lib.js';

export default async function handler(req, res) {
  if (!authed(req, 'CRON_SECRET')) return json(res, 401, { error: 'unauthorized' });
  const now = Date.now(), chat = env('CHAT_ID'), sent = [], failed = [];
  const due = (await allPosts()).filter(p => p.status === 'scheduled' && Date.parse(p.at) <= now).sort((a, b) => a.at.localeCompare(b.at));
  for (const p of due) {
    try {
      p.status = 'sending'; await savePost(p);                                 // claim it first, so an overlapping tick can't send it twice
      const n = String(p.n).padStart(3, '0');
      await tg('sendVideo', { chat_id: chat, video: p.fileId, caption: `${p.brand} · #${n} · ${p.title}`.slice(0, 1000), supports_streaming: true });
      const msg = await tg('sendMessage', {
        chat_id: chat, text: postText(p),
        reply_markup: { inline_keyboard: [[{ text: '✅ Mark as posted', callback_data: `posted:${p.id}` }]] },
      });
      Object.assign(p, { status: 'sent', sentAt: new Date().toISOString(), messageId: msg.message_id }); delete p.lastError; await savePost(p);
      sent.push(p.id);
    } catch (e) { p.status = 'scheduled'; p.lastError = e.message; await savePost(p); failed.push({ id: p.id, error: e.message }); }
  }
  return json(res, 200, { ok: true, due: due.length, sent, failed });
}
