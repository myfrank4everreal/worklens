# Google Form: Due soon closed testing application

Create at forms.google.com, then copy these in.

**Title:** Due soon - Closed Testing Application (Test for Test)

**Description:**
> Join a strict 14-day closed testing community for Due soon, a task and due-date manager for Android.
> You install and keep Due soon for 14 days and send feedback at least every 48 hours. In return we
> test your app the same way. No feedback for 48h = 1 strike; 3 strikes and you're out.
> After you apply, our Telegram bot verifies your install with 2 screenshots.

| # | Question | Type | Required | Validation / options |
|---|---|---|---|---|
| 1 | Full Name | Short answer | Yes | |
| 2 | Gmail (the one on your Play Store) | Short answer | Yes | Response validation → Regular expression → Contains → `@gmail.com` |
| 3 | Telegram Username (with @) | Short answer | Yes | Regular expression → Matches → `^@[A-Za-z0-9_]{5,}$` |
| 4 | Phone (WhatsApp), e.g. +234… | Short answer | Yes | Regular expression → Matches → `^\+\d{7,15}$` |
| 5 | Device model + Android version | Short answer | Yes | e.g. Tecno Spark 10 · Android 13 |
| 6 | Link to YOUR app (Play testing link) | Short answer | Yes | Text → URL |
| 7 | I agree to keep Due soon installed for 14 days, open it daily, send feedback every 48h, and accept the 3-strike rule | Checkboxes (one box) | Yes | |
| 8 | How did you find us? | Dropdown | No | Facebook, Reddit, Friend, Other |

**Settings**
- Responses → link to a new sheet named **Due soon - Testers DB**.
- Confirmation message: *"Thanks! Now open https://t.me/YourBotUsername and press Start to verify."*

**Getting applicants into TestLoop**
In the sheet: **File → Download → CSV**, then WorkLens → TestLoop → **Import CSV**. Applicants land in
the verification queue, and when the same Gmail later completes `/start` in Telegram the two
records merge. A Status column for n8n isn't needed; WorkLens tracks status.
