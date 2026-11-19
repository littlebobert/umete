#!/bin/bash
# Downloads Chromium's autofill heuristics corpus (about 180 saved real-world
# forms, each with the expected field types) into eval/corpus/chromium.
# The pages are copies of other companies' sites, so they are git-ignored
# rather than committed. Chromium's test data is BSD-licensed.
set -euo pipefail
cd "$(dirname "$0")"
DEST=corpus/chromium
BASE=https://raw.githubusercontent.com/chromium/chromium/main/components/test/data/autofill/heuristics
mkdir -p "$DEST"
names=$(gh api repos/chromium/chromium/contents/components/test/data/autofill/heuristics/input --jq '.[].name' 2>/dev/null \
  || curl -sf https://api.github.com/repos/chromium/chromium/contents/components/test/data/autofill/heuristics/input | python3 -c 'import json,sys; print("\n".join(f["name"] for f in json.load(sys.stdin)))')
count=0
for name in $names; do
  stem="${name%.*}"
  [ -s "$DEST/$name" ] && [ -s "$DEST/$stem.out" ] && { count=$((count + 1)); continue; }
  curl -sfL "$BASE/input/$name" -o "$DEST/$name"
  curl -sfL "$BASE/output/$stem.out" -o "$DEST/$stem.out" || rm -f "$DEST/$stem.out"
  count=$((count + 1))
done
echo "$count forms in eval/$DEST"
