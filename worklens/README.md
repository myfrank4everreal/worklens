# WorkLens

WorkLens is a privacy-first, local work intelligence assistant. It tracks active Windows applications, groups activity by project, maintains tasks and reminders, produces evidence-linked daily and weekly reports, and can answer natural-language questions about your own recorded history ("what was I working on yesterday") by retrieving the specific evidence behind its answer. OpenRouter is optional and is used only for explicitly requested AI analysis: daily/weekly reviews, repository analysis, and Ask.

See `docs/PROGRESS.md` for a running log of what's been built and why, including known untested edges.

## Requirements

- Windows 10 or 11
- Node.js 22.5 or newer

## Run

```powershell
cd worklens
npm start
```

Open <http://localhost:4317>. Activity recording is off until you press **Start recording**.

## Package as a Windows desktop app

WorkLens ships as a self-contained Electron app: the server runs inside Electron's own process (no
separate Node install required on the machine you install it on), data lives in the per-user
`%APPDATA%\WorkLens` folder (so an app update never wipes your history), and it lives in the system
tray so closing the window doesn't stop recording.

```powershell
cd worklens
npm install
npm run electron:dev
```

To build a Windows installer / EXE:

```powershell
cd worklens
npm run dist
```

This produces `dist/WorkLens-Setup-<version>.exe`, a per-user NSIS installer via `electron-builder`
(no admin rights needed — it installs to `%LOCALAPPDATA%\Programs\WorkLens`). On first launch it
registers itself to start automatically when you log into Windows; toggle that off any time from
the WorkLens tray icon's **Start when I log in** checkbox. The tray icon is also how you reopen the
window, fully quit the app, or restart it.

**The desktop app's OpenRouter key lives in its own `.env`, separate from the project folder's.**
`npm start` reads the project folder's `.env` via Node's `--env-file-if-exists` flag, but the
Electron app is never launched that way, so it keeps its own copy at `%APPDATA%\WorkLens\.env`
(created empty on first launch) — use the tray icon's **Edit OpenRouter key (.env)** to open it in
Notepad, then **Restart WorkLens** for the change to take effect.

> If Electron fails with `Electron failed to install correctly`, delete `node_modules/electron` and rerun `npm install` on a machine with outbound access to the Electron download endpoint or set an alternate mirror. This is an environment-specific binary download issue, not a source-code problem in WorkLens itself.

## Install the Chrome extension

1. Keep WorkLens running.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the `chrome-extension` folder in this project.
5. Open WorkLens, copy the extension key shown under browser connection, and paste it into the extension popup.
6. Select **Connect & enable**. Chrome will show the history permission during installation because it is declared in the manifest.

The extension syncs only HTTP(S) history after you enable it. It ignores local pages, excludes sensitive domains configured in the popup, and never sends page contents, cookies, form data, or passwords.

## Smart repository analysis

Projects can be linked to a full absolute local repository path. Select **Analyze repository** to let WorkLens:

- inspect a bounded set of relevant source, documentation, and configuration files;
- inspect Git status, HEAD, and recent commit messages;
- generate evidence-backed milestones and tasks;
- mark tasks that require credentials, approvals, purchases, product decisions, or other manual intervention;
- update AI-managed task status when later repository evidence proves completion.

After the first manual analysis, WorkLens checks the repository fingerprint every minute and re-analyzes only when meaningful file or Git changes occur. `.env` files, credentials, keys, dependency folders, build output, lockfiles, binary files, and symlinks are excluded. Repository analysis uses the ZDR-protected OpenRouter route. Because browser folder pickers hide absolute filesystem paths, paste the full path into the project folder field when repository analysis is required.

To enable AI reports, copy `.env.example` to `.env`, add an OpenRouter API key, and restart. WorkLens sends summarized activity—not screenshots or keystrokes—and requests Zero Data Retention routing.

## Ask

The **Ask** view answers questions about your own tracked history — "what was I working on yesterday," "what's blocked on Project Atlas." Activity is rolled up locally into 5–20 minute episodes, embedded via OpenRouter, and retrieved by similarity when you ask a question; the model is told to answer only from the retrieved evidence and to say so plainly when it doesn't have enough. Each answer shows the specific evidence it used. Requires an OpenRouter key.

## Focus, drift, and resume briefs

Pin a project as "Focused on" from the Today view. If your live activity classifies to something else for a sustained stretch, a dismissible banner says so (mode — silent, gentle, or strict — is set in Settings). Opening a project, or having one pinned, shows a resume brief: what you last touched and the oldest open task, computed locally with no AI call.

