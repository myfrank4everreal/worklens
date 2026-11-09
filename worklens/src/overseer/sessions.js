// Overseer · reads what every Claude Code session in the Claude desktop app has been doing, straight
// off disk, read-only. Nothing here talks to the app or changes a file.
//
// Two places on disk:
//   1. The app's own index, one JSON file per session:
//        %LOCALAPPDATA%\Claude-Data\<account>\claude-code-sessions\<org>\<workspace>\local_<id>.json
//      Title, folder, archived flag, timestamps, which session started it, and the CLI session id.
//   2. Claude Code's transcripts, one JSONL file per CLI session:
//        ~/.claude/projects/<folder slug>/<cliSessionId>.jsonl
//      These reach 70 MB, so only the tail is ever read.
//
// Both formats belong to Claude, not to us, and can change in an app update. Everything below is
// defensive: a field that's missing gives an emptier summary, never a crash.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SKIP_DIRS = /^(backlog|deleted_.*)$/;
const TAIL_STEPS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
const WRAP_UP = 'mcp__ccd_turn__wrap_up';

export function claudeDataDir() {
  return process.env.WORKLENS_CLAUDE_DATA || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude-Data');
}
export function transcriptsDir() {
  return process.env.WORKLENS_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// Every local_*.json under every account's claude-code-sessions folder, skipping the app's
// backlog and deleted folders.
function metadataFiles() {
  const files = [];
  const walk = (dir, depth) => {
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 3 && !SKIP_DIRS.test(entry.name)) walk(full, depth + 1); }
      else if (/^local_[\w-]+\.json$/.test(entry.name)) files.push(full);
    }
  };
  for (const account of listDir(claudeDataDir())) {
    if (account.isDirectory()) walk(path.join(claudeDataDir(), account.name, 'claude-code-sessions'), 0);
  }
  return files;
}

// cliSessionId -> transcript path. Rebuilt at most every 20 s; there are only a few dozen folders.
let transcriptIndex = { at: 0, map: new Map() };
function transcriptPath(cliSessionId) {
  if (!cliSessionId) return null;
  if (Date.now() - transcriptIndex.at > 20000) {
    const map = new Map();
    for (const project of listDir(transcriptsDir())) {
      if (!project.isDirectory()) continue;
      for (const file of listDir(path.join(transcriptsDir(), project.name))) {
        if (file.isFile() && file.name.endsWith('.jsonl')) map.set(file.name.slice(0, -6), path.join(transcriptsDir(), project.name, file.name));
      }
    }
    transcriptIndex = { at: Date.now(), map };
  }
  return transcriptIndex.map.get(cliSessionId) || null;
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // The first line is almost always cut in half; drop it unless the read began at byte 0.
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    return { lines, complete: start === 0 };
  } finally { fs.closeSync(fd); }
}

// What the person typed, without the app's injected reminders, pasted-content wrappers or command
// caveats. Returns '' for anything that isn't a person's own words.
export function cleanUserText(content) {
  let text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
  if (!text) return '';
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<side-sessions-event>[\s\S]*?<\/side-sessions-event>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<local-command-[\w-]+>[\s\S]*?<\/local-command-[\w-]+>/g, '')
    .replace(/<command-[\w-]+>[\s\S]*?<\/command-[\w-]+>/g, '')
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, (_, inner) => `[pasted: ${inner.trim().slice(0, 120)}…]`)
    .trim();
  if (/^\[Request interrupted/.test(text)) return '';
  if (/^(Base directory for this skill|Caveat:|\[SYSTEM NOTIFICATION)/.test(text)) return '';
  return text;
}

function textOf(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('\n').trim();
}

// Walks the transcript tail backwards and pulls out the recent turns. Only the main conversation
// counts: subagent ("sidechain") records are skipped.
function parseTail(lines, wantTurns) {
  const turns = [];
  let wrapUp = null, lastAt = null, lastTool = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.isSidechain) continue;
    if (!lastAt && record.timestamp && (record.type === 'assistant' || record.type === 'user')) lastAt = record.timestamp;
    const content = record.message?.content;
    if (record.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use') {
          if (!lastTool) lastTool = block.name;
          if (!wrapUp && block.name === WRAP_UP && block.input) wrapUp = { recap: block.input.recap || '', ask: block.input.ask || '', at: record.timestamp || null };
        }
      }
      const text = textOf(content);
      if (text) turns.push({ role: 'assistant', text, at: record.timestamp || null });
    } else if (record.type === 'user' && !record.isMeta) {
      const text = cleanUserText(content);
      if (text) turns.push({ role: 'user', text, at: record.timestamp || null });
    }
    if (turns.length >= wantTurns && wrapUp) break;
  }
  turns.reverse();
  return { turns: turns.slice(-wantTurns), wrapUp, lastAt, lastTool };
}

const tailCache = new Map(); // path -> { size, mtimeMs, want, value }
function transcriptSummary(file, wantTurns = 6) {
  if (!file) return null;
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = tailCache.get(file);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs && hit.want >= wantTurns) {
    return { ...hit.value, turns: hit.value.turns.slice(-wantTurns) };
  }
  let value = { turns: [], wrapUp: null, lastAt: null, lastTool: null, modifiedAt: stat.mtimeMs };
  for (const bytes of TAIL_STEPS) {
    const { lines, complete } = readTail(file, bytes);
    value = { ...parseTail(lines, wantTurns), modifiedAt: stat.mtimeMs };
    const hasAssistant = value.turns.some(t => t.role === 'assistant');
    const hasUser = value.turns.some(t => t.role === 'user');
    if (complete || (hasAssistant && hasUser && value.turns.length >= Math.min(wantTurns, 2))) break;
  }
  tailCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, want: wantTurns, value });
  return value;
}

