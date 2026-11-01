// Workstation · TestLoop screen — admin panel for closed-testing campaigns, backed by
// /api/testloop. The cloud Telegram bot onboards and verifies testers; this screen shows what it
// synced, and every decision made here (approve, strike, retention day) is sent back to the bot.
import { reportContext } from '/monitor.js';
const root = document.querySelector('#testloopRoot');
const dialog = document.querySelector('#testloopDialog');
const form = document.querySelector('#testloopForm');
const STATUS_LABEL = { pending: 'Pending', active: 'Active', need_proof: 'Need proof', strike_1: 'Strike 1', strike_2: 'Strike 2', removed: 'Removed', completed: 'Completed' };
const CYCLE = ['active', 'need_proof', 'strike_1', 'strike_2', 'removed', 'completed'];
let data = null, activeId = null, onSubmit = null, draft = '';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2400); }
async function request(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}
function remember(id) { try { localStorage.setItem('wl-active-testloop', String(id)); } catch {} }
function recall() { try { return Number(localStorage.getItem('wl-active-testloop')) || null; } catch { return null; } }
function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}
const who = t => t.username || t.name || t.gmail;

export async function loadTestloop() {
  try {
    data = await request(`/api/testloop${activeId || recall() ? `?app=${activeId || recall()}` : ''}`);
    activeId = data.app?.id ?? null;
    render();
  } catch (error) { root.innerHTML = `<div class="card empty">Couldn't load TestLoop: ${esc(error.message)}</div>`; }
}

