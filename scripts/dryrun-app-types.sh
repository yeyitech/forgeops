#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/dryrun-app-types.sh [--type android|serverless|all] [--root PATH] [--cleanup]

Options:
  --type <value>   Run target type: android | serverless | all (default: all)
  --root <path>    Reuse a fixed workspace directory (default: auto-create in /tmp)
  --cleanup        Remove workspace when all checks pass
  --help           Show this help

Notes:
  - This script runs ForgeOps CLI `project init` end-to-end with dry-run style setup:
    pre-bound fake GitHub origin + `--no-branch-protection` to avoid real repo mutation.
  - It still requires local ForgeOps runtime prerequisites to pass
    (codex command + gh + valid GitHub PAT in ForgeOps system config).
EOF
}

TYPE="all"
ROOT=""
CLEANUP_ON_SUCCESS=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --type)
      TYPE="${2:-}"
      shift 2
      ;;
    --root)
      ROOT="${2:-}"
      shift 2
      ;;
    --cleanup)
      CLEANUP_ON_SUCCESS=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$TYPE" ]; then
  echo "--type is required" >&2
  exit 2
fi

case "$TYPE" in
  android|serverless|all) ;;
  *)
    echo "Invalid --type: $TYPE (expected android|serverless|all)" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "$ROOT" ]; then
  ROOT="$(mktemp -d /tmp/forgeops-app-types-dryrun-XXXXXX)"
else
  mkdir -p "$ROOT"
fi

FAKEBIN="$ROOT/fakebin"
mkdir -p "$FAKEBIN"

SUCCESS=0
cleanup() {
  if [ "$SUCCESS" -eq 1 ] && [ "$CLEANUP_ON_SUCCESS" -eq 1 ]; then
    rm -rf "$ROOT"
    echo "workspace cleaned: $ROOT"
  else
    echo "workspace kept: $ROOT"
  fi
}
trap cleanup EXIT

cat > "$FAKEBIN/java" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-version" ]; then
  echo 'openjdk version "17.0.9"' >&2
  exit 0
fi
echo "fake java"
exit 0
EOF

cat > "$FAKEBIN/sdkmanager" <<'EOF'
#!/usr/bin/env bash
echo "fake sdkmanager"
exit 0
EOF

cat > "$FAKEBIN/serverless" <<'EOF'
#!/usr/bin/env bash
echo "fake serverless $*"
exit 0
EOF

chmod +x "$FAKEBIN/java" "$FAKEBIN/sdkmanager" "$FAKEBIN/serverless"

run_android() {
  local name="android-dryrun"
  local dir="$ROOT/$name"
  mkdir -p "$dir"
  git -C "$dir" init -b main >/dev/null
  git -C "$dir" remote add origin "https://github.com/forgeops-dryrun/$name.git"

  PATH="$FAKEBIN:$PATH" node "$REPO_ROOT/src/cli/index.js" project init \
    --name "$name" \
    --type android \
    --path "$dir" \
    --no-branch-protection > "$ROOT/android-init.log" 2>&1

  mkdir -p "$dir/app/src/main"
  cat > "$dir/app/src/main/AndroidManifest.xml" <<'EOF'
<manifest package="com.forgeops.dryrun"></manifest>
EOF
  cat > "$dir/settings.gradle" <<'EOF'
rootProject.name = "android-dryrun"
EOF
  cat > "$dir/gradlew" <<'EOF'
#!/usr/bin/env bash
echo "fake gradlew $*"
exit 0
EOF
  chmod +x "$dir/gradlew"

  (
    cd "$dir"
    PATH="$FAKEBIN:$PATH" node .forgeops/tools/platform-preflight.mjs --strict --json > "$ROOT/android-preflight.json"
    PATH="$FAKEBIN:$PATH" node .forgeops/tools/platform-smoke.mjs --strict --json > "$ROOT/android-smoke.json"
  )
}

run_serverless() {
  local name="serverless-dryrun"
  local dir="$ROOT/$name"
  mkdir -p "$dir"
  git -C "$dir" init -b main >/dev/null
  git -C "$dir" remote add origin "https://github.com/forgeops-dryrun/$name.git"

  PATH="$FAKEBIN:$PATH" node "$REPO_ROOT/src/cli/index.js" project init \
    --name "$name" \
    --type serverless \
    --path "$dir" \
    --no-branch-protection > "$ROOT/serverless-init.log" 2>&1

  cat > "$dir/serverless.yml" <<'EOF'
service: serverless-dryrun
provider:
  name: aws
  runtime: nodejs20.x
functions:
  ping:
    handler: handler.ping
EOF
  cat > "$dir/package.json" <<'EOF'
{
  "name": "serverless-dryrun",
  "private": true,
  "scripts": {
    "smoke:serverless": "echo serverless smoke ok"
  }
}
EOF

  (
    cd "$dir"
    PATH="$FAKEBIN:$PATH" node .forgeops/tools/platform-preflight.mjs --strict --json > "$ROOT/serverless-preflight.json"
    PATH="$FAKEBIN:$PATH" node .forgeops/tools/platform-smoke.mjs --strict --json > "$ROOT/serverless-smoke.json"
  )
}

if [ "$TYPE" = "all" ] || [ "$TYPE" = "android" ]; then
  run_android
fi

if [ "$TYPE" = "all" ] || [ "$TYPE" = "serverless" ]; then
  run_serverless
fi

node --input-type=module -e '
import fs from "node:fs";
const root = process.argv[1];
const files = [
  "android-preflight.json",
  "android-smoke.json",
  "serverless-preflight.json",
  "serverless-smoke.json",
];
const existing = files.filter((item) => fs.existsSync(`${root}/${item}`));
let failed = 0;
for (const file of existing) {
  const json = JSON.parse(fs.readFileSync(`${root}/${file}`, "utf8"));
  const requiredFailed = Array.isArray(json.failedRequired) ? json.failedRequired.length : 0;
  console.log(`${file}: ok=${json.ok} required_failed=${requiredFailed}`);
  if (requiredFailed > 0 || json.ok !== true) {
    failed += 1;
  }
}
if (failed > 0) {
  process.exit(1);
}
' "$ROOT"

echo "Dry-run finished successfully."
SUCCESS=1
