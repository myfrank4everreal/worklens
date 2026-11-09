# WorkLens implementation progress

Running log of what's been implemented against the Aug 30 2026 build audit, in the order it
was done. Newest entry on top. Each entry names the files touched so a diff is easy to find.

Source of the plan: the "WorkLens Build Audit" artifact (capability mapping + roadmap) referenced
from this session's project memory.

---

## 2026-11-01 — Workstation phase 6: VoiceStudio connector

**Files touched:** `src/media/voicestudio.js` (new), `src/media/api.js`, `src/db.js`
(`voice_profiles.model`, `voice_clips.engine`), `public/voice.js`, `public/voice.css`, `package.json`.

**Why:** Kokoro covers stock voices. VoiceStudio is the app for cloned or designed voices.
Characters can now use either engine from the same Voice screen, and VoiceStudio lines land in the
same library, Studio and timeline as Kokoro lines.

**How it works:**
- VoiceStudio runs as its own app with a local OpenAI-compatible API, so WorkLens talks to it over HTTP
  instead of bundling it: `GET /v1/audio/voices`, `GET /v1/models`, and `POST /v1/audio/speech` with
  `response_format: 'wav'`. The default address is `http://127.0.0.1:3900` (from VoiceStudio's own
  `config/app.json`). It can be changed on the Voice screen or with `WORKLENS_VOICESTUDIO_URL`.
- **Local only:** the address must be 127.0.0.1, localhost or ::1, over http(s), so script text never
  leaves the machine. VoiceStudio trusts loopback callers. `WORKLENS_VOICESTUDIO_KEY` is sent as a
  bearer token if a setup needs one.
- **Errors:** "not running" points to finishing VoiceStudio's local runtime setup. A 401 or 403 adds a
  note to accept the model licence in VoiceStudio's Model Manager. VoiceStudio's own message is passed
  through. Status is never cached, because VoiceStudio is started and stopped separately.
- **Voice screen:** two engine chips, a VoiceStudio card (status, address, "Check again", licence
  note), an Engine choice for custom lines and in the character dialog, and an optional VoiceStudio
  model per character. A saved VoiceStudio voice stays selectable while the app is closed, and Generate
  is disabled until it's back. Compare voices stays Kokoro-only. Clips and log lines name the engine.

**Licensing note shown in the app:** the VoiceStudio app is AGPL, each model has its own terms, and its
default OmniVoice model is non-commercial. Clone a voice only with that person's permission.

**State on this machine:** VoiceStudio is installed (`%LOCALAPPDATA%\Programs\VoiceStudio`) and its
window runs, but its **local runtime was never set up**. Nothing listens on :3900, and its window
process (:51199) answers 403 to everything. So the connector shows "VoiceStudio offline" until the
runtime is installed inside VoiceStudio.

**Tested** on a copy of the data (port 4400) against a stand-in for VoiceStudio's API on 127.0.0.1:3911,
written from VoiceStudio's `openai_compat.py` routes:
- Offline message at :3900. `http://example.com:3900` and `file:///` addresses were refused.
- Connecting through "Check again" updated the chip and the card (1 profile, 3 models).
- A character created with engine VoiceStudio, voice `vp_frank01` and model `omnivoice` generated a
  5.4s line. The stand-in received `{model:'omnivoice', voice:'vp_frank01', response_format:'wav'}`,
  and the clip and log say VoiceStudio.
- A 403 licence error came through readably.
- With the stand-in stopped, the VoiceStudio character's Generate was disabled, and an API call
  returned the "not running" message.
- Kokoro still generated (2.9s line). No horizontal overflow at 375px.

**Not verified:** real speech from VoiceStudio, which needs its runtime and a model.

---

## 2026-11-01 — Workstation phase 5: monitoring integration

**Files touched:** `src/workstation.js`, `public/monitor.js` (new), `src/server.js` (capture hook,
route, dashboard field), `src/db.js` (`studio_projects.brand_id`), `src/media/api.js` (brand link,
export logged to a project), `public/app.js` (view reports, Today card), `public/studio.js`,
`public/voice.js`, `public/brands.js`, `public/theme.css`, `public/index.html`, `package.json`.

