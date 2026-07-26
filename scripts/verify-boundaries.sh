#!/usr/bin/env bash
#
# Tests the architecture tests.
#
# `pnpm boundaries` passing proves nothing on its own — a config with a typo'd
# path regex also passes, silently, forever. This script additionally injects a
# known-bad import into packages/domain and asserts that dependency-cruiser
# rejects it. If the rules ever stop working, CI fails here rather than three
# months later when a Prisma import has quietly settled into the domain layer.
#
# Usage: pnpm boundaries:verify

set -euo pipefail

cd "$(dirname "$0")/.."

PROBE="packages/domain/src/__boundary-probe.ts"
INDEX="packages/domain/src/index.ts"
BACKUP=""

# Restore only if a backup was actually taken.
#
# The earlier version created the temp file up front with mktemp and restored
# "if the file exists" — but mktemp creates an *empty* file immediately, so any
# exit before the copy (a failing step 1, a Ctrl-C) wrote that empty file over
# index.ts and silently truncated real source. Guarding on a non-empty BACKUP
# variable, set only after a successful cp, makes the restore impossible to
# trigger before there is something to restore.
cleanup() {
  rm -f "$PROBE"
  if [[ -n "$BACKUP" && -s "$BACKUP" ]]; then
    mv "$BACKUP" "$INDEX"
  fi
}
trap cleanup EXIT

echo "==> 1/2  the real graph must be clean"
pnpm exec depcruise --config .dependency-cruiser.cjs apps packages

echo
echo "==> 2/2  a deliberate violation must be rejected"

tmp="$(mktemp)"
cp "$INDEX" "$tmp"
# Only now is a restore meaningful.
BACKUP="$tmp"

cat > "$PROBE" <<'PROBE_EOF'
// Injected by scripts/verify-boundaries.sh. Never committed.
import { Injectable } from '@nestjs/common';
import { defineConfig } from 'vitest/config';
export const probe = { Injectable, defineConfig };
PROBE_EOF
echo "export * from './__boundary-probe.js';" >> "$INDEX"

if pnpm exec depcruise --config .dependency-cruiser.cjs apps packages > /dev/null 2>&1; then
  echo "FAIL: dependency-cruiser accepted a framework import inside packages/domain."
  echo "      The boundary rules in .dependency-cruiser.cjs are not doing their job."
  exit 1
fi

echo "    ok — violation correctly rejected"
echo
echo "Boundary enforcement verified."
