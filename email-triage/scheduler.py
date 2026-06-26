"""Simple always-on scheduler: emails a digest once a day at DAILY_RUN_TIME.

Run it and leave it running (e.g. on a small server or a spare machine):

    python scheduler.py

It just waits until the configured time each day, then runs
`python main.py --email`. For most production setups, cron or launchd (see
README) is more robust because it survives reboots — use this when you want a
zero-extra-setup option you can start in a terminal.
"""

from __future__ import annotations

import subprocess
import sys
import time
from datetime import datetime, timedelta

import config


def seconds_until(hhmm: str) -> float:
    """Seconds from now until the next occurrence of local time HH:MM."""
    now = datetime.now()
    hour, minute = (int(x) for x in hhmm.split(":"))
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


def main() -> int:
    print(f"Scheduler started. Sending a digest every day at {config.DAILY_RUN_TIME} "
          "(local time). Ctrl-C to stop.")
    while True:
        wait = seconds_until(config.DAILY_RUN_TIME)
        print(f"Next digest in {wait / 3600:.1f}h.")
        time.sleep(wait)
        print(f"[{datetime.now():%Y-%m-%d %H:%M}] Running digest...")
        subprocess.run([sys.executable, "main.py", "--email"])
        time.sleep(61)  # step past the trigger minute so we don't fire twice


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nScheduler stopped.")
