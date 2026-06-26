"""Send the HTML digest by email over SMTP.

We deliberately send via SMTP rather than the Gmail API so the app keeps its
read-only Gmail scope (it can never send from the client's account). The digest
goes out from a sending account you control (e.g. your own Gmail App Password).
"""

from __future__ import annotations

import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import config


def send_digest_email(html: str, subject: str) -> None:
    """Email the rendered HTML digest to config.EMAIL_TO."""
    if not (config.SMTP_USER and config.SMTP_PASSWORD and config.EMAIL_TO):
        raise RuntimeError(
            "Email not configured. Set SMTP_USER, SMTP_PASSWORD, and EMAIL_TO "
            "in your .env (see .env.example)."
        )

    sender = config.EMAIL_FROM or config.SMTP_USER

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = ", ".join(config.EMAIL_TO)
    # Plain-text fallback for clients that don't render HTML.
    msg.attach(MIMEText("Your inbox digest is in the HTML version of this email.",
                        "plain"))
    msg.attach(MIMEText(html, "html"))

    context = ssl.create_default_context()
    with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT) as server:
        server.starttls(context=context)
        server.login(config.SMTP_USER, config.SMTP_PASSWORD)
        server.sendmail(sender, config.EMAIL_TO, msg.as_string())
