"""Persistent state between runs: what's already been sent, and a cache of
triage results so we never pay Claude twice for the same email.

The cache is the main cost saver. Each email is analyzed by Claude once, when
it's first seen; later runs reuse the stored result. The cache auto-invalidates
if the model or the importance rules change, so edits to TRIAGE_CRITERIA always
take effect.
"""

from __future__ import annotations

import hashlib
import json
import os

import config


def _signature() -> str:
    """Fingerprint of the triage config. If it changes, the cache is stale."""
    raw = f"{config.TRIAGE_MODEL}\n{config.TRIAGE_CRITERIA}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def load() -> dict:
    """Return {"reported_ids": set, "cache": dict, "signature": str}."""
    fresh = {"reported_ids": set(), "cache": {}, "signature": _signature()}
    if not os.path.exists(config.STATE_FILE):
        return fresh
    try:
        with open(config.STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return fresh

    sig = _signature()
    # If the model or criteria changed, drop the cached triage results.
    cache = data.get("cache", {}) if data.get("signature") == sig else {}
    return {
        "reported_ids": set(data.get("reported_ids", [])),
        "cache": cache,
        "signature": sig,
    }


def save(reported_ids: set[str], cache: dict) -> None:
    """Persist reported IDs and the triage-result cache."""
    with open(config.STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(
            {
                "reported_ids": sorted(reported_ids),
                "cache": cache,
                "signature": _signature(),
            },
            f,
        )