**Why:** before this, every minute inside the workstation window was captured as one generic
"WorkLens" window with no project. Now WorkLens records which tool you were in, what you were working
on, and which project it belongs to.

**How it works:**
- Each screen calls `reportContext()` (`public/monitor.js`). It sets the window title to
  `<label> · Workstation` and posts `{tool, label, brandId | studioProjectId}` to
  `/api/workstation/context`, debounced 300 ms, with a re-post every 5 minutes while the page is
  visible. Labels: `Editing "<project>" · <brand>`, `Voice lines for <character>`,
  `Brand: <name>`, or the WorkLens screen name.
- `capture()` asks `workstationCapture(app, title)` first. If the front window is the workstation
  (a title ending in `· Workstation`, or WorkLens/electron with "Workstation" in the title), the
  activity is stored as `Workstation · Studio|Voice|Brands|WorkLens` with the reported label, source
  `workstation`. The context expires after 30 minutes. Sensitive-title redaction and idle detection
  still run first.
- **Project attribution:** brand → its linked WorkLens project. A Studio project now has a Brand
  picker (Project panel), so editing time *and* "Rendered video" log entries land on that brand's
  project. The panel says when the brand isn't linked yet.
- **Today → "Workstation today" card:** time per tool (bars), plus counts of exports, voice lines and
  posts logged today. Each count opens its tool. The data comes from `dashboard().workstation`
  (also available at `/api/workstation/summary`).

**Tested** on a copy of the data (port 4399):
- Unit checks of `workstationCapture`: a non-workstation window → null. Studio with a linked brand →
  `Workstation · Studio`, project 1, confidence 1. Brands → same project. Today → `Workstation ·
  WorkLens`, no project.
- In the browser: window titles followed every screen (`Editing "Phase 4 test reel" · Tees Inspired ·
  Workstation`, `Voice lines for Frank Madu · Workstation`, `Brand: Tees Inspired · Workstation`), and
  the server context matched. Changing the Studio brand updated the title and the hint.
- An export with `studioProjectId` was logged to project 1. The Today card rendered tool time and
  counts. No horizontal overflow at 375px.

**Not verified:** a real foreground capture of the Electron window. The test machine's foreground
window was the Claude app, so detection was exercised through the unit checks above. The Voice label
appears only after Kokoro's first voice list loads (~11s on a cold start).

---

## 2026-11-01 — Workstation phase 4: Studio, the video editor

**Files touched:** `public/studio.js`, `public/studio.css` (new), `public/index.html`, `src/db.js`
(`studio_projects` table), `src/media/api.js` (`/api/media/projects` routes; `folder=frames` on upload).

**Why:** the editor on top of the phase 3 render engine: merge clips, add a voice line, images and
captions, and export a finished 9:16 reel without leaving the workstation.

**What it does:**
- **One video track** of clips and stills, plus an optional end card that fades in. Drag a block to
  reorder it, drag its edges to trim, or split at the playhead (S). Stills get a length on screen.
- **Captions** are drawn to a full-frame 1080×1920 PNG in the browser (Inter 800, dark rounded box,
  top / center / bottom, three sizes). The same image is used in the preview and in the export, so the
  preview shows exactly what gets rendered. Export uploads them to `media/frames/`, and the Media list hides them.
- **Audio rows**, one per voice line or music file: move, trim, volume up to 200%. The clips' own
  sound can be kept or muted and has its own volume.
- **Live preview** in the page: one `<video>`, one `<img>`, the caption layer and an `Audio()` per
  row, all driven from a single clock and re-synced whenever they drift more than 0.3s. Space plays,
  arrow keys nudge, Delete removes the selected block.
- **Brand 9:16 preset** adds a hook caption (0–3s, top, large) and picks an end card from the
  images (`end|card|crest|logo|cta` in the name first).
