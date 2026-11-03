import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';
import { aiConfigured, reviewDay, analyzeUrlOnly, answerFromEvidence, reviewWeek, extractPlanFromText } from './openrouter.js';
import { inspectProject, collectProject } from './project-analyzer.js';
import { rollupEpisodes, embedPendingEpisodes, searchEpisodes } from './episodes.js';
import { renderTextPdf } from './pdf.js';
import { parsePlainTextPlan } from './plan-parser.js';
import { brandsApi, seedBrandAccounts, seedBrands } from './brands.js';
import { hubApi, seedHub } from './hub.js';
import { socialApi, startSocialSync } from './social.js';
import { testloopApi, seedTestloop, startTestloopSync } from './testloop.js';
import { mediaApi, seedVoiceProfiles, startMediaJobs } from './media/api.js';
import { enginesApi, stopEngines } from './engines.js';
import { workstationApi, workstationCapture, workstationSummary } from './workstation.js';

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, 'public');
// powershell.exe is a real OS process, not Electron — it can't read into an app.asar archive,
// so a packaged run points this at the unpacked copy (see electron/main.js).
const scriptDir = process.env.WORKLENS_SCRIPT_DIR || path.join(root, 'src');
const port = Number(process.env.WORKLENS_PORT || 4317);
const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUILD = { version: JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version, root: appRoot, startedAt: new Date().toISOString(), features: ['engines', 'hub', 'content', 'social'] };
const DEFAULT_SENSITIVE_TERMS = ['password','passcode','secret','token','credential','bank','wallet','checkout','payment','private browsing','incognito'];
let timer = null;
let lastActivityId = null;
const analyzingProjects = new Set();
if (!getSetting('extension_key')) setSetting('extension_key', crypto.randomBytes(12).toString('hex'));

function sensitiveTerms() {
  const custom = getSetting('sensitive_terms', '');
  const extra = custom ? custom.split(',').map(t => t.trim()).filter(Boolean) : [];
  return [...new Set([...DEFAULT_SENSITIVE_TERMS, ...extra])];
}
function isSensitive(text) {
  const terms = sensitiveTerms();
  if (!terms.length) return false;
  const pattern = new RegExp(terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  return pattern.test(text);
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function classify(app, title) {
  const haystack = `${app} ${title}`.toLowerCase();
  const projects = db.prepare("SELECT * FROM projects WHERE status='active'").all();
  let best = null;
  let score = 0;
  for (const project of projects) {
    const terms = project.keywords.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
    const hits = terms.filter(term => haystack.includes(term)).length;
    if (hits > score) { best = project; score = hits; }
  }
  return { projectId: best?.id ?? null, confidence: score ? Math.min(0.55 + score * 0.15, 0.95) : 0 };
}

const IDLE_THRESHOLD_SECONDS = 120;

function extendOrInsert(appName, title, projectId, confidence, source) {
  const current = lastActivityId ? db.prepare('SELECT * FROM activities WHERE id=?').get(lastActivityId) : null;
  if (current && current.app_name === appName && current.window_title === title) {
    db.prepare('UPDATE activities SET duration_seconds=duration_seconds+15 WHERE id=?').run(lastActivityId);
    return;
  }
  const result = db.prepare('INSERT INTO activities(captured_at,app_name,window_title,project_id,duration_seconds,confidence,source) VALUES(?,?,?,?,?,?,?)')
    .run(new Date().toISOString(), appName, title, projectId, 15, confidence, source);
  lastActivityId = Number(result.lastInsertRowid);
}

async function capture() {
  if (getSetting('recording', 'false') !== 'true') return;
  try {
    // powershell.exe startup plus compiling collector.ps1's inline Add-Type on every launch
    // (no cross-process cache) can take 5-6s+ on a loaded machine — comfortably under the
    // 15s capture interval below, but well past a tight timeout, which made every capture
    // fail with ETIMEDOUT.
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptDir, 'collector.ps1')], { timeout: 12000 });
    const event = JSON.parse(stdout.trim());
    // A window can stay foregrounded while you're away from the keyboard; without this, that
    // whole stretch would silently count as focused time on whatever was last open.
    if (Number(event.idleSeconds) >= IDLE_THRESHOLD_SECONDS) {
      extendOrInsert('Idle', 'Away from keyboard', null, 0, 'idle');
      return;
    }
    if (!event.title || event.app === 'powershell') return;
    const title = isSensitive(event.title) ? '[Sensitive window redacted]' : event.title.slice(0, 500);
    // Time inside the workstation window is recorded per tool, not as one generic WorkLens window.
    const tool = workstationCapture(event.app, title);
    if (tool) return extendOrInsert(tool.app, tool.title, tool.projectId, tool.confidence, tool.source);
    const match = classify(event.app, title);
    extendOrInsert(event.app, title, match.projectId, match.confidence, 'windows');
  } catch (error) {
    console.error('Capture failed:', error.message);
  }
}

function setRecording(enabled) {
  setSetting('recording', enabled ? 'true' : 'false');
  if (timer) clearInterval(timer);
  timer = enabled ? setInterval(capture, 15000) : null;
  if (enabled) capture();
}

function normalizeKey(value) { return String(value ?? '').trim().toLowerCase().slice(0, 100); }

