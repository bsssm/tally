#!/usr/bin/env bash
# Exercises the passphrase key source end to end through the CLI, non-interactively, in a sandbox.
# Needs a real OpenRouter key in OPENROUTER_API_KEY because `tally connect` validates it online
# before anything is stored. Nothing touches ~/.tally or the macOS Keychain.
#
#   OPENROUTER_API_KEY=sk-or-v1-... bash scripts/passphrase-test.sh
#
# Interactive variant (the prompt itself): leave TALLY_PASSPHRASE unset and run the same `connect`
# with TALLY_KEY_SOURCE=passphrase in a terminal; clack asks "Passphrase to protect your stored API keys".
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$root/packages/cli/dist/bin/index.js"
[ -f "$bin" ] || { echo "run pnpm build first"; exit 1; }
[ -n "${OPENROUTER_API_KEY:-}" ] || { echo "set OPENROUTER_API_KEY (a real key; connect validates it)"; exit 2; }

work="$(mktemp -d -t tally-pass.XXXXXX)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home"
base=(env HOME="$work/home" TALLY_HOME="$work/th" TALLY_KEY_SOURCE=passphrase NO_COLOR=1)

fail() { echo "FAIL: $1"; exit 1; }

echo "1. default command: no passphrase asked, no salt written"
"${base[@]}" node "$bin" </dev/null >/dev/null || fail "wallet failed"
[ ! -e "$work/th/salt" ] || fail "salt created by the wallet"

echo "2. connect with TALLY_PASSPHRASE set: key stored under a passphrase-derived master key"
out="$("${base[@]}" TALLY_PASSPHRASE='correct horse battery' node "$bin" connect openrouter --key "$OPENROUTER_API_KEY" </dev/null 2>&1)" || { echo "$out"; fail "connect failed"; }
echo "$out" | grep -q "passphrase master key" || { echo "$out"; fail "connect did not report the passphrase source"; }
[ -e "$work/th/salt" ] && [ -e "$work/th/keycheck" ] || fail "salt/keycheck missing after connect"
if grep -qF "$OPENROUTER_API_KEY" "$work/th/tally.db"; then fail "plaintext key found in tally.db"; fi

echo "3. sync with the right passphrase works"
"${base[@]}" TALLY_PASSPHRASE='correct horse battery' node "$bin" sync --days 7 </dev/null >/dev/null 2>&1 || fail "sync with the right passphrase failed"

echo "4. sync with the wrong passphrase is refused with master-key-mismatch"
set +e
out="$("${base[@]}" TALLY_PASSPHRASE='wrong horse' node "$bin" sync --days 7 </dev/null 2>&1)"
code=$?
set -e
[ "$code" -ne 0 ] || fail "wrong passphrase was accepted"
echo "$out" | grep -q "does not match" || { echo "$out"; fail "unexpected error for a wrong passphrase"; }

echo "5. providers (read-only) never asks for the passphrase"
"${base[@]}" node "$bin" providers </dev/null >/dev/null || fail "providers needed the passphrase"

echo "PASS: passphrase path"