- **Projects autosave** (700 ms debounce, flushed when the page closes) to `studio_projects`; switch,
  create or delete them from the header. Deleting a project keeps its media and exports.
- **Exports** list with live progress, cancel, in-page playback, "Save as…" and delete. Each finished
  export is logged to the WorkLens timeline (by the phase 3 engine) and shows up in Media, so it can
  go back into another edit. **Save last frame** on a clip gives the start image for the next AI clip.

**Tested** on a copy of the data (port 4398, never the real DB): added two clips, the preset (hook
and end card), a Frank Madu voice line, split a clip at 3s, dragged a caption edge (3.0→5.0s),
dragged a clip to the front, then reloaded. Order, trims and the title all came back. Preview
playback kept the video within 0.15s of the clock, and the caption showed at 0.5s. Exported 14.9s at
1080×1920 H.264 + AAC in 37s on this laptop. Frames checked: hook caption over the clip, the split
clip, and the end card. "Rendered video" was logged to the timeline. At 375px the page has no
horizontal overflow (only the timeline scrolls sideways).

**Not done:** transitions between clips (only the end card fades), music ducking under voice, and
multiple video tracks (picture-in-picture). Media names saved before this change keep their old
timestamped names.

---

## 2026-11-01 — Workstation phase 3: media engine (ffmpeg render jobs) and the Voice tool

**Files touched:** `src/media/ffmpeg.js`, `src/media/render.js`, `src/media/voice.js`,
`src/media/kokoro_tts.py`, `src/media/api.js` (all new), `src/db.js`, `src/server.js`,
`package.json`, `public/voice.js`, `public/voice.css` (new), `public/index.html`.

**Why:** Studio (phase 4) needs an engine that can join clips, lay images and audio over them and
export a finished reel; Voice needs one consistent, commercially usable voice per character. This
phase builds both engines and the Voice screen; the editor UI comes next.

**Decisions shaped by the machine and connection** (8 GB RAM, no discrete GPU, ~1–9 MB/min
downloads):
- **ffmpeg is found, not downloaded** (`ffmpeg.js`): `WORKLENS_FFMPEG` → the `ffmpeg-static` package if
  installed → the binary Python's `imageio-ffmpeg` already ships → `ffmpeg` on PATH. On this machine
  that resolves to the imageio copy (ffmpeg 7.1). A packaged build can bundle `ffmpeg-static` later
  without code changes. `probe()` reads ffmpeg's own banner because that copy has no ffprobe.
- **Voice uses the Python Kokoro already installed** (`kokoro-onnx` + onnxruntime), called through a
  short-lived helper (`kokoro_tts.py`), rather than `kokoro-js`, whose `onnxruntime-node` dependency
  is ~300 MB unpacked. The helper loads the **int8 model (~88 MB)** in preference to the 310 MB fp32 one;
  quality is close and the download is a third of the size. Kokoro's weights are Apache-2.0.
  `voice.js` is a thin wrapper, so the engine can later become `kokoro-js` or a VoiceStudio connector
  without API/UI changes.

**What changed:**
- **Render engine** (`render.js`), the Node successor to `media-lab/stitch_video.py`: a timeline
  (`clips` in order, still images with a duration, `overlays` as timed PNGs, extra `audio` tracks with
  start/in/out/volume, `clipAudio.keep/volume`, optional `endCard`) becomes one ffmpeg command. Every
  clip is scaled/cropped to fill the frame and normalised (fps, pixel format, SAR), a silent track is
  generated for clips without audio so `concat` never mismatches, extra audio is `adelay`ed to its
  start and `amix`ed with a limiter, x264 `veryfast`/CRF 20. Captions are deliberately drawn as PNGs by
  the editor and passed in as overlays, avoiding ffmpeg `drawtext`'s fragile font-path escaping on
  Windows. `lastFrame()` keeps the "seamless next clip" trick from the Gemini workflow.
