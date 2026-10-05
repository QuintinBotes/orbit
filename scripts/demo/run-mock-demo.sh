#!/usr/bin/env bash
# The three demo runs of spec section 2, fully offline: the real controller,
# adapters, evidence runner, UI runner, review and delivery code, with the
# provider CLIs replaced by tests/fakes and GitHub by FakeGitHub. Used in CI.
#
#   scripts/demo/run-mock-demo.sh [--out DIR] [--goals simple,difficult,ui] [--keep] [--json]
#
# --out DIR   where each run's final.md is collected (default: a new temp directory)
# --goals     a comma separated subset of simple, difficult, ui
# --keep      keep the scratch repository, state and worktrees for inspection
# --json      print the result as JSON instead of a table
#
# Needs Node 22.18 or newer, `npm ci` run in the Orbit checkout, and the Playwright
# Chromium (`npx playwright install chromium`). It never calls a model, never
# touches the network (dependencies come from the npm cache, or from this
# checkout's node_modules when the cache is cold) and never prints a secret.
#
# Exit codes: 0 all three runs ended as expected, 1 a run did not, 2 bad arguments,
# 3 the machine cannot run the browser journeys.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "${1:-}" in -h | --help)
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 0
  ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "node is required (22.18 or newer)" >&2
  exit 2
fi
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' || {
  echo "Node 22.18 or newer is required, found $(node -v)" >&2
  exit 2
}
if [ ! -d "$root/node_modules" ]; then
  echo "run 'npm ci' in $root first" >&2
  exit 2
fi

# Provider and GitHub credentials are never needed here; make sure none leaks into a fake run.
unset GH_TOKEN GITHUB_TOKEN ANTHROPIC_API_KEY CODEX_API_KEY OPENAI_API_KEY

cd "$root"
exec node --experimental-transform-types --no-warnings scripts/demo/mock-demo.ts "$@"
