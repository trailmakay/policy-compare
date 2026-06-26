"""The AI part: send fetched emails to Claude and get structured triage back.

We send a batch of emails in one request and ask Claude to return a JSON array
(one entry per email) using structured outputs, so the result is guaranteed to
match our schema and is safe to parse.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import anthropic

import config
from gmail_client import Email

# Importance levels, ordered most -> least important (used for sorting).
IMPORTANCE_ORDER = ["urgent", "high", "medium", "low"]

# Structured-output schema. Claude is constrained to return exactly this shape.
_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "email_id": {"type": "string"},
                    "importance": {
                        "type": "string",
                        "enum": IMPORTANCE_ORDER,
                    },
                    "needs_action": {"type": "boolean"},
                    "is_marketing": {"type": "boolean"},
                    "summary": {"type": "string"},
                    "action_items": {"type": "array", "items": {"type": "string"}},
                    "reason": {"type": "string"},
                },
                "required": [
                    "email_id",
                    "importance",
                    "needs_action",
                    "is_marketing",
                    "summary",
                    "action_items",
                    "reason",
                ],
                "additionalProperties": False,
            },
        }
    },
    "required": ["results"],
    "additionalProperties": False,
}


@dataclass
class TriageResult:
    """Claude's verdict on one email, joined back to the original Email."""

    email: Email
    importance: str
    needs_action: bool
    is_marketing: bool
    summary: str
    action_items: list[str]
    reason: str

    @property
    def rank(self) -> int:
        try:
            return IMPORTANCE_ORDER.index(self.importance)
        except ValueError:
            return len(IMPORTANCE_ORDER)


def result_to_cache(r: "TriageResult") -> dict:
    """Serialize a result for storage (everything except the email itself)."""
    return {
        "importance": r.importance,
        "needs_action": r.needs_action,
        "is_marketing": r.is_marketing,
        "summary": r.summary,
        "action_items": r.action_items,
        "reason": r.reason,
    }


def result_from_cache(email: Email, d: dict) -> "TriageResult":
    """Rebuild a result from a cached dict plus the (current) email."""
    return TriageResult(
        email=email,
        importance=d["importance"],
        needs_action=d["needs_action"],
        is_marketing=d.get("is_marketing", False),
        summary=d["summary"],
        action_items=d["action_items"],
        reason=d["reason"],
    )


def _build_prompt(emails: list[Email]) -> str:
    """Render the batch of emails into a single prompt block for Claude."""
    blocks = []
    for e in emails:
        blocks.append(
            f"--- EMAIL id={e.id} ---\n"
            f"From: {e.sender}\n"
            f"Subject: {e.subject}\n"
            f"Date: {e.date}\n"
            f"Body:\n{e.body or e.snippet}\n"
        )
    joined = "\n".join(blocks)
    return (
        "Triage the following emails. Return one result object per email, using "
        "the exact email id given. Write the summary in 1-2 plain sentences. "
        "List concrete action items only if the recipient personally needs to do "
        "something; otherwise return an empty list.\n\n"
        "Set is_marketing to true when the email is a promotional or marketing "
        "message rather than a real 1:1 message — e.g. insurance carrier product "
        "announcements, bulletins, newsletters, webinar/event invites, sales "
        "promotions, and lead-vendor pitches. For these, still write a short "
        "one-line summary of what's being promoted. Set is_marketing to false for "
        "genuine client, prospect, carrier-servicing, or business messages.\n\n"
        f"{joined}"
    )


def _triage_batch(client, emails: list[Email]) -> list[TriageResult]:
    """Triage one batch of emails in a single Claude call."""
    response = client.messages.create(
        model=config.TRIAGE_MODEL,
        max_tokens=16000,
        system=config.TRIAGE_CRITERIA,
        messages=[{"role": "user", "content": _build_prompt(emails)}],
        output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
    )

    # With output_config.format set, the first text block is guaranteed valid JSON.
    text = next(b.text for b in response.content if b.type == "text")
    parsed = json.loads(text)

    by_id = {e.id: e for e in emails}
    out: list[TriageResult] = []
    for item in parsed["results"]:
        email = by_id.get(item["email_id"])
        if email is None:
            continue  # skip any id Claude didn't echo back correctly
        out.append(
            TriageResult(
                email=email,
                importance=item["importance"],
                needs_action=item["needs_action"],
                is_marketing=item.get("is_marketing", False),
                summary=item["summary"],
                action_items=item["action_items"],
                reason=item["reason"],
            )
        )
    return out


def triage_emails(emails: list[Email]) -> list[TriageResult]:
    """Triage all emails in reliable batches and return ranked results."""
    if not emails:
        return []

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    size = config.TRIAGE_BATCH_SIZE
    batches = [emails[i:i + size] for i in range(0, len(emails), size)]

    results: list[TriageResult] = []
    for n, batch in enumerate(batches, 1):
        if len(batches) > 1:
            print(f"  batch {n}/{len(batches)} ({len(batch)} emails)...")
        try:
            results.extend(_triage_batch(client, batch))
        except Exception as e:  # one bad batch shouldn't sink the whole run
            print(f"  warning: batch {n} failed ({e}); will retry next run.")

    results.sort(key=lambda r: r.rank)
    return results
