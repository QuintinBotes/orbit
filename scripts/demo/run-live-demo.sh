#!/usr/bin/env bash
# The three demo runs of spec section 2, unattended, with the live providers:
# Claude writes, Codex reviews, and the delivery adapter opens real draft pull
# requests on a private GitHub repository made from examples/demo-app.
#
#   scripts/demo/run-live-demo.sh --repo OWNER/NAME [options]
#
# --repo OWNER/NAME   REQUIRED, never defaulted. The private repository to use. It is created
#                     when missing (only with --yes, or after you confirm) and reused when it
#                     exists and is private. A public repository is refused.
# --out DIR           where each run's final.md goes (default: docs/demos/<today> in this checkout)
# --workdir DIR       where the local clone lives (default: a new temp directory)
# --goals LIST        comma separated subset of simple, difficult, ui (default: all three)
# --orbit COMMAND     how to start Orbit (default: node plugin/dist/orbit.mjs from this checkout)
# --yes               do not ask before creating the repository or pushing the first commit
# --dry-run           print what would happen and stop; creates and runs nothing
#
# Credentials, kept apart on purpose:
#   * Setting up the repository uses YOUR `gh auth login` session (GH_TOKEN and GITHUB_TOKEN
#     are removed from the environment of those steps).
#   * The runs use GH_TOKEN, which you must export: a fine-grained token scoped to this one
#     repository with Contents, Pull requests and Actions read/write. Orbit refuses a broad
#     keyring login for unattended delivery. Workers never see it.
# This script never prints a token and passes every line of output through a redaction filter.
#
# Costs money: the live providers are billed. Cap: scheduler.hard_limits.model_cost_usd per run
# in examples/demo-app/.orbit/config.yaml.
#
# Exit codes: 0 all three runs SUCCEEDED, 1 a run did not, 2 bad arguments or missing
# prerequisites, 3 doctor failed.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
example="$root/examples/demo-app"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}
die() {
  echo "error: $*" >&2
  exit 2
}

repo="" out="" workdir="" goals="simple,difficult,ui" orbit_cmd="" assume_yes=0 dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 || die "--repo needs a value" ;;
    --repo=*) repo="${1#--repo=}"; shift ;;
    --out) out="${2:-}"; shift 2 || die "--out needs a value" ;;
    --workdir) workdir="${2:-}"; shift 2 || die "--workdir needs a value" ;;
    --goals) goals="${2:-}"; shift 2 || die "--goals needs a value" ;;
    --orbit) orbit_cmd="${2:-}"; shift 2 || die "--orbit needs a value" ;;
    --yes) assume_yes=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

if [ -z "$repo" ]; then
  usage >&2
  die "--repo OWNER/NAME is required. This script creates or reuses a GitHub repository and pushes to it, so it never guesses one."
fi
[[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] || die "--repo must look like OWNER/NAME, got: $repo"
name="${repo#*/}"

IFS=',' read -r -a goal_list <<<"$goals"
for g in "${goal_list[@]}"; do
  case "$g" in simple | difficult | ui) ;; *) die "unknown goal: $g (choose from simple, difficult, ui)" ;; esac
done

today="$(date +%F)"
out="${out:-$root/docs/demos/$today}"

# Everything printed passes through this. Orbit redacts its own logs; this is the second line of defence.
# Line-buffered, or progress only shows when a run ends: BSD sed spells it -l, GNU sed -u.
if sed --version >/dev/null 2>&1; then sed_lines=-u; else sed_lines=-l; fi
redact() {
  sed "$sed_lines" -E \
    -e 's/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/[redacted]/g' \
    -e 's/sk-ant-[A-Za-z0-9_-]{8,}/[redacted]/g' \
    -e 's/sk-[A-Za-z0-9_-]{20,}/[redacted]/g' \
    -e 's#((Bearer|bearer|BEARER|Authorization:|authorization:|token|TOKEN|password|PASSWORD|secret|SECRET|api[_-]?key|API[_-]?KEY)[=: ]+)[A-Za-z0-9._~+/=-]{16,}#\1[redacted]#g'
}
say() { printf '%s\n' "$*" | redact; }

