#!/bin/sh
# Protocol facts come from herdr itself, not from memory.
set -e
cd "$(dirname "$0")/.."
herdr api schema --json > docs/herdr-api.schema.json
echo "docs/herdr-api.schema.json: $(herdr --version 2>/dev/null)"
