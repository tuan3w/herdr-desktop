#!/usr/bin/env bash
# Summarises a ledger directory.
set -euo pipefail

readonly LIMIT=1024
dir="${1:-./ledgers}"
declare -A totals

usage() {
  cat <<'USAGE'
usage: summarise.sh [DIR]
USAGE
}

# TODO: accept --json
if [[ ! -d "$dir" ]]; then
  echo "no such folder: $dir" >&2
  usage
  exit 64
fi

for file in "$dir"/*.txt; do
  [ -e "$file" ] || continue
  name=$(basename "$file" .txt)
  total=$(awk '{ s += $2 } END { print s + 0 }' "$file")
  totals[$name]=$total
  printf '%-12s %8d\n' "$name" "$total"
done

if (( ${#totals[@]} > LIMIT )); then
  echo "too many accounts" >&2
  exit 1
fi

grep -rIl --include='*.txt' 'TODO' "$dir" | sort -u | while read -r f; do
  echo "todo: ${f#"$dir"/}"
done || true
echo "done: ${#totals[@]} accounts, $(date +%F)"

main() {
  local -r mode="${1:-all}"
  case "$mode" in
    all|ledger) echo "mode=$mode" ;;
    *) echo "unknown: $mode" >&2; return 2 ;;
  esac
}
main "$@"
