import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Packaged (Electron) runs point this at app.getPath('userData') so the database survives
// app updates instead of living inside the (replaceable) install directory; `npm start` from
// source keeps the old ./data behavior.
export const dataDir = path.resolve(process.env.WORKLENS_DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'worklens.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#7c5cff',
    keywords TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY,
    captured_at TEXT NOT NULL,
    app_name TEXT NOT NULL,
    window_title TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'windows'
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    due_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    remind_at TEXT NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS activities_source_event
    ON activities(source, captured_at, window_title);
  CREATE TABLE IF NOT EXISTS milestones (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'todo',
    evidence TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    operation TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    secure INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'success'
  );
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    embedding BLOB,
    embedding_model TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS episodes_started_at ON episodes(started_at);
  CREATE INDEX IF NOT EXISTS episodes_project ON episodes(project_id);
  -- Workstation · Brands: brand workspaces, their social accounts, and one row per day an
  -- account was posted on. A day-log rather than a single "last posted" column, so history
  -- (streaks, "what did I post this week") is answerable later.
  CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#FF6B35',
    description TEXT NOT NULL DEFAULT '',
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS brand_accounts (
    id INTEGER PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    link TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS brand_posts (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES brand_accounts(id) ON DELETE CASCADE,
    posted_on TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, posted_on)
  );
  CREATE INDEX IF NOT EXISTS brand_accounts_brand ON brand_accounts(brand_id);
  CREATE INDEX IF NOT EXISTS brand_posts_account_day ON brand_posts(account_id, posted_on);
  -- Workstation · Voice and media engine. Files themselves live under <dataDir>/media; these rows
  -- record what was made, from what, and for whom.
  CREATE TABLE IF NOT EXISTS voice_profiles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    engine TEXT NOT NULL DEFAULT 'kokoro',
    voice TEXT NOT NULL,
    speed REAL NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS voice_clips (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER REFERENCES voice_profiles(id) ON DELETE SET NULL,
    voice TEXT NOT NULL,
    speed REAL NOT NULL DEFAULT 1,
    text TEXT NOT NULL,
    file TEXT NOT NULL,
    seconds REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS media_renders (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    file TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    timeline TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS studio_projects (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    timeline TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

for (const statement of [
  "ALTER TABLE voice_profiles ADD COLUMN model TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE voice_clips ADD COLUMN engine TEXT NOT NULL DEFAULT 'kokoro'",
  "ALTER TABLE studio_projects ADD COLUMN brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL",
  "ALTER TABLE projects ADD COLUMN root_path TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE projects ADD COLUMN progress_note TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE projects ADD COLUMN auto_analyze INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE projects ADD COLUMN repo_fingerprint TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE projects ADD COLUMN last_analysis_at TEXT",
  "ALTER TABLE tasks ADD COLUMN manual_intervention INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  "ALTER TABLE tasks ADD COLUMN evidence TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE tasks ADD COLUMN external_key TEXT",
  "ALTER TABLE tasks ADD COLUMN milestone_key TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE milestones ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  "ALTER TABLE milestones ADD COLUMN external_key TEXT",
  "ALTER TABLE tasks ADD COLUMN milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL"
]) {
  try { db.exec(statement); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_external_key ON tasks(project_id, external_key) WHERE external_key IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS milestones_project_external_key ON milestones(project_id, external_key) WHERE external_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS tasks_milestone_id ON tasks(milestone_id);
`);
// Backfill: earlier builds only linked an AI-synced task to its milestone through matching
// text keys (tasks.milestone_key === milestones.external_key). Manually-created milestones
// never had an external_key, so they could never receive a task through that match, and any
// task without a milestone_key was invisible in the project-detail grouping. milestone_id is
// now the single source of truth; this fills it once from whatever the old key match implies,
// and is a no-op on every subsequent boot once every row already has it resolved.
db.exec(`
  UPDATE tasks SET milestone_id = (
    SELECT m.id FROM milestones m WHERE m.project_id = tasks.project_id AND m.external_key = tasks.milestone_key
  )
  WHERE milestone_id IS NULL AND milestone_key != '' AND EXISTS (
    SELECT 1 FROM milestones m WHERE m.project_id = tasks.project_id AND m.external_key = tasks.milestone_key
  );
`);
// Repair pass: the exact-match backfill above still leaves a task in the backlog whenever the
// model didn't reproduce its milestone's key byte-for-byte the same way twice (case, whitespace)
// or wrote the milestone's title where its key belonged — both real, observed LLM slips, not
// hypothetical. Retry the same link with a looser comparison. Also a no-op once resolved.
db.exec(`
  UPDATE tasks SET milestone_id = (
    SELECT m.id FROM milestones m
    WHERE m.project_id = tasks.project_id AND m.external_key IS NOT NULL
      AND trim(m.external_key) = trim(tasks.milestone_key) COLLATE NOCASE
    LIMIT 1
  )
  WHERE milestone_id IS NULL AND milestone_key != '' AND EXISTS (
    SELECT 1 FROM milestones m WHERE m.project_id = tasks.project_id AND m.external_key IS NOT NULL
      AND trim(m.external_key) = trim(tasks.milestone_key) COLLATE NOCASE
  );
  UPDATE tasks SET milestone_id = (
    SELECT m.id FROM milestones m
    WHERE m.project_id = tasks.project_id AND trim(m.title) = trim(tasks.milestone_key) COLLATE NOCASE
    LIMIT 1
  )
  WHERE milestone_id IS NULL AND milestone_key != '' AND EXISTS (
    SELECT 1 FROM milestones m WHERE m.project_id = tasks.project_id AND trim(m.title) = trim(tasks.milestone_key) COLLATE NOCASE
  );
`);

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');

export function getSetting(key, fallback = null) {
  return getSettingStmt.get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}