// Shared by the AI repository analyzer (source='ai') and the pasted-plan importer
// (source='import') — both turn a {summary, milestones, tasks} plan into real milestone/task
// rows, upserted so a re-run updates existing rows (matched by external_key) instead of
// duplicating them. Caps differ by caller: AI repo analysis is deliberately bounded (see its
// own prompt) since it's inferring structure from code, while a plan the user pasted themselves
// shouldn't be truncated down to the same small size.
function upsertPlanItems(projectId, plan, { source, milestoneCap, taskCap }) {
  if (!plan || !Array.isArray(plan.milestones) || !Array.isArray(plan.tasks)) throw new Error('That did not produce a usable plan.');
  const milestoneUpsert = db.prepare(`INSERT INTO milestones(project_id,title,weight,status,evidence,source,external_key,completed_at)
    VALUES(?,?,?,?,?,?,?,CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END)
    ON CONFLICT(project_id,external_key) WHERE external_key IS NOT NULL DO UPDATE SET title=excluded.title,weight=excluded.weight,status=excluded.status,evidence=excluded.evidence,completed_at=excluded.completed_at`);
  // Case/whitespace-insensitive on purpose: an LLM asked to reuse "the same stable key" across a
  // task and its milestone doesn't always reproduce it byte-for-byte, and a mismatch here is
  // exactly what silently dropped a task into the backlog instead of its intended milestone.
  const milestoneByKey = db.prepare("SELECT id,title FROM milestones WHERE project_id=? AND external_key IS NOT NULL AND trim(external_key)=trim(?) COLLATE NOCASE");
  // milestone_id (a real foreign key, resolved below) is now the source of truth for grouping —
  // milestone_key/external_key stay only so a later sync can still find the same milestone
  // and task rows to update rather than duplicating them.
  const taskUpsert = db.prepare(`INSERT INTO tasks(project_id,title,status,manual_intervention,source,evidence,external_key,milestone_key,milestone_id,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END)
    ON CONFLICT(project_id,external_key) WHERE external_key IS NOT NULL DO UPDATE SET title=excluded.title,status=excluded.status,manual_intervention=excluded.manual_intervention,evidence=excluded.evidence,milestone_key=excluded.milestone_key,milestone_id=excluded.milestone_id,completed_at=excluded.completed_at`);
  let unmatched = 0;
  db.exec('BEGIN');
  try {
    const idByNormalizedKey = new Map();   // this batch's milestones, keyed by normalized external_key
    const idByNormalizedTitle = new Map(); // ...and by normalized title, for the "put the title where the key belongs" slip
    for (const item of plan.milestones.slice(0, milestoneCap)) {
      const status = item.status === 'done' ? 'done' : 'todo';
      const key = String(item.key ?? '').slice(0,100);
      const title = String(item.title).slice(0,300);
      milestoneUpsert.run(projectId, title, Math.max(1,Math.min(20,Number(item.weight)||1)), status, String(item.evidence||'').slice(0,1000), source, key, status);
      const row = milestoneByKey.get(projectId, key);
      if (row) { idByNormalizedKey.set(normalizeKey(key), row.id); idByNormalizedTitle.set(normalizeKey(title), row.id); }
    }
    for (const item of plan.tasks.slice(0, taskCap)) {
      const status = item.status === 'done' ? 'done' : 'todo';
      const rawMilestoneKey = String(item.milestoneKey||'').slice(0,100);
      const normalizedMilestoneKey = normalizeKey(rawMilestoneKey);
      let milestoneId = null;
      if (normalizedMilestoneKey) {
        milestoneId = idByNormalizedKey.get(normalizedMilestoneKey)
          ?? milestoneByKey.get(projectId, rawMilestoneKey)?.id // a milestone from an earlier sync, not renamed this time
          ?? idByNormalizedTitle.get(normalizedMilestoneKey)    // model wrote the milestone's title instead of its key
          ?? null;
        if (milestoneId === null) { unmatched += 1; console.warn(`Plan sync for project ${projectId}: task "${item.title}" named milestoneKey "${rawMilestoneKey}" which matched no milestone in this plan — left in the backlog.`); }
      }
      taskUpsert.run(projectId, String(item.title).slice(0,300), status, item.manualIntervention ? 1 : 0, source, String(item.evidence||'').slice(0,1000), String(item.key).slice(0,100), rawMilestoneKey, milestoneId, status);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { milestones: Math.min(plan.milestones.length, milestoneCap), tasks: Math.min(plan.tasks.length, taskCap), unmatched };
}

function syncProjectPlan(projectId, fingerprint, plan) {
  const result = upsertPlanItems(projectId, plan, { source: 'ai', milestoneCap: 8, taskCap: 30 });
  db.prepare('UPDATE projects SET progress_note=?,repo_fingerprint=?,last_analysis_at=CURRENT_TIMESTAMP WHERE id=?').run(String(plan.summary||'').slice(0,2000), fingerprint, projectId);
  return result;
}

// A user-pasted plan (an operational runbook, a deployment guide) isn't repository evidence, so
// it doesn't touch repo_fingerprint/last_analysis_at — those belong to the independent
// AI-repository-analysis flow above, and an import shouldn't make that flow think a repo
// analysis just ran, or get silently overwritten by the next one.
function importPlan(projectId, plan) {
  return upsertPlanItems(projectId, plan, { source: 'import', milestoneCap: 60, taskCap: 400 });
}

async function analyzeAndSync(project) {
  if (analyzingProjects.has(project.id)) throw new Error('This project is already being analyzed.');
  analyzingProjects.add(project.id);
  try { const { context, plan } = await inspectProject(project); syncProjectPlan(project.id, context.fingerprint, plan); return plan; }
  finally { analyzingProjects.delete(project.id); }
}

// Auto re-analysis is debounced (a fingerprint must hold steady for a while — active editing
// changes files constantly) and rate-limited (even a genuinely stable change won't re-trigger
// more than once per interval), so a coding session doesn't turn into a paid AI call every minute.
const FINGERPRINT_STABLE_MS = 5 * 60 * 1000;
const MIN_REANALYSIS_INTERVAL_MS = 15 * 60 * 1000;
const pendingFingerprints = new Map();

async function checkProjectChanges() {
  const projects = db.prepare("SELECT * FROM projects WHERE auto_analyze=1 AND last_analysis_at IS NOT NULL AND root_path!=''").all();
  const now = Date.now();
  for (const project of projects) {
    if (analyzingProjects.has(project.id)) continue;
    try {
      const context = await collectProject(project.root_path);
      if (context.fingerprint === project.repo_fingerprint) { pendingFingerprints.delete(project.id); continue; }
      const pending = pendingFingerprints.get(project.id);
      if (!pending || pending.fingerprint !== context.fingerprint) {
        pendingFingerprints.set(project.id, { fingerprint: context.fingerprint, since: now });
        continue;
      }
      if (now - pending.since < FINGERPRINT_STABLE_MS) continue;
      const lastAnalysisMs = project.last_analysis_at ? new Date(`${project.last_analysis_at}Z`).getTime() : 0;
      if (now - lastAnalysisMs < MIN_REANALYSIS_INTERVAL_MS) continue;
      await analyzeAndSync(project);
      pendingFingerprints.delete(project.id);
    }
    catch (error) { console.error(`Auto-analysis failed for ${project.name}:`, error.message); }
  }
}

// The other half of the WORKLENS-BRIEF.md convention: ticking/unticking a checkbox in the
// exported brief (by hand, or by a coding agent following WORKLENS.md) is read back here and
// applied to the real task row, matched by the hidden <!--wl:ID--> marker briefToMarkdown wrote.
// Runs for any project with a root_path regardless of auto_analyze — checklist sync doesn't cost
// an AI call, so there's no reason to gate it the way repository re-analysis is gated.
const CHECKLIST_LINE_RE = /^-\s\[( |x|X)\]\s.*<!--wl:(\d+)-->\s*$/;
function syncBriefCheckboxes(project) {
  if (!project.root_path || !path.isAbsolute(project.root_path)) return;
  const filePath = path.join(project.root_path, 'WORKLENS-BRIEF.md');
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }
  const current = new Map(db.prepare('SELECT id,status FROM tasks WHERE project_id=?').all(project.id).map(t => [t.id, t.status]));
  const update = db.prepare("UPDATE tasks SET status=?,completed_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?");
  let changed = 0;
  for (const line of content.split('\n')) {
    const match = line.match(CHECKLIST_LINE_RE);
    if (!match) continue;
    const id = Number(match[2]);
    if (!current.has(id)) continue;
    const desired = match[1].toLowerCase() === 'x' ? 'done' : 'todo';
    if (current.get(id) !== desired) { update.run(desired, desired, id); changed += 1; }
  }
  if (changed) console.log(`WorkLens: ${changed} task(s) for "${project.name}" updated from a checked box in WORKLENS-BRIEF.md.`);
}

function syncAllChecklists() {
  const projects = db.prepare("SELECT * FROM projects WHERE root_path!=''").all();
  for (const project of projects) {
    try { syncBriefCheckboxes(project); } catch (error) { console.error(`Checklist sync failed for ${project.name}:`, error.message); }
  }
}

// Focus-drift: if the user has pinned a project they're supposed to be working on, and every
// non-idle activity for a while has classified to something else, surface a gentle nudge rather
// than interrupting on every momentary switch (checking a doc, replying to a message).
function computeDrift() {
  const mode = getSetting('drift_mode', 'gentle');
  const focusProjectId = Number(getSetting('focus_project_id', '')) || null;
  if (!focusProjectId || mode === 'silent') return null;
  const thresholdMinutes = mode === 'strict' ? 8 : 20;
  const since = new Date(Date.now() - thresholdMinutes * 60000).toISOString();
  const recent = db.prepare("SELECT * FROM activities WHERE captured_at>=? AND source!='idle' ORDER BY captured_at DESC").all(since);
  if (recent.length < 3 || !recent.every(a => a.project_id !== focusProjectId)) return null;
  const current = db.prepare('SELECT p.name FROM activities a LEFT JOIN projects p ON p.id=a.project_id WHERE a.id=?').get(recent[0].id);
  const focusProject = db.prepare('SELECT name FROM projects WHERE id=?').get(focusProjectId);
  return { minutes: thresholdMinutes, currentProjectName: current?.name || 'something unassigned', focusProjectName: focusProject?.name || 'your focus project' };
}

function dashboard(date = new Date().toISOString().slice(0, 10)) {
  const activities = db.prepare(`SELECT a.*,p.name project_name,p.color project_color FROM activities a LEFT JOIN projects p ON p.id=a.project_id WHERE substr(a.captured_at,1,10)=? ORDER BY a.captured_at DESC LIMIT 100`).all(date);
  const totals = db.prepare(`SELECT COALESCE(p.name,'Unassigned') name,COALESCE(p.color,'#667085') color,SUM(a.duration_seconds) seconds FROM activities a LEFT JOIN projects p ON p.id=a.project_id WHERE substr(a.captured_at,1,10)=? AND a.source!='idle' GROUP BY p.id ORDER BY seconds DESC`).all(date);
  const idleSeconds = db.prepare(`SELECT COALESCE(SUM(duration_seconds),0) seconds FROM activities WHERE substr(captured_at,1,10)=? AND source='idle'`).get(date).seconds;
  return {
    date,
    recording: getSetting('recording', 'false') === 'true',
    aiConfigured: aiConfigured(),
    extension: {
      key: getSetting('extension_key'),
      lastSyncAt: getSetting('extension_last_sync'),
      lastSyncCount: Number(getSetting('extension_last_count', '0'))
    },
    projects: db.prepare(`SELECT projects.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=projects.id AND t.status!='done') open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=projects.id) total_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=projects.id AND t.status='done') done_tasks,
      (SELECT COUNT(*) FROM milestones m WHERE m.project_id=projects.id) milestone_count,
      (SELECT COALESCE(SUM(weight),0) FROM milestones m WHERE m.project_id=projects.id) milestone_weight,
      (SELECT COALESCE(SUM(weight),0) FROM milestones m WHERE m.project_id=projects.id AND m.status='done') done_milestone_weight,
      (SELECT a.window_title FROM activities a WHERE a.project_id=projects.id AND a.source!='idle' ORDER BY a.captured_at DESC LIMIT 1) last_activity_title,
      (SELECT a.captured_at FROM activities a WHERE a.project_id=projects.id AND a.source!='idle' ORDER BY a.captured_at DESC LIMIT 1) last_activity_at,
      (SELECT t.title FROM tasks t WHERE t.project_id=projects.id AND t.status!='done' ORDER BY t.created_at ASC LIMIT 1) next_task_title
      FROM projects ORDER BY status,name`).all().map(project => {
        const milestoneScore = project.milestone_weight ? project.done_milestone_weight / project.milestone_weight : null;
        const taskScore = project.total_tasks ? project.done_tasks / project.total_tasks : null;
        const inputs = [milestoneScore, taskScore].filter(value => value !== null);
        return { ...project, progress: inputs.length ? Math.round(inputs.reduce((a,b) => a+b, 0) / inputs.length * 100) : 0 };
      }),
    tasks: db.prepare("SELECT t.*,p.name project_name FROM tasks t LEFT JOIN projects p ON p.id=t.project_id ORDER BY t.status='done',t.created_at DESC").all(),
    reminders: db.prepare("SELECT r.*,p.name project_name FROM reminders r LEFT JOIN projects p ON p.id=r.project_id WHERE dismissed=0 ORDER BY remind_at").all(),
    milestones: db.prepare("SELECT m.*,p.name project_name FROM milestones m JOIN projects p ON p.id=m.project_id ORDER BY m.status='done',m.created_at").all(),
    aiUsage: db.prepare('SELECT * FROM ai_usage ORDER BY created_at DESC LIMIT 100').all(),
    aiTotals: db.prepare('SELECT COUNT(*) requests,COALESCE(SUM(prompt_tokens+completion_tokens),0) tokens,COALESCE(SUM(cost),0) cost,COALESCE(SUM(CASE WHEN secure=1 THEN 1 ELSE 0 END),0) secure_requests FROM ai_usage').get(),
    activities,
    totals,
    idleSeconds,
    focusProjectId: Number(getSetting('focus_project_id', '')) || null,
    driftMode: getSetting('drift_mode', 'gentle'),
    sensitiveTerms: getSetting('sensitive_terms', ''),
    drift: computeDrift(),
    workstation: workstationSummary(date)
  };
}

// Shared by the PDF download and the "save into the repository" Markdown export — both are the
// same underlying brief (milestones, their tasks, the backlog, and what needs a human), just
// rendered to a different format.
function buildProjectBrief(id) {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  if (!project) return null;
  const milestones = db.prepare("SELECT * FROM milestones WHERE project_id=? ORDER BY status='done',created_at").all(id);
  const tasks = db.prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY status='done',created_at").all(id);
  const totalTasks = tasks.length, doneTasks = tasks.filter(t => t.status === 'done').length;
  const milestoneWeight = milestones.reduce((sum, m) => sum + m.weight, 0);
  const doneMilestoneWeight = milestones.filter(m => m.status === 'done').reduce((sum, m) => sum + m.weight, 0);
  const scores = [milestoneWeight ? doneMilestoneWeight / milestoneWeight : null, totalTasks ? doneTasks / totalTasks : null].filter(v => v !== null);
  const progress = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 100) : 0;
  const tasksByMilestone = new Map(milestones.map(m => [m.id, []]));
  const backlog = [];
  for (const task of tasks) { if (task.milestone_id && tasksByMilestone.has(task.milestone_id)) tasksByMilestone.get(task.milestone_id).push(task); else backlog.push(task); }
  const manual = tasks.filter(t => t.manual_intervention && t.status !== 'done');
  return { project, milestones, tasksByMilestone, backlog, manual, totalTasks, doneTasks, milestoneWeight, doneMilestoneWeight, progress };
}

