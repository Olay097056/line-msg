#!/usr/bin/env bash
# Apply 0003_cron.sql with CRON_SECRET substituted in, without ever printing
# the secret or writing it to a committed file.
#
# Usage: SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... CRON_SECRET=... \
#          ./supabase/set-cron-secret.sh
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN}"
: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF}"
: "${CRON_SECRET:?set CRON_SECRET}"

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

sed "s/__CRON_SECRET__/$CRON_SECRET/" "$dir/migrations/0003_cron.sql" > "$tmp"
bash "$dir/apply.sh" "$tmp"