function render() {
  const { app, apps, stats, sync } = data;
  if (document.querySelector('#testloop')?.classList.contains('active')) reportContext({ tool: 'testloop', label: app ? `TestLoop: ${app.name}` : 'TestLoop' });
  const head = `<div class="section-head"><div><span class="eyebrow">STUDIO TOOL · CLOSED TESTING OS</span><h2>TestLoop</h2></div>
    <div class="brand-actions"><button data-tl="connect">${sync.connected ? '● Bot connected' : 'Connect bot'}</button>${app ? `<button data-tl="import">Import CSV</button><button class="primary" data-tl="add-tester">+ Add tester</button>` : ''}</div></div>
    <div class="tl-apps">${apps.map(a => `<button class="tl-pill ${a.id === activeId ? 'active' : ''}" data-tl-app="${a.id}">${esc(a.name)} <em>${a.testers} testers</em></button>`).join('')}<button class="tl-pill add" data-tl="add-app">+ Add app</button></div>`;
  if (!app) { root.innerHTML = `${head}<div class="card empty brand-empty"><strong>No apps yet</strong><p>Add the app you need closed testers for.</p></div>`; return; }
  const testerPct = Math.min(100, Math.round(stats.testers / stats.target * 100));
  const dayPct = Math.round(stats.campaignDay / app.days_required * 100);
  root.innerHTML = `${head}
    <div class="tl-stats">
      <div class="stat ${stats.testers >= stats.target ? 'stat-success' : ''}"><strong>${stats.testers}/${stats.target}</strong><span>Testers in</span><div class="progress"><i style="width:${testerPct}%"></i></div></div>
      <div class="stat"><strong>Day ${stats.campaignDay}/${app.days_required}</strong><span>${stats.finished} finished 14 days</span><div class="progress"><i style="width:${dayPct}%"></i></div></div>
      <div class="stat ${stats.queue ? 'stat-warn' : ''}"><strong>${stats.queue}</strong><span>Awaiting verification</span></div>
      <div class="stat ${stats.atRisk ? 'stat-danger' : ''}"><strong>${stats.atRisk}</strong><span>At risk (proof, strikes, quiet 48h)</span></div>
      <div class="stat"><strong>${stats.feedback}</strong><span>Feedback · avg ${stats.avgScore ?? '—'}/5</span></div>
    </div>
    ${stats.ready ? `<div class="card tl-ready">✓ ${stats.target} testers have completed ${app.days_required} days. You can apply for production access in Play Console.</div>` : ''}
    <div class="tl-grid">
      <div class="card tl-table-card">
        <div class="section-title"><h3>Testers</h3><span class="eyebrow">CLICK STATUS TO CHANGE · ± TO EDIT DAY</span></div>
        ${data.testers.length ? `<div class="tl-table-wrap"><table class="tl-table"><thead><tr><th>Tester</th><th>Day</th><th>Feedback</th><th>Status</th><th></th></tr></thead><tbody>${data.testers.map(testerRow).join('')}</tbody></table></div>`
          : `<div class="empty">No active testers yet. Approve applicants from the queue, add one by hand, or import your Form CSV.</div>`}
      </div>
      <div class="tl-side">
        <div class="card"><div class="section-title"><h3>Verification queue</h3><span class="pill">${data.queue.length}</span></div>
          ${data.queue.length ? data.queue.map(queueRow).join('') : '<div class="empty">Nobody waiting. New applicants from the bot or your Form CSV land here.</div>'}</div>
        <div class="card tl-sync"><span class="eyebrow">TELEGRAM BOT</span>
          ${sync.connected ? `<p>Synced ${esc(ago(sync.lastSync))} from <code>${esc(sync.url.replace(/^https?:\/\//, ''))}</code></p>${sync.error ? `<p class="tl-error">Last sync failed: ${esc(sync.error)}</p>` : ''}<button data-tl="sync">Sync now</button>`
            : '<p>Not connected. Testers you add here stay local until the cloud bot is deployed and connected.</p><button data-tl="connect">Connect bot</button>'}</div>
      </div>
    </div>
    <div class="tl-grid">
      <div class="card"><div class="section-title"><h3>Feedback</h3><span class="eyebrow">${data.aiConfigured ? 'AI-SCORED 1–5' : 'ADD OPENROUTER KEY TO SCORE'}</span></div>
        <div class="tl-feed">${data.feedback.length ? data.feedback.map(feedbackRow).join('') : '<div class="empty">No feedback yet. Testers send it with /feedback in Telegram.</div>'}</div>
        <form class="tl-feedback-form" id="tlFeedbackForm"><select name="testerId"><option value="">No tester</option>${data.testers.map(t => `<option value="${t.id}">${esc(who(t))}</option>`).join('')}</select><input name="text" minlength="11" required placeholder="Device: Pixel 7 · Bug: reminder didn't fire…"><button class="primary">Add</button></form>
      </div>
      <div class="card"><div class="section-title"><h3>Announcement</h3><span class="eyebrow">TELEGRAM → WHATSAPP</span></div>
        <textarea id="tlAnnounce" rows="4" placeholder="New build 1.0.3 is live: fixed reminders on Android 14.">${esc(draft)}</textarea>
        <pre class="tl-preview" id="tlPreview"></pre>
        <div class="brand-actions"><button data-tl="copy-announce">Copy</button><button class="primary" data-tl="send-announce" ${sync.connected ? '' : 'disabled title="Connect the bot first"'}>Send via bot</button></div>
      </div>
    </div>`;
  updatePreview();
}

function testerRow(t) {
  return `<tr class="${t.quiet ? 'tl-quiet' : ''}">
    <td><strong>${esc(who(t))}</strong><small>${esc(t.gmail)}${t.device ? ` · ${esc(t.device)}` : ''}${t.quiet ? ' · no feedback in 48h' : ''}</small></td>
    <td class="tl-day"><button class="icon-btn" data-tl-day="${t.id}" data-delta="-1" ${t.day <= 1 ? 'disabled' : ''}>−</button><span class="mono">${t.day}/${data.app.days_required}</span><button class="icon-btn" data-tl-day="${t.id}" data-delta="1" ${t.day >= data.app.days_required ? 'disabled' : ''}>+</button></td>
    <td class="mono">${t.feedbacks}${t.last_feedback ? ` <small>${esc(ago(t.last_feedback))}</small>` : ''}</td>
    <td><button class="tl-status s-${t.status}" data-tl-status="${t.id}" title="Click for next status">${STATUS_LABEL[t.status] || t.status}</button></td>
    <td><button class="icon-btn danger" title="Remove tester" data-tl-remove="${t.id}">🗑</button></td></tr>`;
}
function queueRow(t) {
  return `<div class="tl-queue-row"><div><strong>${esc(who(t))}</strong><small>${esc(t.gmail)} · via ${esc(t.source)}${t.ai_reason ? ` · ${esc(t.ai_reason)}` : ''}</small></div>
    <div class="tl-queue-actions"><button class="primary" data-tl-approve="${t.id}">Approve</button><button data-tl-reject="${t.id}">Reject</button></div></div>`;
}
function feedbackRow(f) {
  return `<div class="tl-fb"><div class="tl-fb-head"><span class="tl-tag t-${esc(f.tag)}">${esc(f.tag)}</span><strong>${esc(f.username || f.name || f.gmail || 'Unknown tester')}</strong><span class="tl-score">${f.score ? `${f.score}/5` : 'unscored'}</span><small>${esc(ago(f.created_at))}</small></div>
    <p>${esc(f.text)}</p>${f.summary ? `<small>${esc(f.summary)}</small>` : ''}</div>`;
}
function updatePreview() {
  const el = document.querySelector('#tlPreview');
  if (el) el.textContent = `🚀 DUE SOON UPDATE\n\n${draft || '…'}\n\n👉 Test in Telegram HQ\n📋 Feedback: /feedback Device: X Bug: Y`;
}

// ---------- Dialog ----------
function openDialog(title, fieldsHtml, submitLabel, handler) {
  dialog.querySelector('#testloopDialogTitle').textContent = title;
  dialog.querySelector('#testloopDialogFields').innerHTML = fieldsHtml;
  dialog.querySelector('#testloopDialogSave').textContent = submitLabel;
  onSubmit = handler;
  dialog.showModal();
  dialog.querySelector('input,textarea,select')?.focus();
}
const fields = f => Object.fromEntries(new FormData(f));

function addApp() {
  openDialog('Add app', '<label>App name</label><input name="name" maxlength="80" required placeholder="e.g. Due soon"><label>Play testing link <small>(optional)</small></label><input name="playLink" type="url" placeholder="https://play.google.com/apps/testing/…"><label>Testers needed</label><input name="targetTesters" type="number" min="1" value="20"><label>Days required</label><input name="daysRequired" type="number" min="1" value="14">', 'Add app', async f => {
    const { id } = await request('/api/testloop/apps', { method: 'POST', body: JSON.stringify(f) });
    activeId = id; remember(id); toast(`${f.name.trim()} added`);
  });
}
function addTester() {
  openDialog('Add tester', '<label>Name</label><input name="name" maxlength="120" placeholder="Full name"><label>Gmail</label><input name="gmail" type="email" required placeholder="name@gmail.com"><label>Telegram username <small>(optional)</small></label><input name="username" maxlength="80" placeholder="@username"><label>Device <small>(optional)</small></label><input name="device" maxlength="160" placeholder="Tecno Spark 10 · Android 13"><p class="dialog-note">Added as active, starting day 1 today. Remember to add the Gmail to your Play Console testers list.</p>', 'Add tester', async f => {
    await request(`/api/testloop/apps/${activeId}/testers`, { method: 'POST', body: JSON.stringify(f) });
    toast('Tester added');
  });
}
function importCsv() {
  openDialog('Import Google Form responses', '<label>CSV file <small>(Responses sheet → File → Download → CSV)</small></label><input type="file" name="file" accept=".csv,text/csv" required><p class="dialog-note">Applicants land in the verification queue. Rows without a @gmail.com address are skipped, and Gmails already in this app are left alone.</p>', 'Import', async () => {
    const file = dialog.querySelector('input[type=file]').files[0];
    if (!file) throw new Error('Choose a CSV file.');
    const result = await request(`/api/testloop/apps/${activeId}/import`, { method: 'POST', body: JSON.stringify({ csv: await file.text() }) });
    toast(`Imported ${result.added} · skipped ${result.skipped}`);
  });
}
function connectBot() {
  const s = data.sync;
  openDialog('Connect TestLoop bot', `<label>Bot URL</label><input name="url" type="url" value="${esc(s.url)}" placeholder="https://testloop-bot.up.railway.app"><label>Sync token <small>(SYNC_TOKEN from the bot's env)</small></label><input name="token" type="password" placeholder="${s.connected ? 'Saved — leave blank to keep' : 'Paste the token'}" autocomplete="off"><p class="dialog-note">WorkLens pulls testers and feedback every 2 minutes and sends approvals, strikes and announcements back. Clear the URL to disconnect.</p>`, 'Save & sync', async f => {
    const result = await request('/api/testloop/connection', { method: 'POST', body: JSON.stringify(f) });
    toast(result.disconnected ? 'Bot disconnected' : `Synced ${result.testers ?? 0} testers, ${result.feedback ?? 0} new feedback`);
  });
}
function rejectTester(id) {
  const t = data.queue.find(x => x.id === id); if (!t) return;
  openDialog('Reject applicant?', `<p class="dialog-note">Remove <strong>${esc(who(t))}</strong> from the queue.${t.remote_id ? ' The bot will tell them why.' : ''}</p><label>Reason</label><input name="reason" maxlength="300" placeholder="Screenshot doesn't show Due soon installed">`, 'Reject', async f => {
    await request(`/api/testloop/testers/${id}/reject`, { method: 'POST', body: JSON.stringify(f) });
    toast('Applicant rejected');
  });
}
function removeTester(id) {
  const t = data.testers.find(x => x.id === id); if (!t) return;
  openDialog('Remove tester?', `<p class="dialog-note">Delete <strong>${esc(who(t))}</strong> and stop tracking them. To keep their history, set their status to Removed instead.</p>`, 'Remove', async () => {
    await request(`/api/testloop/testers/${id}`, { method: 'DELETE' });
    toast('Tester removed');
  });
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!onSubmit) return dialog.close();
  const save = dialog.querySelector('#testloopDialogSave');
  save.disabled = true;
  try { await onSubmit(fields(form)); dialog.close(); await loadTestloop(); }
  catch (error) { toast(error.message); }
  finally { save.disabled = false; }
});
dialog.addEventListener('click', e => { if (e.target.closest('[data-testloop-close]')) dialog.close(); });

