# TestLoop bot

The tester-facing half of TestLoop. It runs in the cloud so it answers 24/7, and WorkLens
(Studio tools → TestLoop) is where you manage everything it collects.

```
Tester ──Telegram──▶ TestLoop bot (Railway) ◀──sync every 2 min── WorkLens (your PC)
                        │  SQLite on a volume        approve / strike / day / announce ──▶
                        └─▶ main group, logs group, WhatsApp
```

No npm dependencies: it uses Node 22's built-in `fetch` and `node:sqlite`.

## What it does

| Where | What |
|---|---|
| `/start` (private chat) | Asks for Gmail, then 2 screenshots (Play listing showing Uninstall/Open + app open) |
| Screenshot check | `gpt-4o` via OpenRouter. Valid → tester is active, gets the Play link and group invite. Invalid → asked to resend. AI unavailable → queued for you in WorkLens |
| `/feedback <text>` | Over 10 characters, scored 1–5 by `gpt-4o-mini`, posted to the main group |
| `/check` | The tester's day X/14, feedback count, strikes |
| `/help`, `/rules` | Rules and the 3-strike system |
| `/announce <text>` | Admins only. Posts to the main group and WhatsApp |
| 21:00 WAT nightly | Strike for no feedback in 48h (3 = removed), day 7 retention proof request, day 14 completion, reminder in the main group |

## 1. Telegram setup

1. Open **@BotFather** → `/newbot` → pick a name and username → copy the token to `BOT_TOKEN`.
2. In BotFather: `/setcommands`, choose your bot, paste:
   ```
   start - Join closed testing
   check - My day and strikes
   feedback - Send feedback
   help - Rules and commands
   rules - Short rules
   ```
3. Create two groups: **Due soon Testers HQ** (main) and **TestLoop Logs** (just you). Add the bot to both and make it **admin**.
4. Get the group IDs: add **@RawDataBot** (or @userinfobot) to each group, read the `chat.id` (looks like `-100…`), then remove it. Put them in `MAIN_GROUP_ID` and `LOGS_GROUP_ID`.
5. Your own user ID: message **@userinfobot** → put it in `ADMIN_IDS`.
6. Main group → Invite links → create one → `MAIN_GROUP_INVITE`.

## 2. Deploy on Railway

1. Push this repo to GitHub. In Railway: **New project → Deploy from GitHub repo**.
2. Service **Settings → Root directory**: `worklens/testloop-bot`. Start command: `npm start`.
3. **Add a volume** mounted at `/data` (otherwise testers are wiped on every deploy).
4. **Variables**: everything from `.env.example`, with `DATA_DIR=/data`. Generate `SYNC_TOKEN` with
   `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
5. **Settings → Networking → Generate domain**. Open `https://<domain>/health` and it should say `{"ok":true,…}`.
6. Keep it at **one replica**: two copies polling Telegram conflict.

## 3. Connect WorkLens

WorkLens → **TestLoop** → **Connect bot** → paste `https://<domain>` and the `SYNC_TOKEN` → Save & sync.

From then on:
- New testers and feedback appear within 2 minutes (or click **Sync now**).
- **Approve / Reject** in the verification queue messages the tester through the bot.
- Changing a status to Need proof or a Strike messages the tester. Day edits are mirrored.
- **Send via bot** in the Announcement box posts to the main group and WhatsApp.

## 4. WhatsApp (optional)

WhatsApp's Cloud API **cannot post into WhatsApp groups**. It sends to individual numbers.
TestLoop sends announcements to each number in `WHATSAPP_RECIPIENTS`.

1. developers.facebook.com → **My Apps → Create app → Business** → add **WhatsApp**.
2. **WhatsApp → API Setup**: copy the **Phone number ID** → `WHATSAPP_PHONE_ID`.
3. Create a permanent token: Business Settings → **System users** → add → generate token with
   `whatsapp_business_messaging` → `WHATSAPP_TOKEN` (the 24h test token expires).
4. Add a real phone number and verify it, or use the test number with up to 5 verified recipients.
5. Rule to know: free-form text only reaches people who messaged your number in the last 24 hours.
   For everyone else, create an approved **template** in WhatsApp Manager. Until then, use
   **Copy** in WorkLens and paste the announcement into your WhatsApp group by hand.

## Run locally

```bash
cp .env.example .env    # fill BOT_TOKEN and SYNC_TOKEN at least, DATA_DIR=data
npm run dev
```

Stop the Railway service first. Only one copy may poll a bot token at a time.
Connect WorkLens to `http://localhost:3000` to test the sync.

## API (used by WorkLens)

All except `/health` need `Authorization: Bearer <SYNC_TOKEN>`.

- `GET /sync?since=<cursor>` → `{ cursor, testers[], feedback[] }` changed after the cursor
- `POST /admin/testers/:id` with `{ action: "approve" | "reject" | "remove", reason? }` or `{ status, strikes, started_on }`
- `POST /admin/announce` with `{ text }`
