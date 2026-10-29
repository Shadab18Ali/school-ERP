#!/usr/bin/env bash
# Applies every migration to an EMPTY Postgres database and runs every SQL test in supabase/tests.
# For CI and local checks only — never point it at a real Supabase project.
#   DATABASE_URL=postgresql://user:pass@localhost:5432/erp_ci supabase/tests/ci/run_sql_tests.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
: "${DATABASE_URL:?set DATABASE_URL to an empty test database}"
psql_() { psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 "$@"; }

psql_ -f "$here/supabase_stub.sql" >/dev/null
for f in "$root"/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  psql_ -f "$f" >/dev/null 2>"$here/.err" || { echo "MIGRATION FAILED: $f"; grep -v NOTICE "$here/.err"; exit 1; }
done
echo "migrations applied: $(ls "$root"/migrations/[0-9][0-9][0-9][0-9]_*.sql | wc -l)"

failed=0
for t in "$root"/tests/*.sql; do
  out=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$t" 2>&1) || true
  if grep -q "PASSED" <<<"$out" && ! grep -q "ERROR" <<<"$out"; then
    echo "ok    $(basename "$t")"
  else
    echo "FAIL  $(basename "$t")"; grep -E "ERROR|FAIL" <<<"$out" | head -5; failed=1
  fi
done
rm -f "$here/.err"
exit $failed
