#!/usr/bin/env bash
set -euo pipefail

BASE_URL="__FORGEOPS_BASE_URL__"
LATEST_JSON_URL="${BASE_URL%/}/latest.json"
PROJECT_NAME="${1:-forgeops-demo}"
PROJECT_TYPE="${2:-web}"
PROJECT_PATH="${3:-$HOME/project/${PROJECT_NAME}}"
SKIP_INIT="${FORGEOPS_INSTALL_SKIP_INIT:-0}"
BOOTSTRAP_DEMO="${FORGEOPS_INSTALL_BOOTSTRAP_DEMO:-1}"
SKIP_GLOBAL_SKILLS_INIT="${FORGEOPS_INSTALL_SKIP_GLOBAL_SKILLS_INIT:-0}"
GLOBAL_SKILLS_REPO="${FORGEOPS_GLOBAL_SKILLS_REPO:-}"
GLOBAL_SKILLS_VISIBILITY="${FORGEOPS_GLOBAL_SKILLS_VISIBILITY:-private}"
GLOBAL_SKILLS_BRANCH_PROTECTION="${FORGEOPS_GLOBAL_SKILLS_BRANCH_PROTECTION:-0}"
PROJECT_BRANCH_PROTECTION="${FORGEOPS_PROJECT_BRANCH_PROTECTION:-0}"
GIT_USER_NAME="${FORGEOPS_GIT_USER_NAME:-}"
GIT_USER_EMAIL="${FORGEOPS_GIT_USER_EMAIL:-}"
GITHUB_PAT_ENV="${FORGEOPS_GITHUB_PAT:-}"
GITHUB_PAT_FILE="${FORGEOPS_GITHUB_PAT_FILE:-}"
FORGEOPS_RUNTIME_HOME="${FORGEOPS_HOME:-$HOME/.forgeops}"
SKIP_DASHBOARD_SETUP="${FORGEOPS_INSTALL_SKIP_DASHBOARD_SETUP:-0}"
OPEN_DASHBOARD="${FORGEOPS_INSTALL_OPEN_DASHBOARD:-1}"
DASHBOARD_HOST="${FORGEOPS_DASHBOARD_HOST:-127.0.0.1}"
DASHBOARD_PORT="${FORGEOPS_DASHBOARD_PORT:-4173}"

PRODUCT_TYPES=("web" "miniapp" "ios" "microservice" "android" "serverless" "other")

function has_command() {
  command -v "$1" >/dev/null 2>&1
}

function fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

function calc_sha256() {
  local file_path="$1"
  if has_command shasum; then
    shasum -a 256 "$file_path" | awk '{print $1}'
    return
  fi
  if has_command sha256sum; then
    sha256sum "$file_path" | awk '{print $1}'
    return
  fi
  fail "Missing checksum tool: require shasum or sha256sum"
}

function validate_product_type() {
  local target="$1"
  for item in "${PRODUCT_TYPES[@]}"; do
    if [[ "$item" == "$target" ]]; then
      return 0
    fi
  done
  return 1
}