- **Media API** (`api.js`, routed after the CSRF guard like Brands): files live in
  `<dataDir>/media/{uploads,voice,renders,frames}`. `GET /api/media/status|library|file` (file
  serving supports HTTP Range so video/audio can seek), `POST /api/media/upload` (streams the body,
  type allowlist, 2 GB cap), `POST /api/media/probe`, `POST /api/media/last-frame`, and render jobs:
  `POST /api/media/renders` (202 + id, runs in the background with progress), `GET
  /api/media/renders[/:id]`, `DELETE` (cancels a running job or deletes a finished one). Relative paths
  can't escape the media folder; absolute paths to the person's own files are allowed, since this is
  a local app. Finished renders log "Rendered video …" to the activity table.
- **Voice API**: `GET /api/voice` (engine status, voices, character profiles, recent clips), profile
  CRUD, `POST /api/voice/generate` (by profile or by voice+speed; saves a WAV to the media library and
  logs "Generated voice line for …"), `DELETE /api/voice/clips/:id`. Tables: `voice_profiles`,
  `voice_clips`, `media_renders`. Seeded once: **Frank Madu → am_onyx at 0.95×** (deep, calm American
  voice per his character bible), as a starting point to change after comparing samples.
- **Voice screen**: engine status chip and a setup card that names exactly what's missing; "Say a
  line" (character or custom voice + speed); a **Compare voices** panel (same line, up to four voices,
  with "use for a character"); characters list with edit/delete; recent lines with players. The
  Brands and Voice sidebar entries lost their phase tags; Studio's placeholder now says the engine is
  ready.

**Bugs found while testing, fixed:** (1) the helper was run with `python -I`, and isolated mode drops
per-user site-packages, which is where `pip install --user kokoro-onnx` puts Kokoro, so the package
looked "missing"; now `-E`. (2) A model file only partly downloaded passed the old "> 1 MB" check and
would have crashed onnxruntime; each model now has a minimum complete size, and a partial file reports
"still downloading (N of ~M MB)".

**Tested:** `npm run check` covers every new module. Engine directly: a timeline with a trimmed video
clip, a still image, a timed PNG overlay, a delayed extra audio track and an end card rendered 8.0 s of
1080×1920 + audio in 10.6 s on this laptop, with progress callbacks; frames at 1.0/3.5/5.0/7.0 s showed
the overlay present then gone, the still, and the end card exactly as timed; last-frame extraction
works. API on port 4397 against a copy of the database: ffmpeg status, uploads (and a rejected `.exe`),
a `../worklens.db` path traversal rejected, a background render job reaching `done` with a working
Range request (206), last frame, and the render logged to the timeline. Voice screen in the browser
pane at 1440px and 375px (no overflow) in the not-ready state with the exact download message.
Speech synthesis (after the int8 model finished, 92,361,271 bytes): `--list` ≈11s, 28 English
voices. Generated the same line through /api/voice/generate with the Frank Madu profile (5.63s of
audio in 21s), am_onyx (5.42s/12s), am_michael (5.40s/21s), am_fenrir (5.23s/17s) and am_adam
(4.89s/18s); each logged to the timeline. Voice screen in the ready state: engine chip
"Kokoro ready", Generate enabled, five clips listed and playable.

---

## 2026-11-01 — Workstation phase 2: Brands module (Brand Command Center, persistent)

**Files touched:** `src/brands.js` (new), `src/db.js`, `src/server.js`, `package.json`,
`public/brands.js` (new), `public/brands.css` (new), `public/index.html`, `public/app.js`.

**Why:** the Brand Command Center page kept its brands and accounts only in that page's memory,
so nothing survived a reload and WorkLens couldn't see any of it. Its features were recovered from
the page's compiled React source (brands with name/colour/description; accounts with platform,
handle, link and last-posted date; Posted Today / Needs Post (1–2 days) / Idle; new brand, add,
edit and remove account, rename, mark posted) and rebuilt here on the workstation's own storage
and design tokens.

