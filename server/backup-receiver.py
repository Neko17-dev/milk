#!/usr/bin/env python3
"""
极简备份接收服务（仅使用 Python 3 标准库，零外部依赖）
接收前端每日自动上传的 ZIP/JSON 备份，并支持带 Token 拉取最新备份。
"""

import datetime
import hmac
import json
import os
import re
import shutil
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HOST = os.environ.get("BACKUP_HOST", "127.0.0.1")
PORT = int(os.environ.get("BACKUP_PORT", "8787"))
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", "/data/milk-backups"))
BACKUP_TOKEN = os.environ.get("BACKUP_TOKEN", "").strip()
MAX_BYTES = int(os.environ.get("BACKUP_MAX_MB", "200")) * 1024 * 1024
KEEP_DAYS = int(os.environ.get("BACKUP_KEEP_DAYS", "30"))


def safe_date_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d")


def prune_old_backups() -> None:
    if KEEP_DAYS <= 0:
        return
    cutoff = datetime.datetime.now().timestamp() - KEEP_DAYS * 86400
    pattern = re.compile(r"^chatapp-backup-\d{4}-\d{2}-\d{2}\.(zip|json)$")
    for p in BACKUP_DIR.iterdir():
        if p.is_file() and pattern.match(p.name):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass


class BackupHandler(BaseHTTPRequestHandler):
    server_version = "MilkBackup/1.0"

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _check_auth(self) -> bool:
        token = (self.headers.get("X-Backup-Token") or "").strip()
        if not token or not hmac.compare_digest(token, BACKUP_TOKEN):
            self._send_json(401, {"ok": False, "error": "密钥无效"})
            return False
        return True

    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/")
        if path in ("/api/backup/health", "/health"):
            self._send_json(200, {"ok": True})
            return

        if not self._check_auth():
            return

        if path in ("/api/backup/list", "/list"):
            files = []
            for p in sorted(BACKUP_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
                if p.is_file() and p.name.startswith("chatapp-backup-"):
                    st = p.stat()
                    files.append({
                        "name": p.name,
                        "bytes": st.st_size,
                        "mtime": int(st.st_mtime),
                    })
            self._send_json(200, {"ok": True, "files": files})
            return

        if path in ("/api/backup/latest", "/latest"):
            latest_zip = BACKUP_DIR / "latest.zip"
            latest_json = BACKUP_DIR / "latest.json"
            target = latest_zip if latest_zip.exists() else (latest_json if latest_json.exists() else None)
            if not target:
                self._send_json(404, {"ok": False, "error": "暂无备份文件"})
                return
            data = target.read_bytes()
            ctype = "application/zip" if target.suffix == ".zip" else "application/json"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", f'attachment; filename="{target.name}"')
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return

        self._send_json(404, {"ok": False, "error": "Not Found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path.rstrip("/")
        if path not in ("/api/backup", ""):
            self._send_json(404, {"ok": False, "error": "Not Found"})
            return

        if not self._check_auth():
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"ok": False, "error": "无效的 Content-Length"})
            return

        if content_length <= 0:
            self._send_json(400, {"ok": False, "error": "空文件"})
            return
        if content_length > MAX_BYTES:
            self._send_json(413, {"ok": False, "error": f"文件超过上限（{MAX_BYTES // (1024 * 1024)} MB）"})
            return

        data = self.rfile.read(content_length)
        if len(data) < 4:
            self._send_json(400, {"ok": False, "error": "备份文件不完整"})
            return

        is_zip = data[:2] == b"PK"
        is_json = data.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"{")
        if not (is_zip or is_json):
            self._send_json(400, {"ok": False, "error": "仅接受 ZIP 或 JSON 备份文件"})
            return

        ext = "zip" if is_zip else "json"
        date_str = safe_date_str()
        filename = f"chatapp-backup-{date_str}.{ext}"
        dest = BACKUP_DIR / filename
        latest = BACKUP_DIR / f"latest.{ext}"

        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(prefix=".upload-", dir=str(BACKUP_DIR))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp_path, dest)
            shutil.copy2(dest, latest)
            prune_old_backups()
        except Exception as exc:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            self._send_json(500, {"ok": False, "error": f"写入失败: {exc}"})
            return

        self._send_json(200, {"ok": True, "file": filename, "bytes": len(data)})

    def log_message(self, fmt: str, *args) -> None:
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        sys.stdout.write(f"[{ts}] {self.address_string()} - {fmt % args}\n")
        sys.stdout.flush()


def main() -> None:
    if not BACKUP_TOKEN:
        sys.stderr.write("ERROR: 请先通过环境变量 BACKUP_TOKEN 设置备份密钥！\n")
        sys.exit(1)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), BackupHandler)
    print(f"[milk-backup] Listening on http://{HOST}:{PORT} -> {BACKUP_DIR} (keep {KEEP_DAYS} days)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
