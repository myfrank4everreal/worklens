// Workstation · Brands screen — the Brand Command Center inside the workstation, backed by
// /api/brands. Self-contained (own dialog, own request helper) so it doesn't depend on app.js
// internals; app.js's show() still owns which view is visible.
import { reportContext } from '/monitor.js';
const root = document.querySelector('#brandsRoot');
const dialog = document.querySelector('#brandDialog');
const form = document.querySelector('#brandForm');
const PALETTE = ['#FF6B35', '#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6'];
const PLATFORM_SHORT = { IG: 'IG', FB: 'FB', Threads: 'TH', TikTok: 'TT', X: 'X', YT: 'YT' };
let data = null, activeId = null, projects = [], onSubmit = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2200); }
async function request(url, options = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}
function remember(id) { try { localStorage.setItem('wl-active-brand', String(id)); } catch {} }
function recall() { try { return Number(localStorage.getItem('wl-active-brand')) || null; } catch { return null; } }

function lastPostedText(account) {
  if (!account.last_posted) return 'Never logged';
  if (account.last_posted === data.today) return 'Today';
  const days = Math.round((Date.parse(`${data.today}T00:00:00Z`) - Date.parse(`${account.last_posted}T00:00:00Z`)) / 86400000);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}
function host(link) { try { return new URL(link).host.replace(/^www\./, ''); } catch { return link; } }

export async function loadBrands() {
  try {
    data = await request('/api/brands');
    if (!data.brands.some(b => b.id === activeId)) activeId = data.brands.some(b => b.id === recall()) ? recall() : data.brands[0]?.id ?? null;
    render();
  } catch (error) { root.innerHTML = `<div class="card empty">Couldn't load brands: ${esc(error.message)}</div>`; }
}

function render() {
  const { stats, brands } = data;
  const brand = brands.find(b => b.id === activeId);
  // Tells WorkLens which brand is open, so time here lands on the brand's linked project.
  if (document.querySelector('#brands')?.classList.contains('active')) reportContext(brand ? { tool: 'brands', label: `Brand: ${brand.name}`, brandId: brand.id } : { tool: 'brands', label: 'Brands' });
  const pct = stats.accounts ? Math.round(stats.postedToday / stats.accounts * 100) : 0;
  root.innerHTML = `
    <div class="section-head"><div><span class="eyebrow">STUDIO TOOL · BRAND COMMAND CENTER</span><h2>Brands</h2></div>
      <div class="brand-actions"><button data-brand-act="new-brand">+ New brand</button><button class="primary" data-brand-act="add-account" ${brands.length ? '' : 'disabled'}>+ Add account</button></div></div>
    <div class="brand-overview">
      <div class="stat"><strong>${stats.brands}</strong><span>Total brands</span></div>
      <div class="stat"><strong>${stats.accounts}</strong><span>Total accounts</span></div>
      <div class="stat ${stats.accounts && stats.postedToday === stats.accounts ? 'stat-success' : ''}"><strong>${stats.postedToday}/${stats.accounts}</strong><span>Posted today · ${pct}%</span></div>
    </div>
    ${brands.length ? `
      <div class="brand-tabs-head"><span class="eyebrow">BRANDS · ${brands.length} WORKSPACES</span><span class="eyebrow">ACTIVE: ${esc(brand?.name || '—')}</span></div>
      <div class="brand-tabs" role="tablist">${brands.map(tab).join('')}</div>
      ${brand ? brandPanel(brand) : ''}` : `<div class="card empty brand-empty"><strong>No brands yet</strong><p>Create your first brand workspace to start tracking its accounts.</p><button class="primary" data-brand-act="new-brand">+ New brand</button></div>`}`;
}

function tab(b) {
  const posted = b.accounts.filter(a => a.status === 'posted').length;
  const all = b.accounts.length && posted === b.accounts.length;
  return `<button class="brand-tab ${b.id === activeId ? 'active' : ''}" role="tab" aria-selected="${b.id === activeId}" data-brand-tab="${b.id}">
    <i style="background:${esc(b.color)}"></i><span>${esc(b.name)}</span><em>${b.accounts.length}</em>${posted ? `<b class="${all ? 'all' : ''}">${posted}✓</b>` : ''}</button>`;
}

