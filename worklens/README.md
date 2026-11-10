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

## Overseer (voice)

The **Overseer** screen answers questions about everything you have running: every Claude Code
session in the Claude desktop app, plus WorkLens's projects, tasks and content pipeline. Ask by
voice or by typing. It gives a short spoken summary first and leaves the detail on screen.

- **To start it talking:** clap once (turn on **Wake on clap** first), press **Ctrl+Alt+J** anywhere
  (it also works with WorkLens hidden in the tray), use the tray's **Talk to the Overseer** item, or
  click the circle. You hear a rising beep, then speak. It stops listening after about a second of
  quiet.
- **Hearing you:** faster-whisper (`base.en`, int8, CPU) runs on this PC. No audio leaves the
  computer. Set `WORKLENS_WHISPER_MODEL=small.en` for better accuracy at about three times the wait.
- **Thinking:** the installed Claude Code CLI (`claude -p`), on your own Claude login. Your question
  and the session excerpts its tools read go to Anthropic. Its model is Sonnet by default; Haiku or
  Opus can be picked on the screen. Follow-ups within 10 minutes continue the same conversation, so
  "tell me more about the video edit" works.
- **Replying:** the Windows voice (instant, the default) or Kokoro (more natural, much slower on a
  2-core laptop). It speaks one sentence at a time while the rest of the answer is still arriving.
  Clicking the circle or pressing Ctrl+Alt+J while it talks stops it.
- **The session board** groups sessions into *Waiting on you* (the session asked you something and
  is stuck until you answer), *Working now* and *Recently finished*. Click one to read its last turns.

**It can only read.** The overseer's Claude runs with no built-in tools (`--tools ""`), no settings
files (`--restricted`), only its own MCP server (`src/overseer/mcp.js`, via `--strict-mcp-config`)
and permission mode `dontAsk`. Every tool in that server only reads, through WorkLens's GET
endpoints. It can't start, stop or message a session, edit a file or post anything.

