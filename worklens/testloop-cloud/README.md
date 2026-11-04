# TestLoop cloud bot

The TestLoop Telegram bot (`../testloop-bot`) runs on Vercel Hobby here, so it keeps working while this PC is off.
The logic is the same as `testloop-bot/bot.js`: onboarding (Gmail plus 2 screenshots, AI-checked), `/feedback`,
`/check`, `/rules`, `/announce`, the day-7 proof and the nightly strikes. Only the parts around it changed.

| Local bot | Cloud bot |
|---|---|
| getUpdates long-poll loop | Telegram webhook → `/api/telegram` |
| `setInterval` nightly check | cron-job.org, once a day at 20:00 UTC → `/api/tick?key=CRON_SECRET` |
| SQLite file | one JSON file (`db.json`) in the Vercel Blob store `testloop-db`, written only when something changes |
| `http` server | `/health`, `/sync`, `/admin/announce`, `/admin/testers/:id` (same paths, `SYNC_TOKEN`) |

URL: https://testloop-cloud.vercel.app (Vercel project `franklymade-hq/testloop-cloud`).
WorkLens connects with the same `SYNC_TOKEN` (TestLoop → Connect bot).

Environment: the values from `testloop-bot/.env` (the bot token, `SYNC_TOKEN`, OpenRouter, the app, the groups and
`ADMIN_IDS`), plus `CRON_SECRET` and `TG_WEBHOOK_SECRET` (generated, kept in `~/.testloop-cloud.json`) and
`BLOB_READ_WRITE_TOKEN` (added by the store).

- One-time setup: `GET /api/sync?setup=1` (with `SYNC_TOKEN`) points Telegram's webhook here. The local data was
  imported once with `POST /api/sync`.
- **Don't run the local bot at the same time.** While the webhook is set, its long-poll loop gets 409 errors.
- Deploy: `npx vercel deploy --prod --scope franklymade-hq` from this folder.
- Blob limits on Hobby are 2,000 writes/listings a month (shared with brand-poster). Every bot message costs at
  most one write; reads are cheap.
