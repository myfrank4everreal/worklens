// Workstation · monitoring. Tells WorkLens which tool is open and what it's working on, so the 15s
// capture can record "Studio: Editing "Drop reel"" against the right project instead of one
// generic WorkLens window. The window title carries the same label, which is how the capture
// recognises the workstation window in the first place (see src/workstation.js).
let last = null, timer = null;

function send() {
  if (!last) return;
  fetch('/api/workstation/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(last) }).catch(() => {});
}

// ctx: { tool, label, brandId?, studioProjectId? }. Calls in quick succession (a view change,
// then the tool's own richer label once it has loaded) collapse into one report.
export function reportContext(ctx) {
  last = ctx;
  document.title = `${ctx.label} · Workstation`;
  clearTimeout(timer);
  timer = setTimeout(send, 300);
}

// The server forgets a context after 30 minutes, so a page left open keeps it current.
setInterval(() => { if (document.visibilityState === 'visible') send(); }, 5 * 60 * 1000);