# gh with your own login only: the scoped token below is for the runs, not for setup.
gh_admin() { env -u GH_TOKEN -u GITHUB_TOKEN gh "$@"; }

if [ -z "$orbit_cmd" ]; then
  if [ -f "$root/plugin/dist/orbit.mjs" ]; then
    orbit_cmd="node $root/plugin/dist/orbit.mjs"
  else
    orbit_cmd="node --experimental-transform-types --no-warnings $root/src/cli/main.ts"
  fi
fi

say "plan"
say "  repository : $repo (private)"
say "  local clone: ${workdir:-<new temp directory>}"
say "  goals      : $goals"
say "  reports    : $out"
say "  orbit      : $orbit_cmd"
if [ "$dry_run" = 1 ]; then
  say "dry run: nothing created, nothing run"
  exit 0
fi

for tool in git gh node npm claude codex; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required and was not found on PATH"
done
gh_admin auth status >/dev/null 2>&1 || die "gh is not logged in; run: gh auth login"
[ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN is not set. Export a fine-grained token scoped to $repo (Contents, Pull requests and Actions read/write); Orbit refuses a broad keyring login for unattended delivery."
[ -d "$example" ] || die "$example is missing"

confirm() {
  [ "$assume_yes" = 1 ] && return 0
  [ -t 0 ] || die "$1 (not a terminal: pass --yes to proceed)"
  printf '%s [y/N] ' "$1" >&2
  read -r reply
  [ "$reply" = y ] || [ "$reply" = Y ] || die "stopped; nothing was changed"
}

# --- the repository -------------------------------------------------------------------------
created=0
if visibility="$(gh_admin repo view "$repo" --json isPrivate --jq '.isPrivate' 2>/dev/null)"; then
  [ "$visibility" = true ] || die "$repo exists and is not private; refusing to use it"
  say "reusing private repository $repo"
else
  confirm "Create the private repository $repo on GitHub?"
  gh_admin repo create "$repo" --private --description "Orbit demo app: a small reports page for demonstrating autonomous delivery" >/dev/null
  created=1
  say "created private repository $repo"
fi

workdir="${workdir:-$(mktemp -d "${TMPDIR:-/tmp}/orbit-live-demo.XXXXXX")}"
clone="$workdir/$name"
mkdir -p "$workdir"
git_gh() { env -u GH_TOKEN -u GITHUB_TOKEN git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }

if [ ! -d "$clone/.git" ]; then
  git_gh clone --quiet "https://github.com/$repo.git" "$clone" 2>&1 | redact >&2
fi
cd "$clone"
git config user.name "${GIT_AUTHOR_NAME:-$(git config --global user.name || echo 'Orbit Demo')}"
git config user.email "${GIT_AUTHOR_EMAIL:-$(git config --global user.email || echo 'orbit-demo@users.noreply.github.com')}"

# The demo app's own dependencies: doctor checks them and the UI checks run them.
installed=""
install_deps() {
  [ -n "$installed" ] && return 0
  say "installing the demo app's dependencies"
  npm ci --ignore-scripts --no-audit --no-fund 2>&1 | redact | tail -n 3
  npx --no-install playwright install chromium 2>&1 | redact | tail -n 3
  installed=1
}

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  # An empty repository: seed it from the example. DEMO.md is for maintainers and stays out.
  confirm "Push the demo app to the new main branch of $repo?"
  git checkout -q -b main
  tar -C "$example" --exclude=./DEMO.md --exclude=./node_modules --exclude=./test-results --exclude=./playwright-report --exclude=./.orbit/state.sqlite\* --exclude=./.orbit/runs --exclude=./.orbit/worktrees -cf - . | tar -xf -
  git add -A
  git commit -q -m "Demo app"
  # Visual baselines are recorded per platform. A person records them; Orbit never does.
  if [ ! -d "tests/e2e/__screenshots__/desktop/$(node -p 'process.platform')" ]; then
    say "recording visual baselines for this platform (a person's decision, done here once)"
    install_deps
    npx --no-install playwright test visual -u --reporter=null 2>&1 | redact | tail -n 5
    git add -A
    git commit -q -m "Record visual baselines for $(node -p 'process.platform')"
  fi
  git_gh push --quiet -u origin main 2>&1 | redact >&2
else
  git_gh fetch --quiet origin 2>&1 | redact >&2
  git checkout -q main
  git merge --quiet --ff-only origin/main
  [ -f .orbit/config.yaml ] || die "$repo has commits but no .orbit/config.yaml; it does not look like the demo app. Use an empty or demo repository."
  [ -z "$(git status --porcelain)" ] || die "the clone at $clone has uncommitted changes"
fi

install_deps

# --- doctor ---------------------------------------------------------------------------------
say ""
say "orbit doctor"
doctor_log="$workdir/doctor.log"
set +e
# shellcheck disable=SC2086
$orbit_cmd doctor 2>&1 | redact | tee "$doctor_log"
doctor_status=${PIPESTATUS[0]}
set -e
if [ "$doctor_status" -ne 0 ]; then
  say ""
  say "doctor reported a problem (exit $doctor_status); fix it and run this script again. Nothing was run."
  exit 3
fi

# The model registry is per repository and starts unvalidated: without a live probe the router
# has no eligible stronger model, so the difficult goal could never escalate. A few cents.
say ""
say "orbit models refresh --probe"
# A failed probe is reported, not fatal: the runs still state the route they could take.
set +e
# shellcheck disable=SC2086
$orbit_cmd models refresh --probe 2>&1 | redact
probe_status=${PIPESTATUS[0]}
set -e
[ "$probe_status" -eq 0 ] || say "warning: the model probe failed (exit $probe_status); the runs may not be able to escalate"

# --- the runs ---------------------------------------------------------------------------------
mkdir -p "$out"
overall=0
index="$out/README.md"
{
  echo "# Live demo runs, $today"
  echo
  echo "Repository: $repo (private). Providers: Claude writes, Codex reviews. Reports are the controllers' own final.md, unedited apart from secret redaction."
  echo
  echo "| Goal | Run | Outcome | Pull request |"
  echo "|---|---|---|---|"
} >"$index"

for g in "${goal_list[@]}"; do
  say ""
  say "run: $g"
  log="$workdir/run-$g.log"
  git checkout -q main
  set +e
  # shellcheck disable=SC2086
  $orbit_cmd run --goal - --foreground <"$clone/goals/$g.md" 2>&1 | redact | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  run_id="$(grep -Eo 'orb-[0-9]{8}-[0-9]{6}-[0-9a-f]+' "$log" | head -n 1 || true)"
  report="$clone/.orbit/runs/$run_id/final.md"
  outcome="exit $status"
  pr="none"
  if [ -n "$run_id" ] && [ -f "$report" ]; then
    redact <"$report" >"$out/$g.md"
    outcome="$(sed -n 's/^# Orbit run [^:]*: //p' "$report" | head -n 1)"
    pr="$(sed -n 's/^- pull request: //p' "$report" | head -n 1)"
  else
    say "no final report for $g (run id: ${run_id:-unknown})"
  fi
  echo "| $g | ${run_id:-unknown} | ${outcome:-unknown} | ${pr:-none} |" >>"$index"
  say "$g: ${outcome:-unknown} (exit $status)"
  [ "$status" -eq 0 ] || overall=1
done

say ""
say "reports: $out"
say "local clone: $clone"
[ "$created" = 1 ] && say "created $repo; delete it when you are done: gh repo delete $repo"
exit "$overall"
