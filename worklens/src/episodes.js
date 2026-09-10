// Episodes are the retrieval unit behind the conversational interface: raw 15-second activity
// rows are far too granular and numerous to hand to a model or embed one-by-one, so this rolls
// consecutive same-project activity into 5-20 minute chunks with a short text summary, then
// embeds those summaries for semantic search. Nothing here calls a model unless embeddings are
// requested — rollup itself is pure local SQL/JS.
import { db, getSetting, setSetting } from './db.js';
import { embedTexts } from './openrouter.js';

const GAP_SECONDS = 5 * 60;       // a silence longer than this starts a new episode
const MAX_EPISODE_SECONDS = 20 * 60; // cap so one very long focused stretch still splits up
const SETTLE_SECONDS = 6 * 60;    // don't roll up activity from the last few minutes — it may
                                   // still be growing into the current episode

function summarize(rows) {
  const titles = [...new Set(rows.map(r => r.window_title))].slice(0, 4);
  const apps = [...new Set(rows.map(r => r.app_name))];
  return `${apps.join(', ')} — ${titles.join(' · ')}`.slice(0, 600);
}

// Groups a project's activities into episode-sized chunks and inserts rows for any not yet
// covered. Safe to call often — it only ever reads activities newer than the last rollup and
// skips anything too recent to be considered settled.
export function rollupEpisodes() {
  const cutoff = new Date(Date.now() - SETTLE_SECONDS * 1000).toISOString();
  const lastId = Number(getSetting('episodes_last_activity_id', '0'));
  const rows = db.prepare(`SELECT * FROM activities WHERE id > ? AND source != 'idle' AND captured_at < ? ORDER BY captured_at ASC`).all(lastId, cutoff);
  if (!rows.length) return 0;

  const insert = db.prepare('INSERT INTO episodes(project_id,started_at,ended_at,duration_seconds,summary) VALUES(?,?,?,?,?)');
  let batch = [];
  let created = 0;
  let maxId = lastId;

  const flush = () => {
    if (!batch.length) return;
    const duration = batch.reduce((sum, r) => sum + r.duration_seconds, 0);
    if (duration >= 45) { // skip near-instant blips that add noise without evidence value
      insert.run(batch[0].project_id, batch[0].captured_at, batch[batch.length - 1].captured_at, duration, summarize(batch));
      created += 1;
    }
    batch = [];
  };

  for (const row of rows) {
    maxId = Math.max(maxId, row.id);
    const prev = batch[batch.length - 1];
    if (prev) {
      const gap = (new Date(row.captured_at) - new Date(prev.captured_at)) / 1000 - prev.duration_seconds;
      const batchDuration = batch.reduce((sum, r) => sum + r.duration_seconds, 0);
      if (row.project_id !== prev.project_id || gap > GAP_SECONDS || batchDuration > MAX_EPISODE_SECONDS) flush();
    }
    batch.push(row);
  }
  flush();
  setSetting('episodes_last_activity_id', maxId);
  return created;
}

function vecToBlob(vec) { return Buffer.from(Float32Array.from(vec).buffer); }
function blobToVec(blob) { const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); }

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

// Embeds any episode that doesn't have a vector yet, in modest batches so one call to OpenRouter
// can't balloon into thousands of inputs after a long gap without recording running.
export async function embedPendingEpisodes(limit = 100) {
  const pending = db.prepare('SELECT id,summary FROM episodes WHERE embedding IS NULL ORDER BY started_at ASC LIMIT ?').all(limit);
  if (!pending.length) return 0;
  const vectors = await embedTexts(pending.map(e => e.summary));
  const update = db.prepare('UPDATE episodes SET embedding=?,embedding_model=? WHERE id=?');
  const model = process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
  pending.forEach((episode, i) => { if (vectors[i]) update.run(vecToBlob(vectors[i]), model, episode.id); });
  return pending.length;
}

// The retrieval step for /api/ask: embed the question, rank every embedded episode by cosine
// similarity, and return the top few with enough surrounding context (project name, evidence
// text) for the model to cite specifically rather than paraphrase vaguely.
export async function searchEpisodes(question, topK = 8) {
  const [queryVector] = await embedTexts([question]);
  const rows = db.prepare(`SELECT e.*,p.name project_name FROM episodes e LEFT JOIN projects p ON p.id=e.project_id WHERE e.embedding IS NOT NULL`).all();
  const scored = rows.map(row => ({ row, score: cosineSimilarity(queryVector, blobToVec(row.embedding)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(({ row, score }) => ({
    id: row.id,
    projectName: row.project_name || 'Unassigned',
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    summary: row.summary,
    score
  }));
}
