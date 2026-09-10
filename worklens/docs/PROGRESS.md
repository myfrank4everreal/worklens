# WorkLens implementation progress

Running log of what's been implemented against the Aug 30 2026 build audit, in the order it
was done. Newest entry on top. Each entry names the files touched so a diff is easy to find.

Source of the plan: the "WorkLens Build Audit" artifact (capability mapping + roadmap) referenced
from this session's project memory.

---

## 2026-09-06 — Added: import a pasted plan, a shared WORKLENS.md convention, and an MCP server for agents to report progress

**Files touched:** `src/plan-parser.js` (new), `src/mcp-server.js` (new), `src/openrouter.js`,
`src/server.js`, `public/app.js`, `package.json`, `README.md`.

**Why:** the ask was for WorkLens to turn an operational runbook (the kind of multi-phase
deployment guide you'd hand a coding agent) into real milestones/tasks, and to make WorkLens
"intelligent enough to know when a task is currently being worked on by any agent" and update
progress automatically. A pure activity-heuristic ("if the agent touched these files, mark this
task done") was rejected as untrustworthy — it can't distinguish attempting a step from completing
it, especially for manual-intervention steps (buying a plan, approving an app review) that leave no
file trace at all. What shipped instead is three real mechanisms, in increasing order of
directness, so a task only ever gets marked done because something — a person, or an agent that was
told to — actually said so:

1. **Import a plan** (`POST /api/projects/:id/import-plan`, "Import plan" button in project
   detail). Paste any plan; `extractPlanFromText()` (openrouter.js) asks a model to read the plan's
   own phases as milestones and its own numbered/lettered steps as tasks, folding surrounding
   bullet detail into each task's `evidence` field, and to flag `manualIntervention` for anything
   needing a human account/purchase/decision/approval — same shape and same manual-intervention
   judgment repository analysis already uses. With no OpenRouter key configured, or if that call
   fails, `parsePlainTextPlan()` (`src/plan-parser.js`, new) is a deterministic regex/heading-driven
   fallback: headings and "Phase N" lines become milestones, numbered/bulleted lines become tasks,
   fenced code and other prose folds into the current task's evidence. **Known, accepted
   limitation:** the fallback can't tell an outer numbered list from a nested numbered sub-list once
   indentation is lost in a flat plain-text paste, so it over-fragments such input into more/smaller
   tasks than a human (or the AI path) would — verified directly against the actual ~19KB
   brandvideo-automator runbook this feature was built for: the AI path would read its "Phase N:"
   headings as milestones and its lettered sub-steps as tasks, while the heuristic fallback (no key
   configured in this sandbox to test the AI path live) produced 15 milestones (correctly, one per
   phase) but 210 tasks — every bullet line became its own task rather than folding into the
   preceding one's evidence, exactly the documented limitation. Acceptable because this is
   explicitly the fallback, tried only when the AI path isn't available. The import path reuses the
   same upsert logic as AI repository analysis (refactored into a shared `upsertPlanItems()` in
   server.js, with `syncProjectPlan()`/`importPlan()` as thin wrappers with different caps and
   `source` tags — 8 milestones/30 tasks and no `projects` row side effects for AI repo analysis,
   unchanged; 60 milestones/400 tasks and no `repo_fingerprint`/`last_analysis_at` writes for an
   import, since a pasted plan isn't repository evidence and an import shouldn't look like a repo
   analysis just ran).

2. **A shared `WORKLENS.md` convention.** Every "Save brief to repository" now also writes a static
   `WORKLENS.md` next to `WORKLENS-BRIEF.md`, explaining to whichever coding agent is working in
   that repo — Claude Code, Codex, Cline, or a person — how to read the current plan and report
   progress on it, and stating the judgment call explicitly: only mark a task done for work actually
   completed, and leave manual-intervention tasks open rather than assuming someone else handled
   them.

3. **Two-way checklist sync.** `briefToMarkdown()`'s task lines now end with a hidden
   `<!--wl:ID-->` HTML comment — invisible when rendered, but an exact (not fuzzy/title-based)
   anchor back to the task row. A new `syncBriefCheckboxes()`/`syncAllChecklists()`, on the same
   60-second interval as repository-change checking (for every project with a `root_path`,
   regardless of `auto_analyze` — checklist sync costs no AI call, so there's no reason to gate it
   the same way repo re-analysis is), re-reads each project's `WORKLENS-BRIEF.md` and applies any
   ticked/unticked box back to the real task, matched by that marker. `PATCH /api/tasks/:id` now
   also accepts an `evidence` field (only touched when supplied, so a plain checkbox toggle is
   unaffected).

4. **`src/mcp-server.js`** (new, zero added dependencies): a hand-rolled MCP server over stdio
   (newline-delimited JSON-RPC 2.0, confirmed against the official MCP spec — not
   Content-Length/LSP-style framing), for an agent that speaks MCP directly instead of editing a
   file. It never opens `worklens.db` itself — it calls WorkLens's own already-running HTTP API (so
   exactly one process ever touches the database, and the MCP server can be started/stopped freely
   without a lock conflict or a stale read), setting an `Origin` header to satisfy `trustedOrigin()`
   the same way any other local, user-spawned process would need to. Exposes `list_projects`,
   `get_focused_project`, `list_tasks`, `complete_task` (with an evidence note), and `add_task`.
   `npm run mcp` runs it standalone for a quick manual check. README.md documents the exact config
   for Claude Code (`.mcp.json` / `claude mcp add`), Codex CLI (`~/.codex/config.toml`), and Cline
   (`~/.cline/mcp.json`) — all three confirmed against each project's current docs via web fetch
   during design, not assumed from memory.

**What this deliberately does NOT do, and why:** there is no official listing of WorkLens as an
installable integration inside Claude Code's or Codex's own marketplace/plugin UI — that requires
each platform's own submission process, which is outside what building WorkLens itself can produce.
What's shipped is the piece that actually matters for the stated goal — a real MCP server the user
can point any of those three agents at today via their existing "add a custom MCP server" config —
documented plainly as exactly that, not oversold as a one-click marketplace install.

**Tested:** `npm run check` (now includes `plan-parser.js` and `mcp-server.js`) passes. Ran a full
scripted end-to-end test in this sandbox — spun up a scratch `server.js` instance (disposable
sqlite db, real HTTP server, no mocks) and drove `src/mcp-server.js` as a real child process over
stdin/stdout through `initialize` → `notifications/initialized` → `tools/list` → `tools/call` for
every tool (`list_projects`, `get_focused_project`, `list_tasks`, `add_task`, `complete_task`, plus
an unknown-tool error path), confirming each response against the database afterward, not just the
JSON-RPC envelope. Separately tested `import-plan` end-to-end against that same kind of scratch
server: posted a sample multi-phase plan with no `OPENROUTER_API_KEY` set (confirming the automatic
fallback to `parsePlainTextPlan()`, `usedAi:false`), confirmed the manual-intervention step was
flagged, called `save-brief` and confirmed both `WORKLENS-BRIEF.md` and `WORKLENS.md` were written,
hand-ticked one task's checkbox in the brief exactly as a person or agent would, and waited a real
minute-plus for `syncAllChecklists()`'s own interval to pick it up and flip that task to `done` in
the database — not simulated, the actual 60-second `setInterval` in `server.js` firing for real.
Also ran `parsePlainTextPlan()` against the actual pasted brandvideo-automator text (recovered from
this session's own transcript) to confirm the documented over-fragmentation limitation above with
real numbers rather than a guess. **Not tested, and can't be from this sandbox:** `extractPlanFromText()`
against a live OpenRouter call (this sandbox has no network path to openrouter.ai — same standing
limitation as every other AI call in this project) — the fallback path was tested instead, which is
what will actually run in this sandbox and was the more important thing to get right; and no run of
this MCP server through a real Claude Code / Codex / Cline client (only a scripted harness driving
the same JSON-RPC methods those clients use). **The first real test of both of those is on your
machine**: import your actual plan with your OpenRouter key configured to see the AI path, and
point Claude Code or Codex at `src/mcp-server.js` per the README to exercise it from a real agent.

---

## 2026-09-06 — Fixed: the desktop app never loaded `.env`, so the OpenRouter key was invisible to it

**Files touched:** `electron/main.js`, `README.md`.

**The bug, and why it's exactly the error you saw:** `npm start` gets `OPENROUTER_API_KEY` from
Node's own `--env-file-if-exists=.env` CLI flag — but the Electron app is never launched that way
(dev: `electron .`; packaged: double-clicking `WorkLens.exe` or the login-item autostart), so
nothing in `electron/main.js` was ever loading a `.env` file at all. The server code itself was
fine; the desktop build just never handed it a key, no matter what you put in the project folder's
`.env` — which is exactly "OpenRouter is not configured. Add OPENROUTER_API_KEY to .env to use
Ask" from the desktop version specifically.

Fixed by having `electron/main.js` load its own `.env` before starting the server, using Node's
built-in `process.loadEnvFile()` (no dependency added). It lives at `%APPDATA%\WorkLens\.env` — the
same per-user, update-safe location as the data folder, and deliberately separate from the project
folder's `.env` (that one still only matters for `npm start`). A first launch creates it empty with
a comment pointing at https://openrouter.ai/keys, so there's something to edit immediately rather
than a file that has to be created by hand in a folder most people never look in. Added two tray
menu items: **Edit OpenRouter key (.env)** (opens it in Notepad — `.env` has no default Windows
file association, so a plain "open" would otherwise prompt "how do you want to open this file") and
**Restart WorkLens** (`app.relaunch()` + `app.exit()`), since a `.env` edit needs a fresh process to
be picked up and the previous build had no in-app way to do either.

**Tested:** `node --check electron/main.js`. This sandbox cannot install `electron` itself (the npm
registry blocks that specific package here), so the Electron runtime paths could not be exercised
end-to-end from this session — but this change only adds a `fs.existsSync`/`fs.writeFileSync`/
`process.loadEnvFile` call ahead of the existing, already-verified `startServer()` path from the
Aug 31 packaging entry below; nothing about process startup, `node:sqlite`, or module resolution
changes. **The first real run of this fix is on your machine**: run `npm run dist` (or
`npm run electron:dev` to check faster) to rebuild with the fix, launch WorkLens, use the tray's
**Edit OpenRouter key (.env)** to add your key, then **Restart WorkLens** and confirm **Ask** stops
reporting "OpenRouter is not configured."

---

## 2026-08-31 — Real Windows packaging: self-contained EXE, tray, login autostart

**Files touched:** `package.json`, `electron/main.js` (rewritten), `src/db.js`, `src/server.js`,
`README.md`, `build/icon.ico` + `electron/assets/*.png` (new, generated placeholder art).

The previous session's Electron scaffold (`electron/main.js` spawning a separate `node` binary,
`"files": ["**/*"]`) looked complete but had three problems that would have surfaced the moment
anyone actually ran `npm run dist`, none of them caught before now because that session had no
Windows machine or network access to try it. This session does, so all three got fixed and then
verified for real, not just read for plausibility:

1. **Not actually self-contained.** Spawning `node` assumed the *end user's* machine has Node
   22.5+ on PATH — the opposite of "just open the exe." Fixed by running `src/server.js` inside
   Electron's own main process instead (`electron/main.js`'s `startServer()`, via dynamic
   `import()`), after bumping Electron from 27.2.0 (bundles Node 18, too old for `node:sqlite`) to
   37.10.3 (bundles Node 22.16, which as of this session is what shipped in this repo's
   `package-lock.json` — that pin only matters because of point 2 below).