const AGENT_INSTRUCTIONS = 'Work through the milestones below in order. Each task lists the evidence WorkLens expects for completion — treat that as the acceptance criterion. Tasks marked MANUAL INTERVENTION REQUIRED need a credential, approval, purchase, or a human decision: do not attempt them, flag them back to the project owner instead. This brief is a snapshot; verify current state against the live repository before implementing anything.';

// Written alongside WORKLENS-BRIEF.md every time a brief is saved into a repository — static
// content (not per-project), so it's safe to always overwrite. Explains, to whichever coding
// agent is working in that repo, how to read the current plan and report progress on it.
const WORKLENS_MD = `# WorkLens integration for this repository

This project's plan (milestones and tasks) is tracked in WorkLens, a local work-tracking app
running on this machine at http://localhost:${port}. This file explains how any coding agent working
in this repository — Claude Code, Codex, Cline, or a person editing by hand — can read the current
plan and report progress back, so WorkLens's checkmarks stay accurate without anyone re-typing them.

## The current plan: WORKLENS-BRIEF.md

\`WORKLENS-BRIEF.md\`, next to this file, is the live plan: milestones as headings, tasks as a
Markdown checklist (\`- [ ]\` / \`- [x]\`). It is regenerated by WorkLens (Project page → "Save brief
to repository") and re-read by WorkLens roughly once a minute.

**To mark a task done: tick its checkbox** — change \`- [ ]\` to \`- [x]\` — and leave the rest of the
line, including the \`<!--wl:123-->\` comment at the end, exactly as it is; that hidden number is how
WorkLens matches the line back to the right task. WorkLens picks up the change within about a
minute, no restart needed. Unticking a box marks the task open again the same way.

Do not add or remove lines in WORKLENS-BRIEF.md, and do not renumber or reword tasks there — it is
regenerated from WorkLens's own database, so hand-edited structure will be overwritten on the next
"Save brief to repository." Ticking/unticking boxes is the one edit that's meant to stick, and it
does, because it's read back before the file is next regenerated.

## A faster path: WorkLens's MCP server

If your agent supports MCP (Claude Code, Codex CLI, and Cline all do), point it at WorkLens's MCP
server for direct, immediate updates instead of editing a file:

- \`list_tasks\` — the current milestones, tasks, and backlog for a project
- \`complete_task\` — mark a specific task done, with an evidence note describing what proved it
- \`add_task\` — record a new task WorkLens didn't already know about
- \`get_focused_project\` / \`list_projects\` — see what the person is currently focused on

See the "WorkLens MCP server" section of this project's README for the exact config for your agent.

## Judgment calls

- Only mark a task done when you actually completed the work it describes — not when you merely
  started it.
- If a task needs a human decision, credential, purchase, or external approval, leave it open and
  say so — do not mark it done on the assumption someone else will handle it.
- This file and WORKLENS-BRIEF.md reflect a snapshot; if the live repository disagrees with what
  they say, trust the repository and update the task status to match.
`;

