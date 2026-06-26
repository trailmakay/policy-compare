"""Entry point: scan Gmail, triage with Claude, write a digest, optionally email it.

    python main.py                          # generate digest, no email
    python main.py --email                  # always email the digest (the anchor run)
    python main.py --email --only-if-new    # email ONLY if a new important email arrived
    python main.py --query "is:unread"      # custom Gmail search
    python main.py --max-emails 10          # cap how many to scan

Typical schedule: morning + evening runs with --email (always send), plus a few
daytime runs with --email --only-if-new (send only when something new and
important shows up). To keep cost low, each email is analyzed by Claude only
once — later runs reuse the cached result (see state.py).
"""

from __future__ import annotations

import argparse
import sys
from datetime import date

import config
import digest
import state
import triage as triage_mod
from gmail_client import fetch_emails, get_service
from triage import triage_emails


def _subject(results, new_results=None) -> str:
    """Subject line. If new_results is given, summarise just the new items."""
    src = new_results if new_results is not None else results
    counts: dict[str, int] = {}
    for r in src:
        counts[r.importance] = counts.get(r.importance, 0) + 1
    parts = [f"{counts[k]} {k}" for k in ["urgent", "high"] if counts.get(k)]
    head = ", ".join(parts) if parts else "nothing urgent"
    tag = " new" if new_results is not None else ""
    return f"Inbox Digest — {head}{tag} · {date.today():%b %d}"


def main() -> int:
    parser = argparse.ArgumentParser(description="AI inbox triage + digest")
    parser.add_argument("--query", default=config.DEFAULT_QUERY,
                        help="Gmail search query for which emails to scan")
    parser.add_argument("--max-emails", type=int, default=config.SCAN_LIMIT,
                        help="Maximum number of emails to pull and analyze")
    parser.add_argument("--out", default="digest.html",
                        help="Path to write the HTML digest")
    parser.add_argument("--email", action="store_true",
                        help="Email the digest to EMAIL_TO after generating it")
    parser.add_argument("--only-if-new", action="store_true",
                        help="With --email, only send if a new important email "
                             "has arrived since the last digest")
    parser.add_argument("--skip-if-empty", action="store_true",
                        help="With --email, don't send an all-clear when no emails matched")
    args = parser.parse_args()

    if not config.ANTHROPIC_API_KEY:
        print("ERROR: ANTHROPIC_API_KEY is not set. Copy .env.example to .env "
              "and add your key.", file=sys.stderr)
        return 1

    print("Connecting to Gmail...")
    service = get_service()

    print(f"Fetching up to {args.max_emails} emails matching: {args.query}")
    emails = fetch_emails(service, args.query, args.max_emails)
    print(f"Fetched {len(emails)} emails.")

    st = state.load()
    reported = st["reported_ids"]
    cache = st["cache"]

    if not emails:
        print("Nothing to triage.")
        state.save(set(), {})  # inbox is clear; reset memory + cache
        if args.email and not args.only_if_new and not args.skip_if_empty:
            from mailer import send_digest_email
            send_digest_email(digest.render_html([]),
                              f"Inbox Digest — all clear · {date.today():%b %d}")
            print(f"Sent an all-clear email to {', '.join(config.EMAIL_TO)}.")
        return 0

    # Cost saver: only send Claude the emails we haven't analyzed before.
    new_emails = [e for e in emails if e.id not in cache]
    print(f"{len(emails) - len(new_emails)} already analyzed (cached), "
          f"{len(new_emails)} new to analyze.")

    if new_emails:
        print(f"Analyzing {len(new_emails)} new email(s) with {config.TRIAGE_MODEL}...")
        for r in triage_emails(new_emails):
            cache[r.email.id] = triage_mod.result_to_cache(r)

    # Drop cache entries for emails no longer in the inbox (handled/aged out).
    by_id = {e.id: e for e in emails}
    cache = {eid: v for eid, v in cache.items() if eid in by_id}

    # Build the full ranked list from the cache (cached + freshly analyzed).
    results = [
        triage_mod.result_from_cache(by_id[eid], v) for eid, v in cache.items()
    ]
    results.sort(key=lambda r: r.rank)

    # Pull carrier marketing/promotions into their own bundled section.
    marketing = [r for r in results if r.is_marketing]
    main_results = [r for r in results if not r.is_marketing]

    # Already ranked by importance. If there are more than the digest limit, keep
    # the top ones — so the LOWEST-priority emails are the first to get dropped.
    display = main_results[:config.DIGEST_LIMIT]
    if len(main_results) > len(display):
        print(f"Showing top {len(display)} of {len(main_results)} by importance "
              f"(dropped {len(main_results) - len(display)} lowest-priority).")
    if marketing:
        print(f"Bundled {len(marketing)} marketing/promotional emails separately.")

    digest.print_console(display)

    html = digest.render_html(display, marketing=marketing)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"HTML digest written to: {args.out}")

    # What's new and important since the last sent digest?
    current_ids = set(by_id)
    new_important = [
        r for r in results
        if r.importance in config.NOTIFY_IMPORTANCE and r.email.id not in reported
    ]

    if args.email:
        send = (not args.only_if_new) or bool(new_important)
        if send:
            from mailer import send_digest_email
            subject = _subject(display, new_important if args.only_if_new else None)
            send_digest_email(html, subject)
            print(f"Digest emailed to {', '.join(config.EMAIL_TO)}.")
            reported = current_ids  # everything shown has now been seen
        else:
            print("No new important emails since the last digest — not sending.")
            reported = reported & current_ids  # forget anything that left the inbox

    state.save(reported, cache)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