**What changed:**
- **Storage** (`src/db.js`): `brands`, `brand_accounts` and `brand_posts`. Posting is a per-day log
  (`UNIQUE(account_id, posted_on)`) rather than one `last_posted` column, so history ("posts in the
  last 7 days", later streaks and "what did I post this week") is answerable. Deleting a brand
  cascades to its accounts and posts.
- **API** (`src/brands.js`, new): `GET /api/brands`; `POST /api/brands`; `PATCH`/`DELETE
  /api/brands/:id`; `POST /api/brands/:id/accounts`; `PATCH`/`DELETE /api/brand-accounts/:id`;
  `POST /api/brand-accounts/:id/posts` (logs today, idempotent, refuses future dates); `DELETE
  /api/brand-accounts/:id/posts/today` (undo). `server.js` hands each `/api` request to
  `brandsApi()` right after its existing CSRF guard, so the same trusted-origin rule covers these
  routes. Handles are normalised to `@handle`; a blank or non-http link is replaced with the
  platform's profile URL built from the handle.
- **"Today" is the local calendar day** (`localDay()`), not UTC; the original page used
  `toISOString()`, which rolls over at 01:00 in West Africa Time.
- **Seed:** on first run only (guarded by the `brands_seeded` setting, so deleting every brand
  doesn't bring it back), the person's three real brands and four real accounts: Tees Inspired (IG
  and Threads @tees_inspiredworld), Mafrex AI (IG @mafrexai), Augustin Frank (FB). The original's
  placeholder "Brand 4–7" rows with invented handles were left out. No posting days are seeded.
- **WorkLens integration:** each "mark posted" and "undo" writes an `activities` row (app
  `Workstation · Brands`, source `workstation`, e.g. "Posted on Instagram: @tees_inspiredworld (Tees
  Inspired)"). A brand can be linked to a WorkLens project, which tags those rows with that project
  at full confidence. The rows show on the Timeline and roll into episodes, so Ask can use them.
  `brands.js` fires a `workstation:changed` DOM event after a change and `app.js` reloads the
  dashboard on it, so the Timeline updates immediately instead of at the next 15s refresh; Studio and
  Voice will use the same event.
- **UI** (`public/brands.js`, `public/brands.css`): overview stats, brand tabs (account count and a
  posted-today badge), a brand card tinted with the brand's colour (description, platform count,
  linked project, daily progress bar, posted / needs-post tiles), accounts grouped by platform with
  status chip, last post, posts in the last 7 days, edit/remove and a "Mark posted today" / "Posted
  today · undo" button. Its own `<dialog>` handles new/edit brand (seven-colour palette, optional
  project link), add/edit account and the delete/remove confirmations, kept separate from app.js's
  modal so the two never compete for one form. The active brand tab is remembered in
  `localStorage`, wrapped in try/catch.

