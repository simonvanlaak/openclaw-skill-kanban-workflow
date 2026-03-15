#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  verification_primitives.sh http-status <url> <expected_status>
  verification_primitives.sh file-exists <path>
  verification_primitives.sh file-contains <path> <regex>
  verification_primitives.sh diff-changed <before_path> <after_path>
  verification_primitives.sh metric-threshold <label> <actual> <lt|le|eq|ge|gt> <threshold>
EOF
}

die() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

cmd="${1:-}"
shift || true

case "$cmd" in
  http-status)
    url="${1:-}"
    expected="${2:-}"
    [[ -n "$url" && -n "$expected" ]] || { usage; exit 2; }
    actual="$(curl -sS -o /dev/null -w '%{http_code}' "$url")"
    [[ "$actual" == "$expected" ]] || die "http-status url=$url expected=$expected actual=$actual"
    pass "http-status url=$url status=$actual"
    ;;

  file-exists)
    path="${1:-}"
    [[ -n "$path" ]] || { usage; exit 2; }
    [[ -e "$path" ]] || die "file-exists path=$path missing"
    pass "file-exists path=$path"
    ;;

  file-contains)
    path="${1:-}"
    regex="${2:-}"
    [[ -n "$path" && -n "$regex" ]] || { usage; exit 2; }
    [[ -f "$path" ]] || die "file-contains path=$path missing"
    grep -Eq "$regex" "$path" || die "file-contains path=$path regex=$regex no-match"
    pass "file-contains path=$path regex=$regex"
    ;;

  diff-changed)
    before="${1:-}"
    after="${2:-}"
    [[ -n "$before" && -n "$after" ]] || { usage; exit 2; }
    [[ -f "$before" ]] || die "diff-changed before=$before missing"
    [[ -f "$after" ]] || die "diff-changed after=$after missing"
    if cmp -s "$before" "$after"; then
      die "diff-changed before=$before after=$after no-diff"
    fi
    pass "diff-changed before=$before after=$after"
    ;;

  metric-threshold)
    label="${1:-}"
    actual_raw="${2:-}"
    op="${3:-}"
    threshold_raw="${4:-}"
    [[ -n "$label" && -n "$actual_raw" && -n "$op" && -n "$threshold_raw" ]] || { usage; exit 2; }
    python3 - "$label" "$actual_raw" "$op" "$threshold_raw" <<'PY'
import sys
label, actual_raw, op, threshold_raw = sys.argv[1:5]
actual = float(actual_raw)
threshold = float(threshold_raw)
ops = {
    'lt': actual < threshold,
    'le': actual <= threshold,
    'eq': actual == threshold,
    'ge': actual >= threshold,
    'gt': actual > threshold,
}
if op not in ops:
    print(f"FAIL: metric-threshold label={label} invalid-op={op}", file=sys.stderr)
    sys.exit(2)
if not ops[op]:
    print(f"FAIL: metric-threshold label={label} actual={actual} op={op} threshold={threshold}", file=sys.stderr)
    sys.exit(1)
print(f"PASS: metric-threshold label={label} actual={actual} op={op} threshold={threshold}")
PY
    ;;

  ""|-h|--help|help)
    usage
    ;;

  *)
    usage
    die "unknown command: $cmd"
    ;;
esac
