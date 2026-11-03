// Workstation · Connections — the account page (click any social account), the Settings card
// for platform app credentials, and the connect / upload flows. Backed by /api/social/*.
// Self-contained like brands.js and hub.js: own dialog and request helper.
import { reportContext } from '/monitor.js';

const root = document.querySelector('#accountRoot');
const card = document.querySelector('#socialCard');
const dialog = document.querySelector('#socialDialog');
const form = document.querySelector('#socialForm');
const PLATFORM_SHORT = { IG: 'IG', FB: 'FB', Threads: 'TH', TikTok: 'TT', X: 'X', YT: 'YT' };
const STAGES = { idea: 'Idea', prompt: 'Prompt ready', generated: 'Generated', edited: 'Edited', scheduled: 'Scheduled', posted: 'Posted' };
let detail = null, accountId = null, onSubmit = null, waitTimer = null, settings = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
async function request(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}
const num = n => n == null ? '—' : Number(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Number(n) >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : Number(n).toLocaleString();
const ago = iso => { if (!iso) return 'never'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const day = iso => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const when = iso => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const openTool = view => document.querySelector(`.nav[data-view="${view}"]`)?.click();

// ---------- account page ----------
export async function openAccount(id) {
  accountId = Number(id);
  document.querySelectorAll('.view,.nav').forEach(x => x.classList.remove('active'));
  document.querySelector('#account').classList.add('active');
  document.querySelector('.nav[data-view="hub"]')?.classList.add('active');
  document.querySelector('#title').textContent = 'How this account is doing.';
  root.innerHTML = '<div class="card empty">Loading account…</div>';
  await loadAccount();
}

async function loadAccount() {
  try { detail = await request(`/api/social/accounts/${accountId}`); renderAccount(); }
  catch (error) { root.innerHTML = `<div class="card empty">Couldn't load this account: ${esc(error.message)}</div>`; }
}

function change(snaps, daysBack) {
  if (snaps.length < 2) return null;
  const last = snaps[snaps.length - 1];
  const cutoff = new Date(Date.parse(`${last.day}T00:00:00`) - daysBack * 86400000).toISOString().slice(0, 10);
  const base = [...snaps].reverse().find(s => s.day <= cutoff) || snaps[0];
  if (base === last || base.followers == null || last.followers == null) return null;
  return last.followers - base.followers;
}
const delta = n => n == null ? '' : `<em class="${n > 0 ? 'up' : n < 0 ? 'down' : ''}">${n > 0 ? '+' : ''}${num(n)}</em>`;

function renderAccount() {
  const { account: a, connection: c, snapshots, posts, pipeline } = detail;
  reportContext({ tool: 'hub', label: `Account: ${a.handle} (${a.brand_name})` });
  const latest = snapshots[snapshots.length - 1];
  const scheduled = [
    ...pipeline.filter(i => i.stage !== 'posted').map(i => ({ kind: 'pipeline', ...i })),
    ...posts.filter(p => p.status === 'scheduled' || p.status === 'private' || p.status === 'unlisted' || p.status === 'draft').map(p => ({ kind: 'platform', ...p }))
  ];
  const published = posts.filter(p => p.status === 'published');
  const loggedOnly = pipeline.filter(i => i.stage === 'posted' && !published.some(p => i.post_url && p.url && p.url === i.post_url));
  root.innerHTML = `
    <button class="back-button" data-open-tool="hub">← Overview</button>
    <div class="card acct-hero" style="--brand:${esc(a.brand_color)}">
      <div class="acct-id"><span class="pf pf-${esc(a.platform)}">${esc(PLATFORM_SHORT[a.platform] || a.platform)}</span>
        <div><h2>${esc(a.handle)}</h2><span>${esc(a.brand_name)} · <a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">Open profile ↗</a> · last post logged ${a.last_posted ? esc(a.last_posted) : 'never'}</span></div></div>
      <div class="acct-conn">${connectionBlock()}</div>
    </div>
    ${c ? stats(latest, snapshots) : ''}
    <div class="acct-cols">
      <div class="card"><div class="section-title"><h3>Scheduled & to be posted</h3><span class="eyebrow">${scheduled.length}</span></div>
        ${scheduled.map(scheduledRow).join('') || `<div class="empty">Nothing planned for this account. <button class="link-btn" data-open-tool="content">Plan a video</button></div>`}</div>
      <div class="card"><div class="section-title"><h3>Posted</h3><span class="eyebrow">${published.length + loggedOnly.length}</span></div>
        ${published.map(postRow).join('')}${loggedOnly.map(i => scheduledRow({ kind: 'pipeline', ...i })).join('')}
        ${published.length + loggedOnly.length ? '' : `<div class="empty">${c ? 'No posts found on this account yet.' : 'Connect the account to list its posts with captions, hashtags and counts.'}</div>`}</div>
    </div>`;
}

function connectionBlock() {
  const { connection: c, provider, providerLabel, oauthReady, account: a } = detail;
  if (!provider) return `<p class="hint">WorkLens can't read ${esc(a.platform)} stats yet — YouTube, Instagram and TikTok are supported. Posting is still tracked from Brands and Content.</p>`;
  if (!c) {
    if (!oauthReady) return `<p class="hint">To connect ${providerLabel}, add your ${provider === 'youtube' ? 'Google' : 'TikTok'} app credentials once in Settings.</p><button class="primary" data-go-settings>Open Settings</button>`;
    return `<p class="hint">Not connected. Connecting lets WorkLens read followers, views and every post's numbers${provider === 'youtube' ? ', and upload scheduled videos' : ''}.</p><button class="primary" data-connect="${provider}">Connect ${providerLabel}</button>`;
  }
  const mismatch = c.handle && a.handle && c.handle.toLowerCase().replace(/^@/, '') !== a.handle.toLowerCase().replace(/^@/, '');
  return `<div class="conn-state ${esc(c.status)}"><img src="${esc(c.avatar)}" alt="" onerror="this.remove()"><div><strong>${esc(c.name || c.handle)}</strong>
      <span>${c.status === 'ok' ? `Connected · synced ${ago(c.lastSyncAt)}` : c.status === 'expired' ? 'Sign-in expired — reconnect' : 'Last sync failed'}</span></div></div>
    ${c.lastError ? `<p class="hint warn">${esc(c.lastError)}</p>` : ''}
    ${mismatch ? `<p class="hint warn">This connection is ${esc(c.handle)}, but the account here is ${esc(a.handle)}. Reconnect and pick the right ${providerLabel} account if that's wrong.</p>` : ''}
    <div class="brand-actions"><button data-sync="${c.id}" ${c.syncing ? 'disabled' : ''}>${c.syncing ? 'Syncing…' : 'Sync now'}</button>${c.status !== 'ok' ? `<button class="primary" data-connect="${provider}">Reconnect</button>` : ''}<button class="danger-text" data-disconnect="${c.id}">Disconnect</button></div>`;
}

function stats(latest, snaps) {
  if (!latest) return '<div class="card empty">Connected — the first sync is running. Numbers appear in a moment.</div>';
  const x = latest.extra || {};
  const tiles = [
    ['Followers', num(latest.followers), `${delta(change(snaps, 7))}${change(snaps, 7) != null ? ' 7 days' : ''}`],
    detail.provider === 'youtube' ? ['Views · 28 days', num(x.views28), x.net28 != null ? `${delta(x.net28)} subs` : ''] : ['Views · recent posts', num(latest.views), ''],
    detail.provider === 'youtube' ? ['Watch hours · 28 days', x.minutes28 != null ? num(Math.round(x.minutes28 / 60)) : '—', ''] : ['Likes', num(latest.likes), ''],
    ['Posts', num(latest.posts), detail.provider === 'youtube' ? `${num(latest.views)} lifetime views` : '']
  ];
  return `<div class="acct-stats">${tiles.map(([label, value, sub]) => `<div class="stat"><strong>${value}</strong><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`).join('')}</div>
    ${sparkline(snaps)}${x.analyticsError ? `<p class="hint">YouTube Analytics: ${esc(x.analyticsError)}</p>` : ''}`;
}

// Followers over time: one series, so no legend; the title names it. Hover shows the day's value.
function sparkline(snaps) {
  const pts = snaps.filter(s => s.followers != null);
  if (pts.length < 2) return '<div class="card spark-card"><div class="section-title"><h3>Followers</h3><span class="eyebrow">TREND</span></div><div class="empty">The trend appears after a second day of syncing.</div></div>';
  const W = 640, H = 120, P = 6;
  const vals = pts.map(p => p.followers), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const xy = pts.map((p, i) => [P + i * (W - 2 * P) / (pts.length - 1), H - P - (p.followers - lo) / span * (H - 2 * P)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  return `<div class="card spark-card"><div class="section-title"><h3>Followers</h3><span class="eyebrow">${esc(pts[0].day)} → ${esc(pts[pts.length - 1].day)}</span></div>
    <div class="spark" data-spark='${esc(JSON.stringify(pts.map((p, i) => [p.day, p.followers, xy[i][0], xy[i][1]])))}'>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Followers from ${esc(num(vals[0]))} to ${esc(num(vals[vals.length - 1]))}">
        <line x1="0" x2="${W}" y1="${H - P}" y2="${H - P}" class="spark-base"/><path d="${d}" class="spark-line" vector-effect="non-scaling-stroke"/>
        <line class="spark-cross" x1="0" x2="0" y1="0" y2="${H}" vector-effect="non-scaling-stroke"/></svg>
      <span class="spark-dot"></span><div class="spark-tip"></div>
      <div class="spark-axis"><span>${num(lo)}</span><span>${num(hi)}</span></div></div></div>`;
}

root.addEventListener('pointermove', e => {
  const box = e.target.closest?.('.spark'); if (!box) return;
  const pts = JSON.parse(box.dataset.spark), r = box.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width * 640;
  const p = pts.reduce((best, q) => Math.abs(q[2] - fx) < Math.abs(best[2] - fx) ? q : best);
  const x = p[2] / 640 * r.width, y = p[3] / 120 * r.height;
  box.classList.add('hover');
  box.querySelector('.spark-cross').setAttribute('x1', p[2]); box.querySelector('.spark-cross').setAttribute('x2', p[2]);
  Object.assign(box.querySelector('.spark-dot').style, { left: `${x}px`, top: `${y}px` });
  const tip = box.querySelector('.spark-tip');
  tip.innerHTML = `<strong>${num(p[1])}</strong><span>${esc(day(`${p[0]}T12:00`))}</span>`;
  tip.style.left = `${Math.min(Math.max(x, 50), r.width - 50)}px`;
});
root.addEventListener('pointerleave', e => { root.querySelectorAll('.spark.hover').forEach(b => b.classList.remove('hover')); }, true);

const chips = tags => tags?.length ? `<div class="tag-chips">${tags.slice(0, 12).map(t => `<span>${esc(t)}</span>`).join('')}${tags.length > 12 ? `<span>+${tags.length - 12}</span>` : ''}</div>` : '';

function scheduledRow(i) {
  if (i.kind === 'platform') {
    return `<div class="post-row"><div class="post-thumb">${i.thumb ? `<img src="${esc(i.thumb)}" alt="">` : ''}</div><div class="post-body">
      <strong>${esc(i.title || 'Untitled')}</strong><span>${i.status === 'scheduled' ? `Scheduled on ${esc(detail.providerLabel)} · ${esc(when(i.scheduled_at))}` : `${esc(i.status)} on ${esc(detail.providerLabel)}`}</span>
      ${chips(i.hashtags)}</div><a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>`;
  }
  const tags = i.hashtags ? i.hashtags.split(/\s+/).filter(Boolean) : [];
  return `<div class="post-row"><div class="post-thumb stage">${esc(STAGES[i.stage]?.slice(0, 1) || '?')}</div><div class="post-body">
    <strong>${esc(i.title)}</strong><span>${esc(STAGES[i.stage] || i.stage)} in Content${i.scheduled_at ? ` · ${esc(when(i.scheduled_at))}` : ''}${i.posted_at ? ` · posted ${esc(day(i.posted_at))}` : ''}</span>
    ${i.caption ? `<p>${esc(i.caption.slice(0, 160))}</p>` : ''}${chips(tags)}</div><button data-edit-content="${i.id}">Open</button></div>`;
}

function postRow(p) {
  const counts = [['views', p.views], ['likes', p.likes], ['comments', p.comments], ['shares', p.shares]].filter(([, v]) => v != null);
  return `<div class="post-row"><div class="post-thumb">${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy">` : ''}</div><div class="post-body">
    <strong>${esc(p.title || p.caption.slice(0, 80) || 'Untitled')}</strong><span>${esc(day(p.published_at))}${p.extra?.type ? ` · ${esc(String(p.extra.type).toLowerCase())}` : ''}</span>
    <div class="post-counts">${counts.map(([k, v]) => `<span><b>${num(v)}</b> ${k}</span>`).join('')}</div>
    ${chips(p.hashtags)}${p.caption ? `<details><summary>Caption</summary><p>${esc(p.caption)}</p></details>` : ''}</div>
    <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div>`;
}

// Opening the sign-in page: the desktop app sends it to the default browser. Then wait for the
// callback to land and refresh, for up to five minutes.
async function connect(provider) {
  if (provider === 'instagram') return instagramDialog();
  const { authUrl } = await request(`/api/social/connect/${provider}`, { method: 'POST', body: JSON.stringify({ accountId }) });
  window.open(authUrl, '_blank', 'noopener');
  toast('Finish signing in in your browser, then come back here.');
  const before = detail.connection?.lastSyncAt || '';
  clearInterval(waitTimer);
  const started = Date.now();
  waitTimer = setInterval(async () => {
    if (Date.now() - started > 5 * 60000 || !document.querySelector('#account.active')) return clearInterval(waitTimer);
    const next = await request(`/api/social/accounts/${accountId}`).catch(() => null);
    if (next?.connection && next.connection.lastSyncAt !== before && next.connection.lastSyncAt) { clearInterval(waitTimer); detail = next; renderAccount(); toast(`${next.providerLabel} connected`); }
  }, 3000);
}

function instagramDialog() {
  openDialog('Connect Instagram', `
    <ol class="steps">
      <li>Make sure <strong>${esc(detail.account.handle)}</strong> is a Professional account (Instagram → Settings → Account type and tools → Switch to professional).</li>
      <li>On <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer">developers.facebook.com/apps</a>, create an app with the use case <em>Manage messaging & content on Instagram</em>.</li>
      <li>In the app: Instagram → <em>API setup with Instagram login</em> → <em>Generate access tokens</em> → Add account → sign in as ${esc(detail.account.handle)} → <em>Generate token</em>.</li>
      <li>Paste the token below. WorkLens keeps it encrypted on this PC and renews it before its 60 days run out.</li>
    </ol>
    <label>Access token</label><textarea name="token" rows="3" required placeholder="IGAA…"></textarea>`, 'Connect', async f => {
    await request('/api/social/connect/instagram', { method: 'POST', body: JSON.stringify({ accountId, token: f.token }) });
    toast('Instagram connected');
    await loadAccount();
  });
}

function gumroadDialog(storeId) {
  openDialog('Connect Gumroad', `
    <ol class="steps">
      <li>On Gumroad: <a href="https://app.gumroad.com/settings/advanced" target="_blank" rel="noopener noreferrer">Settings → Advanced</a> → Applications → create one (any name, redirect URI <code>http://localhost</code>).</li>
      <li>Open it and click <em>Generate access token</em>.</li>
      <li>Paste it below. WorkLens reads products and this month's sales and updates this row every 6 hours.</li>
    </ol>
    <label>Access token</label><input name="token" required autocomplete="off">`, 'Connect', async f => {
    await request('/api/social/connect/gumroad', { method: 'POST', body: JSON.stringify({ storeId, token: f.token }) });
    toast('Gumroad connected');
    document.dispatchEvent(new CustomEvent('workstation:changed', { detail: { tool: 'places' } }));
    document.querySelector('.nav[data-view="places"]')?.click();
  });
}

// Content item → YouTube. Confirms what will happen first: uploading publishes outside WorkLens.
async function uploadDialog(contentId, item) {
  const conns = (await request('/api/social/connections')).connections.filter(c => c.provider === 'youtube');
  if (!conns.length) return toast('Connect a YouTube channel first: open the channel from Overview and click Connect.');
  const brandYT = conns.find(c => item.accounts?.includes(c.brandAccountId)) || conns[0];
  const future = item.scheduled_at && Date.parse(item.scheduled_at) > Date.now() + 15 * 60000;
  openDialog('Upload to YouTube', `
    <p class="dialog-note">Uploads <strong>${esc(item.title)}</strong> with its caption and hashtags as the description${future ? `, scheduled to go public <strong>${esc(when(item.scheduled_at))}</strong>` : ''}.</p>
    <label>Channel</label><select name="connectionId">${conns.map(c => `<option value="${c.id}" ${c.id === brandYT.id ? 'selected' : ''}>${esc(c.name)} ${esc(c.handle)}</option>`).join('')}</select>
    ${future ? '<input type="hidden" name="privacy" value="private">' : `<label>Visibility</label><select name="privacy"><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select>`}
    <p class="hint">Until your Google project passes YouTube's API audit, YouTube keeps API uploads private, even scheduled ones. You can then make it public in YouTube Studio.</p>`, 'Upload', async f => {
    toast('Uploading… this can take a few minutes for a big file.');
    const r = await request('/api/social/youtube/upload', { method: 'POST', body: JSON.stringify({ contentId, connectionId: Number(f.connectionId), privacy: f.privacy }) });
    toast(`Uploaded (${r.privacy}${r.publishAt ? `, publishes ${when(r.publishAt)}` : ''})`);
    document.dispatchEvent(new CustomEvent('workstation:changed', { detail: { tool: 'content' } }));
  });
}

// ---------- Settings card ----------
async function loadSettings() {
  if (!card) return;
  try {
    const [s, c] = await Promise.all([request('/api/social/settings'), request('/api/social/connections')]);
    settings = s; renderSettings(c.connections);
  } catch (error) { card.querySelector('[data-social-body]').innerHTML = `<p class="hint">${esc(error.message)}</p>`; }
}

function renderSettings(connections) {
  const s = settings;
  card.querySelector('[data-social-body]').innerHTML = `
    ${s.encrypted ? '' : '<p class="hint warn">Running without the desktop app, so secrets are stored unencrypted. Save them from the installed WorkLens to encrypt them.</p>'}
    <div class="social-provider"><strong>YouTube</strong> <span class="hint">${s.google.clientId && s.google.secretSet ? 'Ready to connect channels' : 'Needs a Google OAuth client'}</span>
      <label>Google client ID</label><input data-s="googleClientId" value="${esc(s.google.clientId)}" placeholder="…apps.googleusercontent.com">
      <label>Google client secret</label><input type="password" data-s="googleClientSecret" placeholder="${s.google.secretSet ? 'Saved — type to replace' : 'GOCSPX-…'}">
      <label>Redirect URI <small>(paste into Google)</small></label><div class="or-key"><input readonly value="${esc(s.redirect.youtube)}"><button data-copy="${esc(s.redirect.youtube)}">Copy</button></div>
      <details><summary>How to get these (10 minutes, free)</summary><ol class="steps">
        <li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">Create a Google Cloud project</a> called WorkLens.</li>
        <li>APIs & Services → Library: enable <em>YouTube Data API v3</em> and <em>YouTube Analytics API</em>.</li>
        <li>OAuth consent screen (Google Auth Platform): External; under Audience add the Google accounts that own your channels as test users.</li>
        <li>Clients → Create client → <em>Web application</em> → add the redirect URI above → copy the client ID and secret here.</li>
        <li>While the app is in <em>Testing</em>, Google ends sign-ins after 7 days. Set it to <em>In production</em> (no review needed for your own channels; Google shows an "unverified app" warning you can click through).</li></ol></details>
      <div class="brand-actions"><button class="primary" data-save="google">Save</button>${s.google.clientId ? '<button class="danger-text" data-clear="google">Remove</button>' : ''}</div></div>
    <div class="social-provider"><strong>TikTok</strong> <span class="hint">${s.tiktok.clientKey && s.tiktok.secretSet ? 'Ready to connect accounts' : 'Needs a TikTok developer app'}</span>
      <label>Client key</label><input data-s="tiktokClientKey" value="${esc(s.tiktok.clientKey)}">
      <label>Client secret</label><input type="password" data-s="tiktokClientSecret" placeholder="${s.tiktok.secretSet ? 'Saved — type to replace' : ''}">
      <label>Redirect URI</label><div class="or-key"><input readonly value="${esc(s.redirect.tiktok)}"><button data-copy="${esc(s.redirect.tiktok)}">Copy</button></div>
      <details><summary>How to get these</summary><ol class="steps">
        <li><a href="https://developers.tiktok.com/apps" target="_blank" rel="noopener noreferrer">developers.tiktok.com → Manage apps</a> → Connect an app.</li>
        <li>Add <em>Login Kit</em> with platform <em>Desktop</em> and the redirect URI above.</li>
        <li>Scopes: user.info.basic, user.info.profile, user.info.stats, video.list.</li>
        <li>Submit for review. Until it's approved, use the Sandbox and add your accounts as target users.</li>
        <li>Copy the client key and secret here. Posting to TikTok stays manual: it needs TikTok's separate audit.</li></ol></details>
      <div class="brand-actions"><button class="primary" data-save="tiktok">Save</button>${s.tiktok.clientKey ? '<button class="danger-text" data-clear="tiktok">Remove</button>' : ''}</div></div>
    <p class="hint">Instagram and Gumroad use a token you paste: open an Instagram account from Overview, or the Gumroad row in Sites & stores.</p>
    <div class="section-title"><h3>Connected</h3>${connections.length ? '<button data-sync-all>Sync all</button>' : ''}</div>
    ${connections.map(c => `<div class="conn-row"><span class="store-tag">${esc(c.label)}</span><div><strong>${esc(c.name || c.handle)}</strong><span class="hint">${c.status === 'ok' ? `synced ${ago(c.lastSyncAt)}` : esc(c.lastError || c.status)}</span></div>
      <button data-sync="${c.id}">Sync</button><button class="danger-text" data-disconnect="${c.id}">Disconnect</button></div>`).join('') || '<p class="hint">Nothing connected yet.</p>'}`;
}

card?.addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return;
  try {
    if (t.dataset.copy) { await navigator.clipboard.writeText(t.dataset.copy); return toast('Copied'); }
    if (t.dataset.save) {
      const v = k => card.querySelector(`[data-s="${k}"]`)?.value.trim();
      const body = t.dataset.save === 'google' ? { googleClientId: v('googleClientId'), googleClientSecret: v('googleClientSecret') || undefined } : { tiktokClientKey: v('tiktokClientKey'), tiktokClientSecret: v('tiktokClientSecret') || undefined };
      await request('/api/social/settings', { method: 'PUT', body: JSON.stringify(body) }); toast('Saved'); return loadSettings();
    }
    if (t.dataset.clear) { await request('/api/social/settings', { method: 'PUT', body: JSON.stringify({ clear: t.dataset.clear }) }); toast('Removed'); return loadSettings(); }
    if (t.dataset.syncAll !== undefined) { t.disabled = true; t.textContent = 'Syncing…'; const r = await request('/api/social/sync-all', { method: 'POST', body: '{}' }); toast(`${r.ok} synced${r.failed ? `, ${r.failed} failed` : ''}`); return loadSettings(); }
    if (t.dataset.sync) { t.disabled = true; await request(`/api/social/connections/${t.dataset.sync}/sync`, { method: 'POST', body: '{}' }).catch(err => toast(err.message)); return loadSettings(); }
    if (t.dataset.disconnect) return disconnect(Number(t.dataset.disconnect), loadSettings);
  } catch (error) { toast(error.message); t.disabled = false; }
});

