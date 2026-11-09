// Overseer · the Claude session behind the voice. Each question runs the installed Claude Code CLI
// headless (`claude -p`), on the person's own Claude login, with:
//   - no built-in tools at all (--tools ""), so it cannot run commands or touch files;
//   - only the read-only overseer MCP server (src/overseer/mcp.js), via --strict-mcp-config;
//   - no user, project or local settings (--restricted), so allow-rules and a bypassPermissions
//     default from ~/.claude/settings.json can't widen what it may do;
//   - permission mode dontAsk with only mcp__overseer allowed: anything else is refused, never asked.
// Follow-up questions within a few minutes resume the same conversation, so "tell me more" works.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONVERSATION_IDLE_MS = 10 * 60 * 1000;
const TURN_TIMEOUT_MS = 150 * 1000;
export const SPOKEN_BREAK = '---';

let conversation = null; // { id, lastAt }
let running = null;

// The real executable, not the npm .cmd shim, so arguments never pass through cmd.exe quoting.
export function claudeBinary() {
  const candidates = [
    process.env.WORKLENS_CLAUDE_BIN,
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude')
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['claude.exe', 'claude']) {
      const full = path.join(dir, name);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    }
  }
  return null;
}

// Inside the packaged app, process.execPath is electron.exe; ELECTRON_RUN_AS_NODE makes it plain Node.
function nodeCommand() {
  return { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

function systemPrompt(name) {
  return `You are ${name}, the voice overseer of the person's workstation. They talk to you out loud, and your answer is read aloud by a speech engine, then shown on screen.

What you oversee: every Claude Code session in their Claude desktop app (each works on one task in one project folder, and some were started by other sessions), plus WorkLens's own projects, tasks and content pipeline. Your tools read all of that. They only read: you cannot start, stop, message or change any session, file or post. If they ask you to do something, say plainly that you can only report for now, and tell them which session to open to do it.

How to answer:
- Call tools before you write anything. Do not write a word before your tool calls; no "let me check".
- Start with the spoken part: at most three short sentences, under 60 words, in plain speech. No markdown, no bullet points, no lists, no IDs, no file paths, no URLs, no emoji. Say numbers the way a person would. Name sessions by a short version of their title.
- Lead with what matters most: what is waiting on them and anything urgent or time-bound, then what is still working.
- If there is more worth showing, write a line containing only ${SPOKEN_BREAK}, then the detail for the screen in short markdown (headings and bullets are fine there). Leave it out for a simple answer.
- "waiting" means that session asked them something and is stuck until they answer; quote the question briefly. "working" means it is mid-task right now. "idle" means it finished its last turn.
- Only state what the tools returned. If something is unclear or missing, say so in a few words. Never guess at progress.
- When they ask for more detail on one session, read it with read_session and summarise how far it got and what it needs.
- They use they/them for people whose pronouns you don't know.

The current local time is ${new Date().toString()}.`;
}

function mcpConfig() {
  const { command, env } = nodeCommand();
  return JSON.stringify({ mcpServers: { overseer: { type: 'stdio', command, args: [path.join(here, 'mcp.js')], env: { ...env, WORKLENS_PORT: String(process.env.WORKLENS_PORT || 4317) } } } });
}

export function resetConversation() { conversation = null; }
export function busy() { return Boolean(running); }
export function stop() { if (running) { try { running.kill(); } catch {} running = null; } }

// Ask one question. `onEvent` receives { type: 'delta', text } | { type: 'reset' } (text so far was
// a preamble, discard it) | { type: 'tool', name } | { type: 'done', text, spoken, detail, costUsd }
// | { type: 'error', error }. Resolves once the turn ends.
export function ask(question, { model = 'sonnet', name = 'Jarvis', workDir, fresh = false, onEvent = () => {} } = {}) {
  return new Promise((resolve) => {
    const bin = claudeBinary();
    if (!bin) { onEvent({ type: 'error', error: 'Claude Code is not installed or not on PATH. Install it and sign in, then try again.' }); return resolve(); }
    if (running) stop();
    if (fresh || !conversation || Date.now() - conversation.lastAt > CONVERSATION_IDLE_MS) conversation = { id: crypto.randomUUID(), lastAt: 0, started: false };
    const cwd = workDir || path.join(os.tmpdir(), 'worklens-overseer');
    fs.mkdirSync(cwd, { recursive: true });

    const args = [
      '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', model,
      '--restricted', '--tools', '',
      '--strict-mcp-config', '--mcp-config', mcpConfig(),
      '--allowedTools', 'mcp__overseer',
      '--permission-mode', 'dontAsk',
      '--system-prompt', systemPrompt(name),
      ...(conversation.started ? ['--resume', conversation.id] : ['--session-id', conversation.id])
    ];
    const child = spawn(bin, args, { cwd, windowsHide: true, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'worklens-overseer' } });
    running = child;
    let buffer = '', text = '', stderr = '', finished = false;
    const timer = setTimeout(() => { if (!finished) { onEvent({ type: 'error', error: 'The overseer took too long to answer.' }); child.kill(); } }, TURN_TIMEOUT_MS);

    const finish = (event) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (running === child) running = null;
      if (event) onEvent(event);
      resolve();
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'system' && msg.subtype === 'init') { conversation.started = true; continue; }
        if (msg.type === 'stream_event') {
          const ev = msg.event || {};
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            if (text) { text = ''; onEvent({ type: 'reset' }); }
            onEvent({ type: 'tool', name: String(ev.content_block.name || '').replace(/^mcp__overseer__/, '') });
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            text += ev.delta.text;
            onEvent({ type: 'delta', text: ev.delta.text });
          }
          continue;
        }
        if (msg.type === 'result') {
          conversation.lastAt = Date.now();
          if (msg.is_error || msg.subtype !== 'success') {
            finish({ type: 'error', error: friendlyError(msg.result || msg.subtype || 'The overseer failed.') });
          } else {
            const full = String(msg.result || text).trim();
            finish({ type: 'done', text: full, ...splitSpoken(full), costUsd: msg.total_cost_usd ?? null });
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    child.on('error', (error) => finish({ type: 'error', error: `Could not start Claude Code: ${error.message}` }));
    child.on('close', (code) => {
      if (!finished) {
        if (!conversation.lastAt && conversation.started === false) conversation = null;
        finish({ type: 'error', error: friendlyError(stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code stopped (exit ${code}).`) });
      }
    });
    child.stdin.end(question);
  });
}

function friendlyError(message) {
  const m = String(message);
  if (/not logged in|login|authenticate|401/i.test(m)) return 'Claude Code is not signed in on this computer. Run claude once in a terminal and sign in.';
  if (/rate|limit|overloaded|529/i.test(m)) return `Claude is busy or over its usage limit right now. ${m.slice(0, 160)}`;
  return m.slice(0, 400);
}

// The spoken part is everything before a line holding only the break marker.
export function splitSpoken(full) {
  const lines = String(full).split('\n');
  const at = lines.findIndex(l => l.trim() === SPOKEN_BREAK);
  if (at < 0) return { spoken: plainSpeech(full), detail: '' };
  return { spoken: plainSpeech(lines.slice(0, at).join('\n')), detail: lines.slice(at + 1).join('\n').trim() };
}

// Belt and braces: strip whatever markdown slipped into the spoken part.
export function plainSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