**Tested:** `npm run check` (now including `src/brands.js`) and `node --check` on both front-end
files pass. API, with curl against a server on port 4398 using a copy of `data/worklens.db`: seed
contents and links; the CSRF block on a POST without a trusted origin; mark posted twice (second call
reports `alreadyLogged`); create brand and account; unknown platform and future date both rejected
with 400; the activity row written; undo; brand delete cascading to its account. UI in the browser
pane against the same server: mark posted (chip, progress, tab badge, overview and toast update),
add a TikTok account through the dialog, edit brand with a project link (meta line shows "LINKED TO
WORKLENS"), remove an account through the red confirm, undo a post, create and delete a brand, and a
linked post appearing on the Timeline immediately under the "worklens" project. Document overflow was
0 at 1440px and 375px, and no console errors. **Not tested:** the packaged Electron app (it needs a
rebuild to include these files); a real day rollover, which was reasoned through via `localDay()`
rather than waited for.

---

## 2026-11-01 — Workstation phase 1: shell and shared dark design system

**Files touched:** `public/theme.css` (new), `public/index.html`, `public/app.js`, `.gitignore`.

**Why:** WorkLens is becoming the monitoring layer of a wider "Workstation", one window holding
the day-to-day tools (Brands, a Studio video editor, Voice) alongside WorkLens's own views, all in
one visual language. The design source is the Brand Command Center page (near-black surfaces,
hairline borders, white primary accent, Inter for UI and JetBrains Mono for labels/numbers,
green/amber/red status colours). The six-phase plan: (1) this shell and design system, (2) Brands
module with persistent storage, (3) media engine (bundled ffmpeg, the video-stitching logic ported
to Node, Kokoro voice), (4) Studio editor UI, (5) every module logging events to WorkLens so Ask can
see them, (6) a VoiceStudio connector.

**What changed:**
- `public/theme.css` holds the design tokens and is loaded last. Rather than rewriting the eight
  older stylesheets, it re-points their colour variables (`--bg`, `--ink`, `--muted`, `--line`,
  `--card`, `--accent`, `--green`) at the dark palette and overrides the colours they hard-coded
  (white cards, light inputs, pastel badges, the light dialog and toast). New modules use only the
  new tokens. Unstyled buttons get a default via `:where(button:not([class]))`, which has zero
  specificity, so no existing button rule is overridden by it.
- The sidebar is now grouped: **WorkLens** (Today, Projects, Tasks, Timeline, Ask, Model activity),
  **Studio tools** (Brands, Studio, Voice, each tagged with the phase it arrives in) and **System**
  (Settings), with an icon per entry and a live "Monitoring on/off" indicator that follows the
  recording state. The inner icon/label spans are `pointer-events:none` so the existing
  `e.target.matches('.nav')` click handler still sees the button.
- Brands, Studio and Voice have placeholder screens describing what each will do and what it
  connects to; `show()` has titles for them.
- Responsive: the old ≤900px rule hid nav text with `font-size:0` and printed the view name through
  `.nav:after`. With icons that became a clash, so the rail is now icon-only (`content:none`, labels
  and captions `display:none`), and the ≤620px phone drawer restores the text. The drawer's logo is
  pushed right so the fixed menu button no longer covers it.
- Fonts load from Google Fonts with system fallbacks, so an offline machine still renders correctly.
- The TeesInspired brand assets and scripts that arrived in the repo root when this session moved
  here were moved into `media-lab/` and git-ignored; `media-lab/stitch_video.py` is the reference
  implementation for phase 3's Node port.

**Tested:** `npm run check` and `node --check public/app.js` pass. Ran `src/server.js` on port 4399
against a copy of `data/worklens.db` in a temp folder (the installed app on 4317 and the real
database were not touched) and went through Today, Projects, a project detail page, Tasks with the
Add-task dialog open, Settings and the new Brands screen at 1440px, plus the 820px icon rail and the
375px phone drawer. Document overflow was 0 at every width and the console showed no errors.
**Not done yet:** the installed desktop app still shows the old look until it's rebuilt
(`npm run dist`) and reinstalled; `scripts/smoke.mjs` was not run because Playwright isn't installed here.

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

## Workstation · Engines, brand videos and Studio timeline pictures

- **Engines** (new nav item, `src/engines.js` + `public/engines.js`): both video engines side by side and
  kept visibly apart — Lemo-Opuscar's code-made styles (read from `styles/*/style.json`, violet) and
  MoneyPrinterTurbo's stock-footage video types (teal), with install/key status (never the keys
  themselves), search, a "making for" brand, and "New video" that opens a tagged Studio project.
  MPT's web UI can be started from here (WorkLens waits until Streamlit is healthy).
  Engine folders default to `Documents\socialmedia\AI Video Editor\{lemo-opuscar,MoneyPrinterTurbo}`;
  change them with `POST /api/engines/paths`.
- **Film library** (`film_library` table): finished films are found by scanning `lemo/films/<name>/<name>.mp4`
  and `mpt/storage/tasks/*/final-*.mp4`; each gets a thumbnail, brand, status
  (idea → script → rendered → checked → posted) and a one-click check (EBU R128 loudness + black and
  white blackdetect). A pass at −14 ±1 LUFS with no black/white frames moves it to Checked.