function disconnect(id, after) {
  openDialog('Disconnect?', '<p class="dialog-note">WorkLens forgets the sign-in and the synced numbers for this account. You can connect it again any time.</p>', 'Disconnect', async () => {
    await request(`/api/social/connections/${id}`, { method: 'DELETE' }); toast('Disconnected'); await after();
  });
}

// ---------- dialog ----------
function openDialog(title, html, submitLabel, handler) {
  dialog.querySelector('#socialDialogTitle').textContent = title;
  dialog.querySelector('#socialDialogFields').innerHTML = html;
  dialog.querySelector('#socialDialogSave').textContent = submitLabel;
  dialog.querySelector('#socialDialogSave').classList.toggle('danger', /^(Disconnect|Remove)/.test(submitLabel));
  onSubmit = handler;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('textarea,input:not([type=hidden]),select')?.focus();
}
form.addEventListener('submit', async e => {
  e.preventDefault();
  const save = dialog.querySelector('#socialDialogSave');
  save.disabled = true;
  try { await onSubmit?.(Object.fromEntries(new FormData(form))); dialog.close(); }
  catch (error) { toast(error.message); }
  finally { save.disabled = false; }
});
dialog.addEventListener('click', e => { if (e.target.closest('[data-social-close]')) dialog.close(); });

