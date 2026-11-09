#!/usr/bin/env node
// Overseer · the tools the voice overseer's Claude session gets, as a stdio MCP server. Every tool
// only reads: it lists or reads sessions, projects, tasks and content cards through the running
// WorkLens server's GET endpoints. There is nothing here that writes, sends or starts anything.
//
// Started by src/overseer/brain.js with --strict-mcp-config, so this is the only MCP server that
// session sees, and its built-in tools are switched off (--tools "").
import readline from 'node:readline';

const port = process.env.WORKLENS_PORT || 4317;
const base = `http://127.0.0.1:${port}`;

async function get(pathname) {
  let response;
  try { response = await fetch(`${base}${pathname}`); }
  catch (error) { throw new Error(`Could not reach WorkLens at ${base} (${error.message}).`); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error || `WorkLens request failed (${response.status}).`);
  return result;
}

const TOOLS = [
  {
    name: 'list_sessions',
    description: 'Every Claude Code session in the Claude desktop app, newest activity first. Each has a state (working, waiting = it asked the person something, idle), its folder, the question it is waiting on (ask), its last recap, the start of its last reply, and which session started it (startedByTitle). Call this first for any question about sessions or activity.',
    inputSchema: { type: 'object', properties: { includeArchived: { type: 'boolean' }, limit: { type: 'number', description: 'Default 40.' } }, additionalProperties: false }
  },
  {
    name: 'read_session',
    description: 'The last few turns of one session (what the person asked and what the session replied), for detail on how far it got. Use the id from list_sessions.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, turns: { type: 'number', description: 'How many recent turns, default 8, at most 30.' } }, required: ['id'], additionalProperties: false }
  },
  {
    name: 'worklens_overview',
    description: "WorkLens's own records: projects with progress and open tasks, and the content pipeline (cards per stage, what is scheduled next and anything overdue).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

async function callTool(name, args) {
  if (name === 'list_sessions') {
    const query = new URLSearchParams({ limit: String(Math.min(Number(args.limit) || 40, 80)) });
    if (args.includeArchived) query.set('archived', '1');
    const { sessions } = await get(`/api/overseer/sessions?${query}`);
    return sessions.map(s => ({
      id: s.id, title: s.title, project: s.project, state: s.state, lastActivityAt: s.lastActivityAt,
      ask: s.ask || undefined, recap: s.recap || undefined, lastReply: s.lastReply ? s.lastReply.slice(0, 400) : undefined,
      startedByTitle: s.startedByTitle || undefined, archived: s.archived || undefined
    }));
  }
  if (name === 'read_session') {
    const turns = Math.min(Math.max(Number(args.turns) || 8, 1), 30);
    const { session } = await get(`/api/overseer/sessions/${encodeURIComponent(String(args.id))}?turns=${turns}`);
    return session;
  }
  if (name === 'worklens_overview') {
    const [dashboard, content] = await Promise.all([get('/api/dashboard'), get('/api/content').catch(() => null)]);
    const projects = (dashboard.projects || []).filter(p => p.status === 'active').map(p => ({ name: p.name, progress: p.progress, openTasks: p.open_tasks, note: (p.progress_note || '').slice(0, 200) }));
    const openTasks = (dashboard.tasks || []).filter(t => t.status !== 'done').slice(0, 25).map(t => ({ project: (dashboard.projects || []).find(p => p.id === t.project_id)?.name, title: t.title, status: t.status, due: t.due_at || undefined, needsPerson: Boolean(t.manual_intervention) || undefined }));
    let pipeline = null;
    if (content?.items) {
      const items = content.items;
      const byStage = {};
      for (const item of items) byStage[item.stage_label || item.stage] = (byStage[item.stage_label || item.stage] || 0) + 1;
      const upcoming = items.filter(i => i.stage === 'scheduled' && i.scheduled_at).sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at))).slice(0, 6).map(i => ({ title: i.title, at: i.scheduled_at }));
      const overdue = items.filter(i => i.overdue).slice(0, 6).map(i => ({ title: i.title, stage: i.stage_label || i.stage, by: i.post_by || i.scheduled_at }));
      pipeline = { byStage, upcoming, overdue };
    }
    return { now: new Date().toString(), focusedProject: (dashboard.projects || []).find(p => p.id === dashboard.focusProjectId)?.name || null, projects, openTasks, pipeline };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  const { id, method, params } = message;
  try {
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'overseer', version: '0.1.0' } } });
    else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    else if (method === 'tools/call') {
      const result = await callTool(params.name, params.arguments || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    } else send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not implemented: ${method}` } });
  } catch (error) {
    if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error.message }], isError: true } });
    else send({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } });
  }
});