## Milestones and tasks

A project's detail page groups tasks under their milestone, with a separate **Backlog** section
for anything not yet assigned one. Milestones collapse, show a task-progress count, and each has
its own "+ Task" button; a filter box searches milestone and task titles, a "Hide completed" toggle
declutters a mostly-done project, and any task can be moved to a different milestone (or back to
the backlog) from a select right on its row. **Export as PDF** on the project page downloads a
milestones-and-tasks brief written for an implementing agent — instructions, evidence per task, and
a manual-intervention recap — generated locally with no external service or added dependency.
**Save brief to repository** writes the same brief as `WORKLENS-BRIEF.md` directly into the
project's own repository folder (overwriting the previous version each time), so a coding agent
pointed at that folder already has it — no download or manual move needed. It also writes
`WORKLENS.md` alongside it — a short, static explainer for whichever coding agent works in that
repo, covering both ways it can report progress (see the next two sections). AI-generated tasks are
matched to their milestone case/whitespace-insensitively, with a title fallback, so a task the
analyzer clearly intended for a milestone doesn't silently end up in the backlog.

## Import a plan

**Import plan**, on a project's detail page, turns a pasted operational plan, runbook, or
step-by-step guide — the kind of multi-phase deployment or setup checklist you'd hand to a coding
agent — into real milestones and tasks, the same way repository analysis does. Paste the whole
thing into the dialog and WorkLens will: use an OpenRouter model to read the plan's own phases as
milestones and its own numbered/lettered steps as tasks (folding surrounding bullet detail into
each task's evidence field) when a key is configured; or, with no key configured (or if that call
fails), fall back to a deterministic heuristic parser — headings and "Phase N" lines become
milestones, numbered/bulleted lines become tasks — so an import never simply fails for lack of an
API key. Steps that need a human account, purchase, business/legal decision, or an external
party's approval are flagged **manual intervention required**, same as repository analysis. The
heuristic fallback can't tell an outer numbered list from a nested sub-list once a flat paste loses
its indentation, so it can over-fragment a very step-heavy plan into more/smaller tasks than the
AI path would — expected, and the reason the AI path is tried first whenever a key is configured.

## Two ways for a coding agent to report progress

**Tick a checkbox.** `WORKLENS-BRIEF.md`'s task lines are a real Markdown checklist (`- [ ]` /
`- [x]`) with a hidden `<!--wl:123-->` marker at the end of each line identifying the task. Any
agent (or person) working in that repository can tick a box — changing `- [ ]` to `- [x]` and
leaving the rest of the line untouched — and WorkLens picks it up within about a minute (it
re-reads every project's brief on the same one-minute interval it uses to check for repository
changes) and marks that task done. Unticking marks it open again the same way. This needs no setup
beyond having saved a brief into the repository at least once.

**WorkLens's MCP server**, for an agent that speaks MCP (Claude Code, Codex CLI, and Cline all do),
gives direct, immediate updates instead — no polling, no file to edit. It's a small stdio subprocess
(`src/mcp-server.js`, zero added dependencies) that talks to WorkLens's own already-running HTTP API,
so it never opens the database itself and can be started and stopped freely. It exposes:

- `list_projects` — every project's id, name, status, and progress
- `get_focused_project` — the project currently pinned as "Focused on," with its milestones/tasks/backlog
- `list_tasks` — one project's milestones, their tasks, and its backlog, by id
- `complete_task` — mark a task done, with an evidence note describing what proved it
- `add_task` — record a task WorkLens didn't already know about

Point your agent at it with WorkLens running (`npm start`, or the desktop app):

**Claude Code** — `.mcp.json` in the repository, or `claude mcp add --transport stdio worklens -- node /absolute/path/to/worklens/src/mcp-server.js`:

```json
{
  "mcpServers": {
    "worklens": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/worklens/src/mcp-server.js"]
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.worklens]
command = "node"
args = ["/absolute/path/to/worklens/src/mcp-server.js"]
```

**Cline** — `~/.cline/mcp.json` (or its settings UI):

