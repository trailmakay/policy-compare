# AI Inbox Triage

Scans a Gmail inbox, uses Claude to decide which emails actually matter, and
produces a ranked digest with 2-sentence summaries and action items — so the
client only spends reading time on what counts.

```
Gmail  ──OAuth──►  fetch recent emails  ──►  Claude (Opus 4.8)  ──►  digest.html
                                              triage + summarize
```

## What it does

- Logs into Gmail with **read-only** access (standard Google OAuth)
- Pulls recent emails (configurable search query)
- Sends them to Claude, which rates each **urgent / high / medium / low**, flags
  whether the client personally needs to act, and writes a short summary
- Outputs a ranked terminal summary **and** a clean `digest.html`

## Setup

### 1. Install

```bash
cd email-triage
python -m venv .venv && source .venv/bin/activate
pip install -U -r requirements.txt
```

### 2. Anthropic API key

```bash
cp .env.example .env
# edit .env and paste your key from https://console.anthropic.com/
```

### 3. Gmail access (one-time Google setup)

This is the part worth understanding before quoting a client a timeline.
`gmail.readonly` is a Google **"restricted" scope**. For a *public* app Google
requires an annual third-party security review (CASA). **For a single client you
skip all of that** by keeping the app in "Testing" mode and adding them as a
test user.

1. Go to <https://console.cloud.google.com/> and create a project.
2. **APIs & Services → Library →** enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen:**
   - User type: **External**
   - Fill in app name / support email (placeholder is fine while testing)
   - **Publishing status: leave as "Testing"**
   - Under **Test users**, add the client's Gmail address (and your own)
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID:**
   - Application type: **Desktop app**
   - Download the JSON and save it here as **`credentials.json`**

> In Testing mode, only the test users you listed can authorize the app, and
> Google shows an "unverified app" warning they click through. That's expected
> and fine for one client. To open it to the public later, that's when the
> security review comes in.

### 4. Run

```bash
python main.py
```

First run opens a browser asking the signed-in Google account to grant access.
After that the token is cached in `token.json` and reused. Output:

- a ranked summary in the terminal
- `digest.html` you can open in a browser (or email to the client)

## Customising per client

Open `config.py`:

- **`TRIAGE_CRITERIA`** — the most important setting. Plain-English description
  of what "important" means for *this* person. This is what makes the tool feel
  bespoke rather than generic.
- **`HANDLED_LABEL`** — the Gmail label the client applies to mark an email done
  (see below). Defaults to `Handled`.
- **`DEFAULT_QUERY`** — which emails to scan. Defaults to "everything in the
  inbox not yet marked handled, from the last 7 days."
- **`DEFAULT_MAX_EMAILS`** — caps how many emails per run (controls API cost).
- **`TRIAGE_MODEL`** — `claude-opus-4-8` (default) or `claude-sonnet-4-6` to
  save cost at high volume.

## How the client marks an email "done"

An email keeps appearing in the digest until the client explicitly marks it
handled — **reading it is not enough**. This is deliberate: it means something
they opened but meant to come back to won't silently vanish and get forgotten.

To mark one done, the client applies a Gmail label (default name: **Handled**):

1. **One-time:** in Gmail, create a label called `Handled`
   (Settings → Labels → Create new label, or the "+" next to Labels in the
   sidebar).
2. **Daily:** when they finish with an email, they apply that label to it —
   select the email → the label icon → `Handled` (or drag it onto the label).
   From the next run on, it's gone from the digest.

Everything still in the inbox without that label keeps showing up, ranked, until
they deal with it. Tweak the label name with `HANDLED_LABEL` in `config.py` (keep
it a single word with no spaces).

## Cost note

Each email is analyzed by Claude **once**, when it's first seen — the result is
cached in `state.json` and reused on later runs. So a quiet check-in run costs
nothing (no new emails = no Claude call), and a busy one only pays for what's
genuinely new. Bodies are truncated to ~2,500 chars and promotions/social are
excluded by default to keep cost and noise down.

The cache auto-clears if you change `TRIAGE_MODEL` or `TRIAGE_CRITERIA`, so edits
to the importance rules always take effect on the next run.

To cut cost further, set `TRIAGE_MODEL=claude-sonnet-4-6` in `.env` — noticeably
cheaper per email, still strong at triage.

## Emailing the digest

Instead of opening `digest.html` by hand, have it emailed. Fill in the SMTP
settings in `.env` (see `.env.example`), then:

```bash
python main.py --email
```

This sends the digest to everyone in `EMAIL_TO`. For a Gmail sender, turn on
2-Step Verification and create an **App Password** (Google Account → Security →
App passwords) — use that as `SMTP_PASSWORD`, not your normal password.

We send via SMTP from *your* sending account, not the client's — so the app
never gets permission to send from their inbox, only to read it.

Useful flags:
- `--email` — send after generating
- `--skip-if-empty` — with `--email`, send nothing when no emails matched
  (otherwise an "all clear" email goes out)

## Scheduling a daily digest

Two options. Cron/launchd is more robust (survives reboots); the built-in
scheduler is zero extra setup.

### Option A — cron (Linux/macOS, recommended)

Ready-to-use lines are in **`crontab.example`**. Run `crontab -e` and paste
them. The schedule: **two guaranteed digests (7am + 9pm)** plus a check **every
other hour** that only emails when a new important message arrived:

```cron
# 7:00am and 9:00pm — always send the full digest, no matter what
0 7,21 * * * cd "/path/to/email-triage" && .venv/bin/python main.py --email >> cron.log 2>&1

# Every other hour (9am, 11am, 1pm, 3pm, 5pm, 7pm) — only email if a new important message arrived
0 9,11,13,15,17,19 * * * cd "/path/to/email-triage" && .venv/bin/python main.py --email --only-if-new >> cron.log 2>&1
```

`--only-if-new` uses a small `state.json` memory file to tell what's genuinely
new since the last digest, so quiet hours stay silent. "Important" means the
levels in `NOTIFY_IMPORTANCE` (default: urgent + high) — edit in `config.py`.
Change the `7` / `21` for different anchor times, or edit the hour list to check
more/less often.

On macOS, `launchd` is the modern equivalent if you prefer a plist; cron still
works fine for this.

### Option B — built-in scheduler (any OS)

Set `DAILY_RUN_TIME` in `.env`, then leave this running:

```bash
python scheduler.py
```

It waits until the configured time each day and runs `main.py --email`.

> Note: cron/launchd survive reboots; `scheduler.py` only runs while its
> terminal/process is alive. For a real deployment, prefer cron or run the
> scheduler under a process manager.

## Going further

- **Host the OAuth as a web flow** so the client clicks "Connect Gmail" in a
  browser rather than running a script once.
- **Only email when it matters** — tweak `--skip-if-empty`, or edit the send
  logic to only email when there's at least one urgent/high item.
- **Store results** so you can track trends and avoid re-scanning.

## Files

| File | Purpose |
|------|---------|
| `main.py` | CLI entry point |
| `config.py` | Settings + the per-client triage criteria |
| `gmail_client.py` | OAuth login + fetch/parse emails |
| `triage.py` | Sends emails to Claude, returns structured triage |
| `digest.py` | Console + HTML digest rendering |
| `mailer.py` | Emails the HTML digest over SMTP |
| `state.py` | Remembers what's been sent (for `--only-if-new`) |
| `scheduler.py` | Optional always-on daily scheduler |

## Security

`.env`, `credentials.json`, and `token.json` are secrets and are gitignored —
never commit them. The app only ever **reads** email; it has no permission to
send, delete, or modify anything.