**Where the session data comes from:** the Claude desktop app's index in
`%LOCALAPPDATA%\Claude-Data\<account>\claude-code-sessions\` (titles, folders, which session
started which) and the transcripts in `~\.claude\projects\` (only the last few hundred KB of each
is read). Both formats belong to the Claude app and can change in an update, so the reader skips
anything it doesn't recognise instead of failing. "Working" is a guess: the app doesn't write it to
disk, so a transcript changed in the last 90 seconds counts as working.

**Needs:** Claude Code installed and signed in (run `claude` once in a terminal and log in; the
desktop app's own sign-in is separate), and Python 3 with `faster-whisper`, `soundfile`, `numpy`
and, for the Kokoro voice, `kokoro-onnx` with its model files in `~\.kokoro`.

| Route | What it does |
|---|---|
| `GET /api/overseer/sessions` | All sessions with state, open question, recap and last reply (`?archived=1` adds archived ones). |
| `GET /api/overseer/sessions/<id>` | One session's last turns (`?turns=`, at most 40). |
| `POST /api/overseer/ask` | `{ text }` → NDJSON stream: `delta`, `reset`, `tool`, `done` (`spoken`, `detail`), `error`. |
| `POST /api/overseer/stt` | A WAV body → `{ text }`. |
| `POST /api/overseer/tts` | `{ text }` → `audio/wav` (Kokoro). |
| `GET /api/overseer/status`, `POST /api/overseer/settings`, `/warm`, `/stop`, `/new` | Status, settings (name, model, voice), model preload, cancel, new conversation. |

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

## Workstation · Overview, Content, Sites & stores

- **Overview** shows everything on one page: the focus project and last tool used, how many videos
  are at each stage, what's due to post next (overdue in red), every brand's accounts with
  followers and last post, the websites, and the stores and communities. Click any account handle
  to open its **account page**.
- **Content** has one card per video, from idea to posted: brand, target accounts, AI prompt,
  video file, caption, hashtags (one per word, de-duplicated), post time and post link. It has
  **Board** and **Schedule** views. **Generate in Studio** fills Studio's Generate clip panel with
  the prompt; the person still checks the cost and confirms. **Mark posted** also logs a post on each
  target account in Brands. **Upload to YouTube** sends an edited video to a connected channel,
  private or scheduled.
- **Sites & stores**: websites are checked every 30 minutes for status and response time. The
  latest post comes from RSS (`/feed`) or else `sitemap.xml`, and a sitemap listing pages on
  another domain is flagged. Stores and communities (Gumroad, Skool, Shopify, Etsy, Patreon…) each
  carry a link, a tracked number, notes and how-to tips for that platform.

Endpoints: `GET /api/hub`, `GET|POST /api/content`, `PATCH|DELETE /api/content/:id`,
`POST /api/content/:id/posted`, `GET|POST /api/sites`, `POST /api/sites/check`,
`PATCH|DELETE /api/sites/:id`, `GET|POST /api/stores`, `PATCH|DELETE /api/stores/:id`.

## Workstation · Posting bot (Telegram, runs with the PC off)

Every card that reaches **Edited** with a brand, title, description (the card's caption), hashtags and a
video under 50 MB is scheduled automatically (`src/poster.js`, every 5 minutes while Workstation runs).
- **Slots:** the brand's next free **11:00** or **19:00** local time (inside the 10–12 and 16–22 posting
  windows), at least 20 minutes ahead. Two posts a day per brand.
- **Serial number:** each brand counts its own posts (`post_no`: Coded Film #001, #002…).
- **Telegram:** the video is uploaded once to the bot (@Workstation_poster_bot), silently, and its file
  id is kept (`tg_file_id`). The post is queued on the cloud bot, **brand-poster** on Vercel
  (`brand-poster/`, https://brand-poster.vercel.app), and the card moves to **Scheduled**.
- **At post time:** cron-job.org calls the cloud bot at the slots (`0,15 11,19 * * *`, Africa/Lagos; the :15
  calls retry anything that failed). It sends the video, then the
  copy-ready text (brand, post number, title, description, hashtags) with a **✅ Mark as posted** button.
  Tapping it moves the card to **Posted** next time Workstation syncs.
- **Copy rule:** every description is written from discovery keywords taken from the video itself (the
  topic, the named things in it, the phrases people search for), and the hashtags are made from those
  same keywords plus the brand tag.
- **Setup:** all on free plans (Vercel Hobby with a Blob store, cron-job.org; no trials). The token, chat
  id and keys are in Vercel env and Workstation settings (`poster_*`); generated keys are in
  `~/.brand-poster.json`. Content → **📨 Posting bot** shows the status, **Run now**, Settings and the
  cron URL. See `brand-poster/README.md`.

Endpoints: `GET /api/poster`, `POST /api/poster/settings`, `POST /api/poster/run`,
`POST /api/poster/webhook`.

**Free-plan limits (Vercel Blob on Hobby).** Each month you get 2,000 writes/listings and 10,000 reads, and that
allowance is shared by brand-poster and testloop-cloud. If you go over, the store pauses for 30 days rather than
charging you. To stay inside it:
- The queue is one file, written only when a post changes.
- cron-job.org calls only at the slot times.
- Workstation syncs the posting bot every 15 minutes and TestLoop every 10.
- Don't shorten these intervals.

**Brand slots and post-by times.** A brand can have its own slots in the setting `poster_slots_<brandId>`
(Community Info since 9 Nov 2026: `09:00,10:00,11:00,12:00,13:00,15:00,17:00,18:00,19:00,21:00`, up to 10 posts a
day). The cloud bot only sends when cron-job.org calls it, so the cron job's hours must include every slot in use
(`0,15 9-21 * * *` covers these). A card with `post_by` (match predictions)
is never given a slot after that time; its note says so instead, and you can post it by hand or drop it.

## Community Info (football brand, called Pitch Prophet until 8 Nov 2026): data → film → queue

Daily football predictions made from data only: no match footage, no club crests.

| Step | Command | Output |
|---|---|---|
| Briefing | `npm run sports -- briefing [date]` | `data/sports/briefings/<date>.json/.md`: matches, model probabilities, odds, form, tables, story angles, picks, 18+ disclaimer |
| Film | `npm run sports:render -- [date] --format long\|short` | `<lemo>/films/pitch-prophet-<date>-<format>/`: `<name>.mp4`, `.srt`, `post.json` |
| Queue | `npm run sports -- queue [date]` | Content cards at **Edited** for the posting bot, with title, description, hashtags and `post_by` |
| Track record | `npm run sports -- grade` | `data/sports/track-record.json` from finished results |
| Model check | `npm run sports -- backtest [PL] [from] [to]` | walk-forward accuracy and log loss v a naive baseline |

- **Data:** football-data.org (`FOOTBALL_DATA_TOKEN`: tables, fixtures, results for 11 club competitions) and API-Football
  (`API_FOOTBALL_KEY`: every fixture on a date, plus bookmaker odds; 100 requests a day, 15 kept in reserve). Both
  calls honour each API's rate-limit headers and are cached in `data/sports/cache/`. A briefing whose history fails
  to load stops rather than publishing skewed numbers.
- **Model** (`src/sports/model.js`): Dixon-Coles with time decay and shrinkage, fitted on two seasons of every
  competition together. Jan–May 2026 walk-forward on PL/LaLiga/Serie A/Bundesliga: ~50% right, log loss 1.020 v 1.080
  naive. Cross-league ties (European cups) blend 40% model / 60% market. Value picks need model ≥ 40%, ≥ 4 points over
  the bookmaker's fair price, odds 1.40–4.00.
- **Film** (`src/sports/film/`): a lemo-opuscar page in the Sports Telestrator board style (home yellow, away cyan,
  warnings red). Long = sting, today's card, per match title / form / xG pitch / scoreline heat map / model v bookies /
  angle, league table, picks + disclaimer, end card. Short = hook, pitch, scorelines, form, angle, "full breakdown on
  YouTube". Narration (`src/sports/narration.js`) is one Kokoro line per scene written from the numbers (voice
  `SPORTS_VOICE`, default `am_fenrir`); each scene stretches to its line. `mix.py` adds a coded groove (ducked under
  the voice) and foley; lemo's `mux.sh` masters to −14 LUFS. Matches kicking off before `--from` (12:00) are left
  out, since the posts go out from 11:00. Over 49 MB, an upload copy is made for Telegram.
- **Daily run (a day ahead since 9 Nov 2026):** `npm run sports:daily` grades past days, builds **tomorrow's** briefing,
  makes both films, queues them for tomorrow (full video 11:00, short later that day) and sends one status message to
  the owner's Telegram (done, quiet day or failed). Once queued, the cloud posts them even if the laptop is off on
  match day. Windows Task Scheduler runs it at 11:00 as **Pitch Prophet daily** (`scripts/sports-task.ps1`).
  `--date` picks another day. A day already queued is left alone; a run for today only covers matches at least an
  hour away; a day with no major match makes no match videos. The Nigerian league (NPFL) is not covered. Logs: `data/sports/logs/`. The laptop must be
  on, or able to wake (Power Options → Allow wake timers → Enable); if it's missed, the task runs at next start.
- **Voice environment:** `data/sports/voice-env` holds Kokoro for scheduled runs. Packages installed from a Claude
  session land in the Claude app's private folder (`%LOCALAPPDATA%\Packages\Claude_*\LocalCache`), which programs
  outside it, including Task Scheduler, can't see.
- **Nigeria radar:** `npm run sports:nigeria` runs after every daily run. It finds every Nigeria national team
  playing tomorrow and the results from yesterday (football through API-Football: Super Eagles, Super Falcons, Olympic
  Eagles, Flying Eagles, Falconets, Golden Eaglets, Flamingos; basketball through API-Basketball on the same key:
  D'Tigers, D'Tigress), makes a short for each (preview posted on match day; result in the next free slot; at most 3
  of each a day; youth sides get no odds talk), and ranks the last two days of Nigeria sport news from Google News
  (NPFL clubs, betting tips and politics filtered out). The top six stories go to Community Info's Videos → Idea tab and the
  whole list to Telegram. Saved in `data/sports/nigeria/<day>.json/.md`. Auto videos use API facts only.
- **Story videos:** the Claude desktop scheduled task **Community Info: Nigeria story videos** (13:30 daily, while the
  app is open) picks up to two radar stories, checks every fact in two sources, writes a special
  (`src/sports/specials/story-<day>-<name>.mjs`), renders the short and queues it. Covered stories:
  `data/sports/nigeria/covered.json`.
- **Special editions:** one-off stories outside the daily briefing live in `src/sports/specials/<slug>.mjs` (checked facts,
  sources, scenes, narration, copy and slots). Make them with `npm run sports:special -- <slug> --format long|short`, then
  `npm run sports -- queue <slug>`. No odds or betting picks on youth tournaments.
- **Brand kit:** images are drawn by `src/sports/brand/index.html`; the files and channel text are in
  `Claude outputs/community-info-brand/`.
- **Track record:** only days that were actually queued count (`data/sports/published/`), and only picks shown on screen.
- **Copy rules:** titles, descriptions and hashtags come from the teams, competitions and numbers in the film;
  the long video's description carries YouTube chapters. The short (also for TikTok) never mentions odds, bookmakers
  or the market. By the owner's decision the videos carry no spoken disclaimer; the only on-screen notice is a small
  18+ tag on the long video's picks screen. Videos end on "Do you want daily predictions? Follow Community Info or
  subscribe." The written descriptions still say "Predictions, not guarantees. 18+".
- **Slots:** the bot gives the full video the 11:00 slot and the short the latest free slot after 11:00 and before its
  kick-off (`slot_pref`: `HH:MM` / `late`, optionally with a date: `2026-11-21 11:00`, `2026-11-21 late`; anything
  else, e.g. `next`, takes the next free slot). A late run moves the full video to the next free slot. `npm run sports -- queue
  <date> --replace` swaps a remade film into a card that hasn't been sent yet.

## Workstation · TestLoop bot in the cloud

The TestLoop Telegram bot runs on Vercel at https://testloop-cloud.vercel.app (`testloop-cloud/`), not on this PC.
Telegram sends its messages there by webhook. cron-job.org runs the nightly strikes/reminder pass at
`5 20 * * *` UTC (21:05 WAT) via `/api/tick?key=CRON_SECRET`. The data is one JSON file in the Blob store `testloop-db`.
WorkLens → TestLoop is connected to that URL with the same `SYNC_TOKEN`.
- **Don't start the local `testloop-bot/` while the webhook is set.**
- The daily "testloop-daily-check" task checks `/health`.
- Details are in `testloop-cloud/README.md`.

## Workstation · Social connections

Performance numbers come from each platform's official API, through a free developer app the
person creates themselves. The Settings → Social connections card has setup steps for each:

| Platform | How it connects | What WorkLens reads or does |
|---|---|---|
| YouTube | Google OAuth (Web client; redirect `http://localhost:4317/api/social/callback/youtube`) | Subscribers, lifetime and 28-day views, watch hours, net subscribers; every upload with privacy, scheduled publish time, views, likes and comments; uploads a Content item (private, or private with `publishAt`) |
| Instagram | Long-lived token pasted from the Meta app (Instagram API with Instagram Login) | Followers, media count, every post with caption, likes, comments, and views, reach, shares and saves from post insights. The token is renewed before its 60 days run out |
| TikTok | Login Kit (Desktop) OAuth with PKCE; redirect `…/callback/tiktok` | Followers, likes and video count; the video list with views, likes, comments and shares. Posting stays manual until TikTok's content-posting audit |
| Gumroad | Access token pasted on the Gumroad row | Products and this month's sales and revenue, written onto the Gumroad row (refunds excluded) |

- Every sync (every 6 hours, or **Sync now**) stores a daily snapshot, so the account page can show
  a follower trend and the 7-day change. App secrets and tokens are encrypted with Electron
  `safeStorage` in the desktop app.
- An expired sign-in shows on the account page with a **Reconnect** button.
- Google projects that haven't passed YouTube's API audit can only upload private videos.
- Clicking a link opens it in the default browser, which is also where Google and TikTok sign-in
  happens.

Endpoints: `GET|PUT /api/social/settings`, `GET /api/social/connections`,
`POST /api/social/connect/:provider`, `GET /api/social/callback/:provider`,
`POST /api/social/connections/:id/sync`, `PATCH|DELETE /api/social/connections/:id`,
`POST /api/social/sync-all`, `GET /api/social/accounts/:accountId`,
`POST /api/social/youtube/upload`. `GET /api/version` reports which build is answering. The
desktop app checks it on launch, and if an older copy of WorkLens is still running it says so
instead of silently showing that copy.

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
