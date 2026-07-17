"""Configuration for the email triage tool.

This is the file you tailor per client. The TRIAGE_CRITERIA string below is the
single most important knob: it tells Claude what "important" means *for this
specific person*. Edit it to match how your client actually works.
"""

import os

from dotenv import load_dotenv

load_dotenv()

# --- Anthropic ---------------------------------------------------------------
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
# Claude Opus 4.8 is the most capable model. Drop to "claude-sonnet-4-6" if you
# want to cut cost on high email volume.
TRIAGE_MODEL = os.environ.get("TRIAGE_MODEL", "claude-opus-4-8")

# --- Gmail -------------------------------------------------------------------
# Read-only is all we need. This is a Google "restricted" scope — for a single
# client, keep the OAuth app in "Testing" mode and add them as a test user so
# you don't need Google's CASA security review. See README.
GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

# Where OAuth files live (relative to this folder).
CREDENTIALS_FILE = "credentials.json"  # downloaded from Google Cloud Console
TOKEN_FILE = "token.json"              # created automatically after first login

# --- Triage behaviour --------------------------------------------------------
# The client marks an email "done" by applying THIS Gmail label to it. Until
# they do, it keeps appearing in the digest — so an email they read but meant to
# come back to doesn't silently disappear. Reading an email is NOT enough to drop
# it; only applying this label is. Create the label once in Gmail
# (Settings -> Labels -> Create new label) named exactly this. Keep it one word
# (no spaces) so the search query below stays simple.
HANDLED_LABEL = os.environ.get("HANDLED_LABEL", "Handled")

# Default Gmail search: everything in the inbox that ISN'T handled yet, within a
# recent window so the list can't grow forever. Tweak the window to taste:
#   in:inbox -label:Handled              -> no time limit (persists until handled)
#   in:inbox -label:Handled newer_than:14d
# Note: we deliberately INCLUDE Gmail's "Promotions" category now — that's where
# most carrier marketing lands, and we want it captured so it can be bundled into
# the digest's separate marketing section. Social notifications stay excluded.
DEFAULT_QUERY = (
    f"in:inbox -label:{HANDLED_LABEL} newer_than:30d"
    "-category:social"
)

# How many of the most-recent emails to pull from Gmail and analyze each run.
# Pulling a bit more than we show gives the importance ranking something to
# trim from when the inbox is busy.
SCAN_LIMIT = 150

# How many emails the digest actually shows. Everything is ranked by importance
# first, so when there are MORE than this many, the LOWEST-priority ones are
# dropped first — urgent/high always make the cut. Low-priority mail still shows
# as long as you're under the limit.
DIGEST_LIMIT = 100

# Emails are analyzed in batches of this size (one Claude call per batch) so a
# big inbox is processed reliably instead of in one oversized request.
TRIAGE_BATCH_SIZE = 40

# Importance levels that count as "important enough" to trigger an extra,
# off-schedule digest when running with --only-if-new (the afternoon/evening
# runs). A new low/medium email won't interrupt the client; a new urgent/high
# one will.
NOTIFY_IMPORTANCE = ["urgent", "high"]

# Remembers which emails have already gone out in a digest, so later runs can
# tell what's genuinely new. Safe to delete — it just resets that memory.
STATE_FILE = "state.json"

# Each email body is truncated to this many characters before going to Claude,
# to control token cost. Most emails are well under this.
MAX_BODY_CHARS = 2500

# --- Emailing the digest -----------------------------------------------------
# Used by `python main.py --email` and the scheduler. We send via SMTP (not the
# Gmail API) so the read-only Gmail scope stays untouched. For a Gmail sender,
# use an App Password (Google account -> Security -> App passwords), not the
# normal password — that requires 2-Step Verification to be on.
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER")          # the sending account
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD")  # app password
EMAIL_FROM = os.environ.get("EMAIL_FROM")        # defaults to SMTP_USER
# Comma-separated list of recipients (e.g. the client, cc yourself).
EMAIL_TO = [a.strip() for a in os.environ.get("EMAIL_TO", "").split(",") if a.strip()]

# Time of day the scheduler sends the digest (24h "HH:MM", local time).
DAILY_RUN_TIME = os.environ.get("DAILY_RUN_TIME", "07:00")

# --- Per-client triage criteria ---------------------------------------------
# This is the ONE thing you customize per customer. It's kept in a plain-text
# file (criteria.txt) so you can tailor it for each person WITHOUT editing any
# code — just open criteria.txt, rewrite it for their job, and redeploy.
#
# To onboard a new customer: edit criteria.txt to describe who they are and what
# "urgent / high / medium / low" means for their work. If criteria.txt is missing
# for any reason, the built-in default below is used so the tool never breaks.

_DEFAULT_CRITERIA = """\
You are triaging the inbox of a busy professional who is short on time and wants
to spend it only on what truly matters — to their clients, their business, and
the people who depend on them.

Rate each email's importance:

- "urgent": needs their attention today. A real person with a time-sensitive
  problem, a hard deadline, money at risk, or anything that endangers the
  business if ignored.
- "high": matters and needs action this week, but not today. Genuine client or
  prospect requests, follow-ups, and business decisions that aren't same-day.
- "medium": worth being aware of, but no personal action needed. FYI notices,
  routine updates, industry news.
- "low": newsletters, marketing, automated notifications, receipts, promotions,
  social notifications, and anything that reads like a mass send.

Treat as LOW by default: bulk marketing, "no-reply" automated emails that are
purely informational, and anything that reads like a mass send rather than a
genuine 1:1 message.

Treat as HIGHER: real messages from actual clients and prospects, anything
mentioning a deadline, money owed or owing, and direct questions addressed to
them by name.
"""


def _load_criteria() -> str:
    """Read criteria.txt next to this file; fall back to the default if absent."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "criteria.txt")
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read().strip()
        return text or _DEFAULT_CRITERIA
    except FileNotFoundError:
        return _DEFAULT_CRITERIA


TRIAGE_CRITERIA = _load_criteria()