function trim_spaces() {
  local raw="$1"
  printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

function resolve_pat_value() {
  local out=""
  if [[ -n "${GITHUB_PAT_FILE}" ]]; then
    if [[ ! -f "${GITHUB_PAT_FILE}" ]]; then
      fail "FORGEOPS_GITHUB_PAT_FILE does not exist: ${GITHUB_PAT_FILE}"
    fi
    out="$(cat "${GITHUB_PAT_FILE}")"
  fi
  if [[ -n "${GITHUB_PAT_ENV}" ]]; then
    out="${GITHUB_PAT_ENV}"
  fi
  trim_spaces "${out}"
}

function maybe_open_dashboard() {
  local url="$1"
  if [[ "${OPEN_DASHBOARD}" != "1" ]]; then
    echo "- dashboard auto-open skipped (FORGEOPS_INSTALL_OPEN_DASHBOARD=${OPEN_DASHBOARD})"
    echo "- dashboard url: ${url}"
    return
  fi
  if has_command open; then
    open "${url}" >/dev/null 2>&1 || true
    echo "- dashboard opened: ${url}"
    return
  fi
  if has_command xdg-open; then
    xdg-open "${url}" >/dev/null 2>&1 || true
    echo "- dashboard open requested: ${url}"
    return
  fi
  echo "- dashboard url: ${url}"
}

if ! has_command curl; then
  fail "Missing required command: curl"
fi
if ! has_command node; then
  fail "Missing required command: node"
fi
if ! has_command npm; then
  fail "Missing required command: npm"
fi

if [[ -z "${BASE_URL}" ]]; then
  fail "Installer is not configured: BASE_URL is empty. Re-generate install script with a valid OSS URL."
fi

if ! validate_product_type "${PROJECT_TYPE}"; then
  fail "Invalid project type: ${PROJECT_TYPE}. Supported: ${PRODUCT_TYPES[*]}"
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "[1/10] Fetching release metadata..."
curl -fsSL "${LATEST_JSON_URL}" -o "${TMP_DIR}/latest.json"

META_RAW="$(
  node -e '
    const fs = require("node:fs");
    const filePath = process.argv[1];
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const version = String(payload.version ?? "").trim();
    const url = String(payload.url ?? "").trim();
    const sha256 = String(payload.sha256 ?? "").trim();
    if (!version || !url || !sha256) {
      process.stderr.write("latest.json must include version/url/sha256\n");
      process.exit(1);
    }
    process.stdout.write(`${version}\n${url}\n${sha256}\n`);
  ' "${TMP_DIR}/latest.json"
)"

VERSION="$(printf '%s\n' "${META_RAW}" | sed -n '1p')"
PACKAGE_URL="$(printf '%s\n' "${META_RAW}" | sed -n '2p')"
EXPECTED_SHA256="$(printf '%s\n' "${META_RAW}" | sed -n '3p')"
if [[ -z "${VERSION}" || -z "${PACKAGE_URL}" || -z "${EXPECTED_SHA256}" ]]; then
  fail "Invalid latest.json: missing version/url/sha256"
fi