const iso = ms => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);
const short = (text, max) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

// The app doesn't write "running" to disk. A turn that began (a user frame) after the last turn
// edge, and that is still recent, is the best signal there is.
// A transcript written to in the last 90 seconds is a session mid-turn, whatever the index says.
function stateOf(meta, summary) {
  const userAt = meta.latestUserFrameAt || 0;
  const edgeAt = meta.lastTurnEdgeAt || 0;
  const activeAt = Math.max(meta.lastActivityAt || 0, summary?.lastAt ? Date.parse(summary.lastAt) : 0);
  if (summary?.modifiedAt && Date.now() - summary.modifiedAt < 90 * 1000) return 'working';
  if (userAt > edgeAt && Date.now() - activeAt < 20 * 60 * 1000) return 'working';
  if (meta.interruptedAwaitingPerson) return 'waiting';
  if (openAsk(summary)) return 'waiting';
  const lastAssistant = [...(summary?.turns || [])].reverse().find(t => t.role === 'assistant');
  if (lastAssistant && /\?\s*$/.test(lastAssistant.text.trim())) return 'waiting';
  return 'idle';
}

// A question from the session's last wrap-up counts only while nobody has replied after it.
function openAsk(summary) {
  const ask = summary?.wrapUp?.ask;
  if (!ask) return '';
  const askedAt = summary.wrapUp.at ? Date.parse(summary.wrapUp.at) : 0;
  const replied = (summary.turns || []).some(t => t.role === 'user' && t.at && Date.parse(t.at) > askedAt);
  return replied ? '' : ask;
}

// The index files carry large snapshots, so each is parsed once per change, and only the fields
// used here are kept.
const META_FIELDS = ['sessionId', 'cliSessionId', 'lastAssistantCliSessionId', 'cwd', 'originCwd', 'title', 'isArchived', 'createdAt', 'lastActivityAt', 'lastTurnEdgeAt', 'latestUserFrameAt', 'interruptedAwaitingPerson', 'model', 'spawnedFrom'];
const metaCache = new Map();
function readMeta(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = metaCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  let value = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    value = Object.fromEntries(META_FIELDS.map(k => [k, raw[k]]));
  } catch { value = null; }
  metaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function describe(meta, wantTurns) {
  const summary = transcriptSummary(transcriptPath(meta.lastAssistantCliSessionId || meta.cliSessionId), wantTurns);
  const lastAssistant = [...(summary?.turns || [])].reverse().find(t => t.role === 'assistant');
  const lastUser = [...(summary?.turns || [])].reverse().find(t => t.role === 'user');
  return {
    id: meta.sessionId,
    title: meta.title || '(untitled)',
    folder: meta.cwd || meta.originCwd || '',
    project: path.basename(meta.cwd || meta.originCwd || '') || '',
    archived: Boolean(meta.isArchived),
    state: stateOf(meta, summary),
    createdAt: iso(meta.createdAt),
    lastActivityAt: iso(Math.max(meta.lastActivityAt || 0, summary?.lastAt ? Date.parse(summary.lastAt) : 0)),
    model: meta.model || null,
    startedBy: meta.spawnedFrom?.sessionId || null,
    startedByTitle: null, // filled in from the parent's own index entry, see withParents()
    name: meta.spawnedFrom?.name || null,
    recap: summary?.wrapUp?.recap || '',
    ask: openAsk(summary),
    lastUser: lastUser ? short(lastUser.text, 400) : '',
    lastReply: lastAssistant ? short(lastAssistant.text, 900) : '',
    lastTool: summary?.lastTool || null,
    hasTranscript: Boolean(summary),
    turns: summary?.turns || []
  };
}

// spawnedFrom.title is the task title the child was given, not the parent's name, so the parent's
// title comes from the parent's own entry (archived ones included).
function withParents(sessions) {
  const titles = new Map();
  for (const file of metadataFiles()) { const m = readMeta(file); if (m?.sessionId) titles.set(m.sessionId, m.title || ''); }
  for (const s of sessions) if (s.startedBy) s.startedByTitle = titles.get(s.startedBy) || null;
  return sessions;
}

// Every session, newest activity first. `turns` is left out of the list to keep it small.
export function listSessions({ includeArchived = false, limit = 60 } = {}) {
  const sessions = [];
  for (const file of metadataFiles()) {
    const meta = readMeta(file);
    if (!meta?.sessionId) continue;
    if (meta.isArchived && !includeArchived) continue;
    try { const { turns, ...rest } = describe(meta, 6); sessions.push(rest); } catch (error) { sessions.push({ id: meta.sessionId, title: meta.title || '(untitled)', state: 'idle', error: error.message }); }
  }
  sessions.sort((a, b) => Date.parse(b.lastActivityAt || 0) - Date.parse(a.lastActivityAt || 0));
  return withParents(sessions).slice(0, limit);
}

// One session with its last few turns, each trimmed so the whole thing fits in a model prompt.
export function readSession(id, { turns = 10, maxChars = 1500 } = {}) {
  const file = metadataFiles().find(f => path.basename(f, '.json') === id);
  const meta = file && readMeta(file);
  if (!meta) return null;
  const [session] = withParents([describe(meta, Math.min(Math.max(Number(turns) || 10, 1), 40))]);
  session.turns = session.turns.map(t => ({ ...t, text: short(t.text, maxChars) }));
  return session;
}

// Counts for the panel header and the spoken one-liner.
export function sessionCounts(sessions) {
  const counts = { working: 0, waiting: 0, idle: 0, total: sessions.length };
  for (const s of sessions) counts[s.state] = (counts[s.state] || 0) + 1;
  return counts;
}
