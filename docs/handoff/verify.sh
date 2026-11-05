#!/usr/bin/env bash
# Checks a branch as it will land, in a throwaway worktree: install, typecheck, lint, every unit test, the evaluation
# cases, the production build, the browser checks in demo mode, hosted prices with a fake fal key, the live CPU ComfyUI
# checks and the ComfyUI workflow library. docs/HANDOFF.md ("Cutting a PR") explains when to run it.
# Usage: bash docs/handoff/verify.sh <branch> <out-dir>
# Needs: origin/main fetched, the main checkout's scripts/comfy/node_modules (cd scripts/comfy && npm install), ffmpeg
# and ffprobe, and a ComfyUI at http://127.0.0.1:8188 (scripts/comfy/start-comfyui.sh). It can run from any folder:
# the throwaway worktree goes next to the main checkout (<repo>/../wt), whichever worktree holds this script. Results:
# <out-dir>/verify-summary.txt, logs in <out-dir>/logs. Each step's exit code is recorded; a failing step doesn't stop
# the later ones. comfy-validate exits 1 on a server that lacks some graphs' node packs: its log should list only the
# graphs docs/HANDOFF.md names under "Known gaps".
set -u
BRANCH=${1:?branch}
S=$(mkdir -p "${2:?out-dir}" && cd "$2" && pwd)
# The main checkout: the parent of the shared git directory (a linked worktree's own top folder is not it).
REPO=$(dirname "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)")
WT=$REPO/../wt/verify-$(echo "$BRANCH" | tr '/' '-')
L=$S/logs
SUM=$S/verify-summary.txt
mkdir -p "$L"
: > "$SUM"
[ -d "$REPO/scripts/comfy/node_modules" ] || echo "warn: $REPO/scripts/comfy/node_modules is missing (cd scripts/comfy && npm install): comfy-validate will fail" >> "$SUM"
step() { local name=$1; shift; local t0=$(date +%s); ( "$@" ) > "$L/$name.log" 2>&1; local rc=$?; printf '%-34s exit=%-3s %5ss\n' "$name" "$rc" "$(( $(date +%s) - t0 ))" >> "$SUM"; return $rc; }
# Next 16's server process is named next-server, so stop servers by port, not by name.
stop_port() { local port=$1; for i in 1 2 3 4 5; do fuser -k -n tcp "$port" >/dev/null 2>&1 || break; sleep 1; done; sleep 1; }
wait_up() { for i in $(seq 1 90); do curl -sf -o /dev/null "$1" && return 0; sleep 2; done; return 1; }

# Browser checks against the demo server, in this order (they share one data folder). Add new tests/e2e scripts here.
DEMO_CHECKS="shell no-horizontal-scroll composer-flows library-flows cinema-scene cinema-shortcuts notifications clipboard layers assist-flows canvas-smoke canvas-board canvas-open-dub dop-flows cinema-original genjutsu-original character-swap-studio mixed-shorts-original marketing-originals open-tools popcorn-evolution skills-run skills-builder schedule-skill fixes-5 split-soundtrack moss-image cinema-path turnaround"

git -C "$REPO" worktree remove --force "$WT" 2>/dev/null
step worktree git -C "$REPO" worktree add --detach "$WT" "$BRANCH" || exit 1
cd "$WT"
git log --oneline -1 >> "$SUM"
step main-included git merge-base --is-ancestor origin/main HEAD
for f in tests/e2e/*.mjs; do
  n=$(basename "$f" .mjs)
  case " $DEMO_CHECKS eval-review comfyui-selftest comfyui-canvas-concat comfyui-faceless-plus " in *" $n "*) ;; *) [[ $n == _* ]] || echo "not in verify.sh: tests/e2e/$n.mjs" >> "$SUM" ;; esac
done
step install pnpm install --frozen-lockfile --prefer-offline || exit 1
step typegen npx next typegen
step typecheck pnpm typecheck
step lint pnpm lint
# Accounts are refused (503) while the data disk has less free space than they keep (20 GB or a tenth of the disk):
# a container disk with a few GB free would fail tests/gpu-api.test.ts. Set FUOBE_ACCOUNT_DISK_FREE_GB to check the real floor.
step vitest env FUOBE_ACCOUNT_DISK_FREE_GB="${FUOBE_ACCOUNT_DISK_FREE_GB:-1}" pnpm vitest run --maxWorkers=2
step eval-validate pnpm eval:validate
step build env NEXT_TELEMETRY_DISABLED=1 pnpm build

# Demo mode (placeholder results on; main's default is off since 11-03) with ComfyUI and Ollama unreachable: every browser check.
rm -rf "$S/data-demo"; mkdir -p "$S/data-demo"
stop_port 3399
FUOBE_DEMO_MODE=on COMFYUI_URL=http://127.0.0.1:1 OLLAMA_URL=http://127.0.0.1:1 FUOBE_DATA_DIR=$S/data-demo NEXT_TELEMETRY_DISABLED=1 pnpm start -p 3399 > "$L/server-demo.log" 2>&1 &
wait_up http://localhost:3399/ && echo "demo server up" >> "$SUM"
for t in $DEMO_CHECKS; do
  step "e2e-$t" timeout 1200 node "tests/e2e/$t.mjs" http://localhost:3399
done
step e2e-eval-review timeout 600 node tests/e2e/eval-review.mjs
stop_port 3399

# Hosted prices with a fake fal key (estimates only; nothing is sent to fal), MOSS-Image's $0.05 among them.
rm -rf "$S/data-fal"; mkdir -p "$S/data-fal"
stop_port 3401
FAL_KEY=anything COMFYUI_URL=http://127.0.0.1:1 FUOBE_DATA_DIR=$S/data-fal NEXT_TELEMETRY_DISABLED=1 pnpm start -p 3401 > "$L/server-fal.log" 2>&1 &
wait_up http://localhost:3401/ && echo "fal-price server up" >> "$SUM"
step e2e-open-tools-fal-prices timeout 1200 node tests/e2e/open-tools.mjs http://localhost:3401
step e2e-moss-image-fal-prices timeout 1200 node tests/e2e/moss-image.mjs http://localhost:3401 --fal
stop_port 3401

# The live CPU ComfyUI: weight-free workflows through the app's own API.
rm -rf "$S/data-live"; mkdir -p "$S/data-live"
stop_port 3400
FUOBE_DATA_DIR=$S/data-live NEXT_TELEMETRY_DISABLED=1 pnpm start -p 3400 > "$L/server-live.log" 2>&1 &
wait_up http://localhost:3400/ && echo "live server up" >> "$SUM"
step e2e-comfyui-selftest timeout 2400 node tests/e2e/comfyui-selftest.mjs http://localhost:3400
step e2e-comfyui-canvas-concat timeout 2400 node tests/e2e/comfyui-canvas-concat.mjs http://localhost:3400
step e2e-comfyui-faceless-plus timeout 2400 node tests/e2e/comfyui-faceless-plus.mjs http://localhost:3400
# MOSS-Image on the open engine with ComfyUI reachable: Free, not a demo (nothing is run).
step e2e-moss-image-live timeout 1200 node tests/e2e/moss-image.mjs http://localhost:3400 --live
stop_port 3400

# Every workflow in the library posted to the live ComfyUI (never run); packs this server lacks show as failures.
step comfy-validate bash -c "cd scripts/comfy && ln -sfn '$REPO/scripts/comfy/node_modules' node_modules && node validate-workflows.mjs --shared"
git checkout -q -- workflows/comfyui/manifest.json scripts/comfy/validation-state.json 2>/dev/null
rm -rf "$WT/.next"
echo DONE >> "$SUM"
