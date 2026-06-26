"""Run a set of realistic insurance-agency emails through the REAL Claude triage.

No Gmail needed — this uses hand-written sample emails so you can check (and
tune) how well the triage ranks the kind of mail your client actually gets, and
demo the tool without connecting a live inbox.

    python demo.py

Writes demo_digest.html and prints the ranked result.
"""

from __future__ import annotations

import config
import digest
from gmail_client import Email
from triage import triage_emails

# A spread of mail a producing agency owner would realistically receive.
SAMPLES = [
    Email(id="s1", thread_id="t1",
          sender="Maria Gonzalez <maria.g@email.com>", sender_email="maria.g@email.com",
          subject="CAR ACCIDENT this morning - need to file a claim",
          date="", snippet="",
          body="Hi, I was rear-ended on the highway this morning. Everyone's okay "
               "but my car is pretty damaged and undriveable. What do I need to do "
               "to file a claim? Can you call me today? My number is 555-0142."),
    Email(id="s2", thread_id="t2",
          sender="Progressive Billing <no-reply@progressive.com>", sender_email="no-reply@progressive.com",
          subject="FINAL NOTICE: Policy #AU-88213 will cancel for non-payment",
          date="", snippet="",
          body="The auto policy for your client D. Thompson is past due and will be "
               "CANCELLED on June 20 if payment is not received. Coverage will lapse."),
    Email(id="s3", thread_id="t3",
          sender="James Carter <jcarter.home@email.com>", sender_email="jcarter.home@email.com",
          subject="Quote for homeowners insurance?",
          date="", snippet="",
          body="A friend referred me to you. We just bought a house at 14 Oak Lane and "
               "need homeowners coverage before closing on the 25th. Can you put "
               "together a quote? Looking to move quickly."),
    Email(id="s4", thread_id="t4",
          sender="Linda Pham <linda.pham@email.com>", sender_email="linda.pham@email.com",
          subject="Adding my teenage son to our auto policy",
          date="", snippet="",
          body="Our son just got his license. We'd like to add him to our policy. "
               "What info do you need and how will it affect our premium?"),
    Email(id="s5", thread_id="t5",
          sender="Underwriting - Travelers <uw_team@travelers.com>", sender_email="uw_team@travelers.com",
          subject="Docs needed to bind commercial policy - Hartwell LLC",
          date="", snippet="",
          body="To bind the commercial GL policy for Hartwell LLC we need the signed "
               "application and a loss run by end of week. Effective date is July 1."),
    Email(id="s6", thread_id="t6",
          sender="Nationwide Commissions <statements@nationwide.com>", sender_email="statements@nationwide.com",
          subject="Your May commission statement is available",
          date="", snippet="",
          body="Your commission statement for May is now available in the agent portal. "
               "Total: $4,210.55. Log in to view the breakdown."),
    Email(id="s7", thread_id="t7",
          sender="Insurance Journal <newsletter@insurancejournal.com>", sender_email="newsletter@insurancejournal.com",
          subject="This Week in Insurance: market trends & top stories",
          date="", snippet="",
          body="The latest headlines from the insurance industry, plus our weekly "
               "roundup of carrier news and regulatory updates. Read more online."),
    Email(id="s8", thread_id="t8",
          sender="LeadGen Pro <sales@leadgenpro.com>", sender_email="sales@leadgenpro.com",
          subject="🔥 Get 50 exclusive insurance leads - LIMITED TIME 40% OFF",
          date="", snippet="",
          body="Supercharge your agency! Sign up today for our exclusive lead program "
               "and get 40% off your first month. Don't miss out — offer ends Friday!"),
    Email(id="s9", thread_id="t9",
          sender="Dawn at Smith & Co CPA <dawn@smithcpa.com>", sender_email="dawn@smithcpa.com",
          subject="Q2 estimated tax payment due + payroll question",
          date="", snippet="",
          body="Hi — your Q2 estimated tax payment is due June 16. Also, I need your "
               "approval on the updated payroll run for the two new staff before "
               "Friday so everyone gets paid on time."),
    Email(id="s10", thread_id="t10",
          sender="Agency Portal <noreply@agencyportal.com>", sender_email="noreply@agencyportal.com",
          subject="Your monthly activity report is ready",
          date="", snippet="",
          body="Your automated monthly activity summary has been generated and is "
               "available to download from the dashboard. No action required."),
]


def main() -> None:
    if not config.ANTHROPIC_API_KEY:
        raise SystemExit("Set ANTHROPIC_API_KEY in .env first.")
    print(f"Running {len(SAMPLES)} sample insurance emails through {config.TRIAGE_MODEL}...\n")
    results = triage_emails(SAMPLES)
    digest.print_console(results)
    path = digest.write_html(results, "demo_digest.html")
    print(f"Demo digest written to: {path}")


if __name__ == "__main__":
    main()