function briefToPdfBlocks({ project, milestones, tasksByMilestone, backlog, manual, doneTasks, totalTasks, doneMilestoneWeight, milestoneWeight, progress }) {
  const taskBullet = task => ({ style: 'bullet', marker: task.status === 'done' ? '[x] ' : '[ ] ', text: `${task.title}${task.manual_intervention ? ' (MANUAL INTERVENTION REQUIRED)' : ''}${task.evidence ? ` — ${task.evidence}` : ''}` });
  const blocks = [];
  blocks.push({ style: 'title', text: `${project.name} — Implementation Brief` });
  blocks.push({ style: 'meta', text: `Generated ${new Date().toISOString()} by WorkLens` });
  if (project.root_path) blocks.push({ style: 'meta', text: `Repository: ${project.root_path}` });
  blocks.push({ style: 'meta', text: `Overall progress: ${progress}% (${doneTasks}/${totalTasks} tasks, ${doneMilestoneWeight}/${milestoneWeight} milestone weight)` });
  blocks.push({ style: 'divider' });
  blocks.push({ style: 'h2', text: 'Project summary' });
  blocks.push({ style: 'body', text: project.description || project.progress_note || 'No description recorded.' });
  blocks.push({ style: 'h2', text: 'Instructions for the implementing agent' });
  blocks.push({ style: 'body', text: AGENT_INSTRUCTIONS });
  if (!milestones.length) blocks.push({ style: 'body', text: 'No milestones have been recorded yet for this project.' });
  milestones.forEach((m, i) => {
    blocks.push({ style: 'h2', text: `Milestone ${i + 1}: ${m.title} [${m.status === 'done' ? 'DONE' : 'OPEN'}] (weight ${m.weight})` });
    if (m.evidence) blocks.push({ style: 'body', text: `Completion evidence: ${m.evidence}` });
    const children = tasksByMilestone.get(m.id) || [];
    if (!children.length) blocks.push({ style: 'note', text: 'No tasks assigned to this milestone yet.' });
    for (const task of children) blocks.push(taskBullet(task));
  });
  blocks.push({ style: 'h2', text: 'Backlog (not yet assigned to a milestone)' });
  blocks.push(backlog.length ? null : { style: 'body', text: 'Nothing in the backlog.' });
  for (const task of backlog) blocks.push(taskBullet(task));
  blocks.push({ style: 'h2', text: 'Manual intervention required' });
  blocks.push(manual.length ? null : { style: 'body', text: 'Nothing currently requires manual intervention.' });
  for (const task of manual) blocks.push({ style: 'bullet', marker: '! ', text: `${task.title}${task.evidence ? ` — ${task.evidence}` : ''}` });
  blocks.push({ style: 'divider' });
  blocks.push({ style: 'meta', text: 'This brief reflects locally tracked evidence and may be incomplete or stale.' });
  return blocks.filter(Boolean);
}