function brandPanel(b) {
  const posted = b.accounts.filter(a => a.status === 'posted').length;
  const needs = b.accounts.length - posted;
  const pct = b.accounts.length ? Math.round(posted / b.accounts.length * 100) : 0;
  const platforms = [...new Set(b.accounts.map(a => a.platform))];
  const project = projects.find(p => p.id === b.project_id);
  return `
    <div class="card brand-hero" style="--brand:${esc(b.color)}">
      <div class="brand-id">
        <span class="brand-avatar">${esc(b.name.slice(0, 1).toUpperCase())}</span>
        <div>
          <div class="brand-title"><h3>${esc(b.name)}</h3><span class="brand-hex">${esc(b.color)}</span><button class="icon-btn" title="Edit brand" data-brand-act="edit-brand">✎</button></div>
          <p>${esc(b.description || 'No description yet.')}</p>
          <small>${b.accounts.length} ACCOUNTS · ${platforms.length} PLATFORMS${project ? ` · LINKED TO ${esc(project.name.toUpperCase())}` : ''}</small>
        </div>
      </div>
      <div class="brand-progress">
        <div class="brand-progress-head"><span class="eyebrow">DAILY POSTING PROGRESS</span><span class="mono">${posted}/${b.accounts.length} · ${pct}%</span></div>
        <div class="progress"><i style="width:${pct}%;background:var(--brand)"></i></div>
        <div class="brand-mini"><div><span class="eyebrow">POSTED TODAY</span><strong class="${posted ? 'ok' : ''}">${posted} account${posted === 1 ? '' : 's'}</strong></div><div><span class="eyebrow">NEEDS POST</span><strong class="${needs ? 'warn' : ''}">${needs} pending</strong></div></div>
      </div>
    </div>
    ${b.accounts.length ? platforms.map(p => platformGroup(p, b.accounts.filter(a => a.platform === p))).join('') : `<div class="card empty">No accounts on this brand yet. <button class="link-btn" data-brand-act="add-account">Add one</button></div>`}`;
}

function platformGroup(platform, accounts) {
  return `<div class="platform-group">
    <div class="platform-head"><span class="pf pf-${esc(platform)}">${esc(PLATFORM_SHORT[platform] || platform)}</span><span class="eyebrow">${esc(data.platforms[platform] || platform)}</span><span class="pf-count">${accounts.length} account${accounts.length === 1 ? '' : 's'}</span></div>
    <div class="account-grid">${accounts.map(accountCard).join('')}</div></div>`;
}

function accountCard(a) {
  const posted = a.status === 'posted';
  return `<div class="card account-card status-${a.status}">
    <div class="account-top">
      <span class="pf pf-${esc(a.platform)}">${esc(PLATFORM_SHORT[a.platform] || a.platform)}</span>
      <div class="account-name"><strong title="${esc(a.handle)}">${esc(a.handle)}</strong><a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">${esc(host(a.link))} ↗</a></div>
      <span class="status-chip ${a.status}">${esc(a.status_label)}</span>
    </div>
    <div class="account-meta"><span>Last post: <strong>${esc(lastPostedText(a))}</strong></span><span>${a.posts_7d}/7 days</span>
      <span class="account-tools"><button class="icon-btn" title="Edit account" data-account-edit="${a.id}">✎</button><button class="icon-btn danger" title="Remove account" data-account-remove="${a.id}">🗑</button></span></div>
    ${posted ? `<button class="post-btn done" data-account-undo="${a.id}">✓ Posted today · undo</button>` : `<button class="post-btn" data-account-post="${a.id}">Mark posted today</button>`}
  </div>`;
}