if [[ "${PACKAGE_URL}" != http://* && "${PACKAGE_URL}" != https://* ]]; then
  PACKAGE_URL="${BASE_URL%/}/${PACKAGE_URL#./}"
fi

echo "[2/10] Downloading forgeops-${VERSION}.tgz..."
curl -fsSL "${PACKAGE_URL}" -o "${TMP_DIR}/forgeops.tgz"

echo "[3/10] Verifying package checksum..."
ACTUAL_SHA256="$(calc_sha256 "${TMP_DIR}/forgeops.tgz")"
if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  fail "Checksum mismatch: expected=${EXPECTED_SHA256} actual=${ACTUAL_SHA256}"
fi

INSTALL_MODE="global"
FORGEOPS_BIN=""
echo "[4/10] Installing ForgeOps CLI..."
if npm install -g "${TMP_DIR}/forgeops.tgz" >/dev/null 2>&1; then
  GLOBAL_PREFIX="$(npm config get prefix 2>/dev/null || true)"
  if [[ -n "${GLOBAL_PREFIX}" && -x "${GLOBAL_PREFIX}/bin/forgeops" ]]; then
    FORGEOPS_BIN="${GLOBAL_PREFIX}/bin/forgeops"
  else
    FORGEOPS_BIN="$(command -v forgeops || true)"
  fi
else
  INSTALL_MODE="user-prefix"
  PREFIX_PATH="${HOME}/.local/forgeops"
  mkdir -p "${PREFIX_PATH}"
  npm install --prefix "${PREFIX_PATH}" "${TMP_DIR}/forgeops.tgz" >/dev/null
  FORGEOPS_BIN="${PREFIX_PATH}/bin/forgeops"
fi

if [[ -z "${FORGEOPS_BIN}" || ! -x "${FORGEOPS_BIN}" ]]; then
  fail "Install succeeded but forgeops binary not found"
fi

echo "[5/10] Applying Git credential bootstrap..."
if [[ -n "${GIT_USER_NAME}" && -n "${GIT_USER_EMAIL}" ]]; then
  git config --global user.name "${GIT_USER_NAME}"
  git config --global user.email "${GIT_USER_EMAIL}"
  echo "- configured global git identity: ${GIT_USER_NAME} <${GIT_USER_EMAIL}>"
elif [[ -n "${GIT_USER_NAME}" || -n "${GIT_USER_EMAIL}" ]]; then
  echo "- skipped git identity bootstrap: both FORGEOPS_GIT_USER_NAME and FORGEOPS_GIT_USER_EMAIL are required"
else
  echo "- skipped git identity bootstrap: env not provided"
fi

PAT_VALUE="$(resolve_pat_value)"
if [[ -n "${PAT_VALUE}" ]]; then
  mkdir -p "${FORGEOPS_RUNTIME_HOME}"
  chmod 700 "${FORGEOPS_RUNTIME_HOME}" 2>/dev/null || true
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const runtimeHome = process.argv[1];
    const token = process.argv[2];
    const authPath = path.join(runtimeHome, "github-auth.json");
    fs.mkdirSync(runtimeHome, { recursive: true });
    const payload = JSON.stringify({
      patToken: token,
      updatedAt: new Date().toISOString(),
    }, null, 2);
    fs.writeFileSync(authPath, payload, { encoding: "utf8", mode: 0o600 });
  ' "${FORGEOPS_RUNTIME_HOME}" "${PAT_VALUE}"
  chmod 600 "${FORGEOPS_RUNTIME_HOME}/github-auth.json" 2>/dev/null || true
  echo "- configured GitHub PAT at ${FORGEOPS_RUNTIME_HOME}/github-auth.json"
else
  echo "- skipped GitHub PAT bootstrap: env not provided"
fi

echo "[6/10] Running environment doctor..."
if ! "${FORGEOPS_BIN}" doctor; then
  echo "Warning: doctor reported issues. You can still continue, but check output above."
fi

if [[ "${SKIP_GLOBAL_SKILLS_INIT}" == "1" ]]; then
  echo "[7/10] Skipping user-global skills repo init (FORGEOPS_INSTALL_SKIP_GLOBAL_SKILLS_INIT=1)."
else
  echo "[7/10] Initializing user-global skills git repo..."
  GLOBAL_INIT_ARGS=(skill global-init --no-branch-protection)
  if [[ "${GLOBAL_SKILLS_BRANCH_PROTECTION}" == "1" ]]; then
    GLOBAL_INIT_ARGS=(skill global-init --branch-protection)
  fi
  if [[ "${GLOBAL_SKILLS_VISIBILITY}" == "public" ]]; then
    GLOBAL_INIT_ARGS+=("--public")
  else
    GLOBAL_INIT_ARGS+=("--private")
  fi
  if [[ -n "${GLOBAL_SKILLS_REPO}" ]]; then
    GLOBAL_INIT_ARGS+=("--github-repo" "${GLOBAL_SKILLS_REPO}")
  fi
  if ! "${FORGEOPS_BIN}" "${GLOBAL_INIT_ARGS[@]}"; then
    echo "Warning: user-global skills repo init failed. You can retry later with: forgeops skill global-init"
  fi
fi

if [[ "${SKIP_INIT}" == "1" ]]; then
  echo "[8/10] Skipping project init (FORGEOPS_INSTALL_SKIP_INIT=1)."
  echo "[9/10] Skipping demo issue bootstrap (project init skipped)."
else
  echo "[8/10] Bootstrapping demo project..."
  PROJECT_INIT_ARGS=(
    project init
    --name "${PROJECT_NAME}"
    --type "${PROJECT_TYPE}"
    --path "${PROJECT_PATH}"
    --no-open-ui
  )
  if [[ "${PROJECT_BRANCH_PROTECTION}" == "1" ]]; then
    PROJECT_INIT_ARGS+=(--branch-protection)
  else
    PROJECT_INIT_ARGS+=(--no-branch-protection)
  fi
  "${FORGEOPS_BIN}" "${PROJECT_INIT_ARGS[@]}"

  if [[ "${BOOTSTRAP_DEMO}" == "1" ]]; then
    echo "[9/10] Creating quick-start demo issues..."
    PROJECT_ID="$("${FORGEOPS_BIN}" project list | awk -v name="${PROJECT_NAME}" '$2==name{print $1; exit}')"
    if [[ -z "${PROJECT_ID}" ]]; then
      echo "Warning: cannot resolve project id for ${PROJECT_NAME}; skip demo issue bootstrap."
    else
      BASELINE_DESC="$(cat <<'TXT'
目标：构建“情报简报流水线（ForgeOps Demo）”的验收基线。

范围：
1. 信息采集：支持至少 2 类来源并可落库；
2. 内容生产：生成每日简报（摘要 + 要点 + 风险提示）；
3. 分发模拟：输出面向 2 个平台的改写版本；
4. 数据复盘：生成可读的复盘报告（结论 + 优化建议）。

非功能要求：
- 本地可运行；
- 有最小测试；
- 有 README 运行说明；
- 关键步骤可观测（日志/报告）。
TXT
)"
      if ! "${FORGEOPS_BIN}" issue create "${PROJECT_ID}" "[PRD] ForgeOps Demo 基线需求" --description "${BASELINE_DESC}" --no-auto-run >/dev/null 2>&1; then
        echo "Warning: failed to create baseline issue."
      fi

      RUN_DESC="$(cat <<'TXT'
目标：交付可演示的 MVP 闭环，并生成可验收报告。

必须完成：
1. 跑通一次端到端流程：采集 -> 生产 -> 分发模拟 -> 复盘；
2. 产出至少 1 份报告（输入/输出/结论/建议）；
3. PR 描述包含运行命令和验收路径；
4. 测试与验证结果可追溯。
TXT
)"
      RUN_OUTPUT="$("${FORGEOPS_BIN}" issue create "${PROJECT_ID}" "[MVP] 跑通一次完整简报流程并产出报告" --description "${RUN_DESC}" --mode quick 2>/dev/null || true)"
      if [[ -n "${RUN_OUTPUT}" ]]; then
        RUN_ID="$(printf '%s\n' "${RUN_OUTPUT}" | sed -n 's/.*Auto-created run: \([^ ]*\).*/\1/p' | head -n 1)"
        if [[ -n "${RUN_ID}" ]]; then
          echo "- quick demo run started: ${RUN_ID}"
        else
          echo "- demo issue created in quick mode (run id not parsed, check dashboard)"
        fi
      else
        echo "Warning: failed to create quick run issue."
      fi
    fi
  else
    echo "[9/10] Skipping demo issue bootstrap (FORGEOPS_INSTALL_BOOTSTRAP_DEMO=0)."
  fi
