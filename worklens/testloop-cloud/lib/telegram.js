import './env.js';
// Minimal Telegram Bot API client over fetch: long polling plus the handful of methods TestLoop uses.
const token = (process.env.BOT_TOKEN || "").trim();
const api = `https://api.telegram.org/bot${token}`;

export async function call(method, params = {}) {
  const response = await fetch(`${api}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 60000 : 20000)
  });
  const result = await response.json().catch(() => ({}));
  if (!result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  return result.result;
}

// HTML parse mode: usernames with underscores break Telegram Markdown, HTML only needs escaping.
export const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export async function send(chatId, html, extra = {}) {
  if (!chatId) return null;
  try { return await call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
  catch (error) { console.error(`[tg] send to ${chatId} failed:`, error.message); return null; }
}

// Downloads a photo and returns it as a data URL for the vision model.
export async function photoDataUrl(fileId) {
  const file = await call('getFile', { file_id: fileId });
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Photo download failed (${response.status})`);
  const ext = file.file_path.split('.').pop().toLowerCase();
  const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
}

