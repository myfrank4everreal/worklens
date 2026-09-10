const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
const embeddingEndpoint = 'https://openrouter.ai/api/v1/embeddings';
import { db } from './db.js';

function recordUsage(operation, result, secure) {
  const usage = result?.usage || {};
  db.prepare('INSERT INTO ai_usage(operation,model,prompt_tokens,completion_tokens,cost,secure) VALUES(?,?,?,?,?,?)').run(
    operation, result?.model || 'unknown', Number(usage.prompt_tokens || 0), Number(usage.completion_tokens || 0), Number(usage.cost || 0), secure ? 1 : 0);
}

export function aiConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export async function reviewDay(context) {
  if (!aiConfigured()) throw new Error('OpenRouter is not configured. Add OPENROUTER_API_KEY to .env.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:4317',
      'X-Title': 'WorkLens'
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini',
      provider: { zdr: true, data_collection: 'deny' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are a concise work coach. Use only supplied evidence. Distinguish observed activity from inferred progress. Return Markdown with Accomplishments, Open loops, Focus observations, and Tomorrow.' },
        { role: 'user', content: JSON.stringify(context) }
      ]
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result?.error?.message || result?.message || response.statusText;
    throw new Error(`OpenRouter request failed (${response.status}): ${detail}`);
  }
  recordUsage('Daily review', result, true);
  return result.choices?.[0]?.message?.content || 'No review returned.';
}

export async function analyzeUrlOnly(url) {
  if (!aiConfigured()) throw new Error('OpenRouter is not configured.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:4317', 'X-Title': 'WorkLens URL-only analysis' },
    body: JSON.stringify({
      model: 'openrouter/free',
      provider: { data_collection: 'allow' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'Analyze only the URL in the next message. Do not claim to have opened or read the page. Briefly infer its likely purpose, relevant project category, useful classification keywords, and any privacy caution.' },
        { role: 'user', content: url }
      ]
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result?.error?.message || result?.message || response.statusText;
    throw new Error(`Free-model request failed (${response.status}): ${detail}`);
  }
  recordUsage('URL-only analysis', result, false);
  return { analysis: result.choices?.[0]?.message?.content || 'No analysis returned.', model: result.model || 'openrouter/free' };
}