2. **`"files": ["**/*"]` would have shipped `.env` (a live OpenRouter key) and `data/worklens.db`
   (real activity history) inside the installer.** Replaced with an explicit allowlist
   (`electron/`, `src/`, `public/`, `package.json`). Verified by inspecting
   `dist/win-unpacked/resources/app` after a real build — exactly those four things and nothing
   else.
3. **No autostart/tray at all**, so the app would quit the moment its one window closed —
   unworkable for something meant to track activity all day. Added a tray icon (`Tray`/`Menu`),
   closing the window now hides it instead of quitting, `app.setLoginItemSettings` registers the
   app to start at login on first packaged launch (once, via a marker file in `userData` — so a
   user unchecking it later isn't fought on the next launch), and `app.requestSingleInstanceLock()`
   stops a login-triggered start from racing a manual double-click into two servers on one port/DB.

**Also fixed while getting a real build to run, none of it visible from reading the code alone:**
- `src/db.js`'s data directory is now `WORKLENS_DATA_DIR` (set by Electron to
  `app.getPath('userData')`) instead of cwd-relative `./data` — otherwise an NSIS update, which
  replaces the install directory's contents, would have wiped a user's activity history.
- `asar` packing is **disabled** (`"asar": false`). Electron's ESM loader turned out not to
  populate `require('electron')`'s exports correctly in this environment when the main entry runs
  from inside an asar archive (a real, reproducible failure here, not a theoretical one — see the
  ESM note below), and separately `collector.ps1`/`folder-picker.ps1` are spawned as real
  `powershell.exe` processes that can't read into an asar archive at all. Unpacking sidesteps both.
