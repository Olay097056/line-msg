#!/usr/bin/env bash
# Apply SQL migrations to Supabase via the Management API.
#
# Usage:  SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... ./supabase/apply.sh
#         ./supabase/apply.sh path/to/one.sql     # single file
#
# Migrations are idempotent, so re-running the whole directory is safe.
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN}"
: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF}"

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
files=("$@")
if [ ${#files[@]} -eq 0 ]; then
  files=("$dir"/migrations/*.sql)
fi

for f in "${files[@]}"; do
  echo "--> $(basename "$f")"
  payload=$(python -c 'import json,sys; print(json.dumps({"query": open(sys.argv[1], encoding="utf-8").read()}))' "$f")
  code=$(curl -s -o /tmp/supa_apply_out -w '%{http_code}' \
    -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")
  if [ "$code" != "201" ] && [ "$code" != "200" ]; then
    echo "    FAILED http=$code"
    cat /tmp/supa_apply_out
    exit 1
  fi
  echo "    ok http=$code $(head -c 200 /tmp/supa_apply_out)"
done
