const API = 'http://localhost:4317/api/browser-events';
const DEFAULT_EXCLUDES = ['accounts.google.com', 'pay.google.com', 'paypal.com', 'stripe.com', 'wise.com', 'binance.com'];

async function settings() {
  return chrome.storage.local.get({ enabled: false, connectionKey: '', excludedDomains: DEFAULT_EXCLUDES, lastSync: 0, syncMinutes: 5 });
}

function excluded(url, domains) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return true; }
}

async function send(events, config) {
  if (!events.length) return 0;
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorkLens-Key': config.connectionKey },
    body: JSON.stringify({ events })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `WorkLens returned ${response.status}`);
  return result.accepted || 0;
}

async function sync(since) {
  const config = await settings();
  if (!config.enabled || !config.connectionKey) return { accepted: 0, skipped: true };
  const endTime = Date.now();
  const startTime = since || config.lastSync || endTime - 60 * 60 * 1000;
  const history = await chrome.history.search({ text: '', startTime, endTime, maxResults: 500 });
  const events = history
    .filter(item => item.url?.startsWith('http') && !excluded(item.url, config.excludedDomains))
    .map(item => ({ url: item.url, title: item.title || '', visitedAt: item.lastVisitTime || endTime }));
  const accepted = await send(events, config);
  await chrome.storage.local.set({ lastSync: endTime, lastResult: { ok: true, accepted, at: endTime } });
  return { accepted };
}

chrome.runtime.onInstalled.addListener(async () => {
  const config = await settings();
  await chrome.storage.local.set({ excludedDomains: config.excludedDomains });
  chrome.alarms.create('worklens-sync', { periodInMinutes: config.syncMinutes });
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'worklens-sync') sync().catch(async error => chrome.storage.local.set({ lastResult: { ok: false, error: error.message, at: Date.now() } })); });
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type !== 'sync') return false;
  sync(message.since).then(respond).catch(error => respond({ error: error.message }));
  return true;
});
