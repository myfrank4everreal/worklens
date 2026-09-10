#!/usr/bin/env node
// WorkLens MCP server — lets a coding agent (Claude Code, Codex, Cline, or any other MCP client)
// see the current plan for a project and report progress on it directly, instead of guessing from
// activity or waiting for someone to tick a checkbox by hand. Runs as a plain subprocess over
// stdio (newline-delimited JSON-RPC, per the MCP spec) — it does not open the database itself; it
// talks to the already-running WorkLens server's own HTTP API, so there's exactly one process
// that ever touches worklens.db and this can be started/stopped freely without risking a lock
// conflict or a stale read.
import readline from 'node:readline';

const port = process.env.WORKLENS_PORT || 4317;
const base = `http://127.0.0.1:${port}`;

// Requests here come from a local subprocess the user's own coding agent spawned, not a browser —
// the same trust boundary WorkLens's CSRF check (trustedOrigin() in server.js) already assumes
// for anything that isn't a page load. Setting Origin satisfies that check; it isn't a bypass of
// anything a remote attacker could reach, since nothing about MCP's stdio transport is reachable
// over a network.
async function api(pathname, options = {}) {
  let response;
  try {
    response = await fetch(`${base}${pathname}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Origin: base, ...options.headers }
    });
  } catch (error) {
    throw new Error(`Could not reach WorkLens at ${base} (${error.message}). Is WorkLens running?`);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error || `WorkLens request failed (${response.status}). Is WorkLens running at ${base}?`);
  return result;
}

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List WorkLens projects (id, name, status, progress, which one is currently "Focused on").',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_focused_project',
    description: 'Get the project currently pinned as "Focused on" in WorkLens, with its milestones, tasks, and backlog. Returns null if nothing is focused.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_tasks',
    description: "List a project's milestones, their tasks, and its backlog (tasks with no milestone).",
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'number', description: 'The WorkLens project id (from list_projects).' } },
      required: ['projectId'],
      additionalProperties: false
    }
  },
  {
    name: 'complete_task',
    description: 'Mark a WorkLens task done, with an evidence note describing what proves it. Use this the moment you finish the work a task describes.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'The task id (from list_tasks).' },
        evidence: { type: 'string', description: "What proves this is done — a file, a command's output, a test that now passes." }
      },
      required: ['taskId'],
      additionalProperties: false
    }
  },
  {
    name: 'add_task',
    description: 'Record a new task WorkLens did not already know about.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'number' },
        title: { type: 'string' },
        milestoneId: { type: 'number', description: 'Optional — omit to leave it in the backlog.' }
      },
      required: ['projectId', 'title'],
      additionalProperties: false
    }
  }
];

function findProjectTasks(dashboard, projectId) {
  const milestones = dashboard.milestones.filter(m => m.project_id === projectId);
  const tasks = dashboard.tasks.filter(t => t.project_id === projectId);
  const byMilestone = new Map(milestones.map(m => [m.id, []]));
  const backlog = [];
  for (const task of tasks) {
    if (task.milestone_id && byMilestone.has(task.milestone_id)) byMilestone.get(task.milestone_id).push(task);
    else backlog.push(task);
  }
  return {
    milestones: milestones.map(m => ({
      id: m.id, title: m.title, status: m.status, evidence: m.evidence,
      tasks: (byMilestone.get(m.id) || []).map(t => ({ id: t.id, title: t.title, status: t.status, evidence: t.evidence, manualIntervention: Boolean(t.manual_intervention) }))
    })),
    backlog: backlog.map(t => ({ id: t.id, title: t.title, status: t.status, evidence: t.evidence, manualIntervention: Boolean(t.manual_intervention) }))
  };
}

async function callTool(name, args) {
  if (name === 'list_projects') {
    const dashboard = await api('/api/dashboard');
    return dashboard.projects.map(p => ({ id: p.id, name: p.name, status: p.status, progress: p.progress, focused: p.id === dashboard.focusProjectId }));
  }
  if (name === 'get_focused_project') {
    const dashboard = await api('/api/dashboard');
    if (!dashboard.focusProjectId) return null;
    const project = dashboard.projects.find(p => p.id === dashboard.focusProjectId);
    if (!project) return null;
    return { id: project.id, name: project.name, status: project.status, progress: project.progress, ...findProjectTasks(dashboard, project.id) };
  }
  if (name === 'list_tasks') {
    const dashboard = await api('/api/dashboard');
    const project = dashboard.projects.find(p => p.id === Number(args.projectId));
    if (!project) throw new Error(`No project with id ${args.projectId}.`);
    return { id: project.id, name: project.name, ...findProjectTasks(dashboard, project.id) };
  }
  if (name === 'complete_task') {
    await api(`/api/tasks/${Number(args.taskId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'done', evidence: args.evidence || '' }) });
    return { ok: true };
  }
  if (name === 'add_task') {
    const result = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId: Number(args.projectId), title: args.title, milestoneId: args.milestoneId ? Number(args.milestoneId) : null }) });
    return { ok: true, id: result.id };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function sendResult(id, result) { send({ jsonrpc: '2.0', id, result }); }
function sendError(id, message, code = -32000) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  // Notifications (no "id") get no response, per JSON-RPC 2.0 — notifications/initialized is the
  // only one this server expects, but any other notification is silently ignored the same way.
  if (message.id === undefined) return;

  const { id, method, params } = message;
  try {
    if (method === 'initialize') {
      sendResult(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'worklens', version: '0.1.0' } });
    } else if (method === 'tools/list') {
      sendResult(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const result = await callTool(params.name, params.arguments || {});
      sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } else {
      sendError(id, `Method not implemented: ${method}`, -32601);
    }
  } catch (error) {
    if (method === 'tools/call') sendResult(id, { content: [{ type: 'text', text: error.message }], isError: true });
    else sendError(id, error.message);
  }
});

process.stderr.write(`WorkLens MCP server ready — talking to ${base}\n`);