// ---------- Dialog ----------
function openDialog(title, fieldsHtml, submitLabel, handler) {
  dialog.querySelector('#brandDialogTitle').textContent = title;
  dialog.querySelector('#brandDialogFields').innerHTML = fieldsHtml;
  dialog.querySelector('#brandDialogSave').textContent = submitLabel;
  dialog.querySelector('#brandDialogSave').classList.toggle('danger', submitLabel.startsWith('Delete') || submitLabel.startsWith('Remove'));
  onSubmit = handler;
  dialog.showModal();
  dialog.querySelector('input:not([type=hidden]),select')?.focus();
}
const colorPicker = current => `<label>Colour</label><div class="swatches">${PALETTE.map(c => `<label class="swatch"><input type="radio" name="color" value="${c}" ${c.toLowerCase() === String(current).toLowerCase() ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div>`;
const projectPicker = current => `<label>Link to WorkLens project <small>(optional — tags posts in the Timeline)</small></label><select name="projectId"><option value="">Not linked</option>${projects.map(p => `<option value="${p.id}" ${p.id === current ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
const platformPicker = (current = 'IG') => `<label>Platform</label><select name="platform">${Object.entries(data.platforms).map(([k, v]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
const fields = form => Object.fromEntries(new FormData(form));

async function loadProjects() {
  try { projects = (await request('/api/dashboard')).projects?.map(p => ({ id: p.id, name: p.name })) || []; } catch { projects = []; }
}

function newBrand() {
  openDialog('New brand', `<label>Brand name</label><input name="name" maxlength="80" required placeholder="e.g. Tees Inspired">${colorPicker(PALETTE[data.brands.length % PALETTE.length])}<label>Description</label><input name="description" maxlength="300" placeholder="What this brand is about">${projectPicker(null)}`, 'Create brand', async f => {
    const { id } = await request('/api/brands', { method: 'POST', body: JSON.stringify({ name: f.name, color: f.color, description: f.description, projectId: Number(f.projectId) || null }) });
    activeId = id; remember(id); toast(`Brand "${f.name.trim()}" added`);
  });
}
function editBrand() {
  const b = data.brands.find(x => x.id === activeId); if (!b) return;
  openDialog('Edit brand', `<label>Brand name</label><input name="name" maxlength="80" required value="${esc(b.name)}">${colorPicker(b.color)}<label>Description</label><input name="description" maxlength="300" value="${esc(b.description)}">${projectPicker(b.project_id)}<button type="button" class="link-btn danger" data-brand-act="delete-brand">Delete this brand…</button>`, 'Save changes', async f => {
    await request(`/api/brands/${b.id}`, { method: 'PATCH', body: JSON.stringify({ name: f.name, color: f.color, description: f.description, projectId: Number(f.projectId) || null }) });
    toast('Brand updated');
  });
}
function deleteBrand() {
  const b = data.brands.find(x => x.id === activeId); if (!b) return;
  openDialog('Delete brand?', `<p class="dialog-note">This removes <strong>${esc(b.name)}</strong>, its ${b.accounts.length} account(s) and their posting history. Entries already in the WorkLens timeline stay.</p>`, 'Delete brand', async () => {
    await request(`/api/brands/${b.id}`, { method: 'DELETE' });
    activeId = null; toast(`Brand "${b.name}" deleted`);
  });
}
function addAccount() {
  if (!data.brands.length) return;
  openDialog('Add account', `<label>Brand</label><select name="brandId">${data.brands.map(b => `<option value="${b.id}" ${b.id === activeId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>${platformPicker()}<label>Handle</label><input name="handle" maxlength="80" required placeholder="@handle"><label>Profile link <small>(optional — filled in from the handle)</small></label><input name="link" type="url" placeholder="https://">`, 'Add account', async f => {
    await request(`/api/brands/${f.brandId}/accounts`, { method: 'POST', body: JSON.stringify({ platform: f.platform, handle: f.handle, link: f.link }) });
    activeId = Number(f.brandId); remember(activeId); toast(`Account ${f.handle.trim().replace(/^@*/, '@')} added`);
  });
}
function findAccount(id) { for (const b of data.brands) { const a = b.accounts.find(x => x.id === id); if (a) return a; } return null; }
function editAccount(id) {
  const a = findAccount(id); if (!a) return;
  openDialog('Edit account', `${platformPicker(a.platform)}<label>Handle</label><input name="handle" maxlength="80" required value="${esc(a.handle)}"><label>Profile link</label><input name="link" type="url" value="${esc(a.link)}">`, 'Save changes', async f => {
    await request(`/api/brand-accounts/${id}`, { method: 'PATCH', body: JSON.stringify(f) });
    toast('Account updated');
  });
}
function removeAccount(id) {
  const a = findAccount(id); if (!a) return;
  openDialog('Remove account?', `<p class="dialog-note">Remove <strong>${esc(a.handle)}</strong> (${esc(a.platform_label)}) and its posting history from this brand?</p>`, 'Remove account', async () => {
    await request(`/api/brand-accounts/${id}`, { method: 'DELETE' });
    toast('Account removed');
  });
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!onSubmit) return dialog.close();
  const save = dialog.querySelector('#brandDialogSave');
  save.disabled = true;
  try { await onSubmit(fields(form)); dialog.close(); await loadBrands(); }
  catch (error) { toast(error.message); }
  finally { save.disabled = false; }
});
dialog.addEventListener('click', e => {
  if (e.target.closest('[data-brand-close]')) dialog.close();
  if (e.target.closest('[data-brand-act="delete-brand"]')) deleteBrand();
});

root.addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return;
  const act = t.dataset.brandAct;
  if (act === 'new-brand') { await loadProjects(); return newBrand(); }
  if (act === 'add-account') return addAccount();
  if (act === 'edit-brand') { await loadProjects(); return editBrand(); }
  if (t.dataset.brandTab) { activeId = Number(t.dataset.brandTab); remember(activeId); return render(); }
  if (t.dataset.accountEdit) return editAccount(Number(t.dataset.accountEdit));
  if (t.dataset.accountRemove) return removeAccount(Number(t.dataset.accountRemove));
  const postId = t.dataset.accountPost || t.dataset.accountUndo;
  if (postId) {
    t.disabled = true;
    try {
      if (t.dataset.accountPost) { await request(`/api/brand-accounts/${postId}/posts`, { method: 'POST', body: '{}' }); toast('Marked as posted today'); }
      else { await request(`/api/brand-accounts/${postId}/posts/today`, { method: 'DELETE' }); toast("Today's post undone"); }
      document.dispatchEvent(new CustomEvent('workstation:changed', { detail: { tool: 'brands' } }));
      await loadBrands();
    } catch (error) { toast(error.message); t.disabled = false; }
  }
});

// Load whenever the Brands view is opened, so a day rollover or a change made elsewhere shows.
document.addEventListener('click', e => { if (e.target.closest?.('.nav[data-view="brands"]')) { loadProjects().then(loadBrands); } });
loadProjects().then(loadBrands);