```json
{
  "mcpServers": {
    "worklens": {
      "command": "node",
      "args": ["/absolute/path/to/worklens/src/mcp-server.js"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

If WorkLens is running on a non-default port, set `WORKLENS_PORT` in that same config's `env`. A
quick manual sanity check: `npm run mcp` starts the server and prints "WorkLens MCP server ready"
to stderr once it can reach WorkLens.

## Workstation · Engines

The **Engines** screen (Studio tools) shows every way the workstation can make a video. The two
engines sit side by side but stay visibly separate: violet for code-made films, teal for stock
footage.

- **Lemo-Opuscar** (code-made): all styles read from `styles/*/style.json`, grouped by category,
  with poster, typical uses and which of your films already use each style.
- **MoneyPrinterTurbo** (stock footage): its video types (topic → short, your script → short, your
  clips → narrated short, batch, landscape/square). It also shows whether it's installed and whether a
  Pexels/Pixabay key is set. The key itself is never sent to the page. **Start web UI** launches its
  Streamlit app on `127.0.0.1:8501` and opens it once it's healthy.
- **Making for** picks a brand; **New video** creates a Studio project tagged with engine + style.

Engine folders default to `Documents\socialmedia\AI Video Editor\lemo-opuscar` and
`…\MoneyPrinterTurbo`. To point elsewhere:
`POST /api/engines/paths {"lemo": "D:\\…\\lemo-opuscar", "mpt": "D:\\…\\MoneyPrinterTurbo"}`.

### Film library and brand videos

Finished films are found by scanning `<lemo>/films/<name>/<name>.mp4` and
`<mpt>/storage/tasks/<id>/final-*.mp4`. A lemo film's style is read from the `Style:` line at the
top of its `TREATMENT.md`. Each film card has:

- a thumbnail, duration and engine badge, plus a play link
- a **status** (idea → script → rendered → checked → posted; Posted records the date) and a **brand**
- **Run checks**: EBU R128 loudness plus black and white frame detection (ffmpeg `blackdetect`, and
  `negate,blackdetect` for white). A result of −14 ±1 LUFS with no black or white frames moves the
  film to Checked. If a film is re-rendered, its old check result is cleared.
- **Edit in Studio**: opens the film as a new Studio project for that brand

What WorkLens knows about each film is stored in the `film_library` table, keyed by the file
path. The engines' own folders are never written to. **Brands** shows a **Videos** board under
each brand's accounts, with that brand's films by status and its open Studio projects.

### Studio timeline

- Video blocks show the clip's own frames (an ffmpeg frame strip, positioned to match the trim).
  Audio blocks show a waveform of the trimmed part, scaled by volume.
- Films brought in from Lemo-Opuscar get an **Events** row from their `events.json`, showing voice
  lines and sound cues. Hover a tick to see its type and time.
- **Edit history**: each change is listed by name (Added caption, Trimmed clip…). Undo and Redo
  work with the buttons or Ctrl+Z / Ctrl+Shift+Z. Typing or dragging the same thing counts as
  one step. History resets when you switch project.
- **Guides** shades the parts of the 9:16 frame that Instagram and TikTok cover with their buttons
  and captions.

Endpoints: `GET /api/engines`, `GET /api/engines/films`,
`PATCH|POST /api/engines/films/:id[/check|/studio]`, `GET /api/engines/films/:id/{file,thumb,events}`,
`GET /api/engines/poster?slug=`, `POST /api/engines/new-project`, `POST /api/engines/mpt/start`,
`GET /api/engines/strip?path=&n=`, `GET /api/engines/peaks?path=`.

## Privacy defaults

- Recording is opt-in and visibly indicated.
- No keystrokes, clipboard contents, screenshots, passwords, or page bodies are captured.
- Data stays in `data/worklens.db` (not encrypted at rest — see `docs/PROGRESS.md`).
- Window titles matching sensitive terms are redacted; the term list is editable in Settings.
- Repository analysis redacts likely secrets (API keys, tokens) from file content before sending it, in addition to skipping obviously sensitive filenames.
- Activity can be paused instantly, and any activity's project can be corrected from the Timeline.
- AI calls happen only when explicitly triggered (AI review, weekly review, Ask, repository analysis) or, for episode embedding, in small background batches — never a raw activity stream.
- Your data isn't locked in: Settings → Export gives JSON, CSV, and a Markdown report.

## MVP limitations

- Chrome activity is imported from the local extension; Firefox, Edge, and Safari are not yet supported.
- Project classification uses user-defined keywords with a manual correction control (Timeline); it does not yet learn from corrections.
- The Windows tray app isn't code-signed, so Windows SmartScreen will show an "unrecognized publisher" prompt on first install until a code-signing certificate is added.
- `data/worklens.db` is not encrypted at rest.