function briefToMarkdown({ project, milestones, tasksByMilestone, backlog, manual, doneTasks, totalTasks, doneMilestoneWeight, milestoneWeight, progress }) {
  // The trailing HTML comment is invisible when rendered but lets syncBriefCheckboxes() map a
  // ticked/unticked line back to the exact task row — a title match alone would break the
  // moment two tasks share wording, or the title gets edited.
  const taskLine = task => `- [${task.status === 'done' ? 'x' : ' '}] ${task.title}${task.manual_intervention ? ' **(MANUAL INTERVENTION REQUIRED)**' : ''}${task.evidence ? ` — ${task.evidence}` : ''} <!--wl:${task.id}-->`;
  const lines = [];
  lines.push(`# ${project.name} — Implementation Brief`, '');
  lines.push(`_Generated ${new Date().toISOString()} by WorkLens._`, '');
  if (project.root_path) lines.push(`Repository: \`${project.root_path}\``, '');
  lines.push(`Overall progress: **${progress}%** (${doneTasks}/${totalTasks} tasks, ${doneMilestoneWeight}/${milestoneWeight} milestone weight)`, '', '---', '');
  lines.push('## Project summary', '', project.description || project.progress_note || '_No description recorded._', '');
  lines.push('## Instructions for the implementing agent', '', AGENT_INSTRUCTIONS, '');
  if (!milestones.length) lines.push('_No milestones have been recorded yet for this project._', '');
  milestones.forEach((m, i) => {
    lines.push(`## Milestone ${i + 1}: ${m.title} [${m.status === 'done' ? 'DONE' : 'OPEN'}] (weight ${m.weight})`, '');
    if (m.evidence) lines.push(`Completion evidence: ${m.evidence}`, '');
    const children = tasksByMilestone.get(m.id) || [];
    if (!children.length) lines.push('_No tasks assigned to this milestone yet._', '');
    for (const task of children) lines.push(taskLine(task));
    lines.push('');
  });
  lines.push('## Backlog (not yet assigned to a milestone)', '');
  lines.push(backlog.length ? backlog.map(taskLine).join('\n') : '_Nothing in the backlog._', '');
  lines.push('## Manual intervention required', '');
  lines.push(manual.length ? manual.map(t => `- ${t.title}${t.evidence ? ` — ${t.evidence}` : ''}`).join('\n') : '_Nothing currently requires manual intervention._', '');
  lines.push('---', '', '_This brief reflects locally tracked evidence and may be incomplete or stale — regenerate it (Project → Save brief to repository) after the next repository review._');
  return lines.join('\n');
}

function trustedOrigin(req) {
  const allowed = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const origin = req.headers.origin;
  if (origin) return allowed.includes(origin);
  const referer = req.headers.referer;
  if (referer) return allowed.some(o => referer === o || referer.startsWith(`${o}/`));
  return false;
}

