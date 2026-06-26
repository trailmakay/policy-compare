"""Gmail access: OAuth login + fetching/parsing recent messages.

This handles the "Gmail OAuth" part — the standard Google permission flow. On
first run it opens a browser asking the signed-in user to grant read-only
access; after that the token is cached in token.json and reused silently.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from email.utils import parseaddr

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

import config


@dataclass
class Email:
    """A single fetched email, flattened to the fields triage needs."""

    id: str
    thread_id: str
    sender: str        # display form, e.g. "Jane Doe <jane@co.com>"
    sender_email: str  # just the address
    subject: str
    date: str
    snippet: str
    body: str

    @property
    def gmail_link(self) -> str:
        return f"https://mail.google.com/mail/u/0/#all/{self.id}"


def get_service():
    """Authenticate (browser flow on first run) and return a Gmail API service."""
    creds = None
    if os.path.exists(config.TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(
            config.TOKEN_FILE, config.GMAIL_SCOPES
        )

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(config.CREDENTIALS_FILE):
                raise FileNotFoundError(
                    f"Missing {config.CREDENTIALS_FILE}. Download an OAuth "
                    "'Desktop app' client from Google Cloud Console (see README)."
                )
            flow = InstalledAppFlow.from_client_secrets_file(
                config.CREDENTIALS_FILE, config.GMAIL_SCOPES
            )
            creds = flow.run_local_server(port=0)
        with open(config.TOKEN_FILE, "w") as token:
            token.write(creds.to_json())

    return build("gmail", "v1", credentials=creds)


def _decode_part(data: str) -> str:
    """Decode a base64url-encoded message part to text."""
    return base64.urlsafe_b64decode(data.encode("utf-8")).decode(
        "utf-8", errors="replace"
    )


def _extract_body(payload: dict) -> str:
    """Walk a (possibly multipart) payload and return the best plain-text body."""
    # Prefer text/plain; fall back to text/html stripped of nothing fancy.
    plain, html = "", ""

    def walk(part):
        nonlocal plain, html
        mime = part.get("mimeType", "")
        body = part.get("body", {})
        data = body.get("data")
        if data and mime == "text/plain" and not plain:
            plain = _decode_part(data)
        elif data and mime == "text/html" and not html:
            html = _decode_part(data)
        for sub in part.get("parts", []) or []:
            walk(sub)

    walk(payload)
    text = plain or html
    return " ".join(text.split())  # collapse whitespace


def fetch_emails(service, query: str, max_emails: int) -> list[Email]:
    """Fetch up to ``max_emails`` messages matching the Gmail search ``query``."""
    listing = (
        service.users()
        .messages()
        .list(userId="me", q=query, maxResults=max_emails)
        .execute()
    )
    message_refs = listing.get("messages", [])

    emails: list[Email] = []
    for ref in message_refs:
        msg = (
            service.users()
            .messages()
            .get(userId="me", id=ref["id"], format="full")
            .execute()
        )
        headers = {
            h["name"].lower(): h["value"]
            for h in msg.get("payload", {}).get("headers", [])
        }
        sender = headers.get("from", "(unknown sender)")
        body = _extract_body(msg.get("payload", {}))[: config.MAX_BODY_CHARS]

        emails.append(
            Email(
                id=msg["id"],
                thread_id=msg.get("threadId", ""),
                sender=sender,
                sender_email=parseaddr(sender)[1],
                subject=headers.get("subject", "(no subject)"),
                date=headers.get("date", ""),
                snippet=msg.get("snippet", ""),
                body=body,
            )
        )
    return emails
