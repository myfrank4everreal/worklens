# Brand poster

Sends each scheduled brand post to your Telegram at its time, even when this PC is off.

```
Workstation (PC) ──queue──▶ brand-poster (Vercel Hobby) ◀──every 10 min── cron-job.org
  uploads the video to       posts in Vercel Blob            /api/tick?key=CRON_SECRET
  Telegram once (file id)          │
                                   └─▶ Telegram: video + title, description, hashtags,
                                       "Brand · Post #003", ✅ Mark as posted
```

Everything runs on free plans: Vercel Hobby (functions + Blob store `brand-poster-queue`) and cron-job.org.
No Upstash and no paid cron.

## How a post flows

1. A card on Workstation → Content reaches **Edited** with a brand, title, description (caption), hashtags and video.
2. Within 5 minutes Workstation gives it the brand's next free slot (**11:00** or **19:00**, local time) and the
   brand's next post number. It uploads the video to Telegram once (silently, then deletes that message: the
   file id stays valid) and queues the post here. The card moves to **Scheduled**.
3. cron-job.org calls `/api/tick` every 10 minutes. Due posts are sent to your chat: the video, then the
   copy-ready text with a **✅ Mark as posted** button.
4. Tapping the button marks it posted; Workstation pulls that through `/api/sync` and moves the card to **Posted**.

## Endpoints

| Path | Who | What |
|---|---|---|
| `POST /api/queue`, `DELETE /api/queue?id=` | Workstation (Bearer `ADMIN_SECRET`) | Add / remove a post |
| `GET /api/sync` | Workstation | Post states; `?setup=<url>` registers the Telegram webhook |
| `GET /api/tick?key=` | cron-job.org (`CRON_SECRET`) | Send due posts |
| `POST /api/telegram` | Telegram (`TG_WEBHOOK_SECRET` header) | `/start` (shows your chat id), the Posted button |
| `GET /api/health` | anyone | Which settings exist (never their values) |

## Environment (Vercel → brand-poster → Settings → Environment Variables)

`BOT_TOKEN` (from @BotFather), `CHAT_ID` (yours), `ADMIN_SECRET`, `CRON_SECRET`, `TG_WEBHOOK_SECRET`
(generated at setup and kept in `~/.brand-poster.json` on this PC; Workstation reads them from there),
`BLOB_READ_WRITE_TOKEN` (added by the Blob store).

Deploy: `npx vercel deploy --prod --scope franklymade-hq` from this folder.
