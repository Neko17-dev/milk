#!/usr/bin/env bash
# 自动检测 GitHub Actions 最新构建的 APK（tag: latest），有新 build 时自动下载并原子替换本地 APK 文件。
set -euo pipefail

REPO="${GITHUB_REPO:-Neko17-dev/milk}"
DOWNLOAD_DIR="${APK_DOWNLOAD_DIR:-/data/www/milk/download}"
TARGET_APK="${DOWNLOAD_DIR}/milk-latest.apk"
STATE_FILE="${DOWNLOAD_DIR}/.apk_sync_state"
API_URL="https://api.github.com/repos/${REPO}/releases/tags/latest"

mkdir -p "${DOWNLOAD_DIR}"

AUTH_HEADER=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH_HEADER=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

HTTP_CODE=$(curl -sS -o /tmp/milk-release.json -w "%{http_code}" -H "Accept: application/vnd.github+json" "${AUTH_HEADER[@]}" "${API_URL}")
if [ "${HTTP_CODE}" = "404" ]; then
    rm -f /tmp/milk-release.json
    echo "[sync-apk] 尚无 latest Release（请先在 GitHub Actions 运行一次 Build Android APK）"
    exit 0
elif [ "${HTTP_CODE}" != "200" ]; then
    rm -f /tmp/milk-release.json
    echo "[sync-apk] 请求 GitHub API 失败（HTTP ${HTTP_CODE}）"
    exit 1
fi
RELEASE_JSON=$(cat /tmp/milk-release.json)
rm -f /tmp/milk-release.json

ASSET_INFO=$(python3 -c '
import json, sys
data = json.load(sys.stdin)
for a in data.get("assets", []):
    if a.get("name") == "milk-latest.apk":
        print(a.get("id"), a.get("updated_at"), a.get("browser_download_url"), a.get("url"), sep="|")
        sys.exit(0)
sys.exit(1)
' <<< "${RELEASE_JSON}") || {
    echo "[sync-apk] 未在 latest Release 中找到 milk-latest.apk"
    exit 0
}

ASSET_ID="${ASSET_INFO%%|*}"
REST="${ASSET_INFO#*|}"
UPDATED_AT="${REST%%|*}"
REST="${REST#*|}"
BROWSER_URL="${REST%%|*}"
API_ASSET_URL="${REST#*|}"

NEW_SIG="${ASSET_ID}:${UPDATED_AT}"
OLD_SIG=""
if [ -f "${STATE_FILE}" ]; then
    OLD_SIG=$(cat "${STATE_FILE}" 2>/dev/null || true)
fi

if [ "${NEW_SIG}" = "${OLD_SIG}" ] && [ -f "${TARGET_APK}" ]; then
    exit 0
fi

echo "[sync-apk] 检测到新的 APK 构建 (${NEW_SIG})，开始下载..."
TMP_APK="${DOWNLOAD_DIR}/.milk-latest.apk.tmp"

if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Accept: application/octet-stream" "${AUTH_HEADER[@]}" "${API_ASSET_URL}" -o "${TMP_APK}"
else
    curl -fsSL "${BROWSER_URL}" -o "${TMP_APK}"
fi

# 校验是否为有效 ZIP/APK 文件（PK 头且大于 1MB）
FILE_SIZE=$(wc -c < "${TMP_APK}")
HEAD_HEX=$(head -c 2 "${TMP_APK}" | od -An -tx1 | tr -d ' \n')
if [ "${HEAD_HEX}" != "504b" ] || [ "${FILE_SIZE}" -lt 1048576 ]; then
    rm -f "${TMP_APK}"
    echo "[sync-apk] 下载校验失败（size=${FILE_SIZE}, head=${HEAD_HEX}），已放弃替换"
    exit 1
fi

chmod 644 "${TMP_APK}"
mv -f "${TMP_APK}" "${TARGET_APK}"
echo "${NEW_SIG}" > "${STATE_FILE}"
echo "[sync-apk] 已更新 ${TARGET_APK}（${FILE_SIZE} bytes）"
