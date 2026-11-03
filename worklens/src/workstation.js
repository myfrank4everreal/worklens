// Workstation monitoring: what WorkLens records while you work inside the workstation window
// itself. The page reports which tool is open and what's being worked on (a Studio project, a
// brand) to /api/workstation/context, and the window title carries the same label. When the 15s
// capture finds that window in front, server.js asks workstationCapture() to turn the generic
// "WorkLens" window into a tool-level activity, attributed to the brand's linked project.
import { db } from './db.js';

const TOOLS = { brands: 'Brands', testloop: 'TestLoop', studio: 'Studio', voice: 'Voice', engines: 'Engines' };
// How long a reported context stays trusted. The page re-reports on every view change and every
// few minutes while open, so an old context means the page has gone.
const CONTEXT_TTL = 30 * 60 * 1000;
let context = null;

// The page sets document.title to "<label> · Workstation"; the installed app and the dev build
// run as WorkLens / electron, and a browser tab on localhost shows the same title.
const isWorkstationWindow = (app, title) => /· Workstation$/.test(title) || (/^(worklens|electron)$/i.test(app) && /workstation/i.test(title));

function projectForBrand(brandId) {
  if (!brandId) return null;
  return db.prepare('SELECT project_id FROM brands WHERE id=?').get(Number(brandId))?.project_id || null;
}

// Studio project → its brand → that brand's WorkLens project, so exports and editing time land on
// the same project as the brand's posts.
export function projectForStudioProject(studioProjectId) {
  if (!studioProjectId) return null;
  const row = db.prepare('SELECT brand_id FROM studio_projects WHERE id=?').get(Number(studioProjectId));
  return projectForBrand(row?.brand_id);
}

export function workstationCapture(app, title) {
  if (!isWorkstationWindow(app, title)) return null;
  const fresh = context && Date.now() - context.at < CONTEXT_TTL ? context : null;
  const tool = TOOLS[fresh?.tool];
  if (!tool) {
    // A WorkLens screen (Today, Timeline…): reviewing your work, not doing a tool's work.
    return { app: 'Workstation · WorkLens', title: fresh?.label || title.replace(/\s*· Workstation$/, '') || 'WorkLens', projectId: null, confidence: 0, source: 'workstation' };
  }
  return { app: `Workstation · ${tool}`, title: fresh.label, projectId: fresh.projectId, confidence: fresh.projectId ? 1 : 0, source: 'workstation' };
}

export function workstationSummary(date) {
  const tools = db.prepare(`SELECT app_name, SUM(duration_seconds) AS seconds FROM activities
    WHERE source='workstation' AND duration_seconds > 0 AND substr(captured_at,1,10)=? GROUP BY app_name ORDER BY seconds DESC`).all(date)
    .map(r => ({ tool: r.app_name.replace(/^Workstation · /, ''), seconds: r.seconds }));
  const count = (sql) => db.prepare(sql).get(date).n;
  return {
    tools,
    seconds: tools.reduce((s, t) => s + t.seconds, 0),
    exports: count("SELECT COUNT(*) AS n FROM media_renders WHERE status='done' AND substr(finished_at,1,10)=?"),
    voiceLines: count('SELECT COUNT(*) AS n FROM voice_clips WHERE substr(created_at,1,10)=?'),
    posts: count('SELECT COUNT(*) AS n FROM brand_posts WHERE posted_on=?'),
    current: context && Date.now() - context.at < CONTEXT_TTL && TOOLS[context.tool] ? { tool: TOOLS[context.tool], label: context.label } : null
  };
}

export async function workstationApi(req, res, url, { json, body }) {
  if (!url.pathname.startsWith('/api/workstation')) return false;
  if (req.method === 'POST' && url.pathname === '/api/workstation/context') {
    const data = await body(req);
    const tool = String(data.tool || '').slice(0, 40);
    const label = String(data.label || '').trim().slice(0, 300) || TOOLS[tool] || 'WorkLens';
    const projectId = data.studioProjectId ? projectForStudioProject(data.studioProjectId) : projectForBrand(data.brandId);
    context = { tool, label, projectId, at: Date.now() };
    return json(res, 200, { ok: true, projectId });
  }
  if (req.method === 'GET' && url.pathname === '/api/workstation/summary') {
    return json(res, 200, workstationSummary(url.searchParams.get('date') || new Date().toISOString().slice(0, 10)));
  }
  return json(res, 404, { error: 'Unknown workstation request.' });
}
