#!/bin/bash
# Downloads Firefox's form autofill test pages (46 saved checkout, shipping, and
# sign-in pages from 19 retailers) into eval/corpus/firefox, with the test files
# that list the fields Firefox expects on each page. The pages are copies of
# other companies' sites and Firefox's README says they aren't open source, so
# they are git-ignored rather than committed. The expected fields Umete scores
# against are hand-checked and committed in labels/firefox (see firefox-labels.js).
set -euo pipefail
cd "$(dirname "$0")"
DEST=corpus/firefox
REPO=mozilla-firefox/firefox
TEST=browser/extensions/formautofill/test
RAW=https://raw.githubusercontent.com/$REPO/main/$TEST
list() {
  gh api "repos/$REPO/contents/$TEST/$1" --jq '.[] | "\(.type) \(.name)"' 2>/dev/null \
    || curl -sf "https://api.github.com/repos/$REPO/contents/$TEST/$1" | python3 -c 'import json,sys; print("\n".join(f"{f[\"type\"]} {f[\"name\"]}" for f in json.load(sys.stdin)))'
}
mkdir -p "$DEST"
count=0
while read -r kind site; do
  [ "$kind" = dir ] || continue
  mkdir -p "$DEST/$site"
  tests="$DEST/$site/browser_$site.js"
  [ -s "$tests" ] || curl -sfL "$RAW/browser/heuristics/third_party/browser_$site.js" -o "$tests"
  while read -r type name; do
    [ "$type" = file ] && [[ "$name" == *.html ]] || continue
    [ -s "$DEST/$site/$name" ] || curl -sfL "$RAW/fixtures/third_party/$site/$name" -o "$DEST/$site/$name"
    count=$((count + 1))
  done < <(list "fixtures/third_party/$site")
done < <(list fixtures/third_party)
echo "$count pages in eval/$DEST"
