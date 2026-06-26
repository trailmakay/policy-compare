"""Render triage results as a console summary and a clean HTML digest."""

from __future__ import annotations

import html
from datetime import datetime, timezone

import config
from triage import TriageResult

_BADGE_COLORS = {
    "urgent": "#dc2626",
    "high": "#ea580c",
    "medium": "#ca8a04",
    "low": "#64748b",
}


def print_console(results: list[TriageResult]) -> None:
    """Print a compact ranked summary to the terminal."""
    if not results:
        print("No emails matched — nothing to triage.")
        return

    print(f"\nTriaged {len(results)} emails. Ranked by importance:\n")
    for r in results:
        action = " [ACTION NEEDED]" if r.needs_action else ""
        print(f"[{r.importance.upper()}]{action}  {r.email.subject}")
        print(f"    from: {r.email.sender}")
        print(f"    {r.summary}")
        for item in r.action_items:
            print(f"      - {item}")
        print()


def render_html(results: list[TriageResult], marketing: list[TriageResult] | None = None) -> str:
    """Build a standalone HTML digest the client can open or be emailed."""
    marketing = marketing or []
    counts = {}
    for r in results:
        counts[r.importance] = counts.get(r.importance, 0) + 1
    summary_line = " · ".join(
        f"{counts[k]} {k}" for k in ["urgent", "high", "medium", "low"] if counts.get(k)
    ) or "nothing to report"

    timestamp = datetime.now(timezone.utc).strftime("%B %-d, %Y · %-I:%M %p UTC")

    cards = []
    for r in results:
        color = _BADGE_COLORS.get(r.importance, "#64748b")
        action_html = ""
        if r.action_items:
            items = "".join(
                f"<li>{html.escape(i)}</li>" for i in r.action_items
            )
            action_html = f'<ul class="actions">{items}</ul>'
        action_flag = (
            '<span class="flag">ACTION NEEDED</span>' if r.needs_action else ""
        )
        cards.append(
            f"""
        <div class="card">
          <div class="card-head">
            <span class="badge" style="background:{color}">{r.importance.upper()}</span>
            {action_flag}
            <a class="subject" href="{html.escape(r.email.gmail_link)}" target="_blank">
              {html.escape(r.email.subject)}
            </a>
          </div>
          <div class="from">{html.escape(r.email.sender)}</div>
          <p class="summary">{html.escape(r.summary)}</p>
          {action_html}
        </div>"""
        )

    # Separate "Carrier marketing & promotions" section — bundled, with links.
    mkt_section = ""
    if marketing:
        rows = "".join(
            f"""
        <div class="mkt-row">
          <a class="mkt-subject" href="{html.escape(m.email.gmail_link)}" target="_blank">
            {html.escape(m.email.subject)}</a>
          <div class="mkt-meta">{html.escape(m.email.sender)} — {html.escape(m.summary)}</div>
        </div>"""
            for m in marketing
        )
        mkt_section = f"""
    <div class="mkt">
      <h2 class="mkt-h">Carrier marketing &amp; promotions · {len(marketing)}</h2>
      <p class="mkt-note">Bundled out of your way — open any that interest you.</p>
      {rows}
    </div>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inbox Digest</title>
<style>
  body {{ font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#f8fafc;
         color:#0f172a; margin:0; padding:32px; }}
  .wrap {{ max-width:720px; margin:0 auto; }}
  h1 {{ font-size:22px; margin:0 0 4px; }}
  .sub {{ color:#64748b; margin:0 0 24px; font-size:14px; }}
  .card {{ background:#fff; border:1px solid #e2e8f0; border-radius:12px;
           padding:16px 18px; margin-bottom:14px; }}
  .card-head {{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }}
  .badge {{ color:#fff; font-size:11px; font-weight:700; padding:2px 8px;
            border-radius:999px; letter-spacing:.03em; }}
  .flag {{ background:#fee2e2; color:#b91c1c; font-size:11px; font-weight:700;
           padding:2px 8px; border-radius:999px; }}
  .subject {{ font-weight:600; color:#0f172a; text-decoration:none; font-size:15px; }}
  .subject:hover {{ text-decoration:underline; }}
  .from {{ color:#64748b; font-size:13px; margin:6px 0 0; }}
  .summary {{ margin:10px 0 0; font-size:14px; line-height:1.5; }}
  .actions {{ margin:10px 0 0; padding-left:20px; font-size:14px; }}
  .actions li {{ margin:2px 0; }}
  .footer {{ color:#94a3b8; font-size:12px; margin-top:22px; line-height:1.5; }}
  .mkt {{ margin-top:28px; border-top:1px solid #e2e8f0; padding-top:18px; }}
  .mkt-h {{ font-size:15px; margin:0 0 2px; color:#334155; }}
  .mkt-note {{ color:#94a3b8; font-size:12px; margin:0 0 12px; }}
  .mkt-row {{ padding:8px 0; border-bottom:1px solid #f1f5f9; }}
  .mkt-subject {{ font-size:14px; color:#0f172a; text-decoration:none; font-weight:500; }}
  .mkt-subject:hover {{ text-decoration:underline; }}
  .mkt-meta {{ color:#64748b; font-size:12px; margin-top:2px; }}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Inbox Digest</h1>
    <p class="sub">{summary_line} · {timestamp}</p>
    {''.join(cards) if cards else '<p>No emails matched — nothing to triage.</p>'}
    {mkt_section}
    <p class="footer">Done with one? Apply the
      &ldquo;{html.escape(config.HANDLED_LABEL)}&rdquo; label to it in Gmail and it
      drops off tomorrow&rsquo;s digest. Just reading it won&rsquo;t remove it.</p>
  </div>
</body>
</html>
"""


def write_html(results, path: str = "digest.html", marketing=None) -> str:
    with open(path, "w", encoding="utf-8") as f:
        f.write(render_html(results, marketing))
    return path
