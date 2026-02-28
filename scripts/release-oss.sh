#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/release-oss.sh --base-url <OSS_BASE_URL> [--out-dir <DIR>]

Options:
  --base-url <url>   Required. Public OSS prefix, e.g. https://oss.example.com/forgeops
                     You can also pass via FORGEOPS_OSS_BASE_URL env.
  --out-dir <dir>    Output directory (default: dist/oss-release)
  --help             Show this help

Output files:
  <out-dir>/forgeops-<version>.tgz
  <out-dir>/forgeops-<version>.tgz.sha256
  <out-dir>/latest.json
  <out-dir>/install-latest.sh
EOF
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

calc_sha256() {
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

BASE_URL="${FORGEOPS_OSS_BASE_URL:-}"
OUT_DIR="dist/oss-release"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

if [ -z "$BASE_URL" ]; then
  fail "Missing --base-url (or FORGEOPS_OSS_BASE_URL)."
fi
if [[ "$BASE_URL" != http://* && "$BASE_URL" != https://* ]]; then
  fail "--base-url must start with http:// or https://"
fi

if ! has_command node; then
  fail "Missing required command: node"
fi
if ! has_command npm; then
  fail "Missing required command: npm"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_PATH="${REPO_ROOT}/scripts/templates/install-latest.sh.tpl"
if [ ! -f "$TEMPLATE_PATH" ]; then
  fail "Missing installer template: ${TEMPLATE_PATH}"
fi

OUT_ABS="$OUT_DIR"
if [[ "$OUT_ABS" != /* ]]; then
  OUT_ABS="${REPO_ROOT}/${OUT_ABS}"
fi
mkdir -p "$OUT_ABS"

VERSION="$(node -e 'const fs=require("node:fs");const p=require("node:path");const pkg=JSON.parse(fs.readFileSync(p.join(process.argv[1],"package.json"),"utf8"));if(!pkg.version){process.exit(1)}process.stdout.write(String(pkg.version));' "$REPO_ROOT")"
if [ -z "$VERSION" ]; then
  fail "Cannot read version from package.json"
fi

echo "[1/6] Building frontend bundle..."
npm --prefix "$REPO_ROOT/frontend" install >/dev/null
npm --prefix "$REPO_ROOT/frontend" run build >/dev/null
if [ ! -f "$REPO_ROOT/frontend/dist/index.html" ]; then
  fail "Frontend build failed: missing frontend/dist/index.html"
fi

echo "[2/6] Packing npm tarball..."
PACK_FILENAME="$(npm pack "$REPO_ROOT" --silent --pack-destination "$OUT_ABS" | tail -n 1)"
PACK_PATH="${OUT_ABS}/${PACK_FILENAME}"
if [ ! -f "$PACK_PATH" ]; then
  fail "npm pack finished but tarball not found: ${PACK_PATH}"
fi

echo "[3/6] Calculating checksum..."
SHA256_VALUE="$(calc_sha256 "$PACK_PATH")"
printf '%s  %s\n' "$SHA256_VALUE" "$PACK_FILENAME" > "${PACK_PATH}.sha256"

echo "[4/6] Writing latest.json..."
LATEST_JSON_PATH="${OUT_ABS}/latest.json"
node -e '
  const fs = require("node:fs");
  const outFile = process.argv[1];
  const version = process.argv[2];
  const fileName = process.argv[3];
  const sha256 = process.argv[4];
  const payload = {
    version,
    url: fileName,
    sha256,
    published_at: new Date().toISOString()
  };
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
' "$LATEST_JSON_PATH" "$VERSION" "$PACK_FILENAME" "$SHA256_VALUE"

echo "[5/6] Rendering install-latest.sh..."
INSTALLER_PATH="${OUT_ABS}/install-latest.sh"
node -e '
  const fs = require("node:fs");
  const templatePath = process.argv[1];
  const outputPath = process.argv[2];
  const baseUrl = process.argv[3];
  const template = fs.readFileSync(templatePath, "utf8");
  const rendered = template.replaceAll("__FORGEOPS_BASE_URL__", baseUrl);
  fs.writeFileSync(outputPath, rendered, "utf8");
' "$TEMPLATE_PATH" "$INSTALLER_PATH" "${BASE_URL%/}"
if grep -q "__FORGEOPS_BASE_URL__" "$INSTALLER_PATH"; then
  fail "Installer render failed: unresolved BASE_URL placeholder remains."
fi
chmod +x "$INSTALLER_PATH"

echo "[6/6] Done."
echo ""
echo "Artifacts generated in: ${OUT_ABS}"
echo "- ${PACK_FILENAME}"
echo "- ${PACK_FILENAME}.sha256"
echo "- latest.json"
echo "- install-latest.sh"
echo ""
echo "Upload these files to: ${BASE_URL%/}/"
echo "Share this one-command installer:"
echo "curl -fsSL ${BASE_URL%/}/install-latest.sh | bash"
