// Telegram webhook (secret_token = TG_WEBHOOK_SECRET). /start replies with the chat id (for CHAT_ID);
// the "✅ Mark as posted" button marks the post posted. Only the owner's chat (CHAT_ID) can change anything.
import { json, env, body, tg, getPost, savePost } from './_lib.js';

export default async function handler(req, res) {
  if (req.headers['x-telegram-bot-api-secret-token'] !== env('TG_WEBHOOK_SECRET')) return json(res, 401, { error: 'unauthorized' });
  const u = body(req);
  try {
    if (u.message?.text?.startsWith('/start')) {
      const id = String(u.message.chat.id);
      await tg('sendMessage', { chat_id: id, text: env('CHAT_ID') === id ? 'Brand poster is connected. Your scheduled posts will arrive here.' : `Your chat id is ${id}. Put it in Workstation → Posting bot.` });
    }
    const cb = u.callback_query;
    if (cb && String(cb.message?.chat?.id) === env('CHAT_ID') && cb.data?.startsWith('posted:')) {
      const p = await getPost(cb.data.slice(7));
      if (p) { Object.assign(p, { status: 'posted', postedAt: new Date().toISOString() }); await savePost(p); }
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: p ? 'Marked as posted' : 'Post not found' });
      if (p) await tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [[{ text: '✅ Posted', callback_data: 'noop' }]] } });
    } else if (cb) await tg('answerCallbackQuery', { callback_query_id: cb.id });
  } catch (e) { console.error(e); }
  return json(res, 200, { ok: true });                                        // always 200 so Telegram doesn't retry
}
