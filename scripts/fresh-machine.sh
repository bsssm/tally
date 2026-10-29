#!/usr/bin/env bash
# Fresh-machine acceptance test (SPEC §13): a stranger runs `npx tallyai` on a machine with no
# Claude Code logs, no provider key and no Tally store, and gets the wallet's empty state in
# under 60 seconds with exit 0 and no Keychain or passphrase prompt.
#
# Builds, packs packages/cli into a tarball, then installs that tarball with npx inside a temp
# HOME + TALLY_HOME. Set FRESH_KEEP=1 to keep the temp dir, FRESH_SKIP_BUILD=1 to reuse dist/.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
limit="${FRESH_LIMIT_SECONDS:-60}"

if [ -z "${FRESH_SKIP_BUILD:-}" ]; then
  (cd "$root" && pnpm build >/dev/null)
fi

work="$(mktemp -d -t tally-fresh.XXXXXX)"
cleanup() {
  if [ -n "${FRESH_KEEP:-}" ]; then echo "kept $work"; else rm -rf "$work"; fi
}
trap cleanup EXIT

mkdir -p "$work/pack"
tgz_name="$(cd "$root/packages/cli" && npm pack --silent --pack-destination "$work/pack" 2>/dev/null | tail -1)"
tgz="$work/pack/$tgz_name"
[ -f "$tgz" ] || { echo "npm pack produced no tarball"; exit 1; }

fake_home="$work/home"
mkdir -p "$fake_home" "$work/run" "$work/npm-cache"
# A fake HOME has no ~/.claude, no ~/.tally and no npm config; TALLY_HOME keeps the store in the sandbox too.
env_args=(
  HOME="$fake_home"
  TALLY_HOME="$work/tally-home"
  npm_config_cache="$work/npm-cache"
  npm_config_update_notifier=false
  npm_config_fund=false
  npm_config_audit=false
  CI=1
  NO_COLOR=1
)
unset TALLY_MASTER_KEY TALLY_PASSPHRASE TALLY_KEY_SOURCE CLAUDE_CONFIG_DIR 2>/dev/null || true

echo "tarball: $tgz_name ($(du -k "$tgz" | cut -f1) KB)"
echo "running: npx --yes --package $tgz_name tallyai   (HOME=$fake_home)"
start=$(date +%s)
set +e
out="$(cd "$work/run" && env "${env_args[@]}" npx --yes --package "$tgz" tallyai </dev/null 2>&1)"
code=$?
set -e
elapsed=$(( $(date +%s) - start ))

echo "--- output ---"
echo "$out"
echo "--- exit $code in ${elapsed}s ---"

fail() { echo "FAIL: $1"; exit 1; }
[ "$code" -eq 0 ] || fail "exit code $code"
[ "$elapsed" -le "$limit" ] || fail "took ${elapsed}s, limit ${limit}s"
echo "$out" | grep -q "YOUR AI WALLET" || fail "no wallet header in output"
echo "$out" | grep -qi "tally connect openrouter" || fail "empty state does not point at tally connect"
echo "$out" | grep -qi "tally profile" || fail "empty state does not point at tally profile"
if echo "$out" | grep -qi "passphrase"; then fail "a passphrase prompt appeared on the default command"; fi
[ ! -e "$work/tally-home/keycheck" ] || fail "a master key was created on the default command"
[ ! -e "$work/tally-home/salt" ] || fail "a passphrase salt was created on the default command"
[ ! -d "$fake_home/.tally" ] || fail "wrote to ~/.tally despite TALLY_HOME"

# Second run inside the same sandbox: the store exists now, must still be prompt-free and fast.
start=$(date +%s)
(cd "$work/run" && env "${env_args[@]}" npx --yes --package "$tgz" tally </dev/null >/dev/null 2>&1) || fail "second run (tally alias) failed"
echo "second run: $(( $(date +%s) - start ))s"
echo "PASS: fresh machine wallet in ${elapsed}s"
