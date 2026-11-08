#!/usr/bin/env bash
# Scope packet for a herdr-review: what changed since <base>, in risk order, with the tests and docs that name each
# changed file, and the exported names the change removed that are still referenced. It is the plan for the review,
# not the review.
#
#   review_packet.sh [base]      base defaults to HEAD (uncommitted work); any rev works
#
# Read-only: it never touches the tree or the index. Always exits 0, so a caller never mistakes an empty packet for a
# failure. bash 3.2 (macOS) compatible; uses only git and grep.
set -u

cd "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || { echo "# Review packet"; echo "not inside a git repository"; exit 0; }

base="${1:-HEAD}"
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "# Review packet"
  echo "base '$base' is not a commit"
  exit 0
fi

dirty="$(git status --short | wc -l | tr -d ' ')"
tab="$(printf '\t')"
nl='
'

echo "# Review packet"
echo
echo "- base: $(git log -1 --format='%h %s' "$base")"
echo "- head: $(git log -1 --format='%h %s' HEAD)"
echo "- modified or untracked files in the working tree: $dirty"
if [ "$dirty" -gt 0 ]; then
  echo
  echo "The working tree has $dirty modified or untracked files, often another person's or agent's unfinished work."
  echo "Review only the files you were asked about; do not stash, checkout, reset or format."
fi

# Risk rank: the engine and the answer path first, then lib, screens, kit, tests, docs.
rank_of() {
  case "$1" in
    native/*|scripts/*|.github/*|Makefile) echo 0 ;;
    lib/*.test.ts|components/*.test.tsx|App.test.tsx|app-seam.ts) echo 3 ;;
    lib/*|App.tsx) echo 1 ;;
    components/kit/*) echo 1 ;;
    components/*) echo 2 ;;
    *) echo 4 ;;
  esac
}

records=""
paths=""
while IFS="$tab" read -r a d p; do
  [ -z "$p" ] && continue
  [ "$a" = "-" ] && a=0
  [ "$d" = "-" ] && d=0
  records="$records$(rank_of "$p") $((a + d)) $a $d $p$nl"
  paths="$paths$p$nl"
done <<EOF
$(git diff --numstat "$base" 2>/dev/null)
EOF

# Untracked files, minus the ignored scratch space.
while IFS= read -r p; do
  [ -z "$p" ] && continue
  a="$(wc -l < "$p" 2>/dev/null | tr -d ' ')"
  a="${a:-0}"
  records="$records$(rank_of "$p") $a $a 0 $p$nl"
  paths="$paths$p$nl"
done <<EOF
$(git ls-files -o --exclude-standard)
EOF

echo
echo "## Changes (risk order)"
echo
if [ -z "$paths" ]; then
  echo "none"
else
  printf '%s' "$records" | sort -k1,1n -k2,2nr | while read -r rk total a d p; do
    echo "+$a -$d  $p"
  done
fi

# Source files (TS and Rust, not tests) whose tests and docs we look up.
src_files=""
while IFS= read -r p; do
  case "$p" in
    *.test.ts|*.test.tsx) ;;
    lib/*.ts|components/*.tsx|components/kit/*.ts|components/kit/*.tsx|native/*.rs|native/*/src/*.rs|native/*/src/*/*.rs)
      src_files="$src_files$p$nl" ;;
  esac
done <<EOF
$paths
EOF

echo
echo "## Tests that name each changed file (a Rust file is named by its own module's tests: read it)"
echo
if [ -z "$src_files" ]; then
  echo "none"
else
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$p" in native/*) echo "$p: Rust, see native/*/tests and the #[cfg(test)] modules"; continue ;; esac
    name="$(basename "$p")"; name="${name%.tsx}"; name="${name%.ts}"
    hits="$(grep -rlE --include='*.test.ts' --include='*.test.tsx' "[\"'/#]$name[\"']" lib components App.test.tsx .shots .perf 2>/dev/null | sort | tr '\n' ',' | sed 's/,$//; s/,/, /g')"
    own=""
    [ -f "${p%.*}.test.ts" ] && own="${p%.*}.test.ts"
    [ -f "${p%.*}.test.tsx" ] && own="${p%.*}.test.tsx"
    echo "$p: ${own:+$own, }${hits:-none}"
  done <<EOF
$src_files
EOF
fi

echo
echo "## Docs that name each changed file (AGENTS.md: docs change in the same change; make docs gates DESIGN.md and design/)"
echo
if [ -z "$src_files" ]; then
  echo "none"
else
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    name="$(basename "$p")"
    hits=""
    for f in AGENTS.md DESIGN.md design/*.md docs/*.md; do
      [ -f "$f" ] || continue
      if grep -qF "$name" "$f" 2>/dev/null; then
        hits="${hits:+$hits, }$f"
      fi
    done
    echo "$p: ${hits:-none}"
  done <<EOF
$src_files
EOF
fi

echo
echo "## Removed exports still referenced (a clean cutover leaves none: AGENTS.md principle 10)"
echo
# Removed declarations from the diff, with the file that removed each. A name that an added line declares again (it
# moved or was edited in place) was not removed.
decl='^[-+][[:space:]]*(export )?(async )?(function|const|let|class|interface|type|enum|pub fn|pub struct|pub enum|pub async fn|fn) +([A-Za-z_][A-Za-z0-9_]*)'
removed=""
added=""
cur=""
while IFS= read -r line; do
  case "$line" in
    "diff --git "*) cur="${line##* b/}"; continue ;;
    "---"*|"+++"*) continue ;;
  esac
  if [[ "$line" =~ $decl ]]; then
    n="${BASH_REMATCH[4]}"
    case "$line" in
      -*) removed="$removed$n $cur$nl" ;;
      +*) added="$added$n$nl" ;;
    esac
  fi
done <<EOF
$(git diff -U0 "$base" -- '*.ts' '*.tsx' '*.rs' 2>/dev/null)
EOF

found=0
seen=""
while read -r n f; do
  [ -z "$n" ] && continue
  case "$nl$seen" in *"$nl$n$nl"*) continue ;; esac
  seen="$seen$n$nl"
  case "$nl$added" in *"$nl$n$nl"*) continue ;; esac
  refs="$(grep -rnw --include='*.ts' --include='*.tsx' --include='*.rs' "$n" lib components native App.tsx App.test.tsx 2>/dev/null | grep -v "^$f:" | head -8)"
  if [ -n "$refs" ]; then
    found=1
    echo "### $n (removed from $f)"
    echo "$refs"
  fi
done <<EOF
$removed
EOF
[ "$found" -eq 0 ] && echo "none"

echo
echo "## Next"
echo
echo "1. Read each changed file with its callers, consumers of added values and its twin (SKILL.md section 2)."
echo "2. Apply the three lenses: bugs, UI/UX from code, maintainability (SKILL.md section 3)."
echo "3. Prove every P1/P2 in a clean copy (references/reproduce.md); never run nsh test without HERDR_DESKTOP_TEST=1."
exit 0