- **Brands → Videos**: a status board per brand under its accounts, plus the brand's Studio projects.
- **Studio**: clip blocks show their own frames (ffmpeg strip, positioned for the trim), audio blocks a
  waveform of the trimmed part, lemo films an Events row from their `events.json`; an edit history with
  undo/redo (buttons, Ctrl+Z / Ctrl+Shift+Z) and platform safe-zone guides on the preview.
- Tested against a copy of the live database on a second port (`WORKLENS_PORT=4399`).

## Workstation · Posting bot

- `src/poster.js` and the Content screen's **📨 Posting bot** strip: it auto-schedules Edited cards at 11:00/19:00 per
  brand and gives each brand its own post number. New `content_items` columns: `post_no`, `tg_file_id`, `poster_note`.
- `brand-poster/` (Vercel Hobby project franklymade-hq/brand-poster): the queue is in Vercel Blob,
  `/api/queue`, `/api/tick` (cron-job.org at 11:00, 11:15, 19:00 and 19:15 Lagos time), `/api/telegram` (webhook: /start, Mark as posted),
  `/api/sync` and `/api/health`.
- Done: deploy, keys, bot token, chat id, webhook, cron-job.org job. Coded Film #001/#002 queued for 2026-11-05 11:00/19:00.
- Descriptions are written from keywords taken from each video, to help discovery.

## TestLoop bot moved to Vercel

- `testloop-cloud/` is the same logic as `testloop-bot/bot.js`. Long polling became a webhook, `setInterval` became
  cron-job.org (20:05 UTC), and SQLite became one JSON file in Vercel Blob.
- Same HTTP paths (`/health`, `/sync`, `/admin/...`) and the same `SYNC_TOKEN`, so WorkLens only changed its URL.
- 1 tester imported; the local bot is stopped and must stay stopped.
- The WorkLens TestLoop sync went from 2 to 10 minutes, and the posting bot sync from 5 to 15, to stay inside Blob's free reads.

## Overseer: voice questions about every Claude session (branch worklens-voice-overseer)

- `src/overseer/sessions.js` reads the Claude desktop app's session index and the tail of each
  transcript, read-only, and works out each session's state: working (transcript changed in the last
  90 s), waiting (its last wrap-up asked a question nobody has answered) or idle. Tested against the 42
  real sessions on this PC: 2.4 s for the first read, about 40 ms after that.
- `src/overseer/brain.js` runs `claude -p` with no built-in tools, `--restricted`, only the read-only
  `src/overseer/mcp.js` tools, and `dontAsk`. Answers stream; the spoken part comes before a `---` line.
- `src/media/speech_serve.py` keeps Whisper (base.en) and Kokoro loaded in one Python process, which
  stops after 10 idle minutes. faster-whisper's own PyAV decoding fails with the installed PyAV, so the
  helper decodes WAV with soundfile.
- `public/overseer.js`: clap detection (same rules as Jarvis's `clap.ts`, measured in time so it runs on
  audio events and works with the window hidden), recording that stops after about a second of quiet,
  16 kHz WAV encoding, sentence-by-sentence speech. Electron registers Ctrl+Alt+J globally and turns off
  background throttling.
- Tested on a second port (`WORKLENS_PORT=4399`) with an empty test database: the session list,
  session detail, all three MCP tools, the screen, the origin check, and speech-to-text and Kokoro through
  the server. Synthetic clap tests catch single and double claps and ignore speech, sustained noise and a
  door thud.
- **Not tested:** an answer from Claude (the CLI on this PC says `loggedIn: false`), a real clap or real
  speech through a microphone (the browser pane blocks the mic), and the Electron build (global shortcut,
  hidden-window listening).
- **Speed on this PC under load:** with the CPU at 100% from video renders and about 900 MB of RAM free,
  Whisper took 77–117 s to transcribe 7 s of speech and Kokoro ran about 5x slower than real time. Not yet
  measured on an idle machine; the Windows voice is the default for replies because of this.