- **`import { app } from 'electron'` silently resolves to an empty object** in this Electron
  version's ESM main process — not a typo, a reproducible interop gap (Electron's `electron`
  module is a native hook with no real analyzable source, so Node's CJS/ESM interop can't detect
  its named exports). Fixed with `createRequire(import.meta.url)('electron')`, which goes through
  Electron's real module-load hook instead of the ESM loader's static analysis.
- **Startup race**: `import()`-ing `server.js` only runs its top-level code, which calls
  `server.listen()` without waiting for the socket to actually bind — so the first `loadURL` could
  race a not-yet-listening server and flash Chromium's built-in error page before self-healing a
  moment later. Fixed by polling the port before the window's first load
  (`pingServer()`/`startServer()`'s retry loop) and giving `createWindow()` its own bounded retry
  loop as a second line of defense; verified by launching the actual packaged EXE and polling its
  window title every 300ms through startup with zero "Error" titles observed, versus a reliably
  reproducible one before the fix.
- **`server.listen()` had no `'error'` handler** — if the port's ever genuinely taken (e.g. someone
  runs `npm start` and the packaged app at the same time), the server would fail to bind with no
  clear signal. `src/server.js` now logs a clear message, and `electron/main.js` shows a real
  `dialog.showErrorBox` and quits cleanly instead of silently showing a blank or borrowed page if
  its own server never comes up within a generous 20s budget.