// ---------- wiring ----------
root.addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return;
  try {
    if (t.dataset.connect) { t.disabled = true; await connect(t.dataset.connect); t.disabled = false; return; }
    if (t.dataset.sync) { t.disabled = true; t.textContent = 'Syncing…'; await request(`/api/social/connections/${t.dataset.sync}/sync`, { method: 'POST', body: '{}' }).catch(err => toast(err.message)); return loadAccount(); }
    if (t.dataset.disconnect) return disconnect(Number(t.dataset.disconnect), loadAccount);
    if (t.dataset.goSettings !== undefined) { openTool('settings'); return setTimeout(() => card?.scrollIntoView({ behavior: 'smooth' }), 200); }
    if (t.dataset.editContent) document.dispatchEvent(new CustomEvent('edit-content', { detail: { id: Number(t.dataset.editContent) } }));
  } catch (error) { toast(error.message); t.disabled = false; }
});

document.addEventListener('click', e => {
  const open = e.target.closest?.('[data-open-account]');
  if (open) { e.preventDefault(); openAccount(open.dataset.openAccount); }
  const gum = e.target.closest?.('[data-connect-gumroad]');
  if (gum) gumroadDialog(Number(gum.dataset.connectGumroad) || null);
  if (e.target.closest?.('.nav[data-view="settings"]')) loadSettings();
});
document.addEventListener('youtube-upload', e => uploadDialog(e.detail.id, e.detail.item).catch(err => toast(err.message)));
document.addEventListener('workstation:changed', () => { if (document.querySelector('#account.active')) loadAccount(); });
loadSettings();