fi

DASHBOARD_URL="http://${DASHBOARD_HOST}:${DASHBOARD_PORT}"
if [[ "${SKIP_DASHBOARD_SETUP}" == "1" ]]; then
  echo "[10/10] Skipping dashboard setup (FORGEOPS_INSTALL_SKIP_DASHBOARD_SETUP=1)."
  echo "- dashboard url: ${DASHBOARD_URL}"
else
  echo "[10/10] Starting dashboard service..."
  if "${FORGEOPS_BIN}" service install --host "${DASHBOARD_HOST}" --port "${DASHBOARD_PORT}" >/dev/null 2>&1; then
    "${FORGEOPS_BIN}" service restart >/dev/null 2>&1 || true
    maybe_open_dashboard "${DASHBOARD_URL}"
  else
    echo "Warning: failed to setup dashboard service automatically."
    echo "- run manually: forgeops service install --host ${DASHBOARD_HOST} --port ${DASHBOARD_PORT} && forgeops service restart"
    echo "- dashboard url: ${DASHBOARD_URL}"
  fi
fi

echo ""
echo "ForgeOps installed successfully."
echo "- version: ${VERSION}"
echo "- install_mode: ${INSTALL_MODE}"
echo "- forgeops_bin: ${FORGEOPS_BIN}"
if [[ "${INSTALL_MODE}" == "user-prefix" ]]; then
  echo "- note: add PATH if needed -> export PATH=\"\$HOME/.local/forgeops/bin:\$PATH\""
fi
echo "- quick local coding: forgeops codex project --local-only"
echo "- demo project: ${PROJECT_NAME} (${PROJECT_PATH})"
if [[ "${BOOTSTRAP_DEMO}" == "1" && "${SKIP_INIT}" != "1" ]]; then
  echo "- demo issues: baseline + quick run issue created"
fi
echo "- issue-driven pipeline: forgeops issue create <projectId> \"your title\" --mode quick"
echo "- dashboard: ${DASHBOARD_URL}"