- The npm-packaged `electron` binary's own installer (`@electron/get` + `extract-zip`) hit two
  separate, unrelated failures in this environment: the ~130MB GitHub-hosted zip kept resetting
  mid-download (worked around with a resumable `curl --retry`, manually placed into
  `@electron/get`'s cache path — the retry also surfaced that `^37.5.1` had already floated to
  `37.10.3`, so both `electron` and `electron-builder` are now pinned to exact versions to keep
  this reproducible), and `extract-zip` silently hung after the first file on this machine
  (worked around with PowerShell's native `Expand-Archive`, which extracted cleanly). Neither is a
  WorkLens code issue, but anyone rerunning `npm install` from scratch on a similarly flaky
  connection may hit the first one again.
- `electron-builder`'s `win.publisherName` isn't a valid schema property in electron-builder 26.x
  (it was silently accepted by config validation as "additionalProperties: false" territory,
  producing a useless top-level `configuration.win should be one of these:\n  null` error with no
  indication of which property was the problem). Removed; `package.json` gained a real `"author"`
  field instead, which is what electron-builder actually reads for NSIS metadata now.
- Generated placeholder icon art (`build/icon.ico`, `electron/assets/*.png`) purely in Node
  (`zlib.deflateSync` + a hand-written PNG/ICO writer, no image library) since the repo had no icon
  assets at all — a real brand icon is a cosmetic follow-up, not a blocker.

**Verified for real on this machine, not just by reading the code:**
`npm install` (electron 37.10.3 + electron-builder 26.15.3, with the manual cache workaround
above), `npm run electron:dev` (SQLite loaded inside Electron's Node, HTTP server bound and served
the real app on both the default and isolated test ports), `npm run dist` (produced
`dist/WorkLens-Setup-0.1.0.exe`, ~92MB, containing only the intended files), running that installer
for real — it installed to `%LOCALAPPDATA%\Programs\worklens`, launched automatically, opened a
window titled "WorkLens" with zero error-page flashes across a 300ms-resolution poll through
startup, registered `HKCU\...\Run\electron.app.WorkLens`, and the tray/login-item/close-to-tray/
single-instance-lock code paths all ran without throwing. Not independently re-verified after the
final round of fixes: the tray's "Start when I log in" checkbox actually toggling the registry key
off (the registration-on path was exercised directly; the toggle handler itself is simple enough
that it wasn't re-clicked through the UI this session).

**Known, deliberately unaddressed:** the installer isn't code-signed (Windows SmartScreen will
warn on first run — noted in `README.md`); a port collision with something else already using
`WORKLENS_PORT` that also happens to answer HTTP (rather than refusing the connection outright)
isn't distinguishable from the packaged app's own server by the current health check, so on a
dev machine already running `npm start` on the same default port, the packaged app's window would
silently show that other server's content instead of its own or erroring — not a concern for a
real end user, who would only ever have the one installed copy, but worth knowing if testing both
side by side.

---

## 2026-08-30 — Added desktop packaging scaffold for Windows

**Files touched:** `package.json`, `electron/main.js`, `README.md`.

Added the first desktop-packaging pass: a lightweight Electron wrapper that starts the existing
Node server and opens a desktop window pointing at `http://localhost:4317`. `package.json` now
includes an `electron:dev` script for launching the desktop app during development and a
`dist` script for building a Windows NSIS installer through `electron-builder`.

This is the packaging foundation for running WorkLens as a standalone Windows app, but a clean
Electron binary download is still required in the environment that is building it. The current
machine shows the common `Electron failed to install correctly` issue when the runtime is missing
or the download is blocked, so packaging completion is environment-dependent rather than a
WorkLens-source bug. The build config itself is in place and ready for a normal Windows host with
working outbound access to Electron's binary mirrors.

---

## 2026-08-30 — Fixed AI tasks landing in the backlog; save the brief straight into the repo

**Files touched:** `src/db.js` (repair pass for already-mis-sorted tasks), `src/server.js`
(`syncProjectPlan` matching, `buildProjectBrief`/`briefToPdfBlocks`/`briefToMarkdown` extracted,
new `POST /api/projects/:id/save-brief`), `public/app.js` ("Save brief to repository" button).

**The bug:** a task the repository analyzer generates is supposed to carry a `milestoneKey`
matching the milestone it belongs to (`{"milestoneKey":"auth-setup", ...}`, matched against that
milestone's own `key`) — that's how `syncProjectPlan` decides which milestone a new AI task
belongs to, versus the backlog. The match was exact-string, and a model asked to "reuse the same
stable key" across two separate JSON fields doesn't always reproduce it identically — different
casing, stray whitespace, or (worse) writing the milestone's *title* into the `milestoneKey` field
instead of its slug. Any of those meant the lookup missed, `milestone_id` stayed null, and a task
the model clearly intended for a specific milestone landed in the backlog instead, indistinguishable
from a task that was genuinely unassigned.

Fixed on both ends: `syncProjectPlan`'s milestone lookup is now case/whitespace-insensitive
(`trim(...) = trim(...) COLLATE NOCASE`), and falls back to matching the milestone's *title* if the
key itself doesn't match anything — covering the "wrote the title, not the key" slip specifically.
Verified against a set of constructed cases that reproduce each failure mode (exact match, a
case/whitespace-mangled key, title-instead-of-key, a genuinely unmatched key, and a deliberately
empty one for a real backlog task) — all five resolved correctly, and re-running the same plan a
second time (simulating a re-analysis) confirmed no duplicate milestones or tasks get created.
`src/db.js` also got a one-time repair pass using the same looser match, so a task that's *already*
sitting in your backlog from an earlier, stricter sync gets reattached to its milestone the next
time WorkLens starts — no need to re-run repository analysis just to fix already-existing data.
This can't fully guarantee every future AI response resolves correctly (an LLM can still reference
a milestone key that plainly doesn't exist, or genuinely mean for a task to be unassigned), but it
now survives every failure mode actually observed. Either way, the inline milestone-reassignment
select added in the previous session's UI (right there on every backlog row) is still the fast
manual fix for whatever slips through.

**Save the brief into the repository, not just download it:** WorkLens runs on your own machine
with full filesystem access, so a "Save brief to repository" button next to "Export as PDF" on the
project page now writes `WORKLENS-BRIEF.md` directly into the project's configured repository
folder (its `root_path`) — no browser download step, no moving a file into place by hand. Opening
that folder in an editor, or pointing a coding agent at it, means the brief is just already there.
It overwrites the previous version each time so re-clicking after a repository review keeps it
current. Clear, specific errors if the project has no repository path set, the path no longer
exists, or isn't a directory. The PDF and this Markdown export now share one `buildProjectBrief()`
data builder (added while making this change) so the two formats can't drift out of sync with each
other over time.

**Tested:** the matching fix was verified by replicating `syncProjectPlan`'s exact SQL against a
scratch project with constructed mismatched-key test data (couldn't use a real OpenRouter response
— no network path to it from this session, as throughout this project) — all five scenarios above
passed, plus the re-sync-doesn't-duplicate check. The repair pass was verified the same way against
an inserted "already mis-sorted" task. `save-brief` was exercised with curl end-to-end: no
repository path configured (400, clear message), a path that doesn't exist (400), and a real
existing folder (200, file written, content correct, re-running overwrites cleanly) — plus a
Playwright pass clicking the actual button in the browser for both the success and error paths,
confirming the toast text and that the button re-enables itself either way. The refactored PDF
route was re-verified with `qpdf --check` and `pdftotext` after the extraction to confirm it still
produces identical output. Re-ran the full milestones/tasks UI suite and the responsive-overflow
sweep from the previous two entries — both still pass with zero regressions.

## 2026-08-30 — Project page: fixed a sitewide layout overflow, made it fluid

**Files touched:** `public/milestones.css`, `public/app.js` (title tooltips on truncated text).

Asked to make the project page responsive and contained, not overflowing. It was overflowing —
badly: at every width tested, including plain desktop 1440px, the project detail page's content
extended up to ~1100px past the actual viewport edge, producing a horizontal scrollbar on the
whole document. The root cause wasn't specific to anything just built: it's a classic CSS Grid
"blowout." A grid or flex item defaults to `min-width: auto`, meaning the browser won't shrink a
column below its content's natural, unwrapped width. `.detail-layout` (the project page's
milestones/manual-intervention two-column grid) has no descendant that looks obviously wrong in
isolation — no single element was reported as overflowing — but stacked together (task titles,
long milestone titles, a native `<select>`'s widest option) the *sum* of both columns' natural
minimum widths exceeded the page, so the grid container grew past its own box instead of letting
either column shrink. Verified this by removing pieces of the DOM one at a time in a headless
browser and watching `scrollWidth` versus the rendered width at each step; the fix — setting
`min-width: 0` on a grid/flex container's direct children, the standard, documented remedy for
this exact bug — took `.detail-layout`'s internal overflow from 839px to 0 in the same test.

The same missing `min-width: 0` turned out to affect `.grid` (Today view), `.project-grid`
(Projects), `.stats`, and `.hero` too — same pattern, same fix, applied once in
`public/milestones.css` since it's a single shared rule (`.grid>*,.stats>*,.project-grid>*,
.detail-layout>*,.hero>*{min-width:0}`). Also fixed along the way: the mobile (`≤620px`)
milestone-header rule was dead CSS — it referenced `grid-template-areas` names that no child
element was ever assigned (`grid-area`), so on a phone the 5-column desktop grid just stayed
5 columns as-is. Replaced it with a wrapping flex row (the heading gets `flex-basis:100%`, which
forces it onto its own line) — verified layout is correct at 375px via an element-level
screenshot. Added `overflow-x:hidden` on `main` as a backstop, `overflow-wrap:break-word` on the
project name/milestone heading, and `title=` tooltips on the task-title, milestone-title-select,
and repository-path spots that were already truncating with an ellipsis (pre-existing pattern,
now actually reachable now that the columns are properly bounded instead of just spilling wide).

**Tested:** a headless-browser sweep across all seven views (Today, Projects, Tasks, Timeline,
Ask, Model activity, Settings) plus Project detail, at 320/375/480/768/1024/1440px, measuring
`document.documentElement.scrollWidth - clientWidth` — every cell was non-zero (up to 1162px of
overflow) before this fix and exactly 0 after, at every width, on every view. Re-ran the full
milestones/tasks Playwright suite from the previous entry (collapse, filter, hide-completed, add
task from a milestone and from the backlog, inline reassignment, add milestone) against the fixed
CSS — all still pass with zero console errors. Screenshots reviewed at 375/768/1440px, plus a
tight element-level screenshot of the mobile milestone header to confirm the wrap layout reads
cleanly rather than just "technically not overflowing."

## 2026-08-30 — Milestones and tasks: reorganized project detail, PDF export for an implementing agent

**Files touched:** `src/db.js` (`tasks.milestone_id` column + one-time backfill), `src/server.js`
(`syncProjectPlan`, `POST/PATCH /api/tasks`, new `GET /api/projects/:id/brief.pdf`), `src/pdf.js`
(new, dependency-free PDF writer), `public/app.js` (`renderProjectDetail` rewritten,
`detailTaskRow`, `applyDetailFilter`, `modal` context param), `public/milestones.css` (new),
`public/index.html` (stylesheet link).

**The bug this fixes:** milestones and tasks were only ever linked by matching text
(`tasks.milestone_key === milestones.external_key`), a key the repository analyzer sets on
AI-generated milestones but manual "Add milestone" never did. Practically: a milestone you added
by hand could never receive a task through the UI — there was no way to point a task at it — and
any task without a `milestone_key` (every manually-created task, ever) was invisible in the
project detail page entirely; it only showed up in the global Tasks list. `tasks` now has a real
`milestone_id` foreign key, `src/db.js` backfills it once from whatever the old key match implies
(verified against a copy of the real database: all 86 existing tasks resolved correctly, 0
mismatches), and it's the only thing the UI groups by from here on. `milestone_key`/`external_key`
still exist and are still written by `syncProjectPlan`, but only so a later AI re-analysis can find
the same milestone/task rows to update — the grouping itself no longer depends on them.

**What's new on the project detail page:**
- **A visible backlog.** Tasks with no milestone now show in their own "Backlog" section instead
  of disappearing from the page.
- **Collapsible milestones**, defaulting open while in progress and collapsed once done (your own
  toggles after that are remembered — a periodic dashboard refresh won't silently re-expand or
  re-collapse anything you set).
- **Per-milestone progress** (`n/m` tasks done) next to each milestone's title.
- **Scoped "+ Task" buttons** — one on each milestone, one on the backlog — that open the task
  modal with the project (and milestone) already selected, instead of making you find the project
  again in a dropdown from the global Tasks view.
- **A filter/search box** over milestone and task titles, plus a "Hide completed" toggle. Typing
  filters the already-rendered list in place (nothing is rebuilt mid-keystroke, so the input never
  loses focus or cursor position), and a milestone stays visible if either its own title matches or
  any task under it does.
- **Inline milestone reassignment** — every task row (milestone or backlog) has a small select to
  move it to a different milestone or back to the backlog on the spot, no modal needed.
- **"+ Milestone"** button in the section header, scoped to this project.

**PDF export, for an agent to implement from:** a new "Export as PDF" link on the project page
downloads `GET /api/projects/:id/brief.pdf` — the project's milestones (in order, with their
completion evidence), each one's tasks (checkbox state, evidence, a MANUAL INTERVENTION REQUIRED
flag), the backlog, and a dedicated "Manual intervention required" section so those are easy to
see in one place without reading every milestone. It opens with an explicit paragraph addressed to
"the implementing agent": work the milestones in order, treat each task's evidence line as its
acceptance criterion, don't attempt anything flagged manual-intervention, and treat the document as
a snapshot to verify against the live repository rather than ground truth. No PDF library was
added — `src/pdf.js` hand-writes the (small) PDF object/xref/trailer structure using only the
built-in Courier base-14 font, which needs no embedding and is fixed-pitch, so line-wrapping is
exact character-count math instead of a font-metrics table. Kept dependency-free deliberately,
consistent with the rest of the app, and because this session had no way to verify an `npm install`
actually succeeds on your machine.

**Tested:** `node --check` on every changed file; the migration and backfill ran against a copy of
the real database (86/86 existing tasks resolved a `milestone_id` with zero mismatches); every
changed/new endpoint exercised with `curl` against that same copy, including the CSRF block, a
cross-project milestone assignment correctly rejected with 400, and a same-project reassignment
that stuck; the generated PDF was checked with `qpdf --check` (clean) and its extracted text
(`pdftotext`) reviewed by hand for correct structure across a genuinely multi-page (7-page) test
document and the real project data. A dedicated Playwright pass drove the actual UI: collapsing a
milestone, filtering by text (confirming the right milestones stay visible and the input keeps
focus while typing), toggling hide-completed, adding a task from a milestone's own button and from
the backlog's, reassigning a backlog task onto a milestone via the inline select and confirming it
left the backlog, and adding a milestone from the section header — all with zero console or page
errors, plus the existing full-app smoke test and a check of the unrelated Today/Tasks views
re-run to confirm `taskRow` (used there, left untouched) still renders correctly. Screenshots were
reviewed by hand.

## 2026-08-30 — Phase 2 & 3: conversational interface, resume briefs, weekly review

**Files touched:** `src/db.js` (new `episodes` table), `src/episodes.js` (new),
`src/openrouter.js` (`embedTexts`, `answerFromEvidence`, `reviewWeek`), `src/server.js`
(`/api/ask`, `/api/weekly-review`, resume-brief fields on each project, a 5-minute
rollup/embedding timer), `public/app.js` (Ask view, resume brief rendering), `public/index.html`
(Ask nav + view, already added in Phase 1's markup pass).

This was the biggest gap the audit found — the plan's whole "ask it what you worked on" section
had no implementation at all. What's here now:

- **Episodes** (`src/episodes.js`) — raw 15-second activity rows are too granular to embed or hand
  to a model one at a time, so `rollupEpisodes()` merges consecutive same-project activity into
  5–20 minute chunks with a short text summary (apps + distinct window titles), purely in local
  SQL/JS, no model call. It only processes activity older than 6 minutes, so it never cuts an
  episode that's still growing. Runs every 5 minutes and opportunistically before every `/api/ask`
  and `/api/weekly-review` call.
- **Embeddings** (`embedPendingEpisodes`) — episodes without a vector yet get embedded via
  OpenRouter in bounded batches (100 on the timer, 40 inline before answering a question) and
  stored as raw `Float32Array` BLOBs — no vector-database dependency, since a personal history is
  small enough that brute-force cosine similarity over every embedded episode (`searchEpisodes`)
  is fast enough in plain JS.
- **`/api/ask`** — embeds the question, ranks episodes by cosine similarity, builds a numbered
  evidence list (project, time range, summary) from the top matches, and asks a reasoning model to
  answer using *only* that evidence, citing it by number. The response includes the evidence list
  itself so the UI can show exactly what the answer was built from — the same "cite the source"
  discipline the repository analyzer already followed. If OpenRouter isn't configured, or there's
  no evidence yet, it says so plainly instead of guessing.
- **Ask view** — a chat-style UI (`public/app.js`, `#ask` section) with message bubbles and an
  evidence list under each answer.
- **Resume brief** — heuristic, no model call: each project now carries its most recent non-idle
  activity and its oldest open task, and both the Today view (for whichever project you've pinned
  as "Focused on") and the project detail page show "you last worked on this _X ago_, next up: _Y_."
- **Weekly review** (`/api/weekly-review`) — same pattern as the existing daily review, generalized
  over 7 days of daily-totals-by-project, completed/open milestones and tasks, and idle time, with
  its own prompt (patterns, what's stalled, next week's priorities) and its own button next to "AI
  review."

**Tested, and a real limitation to know about:** episode rollup was verified against a copy of the
real database — it produced real episodes from real historical activity with no model call
involved, and the resume-brief fields showed correct data in the UI (screenshot-reviewed). The Ask
UI's rendering (chat bubbles, evidence list) was verified by mocking the `/api/ask` response in a
headless browser, since the actual OpenRouter call could not be. **This session's cloud sandbox has
no network path to `openrouter.ai` at all** — a direct `curl` to it fails at the connection level
with "organization policy," and the app's own `fetch` calls to the chat/embeddings endpoints came
back as HTTP 403 "Forbidden," which is very likely the sandbox's own egress proxy denying the
request rather than a real response from OpenRouter. In other words: the embeddings call, the ask
answer call, and the weekly review call are implemented against OpenRouter's documented
OpenAI-compatible shapes but were **never exercised against the live API** in this session. The
first real test of those three is on your machine, with your key. If the embeddings response
shape turns out to differ from the assumed `{ data: [{ embedding: [...] }] }`, `embedTexts` in
`src/openrouter.js` is the only place that needs to change — `episodes.js` just consumes whatever
array of numbers it returns.

## 2026-08-30 — Phase 1: harden what's running

**Files touched:** `src/server.js`, `src/project-analyzer.js`, `src/collector.ps1`,
`public/app.js`, `public/index.html`, `public/extras.css` (new), `scripts/smoke.mjs` (new,
dev-only), `.env.example` (fixed earlier, see below).

Done:
- **Origin/CSRF check** on every mutating API route except the key-authenticated
  `/api/browser-events` — a request whose `Origin`/`Referer` isn't this app's own page is rejected
  with 403 (`trustedOrigin()` in `server.js`).
- **Auto repo-analysis cooldown** — a changed fingerprint now has to hold steady for 5 minutes
  before it's treated as "settled," and even then a project won't auto-re-analyze more than once
  per 15 minutes (`FINGERPRINT_STABLE_MS` / `MIN_REANALYSIS_INTERVAL_MS` in `checkProjectChanges()`).
  Manually clicking "Review repository" still runs immediately.
- **Idle detection** — `collector.ps1` now also reports seconds since the last keyboard/mouse
  input via `GetLastInputInfo`. Past 2 minutes idle, the capture loop logs a distinct `Idle`
  activity instead of extending whatever window was last foregrounded. Idle time is excluded from
  the productivity stats and per-project totals but still visible in the Timeline.
- **Content-based secret redaction** in `project-analyzer.js` — file excerpts are scanned for
  common credential shapes (OpenRouter/OpenAI-style keys, GitHub tokens, AWS keys, Slack tokens,
  JWTs, generic `key=`/`secret=` assignments) and redacted before being sent to OpenRouter, on top
  of the existing filename-based exclusion.
- **Configurable sensitive terms** — the redaction term list now lives in `settings` (editable in
  Settings → Redacted terms) instead of being a hardcoded regex, additive to a fixed default list.
- **Reminders finished** — `PATCH /api/reminders/:id` to dismiss, plus a Today-view card to add,
  see, and dismiss reminders (soon-due ones highlighted).
- **Correction inbox** — every non-idle Timeline row now has a project reassignment dropdown
  (`PATCH /api/activities/:id`); low-confidence or unclassified rows are flagged with a badge so
  they're easy to find. Corrections are stored at full confidence.
- **Timeline date picker** — prev/next/date-input/Today controls, reusing the dashboard's existing
  `?date=` parameter.
- **Export** — `GET /api/export.json|csv|md` and matching download links in Settings. JSON/CSV give
  the raw activity log; the Markdown report is a per-project summary with milestones and tasks.
- **Focus pin + drift detection (backend + banner)** — a "Focused on" project selector on Today;
  if every non-idle activity for a stretch (8 min in strict mode, 20 in gentle, never in silent)
  classifies to something else, a dismissible banner says so. Mode is set in Settings.

Also fixed the `Assigned`/`Activities` stat tiles, which used to count idle time as an activity —
they now count only non-idle activity, and the hero summary reports idle time separately.

**Tested:** `node --check` on all changed `.js` files; booted the server against a copy of the real
database and exercised every new endpoint with `curl` (CSRF block/pass, reminder create+dismiss,
settings update, all three export formats); ran a headless-browser smoke pass (Playwright) clicking
through every nav view, a project detail, timeline date navigation, and a settings save, with zero
console/page errors. Screenshots of Today, Timeline, Settings, and the new Ask view were reviewed
by hand. Not tested: the actual Windows `collector.ps1` idle-detection code, since this session had
no Windows machine to run PowerShell on — the P/Invoke pattern is standard, but give it a real run
before relying on idle-adjusted totals.

## Status: audit roadmap implemented, pending a real run on your machine

Everything in the audit's "Now" and "Next" phases, plus the lighter "Later" items, is implemented:
security/CSRF hardening, repo-analysis cooldown, idle detection, content-based secret redaction,
configurable sensitive terms, reminders, the correction inbox, timeline date picker, export,
focus pin + drift detection, episodes, embeddings, the Ask conversational interface, resume briefs,
and weekly review.

**Deliberately not attempted, and why:**
- **Encryption at rest for `data/worklens.db`** — the built-in `node:sqlite` module has no
  encryption support; getting it would mean swapping to a native module (e.g. a SQLCipher-backed
  driver), which needs prebuilt binaries or a working native build toolchain on this exact Windows
  machine to verify, and this session had no shell access to your computer to test that with. Left
  as a follow-up rather than risked blind.
- **Tray-app packaging (Tauri) / macOS support** — a genuinely separate build, not a patch to the
  existing Node/HTTP-tab app. Worth doing once the feature set above has been used for real.

### How this was tested, and what wasn't

This session's live connection to your computer was unavailable for running commands the whole
time, so every change was developed and tested against a *copy* of your `worklens` folder,
including a copy of your real `data/worklens.db` (used read-only, to check migrations against real
data — the original file was never written to directly). For each phase: `node --check` on every
changed file, the server booted against that copy and every new endpoint exercised with `curl`
(including deliberately triggering the CSRF block), and a full headless-browser pass (Playwright,
`scripts/smoke.mjs`) clicking through every view with zero console/JS errors, plus hand-reviewed
screenshots.

Two things could **not** be tested from this session and are the first things worth checking on
your machine:
1. **`collector.ps1`'s idle detection** (`GetLastInputInfo` via P/Invoke) — this sandbox has no
   Windows machine to run PowerShell on. The pattern is standard, but it's untested.
2. **The three live OpenRouter calls added in this pass** — embeddings, the Ask answer, and the
   weekly review. This sandbox has no network path to `openrouter.ai` at all (confirmed: direct
   `curl` fails at the connection level, and the app's own calls came back HTTP 403, most likely
   the sandbox's own egress policy rather than a real OpenRouter response). Every other AI call in
   this app (daily review, project analysis, URL-only analysis) already existed before this session
   and was presumably working for you, so the request shape they follow is proven — the new calls
   follow the same pattern, but are unverified against the live API.

### Verification checklist for your next real run

- [ ] `npm start`, confirm it boots without errors, and open <http://localhost:4317>.
- [ ] Start recording, work normally for a few minutes, step away from the keyboard for 2+ minutes,
      come back — check the Timeline shows an "Idle" row for the gap.
- [ ] On the Timeline, reassign a project on one activity row and confirm it sticks after a reload.
- [ ] In Settings, add a test term to "Redacted terms," save, and confirm a matching window title
      gets redacted on the next capture.
- [ ] Click "AI review" once (existing feature) to confirm your OpenRouter key still works after the
      `.env.example` fix.
- [ ] Let the app run for 10–15 minutes with recording on, then open **Ask** and ask something like
      "what have I been working on" — this is the first real exercise of embeddings + the ask
      endpoint. If it errors, the error message will say whether it's an OpenRouter auth/response
      problem (fix in `src/openrouter.js`) versus "not enough activity yet" (just needs more time).
- [ ] Click **Weekly review** once you have a few days of history.
- [ ] Rotate the OpenRouter key that was exposed in `.env.example` (see the top of this file's
      history, or just: Settings → Keys on openrouter.ai) if you haven't already.