async function api(req, res, url) {
  const extensionHeaders = {
    'Access-Control-Allow-Origin': req.headers.origin?.startsWith('chrome-extension://') ? req.headers.origin : 'null',
    'Access-Control-Allow-Headers': 'Content-Type, X-WorkLens-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (req.method === 'OPTIONS' && url.pathname === '/api/browser-events') {
    res.writeHead(204, extensionHeaders); return res.end();
  }
  // Every mutating route except the key-authenticated browser-events endpoint must originate
  // from the app's own page, so a page open in another tab can't drive WorkLens by CSRF.
  if (req.method !== 'GET' && req.method !== 'OPTIONS' && url.pathname !== '/api/browser-events' && !trustedOrigin(req)) {
    return json(res, 403, { error: 'Request origin not trusted.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/browser-events') {
    if (req.headers['x-worklens-key'] !== getSetting('extension_key')) return json(res, 401, { error: 'Invalid WorkLens connection key.' }, extensionHeaders);
    const data = await body(req);
    if (!Array.isArray(data.events) || data.events.length > 500) return json(res, 400, { error: 'Expected no more than 500 events.' }, extensionHeaders);
    const insert = db.prepare('INSERT OR IGNORE INTO activities(captured_at,app_name,window_title,project_id,duration_seconds,confidence,source) VALUES(?,?,?,?,?,?,?)');
    let accepted = 0;
    for (const event of data.events) {
      let parsed;
      try { parsed = new URL(event.url); } catch { continue; }
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      const display = isSensitive(`${event.title} ${parsed.hostname}`) ? '[Sensitive browser page redacted]' : `${String(event.title || parsed.hostname).slice(0, 400)} — ${parsed.hostname}`;
      const match = classify('Chrome', `${display} ${parsed.hostname}`);
      const result = insert.run(new Date(Number(event.visitedAt) || Date.now()).toISOString(), 'Chrome', display, match.projectId, 1, match.confidence, 'chrome-history');
      accepted += Number(result.changes);
    }
    setSetting('extension_last_sync', new Date().toISOString()); setSetting('extension_last_count', accepted);
    return json(res, 200, { accepted }, extensionHeaders);
  }
  // Which build is answering: the desktop app checks this before trusting a server that's
  // already on the port, so an old copy left running can't silently serve stale features.
  if (req.method === 'GET' && url.pathname === '/api/version') return json(res, 200, BUILD);
  if (await brandsApi(req, res, url, { json, body }) !== false) return;
  if (await testloopApi(req, res, url, { json, body }) !== false) return;
  if (await enginesApi(req, res, url, { json, body }) !== false) return;
  if (await mediaApi(req, res, url, { json, body }) !== false) return;
  if (await workstationApi(req, res, url, { json, body }) !== false) return;
  if (await hubApi(req, res, url, { json, body }) !== false) return;
  if (await socialApi(req, res, url, { json, body }) !== false) return;
  if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(res, 200, dashboard(url.searchParams.get('date') || undefined));
  if (req.method === 'POST' && url.pathname === '/api/select-folder') {
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(scriptDir,'folder-picker.ps1')], { timeout: 120000 });
      const selectedPath = stdout.trim();
      if (!selectedPath) return json(res, 200, { cancelled: true });
      const resolved = fs.realpathSync(selectedPath);
      if (!fs.statSync(resolved).isDirectory()) throw new Error('Selected path is not a directory.');
      return json(res, 200, { path: resolved, name: path.basename(resolved) });
    } catch (error) { return json(res, 400, { error: `Folder selection failed: ${error.message}` }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/recording') { const data = await body(req); setRecording(Boolean(data.enabled)); return json(res, 200, { recording: Boolean(data.enabled) }); }
  if (req.method === 'POST' && url.pathname === '/api/projects') {
    const data = await body(req);
    if (!data.name?.trim()) return json(res, 400, { error: 'Project name is required.' });
    const result = db.prepare('INSERT INTO projects(name,description,color,keywords,root_path) VALUES(?,?,?,?,?)').run(data.name.trim(), data.description || '', data.color || '#7c5cff', data.keywords || '', data.rootPath || '');
    return json(res, 201, { id: Number(result.lastInsertRowid) });
  }
  if (req.method === 'PATCH' && /^\/api\/projects\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').pop()); const data = await body(req);
    const current = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!current) return json(res, 404, { error: 'Project not found.' });
    db.prepare('UPDATE projects SET name=?,description=?,color=?,keywords=?,progress_note=?,root_path=?,auto_analyze=? WHERE id=?').run(
      data.name?.trim() || current.name, data.description ?? current.description, data.color || current.color, data.keywords ?? current.keywords,
      data.progressNote ?? current.progress_note, data.rootPath ?? current.root_path, data.autoAnalyze === undefined ? current.auto_analyze : (data.autoAnalyze ? 1 : 0), id);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'DELETE' && /^\/api\/projects\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').pop());
    const result = db.prepare('DELETE FROM projects WHERE id=?').run(id);
    return json(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'Project not found.' });
  }
  if (req.method === 'POST' && /^\/api\/projects\/\d+\/analyze$/.test(url.pathname)) {
    try {
      const id = Number(url.pathname.split('/')[3]); const project = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
      if (!project) return json(res, 404, { error: 'Project not found.' });
      const plan = await analyzeAndSync(project);
      return json(res, 200, { ok: true, summary: plan.summary, milestones: plan.milestones.length, tasks: plan.tasks.length });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && /^\/api\/projects\/\d+\/import-plan$/.test(url.pathname)) {
    try {
      const id = Number(url.pathname.split('/')[3]);
      const project = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
      if (!project) return json(res, 404, { error: 'Project not found.' });
      const data = await body(req);
      const text = String(data.text || '').trim();
      if (!text) return json(res, 400, { error: 'Paste a plan to import first.' });
      if (text.length > 60000) return json(res, 400, { error: 'That plan is too long to import in one go — split it and import in parts.' });
      let plan, usedAi = false;
      if (aiConfigured()) {
        try { plan = await extractPlanFromText(text); usedAi = true; }
        catch (error) { console.error('AI plan extraction failed, falling back to heuristic parsing:', error.message); }
      }
      if (!plan) plan = parsePlainTextPlan(text);
      const result = importPlan(id, plan);
      return json(res, 200, { ok: true, usedAi, ...result });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/milestones') {
    const data = await body(req);
    if (!data.projectId || !data.title?.trim()) return json(res, 400, { error: 'Project and milestone title are required.' });
    const result = db.prepare('INSERT INTO milestones(project_id,title,weight,evidence) VALUES(?,?,?,?)').run(data.projectId, data.title.trim(), Math.max(1, Number(data.weight) || 1), data.evidence || '');
    return json(res, 201, { id: Number(result.lastInsertRowid) });
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/milestones/')) {
    const id = Number(url.pathname.split('/').pop()); const data = await body(req);
    db.prepare("UPDATE milestones SET status=?,evidence=COALESCE(?,evidence),completed_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?").run(data.status, data.evidence ?? null, data.status, id);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const data = await body(req);
    // A task can be scoped to a milestone at creation (the "+ Add task" button inside a
    // milestone in project detail does this); one that belongs to a different project is
    // silently dropped rather than trusted, since the client only offers same-project options.
    let milestoneId = data.milestoneId ? Number(data.milestoneId) : null;
    if (milestoneId) {
      const milestone = db.prepare('SELECT project_id FROM milestones WHERE id=?').get(milestoneId);
      if (!milestone || (data.projectId && milestone.project_id !== Number(data.projectId))) milestoneId = null;
    }
    const result = db.prepare('INSERT INTO tasks(project_id,title,due_at,milestone_id) VALUES(?,?,?,?)').run(data.projectId || null, data.title, data.dueAt || null, milestoneId);
    return json(res, 201, { id: Number(result.lastInsertRowid) });
  }
  if (req.method === 'PATCH' && /^\/api\/tasks\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').pop()); const data = await body(req);
    const current = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!current) return json(res, 404, { error: 'Task not found.' });
    const status = data.status ?? current.status;
    let milestoneId = current.milestone_id;
    // milestoneId is only touched when the request actually includes the key, so a plain
    // status toggle (the checkbox) never has to know or care about milestone assignment.
    if (Object.prototype.hasOwnProperty.call(data, 'milestoneId')) {
      milestoneId = data.milestoneId ? Number(data.milestoneId) : null;
      if (milestoneId) {
        const milestone = db.prepare('SELECT project_id FROM milestones WHERE id=?').get(milestoneId);
        if (!milestone || milestone.project_id !== current.project_id) return json(res, 400, { error: "That milestone isn't part of this task's project." });
      }
    }
    // evidence is likewise only touched when supplied, so the MCP server's complete_task tool
    // can attach a note without every other caller of this route having to pass one through.
    const evidence = data.evidence !== undefined ? String(data.evidence).slice(0, 1000) : current.evidence;
    db.prepare("UPDATE tasks SET status=?,milestone_id=?,evidence=?,completed_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?").run(status, milestoneId, evidence, status, id);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/reminders') {
    const data = await body(req);
    if (!data.text?.trim() || !data.remindAt) return json(res, 400, { error: 'A reminder needs text and a time.' });
    const result = db.prepare('INSERT INTO reminders(project_id,text,remind_at) VALUES(?,?,?)').run(data.projectId || null, data.text.trim(), data.remindAt);
    return json(res, 201, { id: Number(result.lastInsertRowid) });
  }
  if (req.method === 'PATCH' && /^\/api\/reminders\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').pop());
    const result = db.prepare('UPDATE reminders SET dismissed=1 WHERE id=?').run(id);
    return json(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'Reminder not found.' });
  }
  if (req.method === 'PATCH' && /^\/api\/activities\/\d+$/.test(url.pathname)) {
    // Correction inbox: reassigning an activity's project is the only place a person's judgment
    // feeds back into the classifier's evidence, so store it at full confidence and mark how.
    const id = Number(url.pathname.split('/').pop()); const data = await body(req);
    const activity = db.prepare('SELECT * FROM activities WHERE id=?').get(id);
    if (!activity) return json(res, 404, { error: 'Activity not found.' });
    db.prepare("UPDATE activities SET project_id=?,confidence=1,source=CASE WHEN source='windows' OR source='chrome-history' THEN source||'-corrected' ELSE source END WHERE id=?")
      .run(data.projectId || null, id);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const data = await body(req);
    if (data.focusProjectId !== undefined) setSetting('focus_project_id', data.focusProjectId || '');
    if (data.driftMode !== undefined && ['silent', 'gentle', 'strict'].includes(data.driftMode)) setSetting('drift_mode', data.driftMode);
    if (data.sensitiveTerms !== undefined) setSetting('sensitive_terms', String(data.sensitiveTerms).slice(0, 2000));
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/ai-review') {
    try {
      const review = await reviewDay(dashboard((await body(req)).date));
      const projects = db.prepare("SELECT * FROM projects WHERE status='active' AND root_path!=''").all().filter(project => path.isAbsolute(project.root_path));
      json(res, 200, { review, projectReviewsQueued: projects.length });
      setTimeout(async () => { for (const project of projects) { try { await analyzeAndSync(project); } catch (error) { console.error(`Review analysis failed for ${project.name}:`, error.message); } } }, 0);
      return;
    }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/ask') {
    try {
      if (!aiConfigured()) return json(res, 400, { error: 'OpenRouter is not configured. Add OPENROUTER_API_KEY to .env to use Ask.' });
      const data = await body(req);
      const question = String(data.question || '').trim().slice(0, 1000);
      if (!question) return json(res, 400, { error: 'Ask a question first.' });
      rollupEpisodes();
      await embedPendingEpisodes(40);
      const matches = await searchEpisodes(question, 8);
      if (!matches.length) return json(res, 200, { answer: "WorkLens doesn't have enough recorded activity yet to answer that — keep recording for a while and try again.", evidence: [] });
      const evidenceContext = matches.map((m, i) => `${i + 1}. [${m.projectName}] ${new Date(m.startedAt).toLocaleString()}–${new Date(m.endedAt).toLocaleTimeString()} (${Math.round(m.durationSeconds / 60)}m): ${m.summary}`).join('\n');
      const answer = await answerFromEvidence(question, evidenceContext);
      const evidence = matches.map(m => `${m.projectName} · ${new Date(m.startedAt).toLocaleString()} (${Math.round(m.durationSeconds / 60)}m) — ${m.summary}`);
      return json(res, 200, { answer, evidence });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/weekly-review') {
    try {
      rollupEpisodes();
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const dailyTotals = db.prepare(`SELECT substr(a.captured_at,1,10) day, COALESCE(p.name,'Unassigned') project, SUM(a.duration_seconds) seconds
        FROM activities a LEFT JOIN projects p ON p.id=a.project_id WHERE a.captured_at>=? AND a.source!='idle' GROUP BY day,project ORDER BY day`).all(since);
      const idleSeconds = db.prepare(`SELECT COALESCE(SUM(duration_seconds),0) s FROM activities WHERE captured_at>=? AND source='idle'`).get(since).s;
      const completedMilestones = db.prepare(`SELECT m.title,p.name project_name FROM milestones m JOIN projects p ON p.id=m.project_id WHERE m.completed_at>=?`).all(since);
      const completedTasks = db.prepare(`SELECT t.title,p.name project_name FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.completed_at>=?`).all(since);
      const openTasks = db.prepare(`SELECT t.title,p.name project_name FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.status!='done' ORDER BY t.created_at`).all();
      const review = await reviewWeek({ sinceDate: since.slice(0, 10), dailyTotals, idleSeconds, completedMilestones, completedTasks, openTasks });
      return json(res, 200, { review });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/url-only-analysis') {
    try {
      const data = await body(req);
      if (data.consent !== true) return json(res, 400, { error: 'Explicit retention consent is required for every request.' });
      if (typeof data.url !== 'string' || data.url.length > 2048) return json(res, 400, { error: 'Enter one valid URL.' });
      const parsed = new URL(data.url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return json(res, 400, { error: 'Only public HTTP(S) URLs without embedded credentials are allowed.' });
      parsed.search = ''; parsed.hash = '';
      return json(res, 200, await analyzeUrlOnly(parsed.toString()));
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/export.json') {
    const payload = {
      exportedAt: new Date().toISOString(),
      projects: db.prepare('SELECT id,name,description,color,keywords,status,root_path,progress_note,created_at FROM projects').all(),
      activities: db.prepare("SELECT a.captured_at,a.app_name,a.window_title,p.name project_name,a.duration_seconds,a.confidence,a.source FROM activities a LEFT JOIN projects p ON p.id=a.project_id ORDER BY a.captured_at").all(),
      tasks: db.prepare('SELECT t.title,t.status,p.name project_name,t.evidence,t.manual_intervention,t.due_at,t.created_at,t.completed_at FROM tasks t LEFT JOIN projects p ON p.id=t.project_id').all(),
      milestones: db.prepare('SELECT m.title,m.status,p.name project_name,m.evidence,m.weight,m.created_at,m.completed_at FROM milestones m JOIN projects p ON p.id=m.project_id').all(),
      reminders: db.prepare('SELECT r.text,r.remind_at,r.dismissed,p.name project_name FROM reminders r LEFT JOIN projects p ON p.id=r.project_id').all()
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="worklens-export.json"' });
    return res.end(JSON.stringify(payload, null, 2));
  }
  if (req.method === 'GET' && url.pathname === '/api/export.csv') {
    const rows = db.prepare("SELECT a.captured_at,a.app_name,a.window_title,COALESCE(p.name,'') project_name,a.duration_seconds,a.confidence,a.source FROM activities a LEFT JOIN projects p ON p.id=a.project_id ORDER BY a.captured_at").all();
    const csvField = value => { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
    const header = ['captured_at', 'app_name', 'window_title', 'project_name', 'duration_seconds', 'confidence', 'source'];
    const lines = [header.join(','), ...rows.map(row => header.map(key => csvField(row[key])).join(','))];
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="worklens-activities.csv"' });
    return res.end(lines.join('\n'));
  }
  if (req.method === 'GET' && /^\/api\/projects\/\d+\/brief\.pdf$/.test(url.pathname)) {
    const brief = buildProjectBrief(Number(url.pathname.split('/')[3]));
    if (!brief) return json(res, 404, { error: 'Project not found.' });
    const pdf = renderTextPdf(briefToPdfBlocks(brief));
    const safeName = brief.project.name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'project';
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${safeName}-brief.pdf"` });
    return res.end(pdf);
  }
  if (req.method === 'POST' && /^\/api\/projects\/\d+\/save-brief$/.test(url.pathname)) {
    const brief = buildProjectBrief(Number(url.pathname.split('/')[3]));
    if (!brief) return json(res, 404, { error: 'Project not found.' });
    const { root_path: rootPath } = brief.project;
    if (!rootPath || !path.isAbsolute(rootPath)) return json(res, 400, { error: 'Set an absolute repository folder path on this project first (Edit project), then try again.' });
    let resolvedRoot;
    try { resolvedRoot = fs.realpathSync(rootPath); } catch { return json(res, 400, { error: 'The configured repository path no longer exists on disk.' }); }
    if (!fs.statSync(resolvedRoot).isDirectory()) return json(res, 400, { error: 'The configured repository path is not a directory.' });
    const filePath = path.join(resolvedRoot, 'WORKLENS-BRIEF.md');
    try {
      fs.writeFileSync(filePath, briefToMarkdown(brief), 'utf8');
      fs.writeFileSync(path.join(resolvedRoot, 'WORKLENS.md'), WORKLENS_MD, 'utf8');
    }
    catch (error) { return json(res, 500, { error: `Could not write the brief: ${error.message}` }); }
    return json(res, 200, { ok: true, path: filePath });
  }
  if (req.method === 'GET' && url.pathname === '/api/export.md') {
    const projects = db.prepare("SELECT projects.*,(SELECT COUNT(*) FROM tasks t WHERE t.project_id=projects.id AND t.status='done') done_tasks,(SELECT COUNT(*) FROM tasks t WHERE t.project_id=projects.id) total_tasks FROM projects ORDER BY status,name").all();
    const lines = [`# WorkLens activity report`, ``, `Generated ${new Date().toISOString()}`, ``];
    for (const project of projects) {
      const seconds = db.prepare('SELECT COALESCE(SUM(duration_seconds),0) s FROM activities WHERE project_id=? AND source!=\'idle\'').get(project.id).s;
      const tasks = db.prepare('SELECT title,status,evidence FROM tasks WHERE project_id=? ORDER BY status').all(project.id);
      const milestones = db.prepare('SELECT title,status,evidence FROM milestones WHERE project_id=? ORDER BY status').all(project.id);
      lines.push(`## ${project.name}`, ``, project.description || project.progress_note || '_No description._', ``,
        `- Status: ${project.status}`, `- Time tracked: ${(seconds / 3600).toFixed(1)}h`, `- Tasks: ${project.done_tasks}/${project.total_tasks} done`, ``);
      if (milestones.length) { lines.push(`### Milestones`, ``); for (const m of milestones) lines.push(`- [${m.status === 'done' ? 'x' : ' '}] ${m.title}${m.evidence ? ` — _${m.evidence}_` : ''}`); lines.push(''); }
      if (tasks.length) { lines.push(`### Tasks`, ``); for (const t of tasks) lines.push(`- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.evidence ? ` — _${t.evidence}_` : ''}`); lines.push(''); }
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="worklens-report.md"' });
    return res.end(lines.join('\n'));
  }
  return false;
}

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) { const handled = await api(req, res, url); if (handled !== false) return; return json(res, 404, { error: 'Not found' }); }
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(publicDir, requested));
    if (!file.startsWith(publicDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    fs.createReadStream(file).pipe(res);
  } catch (error) { console.error(error); if (!res.headersSent) json(res, 500, { error: 'Internal error' }); }
});

// Keeps the conversational interface's evidence store warm without waiting for someone to ask a
// question first: rollup is free (local SQL only); embedding costs a small OpenRouter call, so it
// only runs when a key is configured and only picks up a bounded batch at a time.
async function maintainEpisodes() {
  try { rollupEpisodes(); } catch (error) { console.error('Episode rollup failed:', error.message); }
  if (!aiConfigured()) return;
  try { await embedPendingEpisodes(100); } catch (error) { console.error('Episode embedding failed:', error.message); }
}

seedBrands();
seedBrandAccounts();
seedHub();
startSocialSync();
seedTestloop();
startTestloopSync();
seedVoiceProfiles();
startMediaJobs();
setRecording(getSetting('recording', 'false') === 'true');
setInterval(checkProjectChanges, 60000);
setInterval(syncAllChecklists, 60000);
setInterval(maintainEpisodes, 5 * 60000);
syncAllChecklists();
maintainEpisodes();
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`WorkLens couldn't start: port ${port} is already in use (maybe another copy of WorkLens is already running?).`);
  } else {
    console.error('WorkLens server error:', error.message);
  }
});
process.on('exit', stopEngines);
server.listen(port, () => console.log(`WorkLens is running at http://localhost:${port}`));
