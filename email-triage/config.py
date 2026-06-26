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

# >>> EDIT THIS for each client. This is what makes the tool feel bespoke. <<<
# Tailored for: the OWNER of an independent insurance agency, who also produces.
TRIAGE_CRITERIA = """\
You are triaging the inbox of the OWNER of an independent insurance agency, who
also works as a producing agent. He is short on time and wants to spend it only
on what truly matters — to his clients, to winning new business, and to running
the agency.

Rate each email's importance:

- "urgent": needs his attention today.
  * A client reporting a claim or loss (accident, injury, fire, theft, water
    damage, etc.) — someone needs help right now.
  * A policy about to cancel, lapse, or non-renew, or a missed/failed payment
    that could leave a client without coverage.
  * A binding or underwriting deadline, or an effective-date issue, where
    coverage depends on a fast response.
  * A hot new lead or quote request — a prospect ready to buy. New business is
    time-sensitive; leads go cold fast.
  * Anything from a state insurance department or regulator, or about his
    license, E&O coverage, or continuing-education deadlines.
  * As the owner: legal threats, anything endangering the business, or a serious
    payroll/staff/vendor/carrier problem that can't wait.

- "high": matters and needs action soon (this week), but not today.
  * Existing-client requests: coverage changes, policy questions, adding a
    vehicle/driver/property, certificates of insurance, document requests.
  * New-business follow-ups and referrals that aren't same-day.
  * Carrier or underwriter requests for information, commission statements, or
    notices that need his review.
  * Owner/operations decisions due this week (finances, vendors, hiring, agency
    management).

- "medium": worth being aware of, but no personal action needed.
  * Routine carrier updates, FYI notices, market/industry news that informs
    decisions, non-urgent internal or staff updates.

- "low": newsletters, marketing, automated portal notifications that are purely
  informational, receipts, promotions, social notifications, mass sends.

Treat as LOW by default: bulk marketing, "no-reply" automated carrier/portal
emails that are purely informational, lead-vendor spam, and anything that reads
like a mass send rather than a genuine 1:1 message.

Treat as HIGHER: messages from actual clients/policyholders and real prospects,
anything mentioning a claim, a deadline, money owed or owing, a policy effective
or cancellation date, and direct questions addressed to him by name. Because he
OWNS the agency, also surface business-level matters (legal, financial, staffing,
key carrier/vendor relationships) that a non-owner agent could safely ignore.
"""