// Turns episode/evidence text into vectors for the conversational interface's retrieval step.
// Uses the OpenAI-compatible embeddings shape OpenRouter documents; this session had no network
// path to openrouter.ai to exercise it live, so if the response shape has changed, this is the
// first place to look (the error message includes the raw status so it's diagnosable).
export async function embedTexts(texts) {
  if (!aiConfigured()) throw new Error('OpenRouter is not configured.');
  if (!texts.length) return [];
  const response = await fetch(embeddingEndpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:4317', 'X-Title': 'WorkLens embeddings' },
    body: JSON.stringify({
      model: process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small',
      input: texts,
      provider: { zdr: true, data_collection: 'deny' }
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Embedding request failed (${response.status}): ${result?.error?.message || response.statusText}`);
  if (!Array.isArray(result.data)) throw new Error('Embedding response did not include the expected "data" array.');
  recordUsage('Embeddings', result, true);
  return result.data.map(item => item.embedding);
}

export async function answerFromEvidence(question, evidenceContext) {
  if (!aiConfigured()) throw new Error('OpenRouter is not configured. Add OPENROUTER_API_KEY to .env.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:4317', 'X-Title': 'WorkLens ask' },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini',
      provider: { zdr: true, data_collection: 'deny' },
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You answer questions about the user\'s own tracked work activity using ONLY the evidence provided below. Every claim must be traceable to a specific evidence item — refer to it by its number, e.g. "(evidence 2)". If the evidence does not answer the question, say plainly that WorkLens does not have enough recorded activity to answer, rather than guessing or using general knowledge. Distinguish what was observed (time spent, files/pages touched) from what you are inferring about progress or blockers. Be concise.' },
        { role: 'user', content: `Evidence:\n${evidenceContext}\n\nQuestion: ${question}` }
      ]
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Ask request failed (${response.status}): ${result?.error?.message || response.statusText}`);
  recordUsage('Work query', result, true);
  return result.choices?.[0]?.message?.content || 'No answer returned.';
}

export async function reviewWeek(context) {
  if (!aiConfigured()) throw new Error('OpenRouter is not configured. Add OPENROUTER_API_KEY to .env.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:4317', 'X-Title': 'WorkLens weekly review' },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini',
      provider: { zdr: true, data_collection: 'deny' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are a concise work coach reviewing a full week. Use only the supplied evidence — daily time-by-project totals, completed/open milestones and tasks, and idle time. Distinguish observed activity from inferred progress. Return Markdown with sections: This week, Patterns (focus, context-switching, idle time), Slipping or stalled, and Suggested priorities for next week.' },
        { role: 'user', content: JSON.stringify(context) }
      ]
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Weekly review failed (${response.status}): ${result?.error?.message || response.statusText}`);
  recordUsage('Weekly review', result, true);
  return result.choices?.[0]?.message?.content || 'No review returned.';
}

// Turns a pasted operational plan/runbook (not a repository) into the same
// {summary, milestones, tasks} shape analyzeProjectContext produces, so both feed the same
// syncing code in server.js. Unlike analyzeProjectContext this has no repository evidence to
// check against — it's just structuring the user's own text — so status is only ever "done" when
// the text itself says a step is already complete.
export async function extractPlanFromText(text) {
  if (!aiConfigured()) throw new Error('OpenRouter is not configured.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:4317', 'X-Title': 'WorkLens plan import' },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'z-ai/glm-5.3-flash',
      provider: { zdr: true, data_collection: 'deny' }, temperature: 0.1,
      messages: [
        { role: 'system', content: `You turn a pasted operational plan, runbook, or step-by-step guide into strict JSON, no fences: {"summary":"...","milestones":[{"key":"stable-slug","title":"...","weight":1,"status":"todo"}],"tasks":[{"key":"stable-slug","milestoneKey":"...","title":"...","status":"todo|done","manualIntervention":false,"evidence":"..."}]}. Use the plan's own top-level phases/sections, in the order they appear, as milestones. Use the plan's own numbered or lettered subsection headings within a phase as individual tasks — do not create a separate task for every bullet point or every line of a code block; fold that supporting detail into the task's own "evidence" field instead. Preserve the plan's ordering. Only mark a task "status":"done" if the text explicitly says it is already complete; otherwise "todo". Set "manualIntervention":true for a step that needs a human account, purchase, business/legal decision, or an external party's approval — false for a step a coding agent could execute on its own (writing code, running a command, editing a config file, creating a file). Do not invent steps that are not in the text, and do not omit any phase or subsection that is in it.` },
        { role: 'user', content: text.slice(0, 60000) }
      ]
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Plan extraction failed (${response.status}): ${result?.error?.message || response.statusText}`);
  recordUsage('Plan import', result, true);
  const raw = result.choices?.[0]?.message?.content || '';
  try { return JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '')); } catch { throw new Error('The model returned an invalid plan. Try again, or import without AI by leaving OpenRouter unconfigured.'); }
}

export async function analyzeProjectContext(context) {
  if (!aiConfigured()) throw new Error('OpenRouter is not configured.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:4317', 'X-Title': 'WorkLens project analysis' },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'z-ai/glm-5.3-flash',
      provider: { zdr: true, data_collection: 'deny' }, temperature: 0.1,
      messages: [
        { role: 'system', content: `You are an evidence-driven software project analyst. Inspect only supplied repository evidence. Return strict JSON, no fences: {"summary":"...","milestones":[{"key":"stable-slug","title":"...","weight":1,"status":"todo|done","evidence":"specific files/tests/commits"}],"tasks":[{"key":"stable-slug","milestoneKey":"...","title":"...","status":"todo|done","manualIntervention":false,"evidence":"what proves status"}]}. Never mark work done without repository evidence. Manual intervention means credentials, account access, purchases, legal/product decisions, physical actions, deployment approval, or subjective acceptance. Use stable keys across repeat analyses. Limit to 8 milestones and 30 tasks.` },
        { role: 'user', content: JSON.stringify(context) }
      ]
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Project analysis failed (${response.status}): ${result?.error?.message || response.statusText}`);
  recordUsage('Project analysis', result, true);
  const raw = result.choices?.[0]?.message?.content || '';
  try { return JSON.parse(raw.replace(/^```json\s*|\s*```$/g,'')); } catch { throw new Error('The model returned an invalid project plan. Try analysis again.'); }
}