async function act(button, work, done) {
  button.disabled = true;
  try { await work(); if (done) toast(done); document.dispatchEvent(new CustomEvent('workstation:changed', { detail: { tool: 'testloop' } })); await loadTestloop(); }
  catch (error) { toast(error.message); button.disabled = false; }
}

root.addEventListener('input', e => { if (e.target.id === 'tlAnnounce') { draft = e.target.value; updatePreview(); } });
root.addEventListener('submit', e => {
  if (e.target.id !== 'tlFeedbackForm') return;
  e.preventDefault();
  const f = fields(e.target);
  act(e.target.querySelector('button'), async () => {
    const r = await request(`/api/testloop/apps/${activeId}/feedback`, { method: 'POST', body: JSON.stringify({ text: f.text, testerId: Number(f.testerId) || null }) });
    toast(r.score ? `Scored ${r.score}/5 · ${r.tag}` : `Saved as ${r.tag} (unscored)`);
  });
});
root.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  const a = t.dataset.tl;
  if (a === 'add-app') return addApp();
  if (a === 'add-tester') return addTester();
  if (a === 'import') return importCsv();
  if (a === 'connect') return connectBot();
  if (a === 'sync') return act(t, () => request('/api/testloop/sync', { method: 'POST', body: '{}' }), 'Synced');
  if (a === 'copy-announce') return navigator.clipboard.writeText(document.querySelector('#tlPreview').textContent).then(() => toast('Copied — paste into WhatsApp'), () => toast("Couldn't copy"));
  if (a === 'send-announce') {
    if (!draft.trim()) return toast('Write the announcement first.');
    return act(t, async () => { await request('/api/testloop/announce', { method: 'POST', body: JSON.stringify({ text: draft, appId: activeId, send: true }) }); draft = ''; }, 'Announcement sent');
  }
  if (t.dataset.tlApp) { activeId = Number(t.dataset.tlApp); remember(activeId); return loadTestloop(); }
  if (t.dataset.tlApprove) return act(t, () => request(`/api/testloop/testers/${t.dataset.tlApprove}/approve`, { method: 'POST', body: '{}' }), 'Approved — now in the active table');
  if (t.dataset.tlReject) return rejectTester(Number(t.dataset.tlReject));
  if (t.dataset.tlRemove) return removeTester(Number(t.dataset.tlRemove));
  if (t.dataset.tlStatus) {
    const tester = data.testers.find(x => x.id === Number(t.dataset.tlStatus));
    const next = CYCLE[(CYCLE.indexOf(tester.status) + 1) % CYCLE.length];
    return act(t, () => request(`/api/testloop/testers/${tester.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) }));
  }
  if (t.dataset.tlDay) {
    const tester = data.testers.find(x => x.id === Number(t.dataset.tlDay));
    return act(t, () => request(`/api/testloop/testers/${tester.id}`, { method: 'PATCH', body: JSON.stringify({ day: tester.day + Number(t.dataset.delta) }) }));
  }
});

// Reload whenever the view opens, so a bot sync that happened meanwhile shows up.
document.addEventListener('click', e => { if (e.target.closest?.('.nav[data-view="testloop"]')) loadTestloop(); });
loadTestloop();
