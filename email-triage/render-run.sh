#!/usr/bin/env bash
set -e

# Write Gmail token from env var (Render stores it as a secret)
echo "$GMAIL_TOKEN_JSON" > token.json

python main.py --email
