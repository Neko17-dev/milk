#!/usr/bin/env python3
"""
极简备份接收服务（仅使用 Python 3 标准库，零外部依赖）
支持单用户（BACKUP_TOKEN）与多用户分目录隔离（BACKUP_TOKENS / BACKUP_TOKENS_FILE）。
每个用户凭各自专属 Token 上传与拉取，互不可见、互不覆盖。
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
from typing import Dict, Optional, Tuple
from urllib.parse import urlparse

HOST = os.environ.get("BACKUP_HOST", "127.0.0.1")
PORT = int(os.environ.get("BACKUP_PORT", "8787"))
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", "/data/milk-backups"))
BACKUP_TOKEN = os.environ.get("BACKUP_TOKEN", "").strip()
BACKUP_TOKENS_RAW = os.environ.get("BACKUP_TOKENS", "").strip()
BACKUP_TOKENS_FILE = os.environ.get("BACKUP_TOKENS_FILE", "").strip()
MAX_BYTES = int(os.environ.get("BACKUP_MAX_MB", "200")) * 1024 * 1024
KEEP_DAYS = int(os.environ.get("BACKUP_KEEP_DAYS", "30"))

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
BACKUP_FILE_RE = re.compile(r"^chatapp-backup-\d{4}-\d{2}-\d{2}\.(zip|json)$")


def load_user_tokens() -> Tuple[Dict[str, str], bool]:
    """
    返回 (user_id -> token 映射, 是否为多用户模式)。
    多用户模式支持：
    1. 环境变量 BACKUP_TOKENS="alice:tok1,bob:tok2"
    2. JSON 文件 BACKUP_TOKENS_FILE='{"alice":"tok1","bob":"tok2"}'
    单用户兼容：
    - 仅设置 BACKUP_TOKEN 时，直接存放在 BACKUP_DIR 根目录。
    """
    users: Dict[str, str] = {}

    if BACKUP_TOKENS_FILE:
        p = Path(BACKUP_TOKENS_FILE)
        if p.is_file():
            raw = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for uid, tok in raw.items():
                    uid_s = str(uid).strip()
                    tok_s = str(tok).strip()
                    if uid_s and tok_s:
                        if not USER_ID_RE.match(uid_s):
                            raise ValueError(f"非法用户名 '{uid_s}'（仅允许字母/数字/_/-，最长32位）")
                        users[uid_s] = tok_s

    if BACKUP_TOKENS_RAW:
        for pair in BACKUP_TOKENS_RAW.split(","):
            pair = pair.strip()
            if not pair:
                continue
            if ":" not in pair:
                raise ValueError(f"BACKUP_TOKENS 格式错误：'{pair}'，应为 用户名:密钥")
            uid_s, tok_s = pair.split(":", 1)
            uid_s = uid_s.strip()
            tok_s = tok_s.strip()
            if not USER_ID_RE.match(uid_s):
                raise ValueError(f"非法用户名 '{uid_s}'（仅允许字母/数字/_/-，最长32位）")
            if not tok_s:
                raise ValueError(f"用户 '{uid_s}' 的密钥为空")
            users[uid_s] = tok_s

    if users:
        return users, True

    if BACKUP_TOKEN:
        return {"_single": BACKUP_TOKEN}, False

    return {}, False


USER_TOKENS: Dict[str, str] = {}
MULTI_USER_MODE: bool = False


def resolve_user_by_token(token: str) -> Optional[Tuple[str, Path]]:
    """通过 Token 匹配用户并返回 (user_id, 该用户专属备份目录)。"""
    if not token:
        return None
    matched_uid: Optional[str] = None
    for uid, expected in USER_TOKENS.items():
        if hmac.compare_digest(token, expected):
            matched_uid = uid
    if not matched_uid:
        return None
    if MULTI_USER_MODE:
        user_dir = (BACKUP_DIR / matched_uid).resolve()
        # 双重防止路径穿越
        if user_dir.parent != BACKUP_DIR.resolve():
            return None
        return matched_uid, user_dir
    return "default", BACKUP_DIR


def safe_date_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d")


def prune_old_backups(target_dir: Path) -> None:
    if KEEP_DAYS <= 0 or not target_dir.exists():
        return
    cutoff = datetime.datetime.now().timestamp() - KEEP_DAYS * 86400
    for p in target_dir.iterdir():
        if p.is_file() and BACKUP_FILE_RE.match(p.name):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass


class BackupHandler(BaseHTTPRequestHandler):
    server_version = "MilkBackup/2.0"

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authenticate(self) -> Optional[Tuple[str, Path]]:
        token = (self.headers.get("X-Backup-Token") or "").strip()
        resolved = resolve_user_by_token(token)
        if not resolved:
            self._send_json(401, {"ok": False, "error": "密钥无效"})
            return None
        return resolved

    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/")
        if path in ("/api/backup/health", "/health"):
            self._send_json(200, {"ok": True, "multiUser": MULTI_USER_MODE})
            return

        auth = self._authenticate()
        if not auth:
            return
        user_id, user_dir = auth

        if path in ("/api/backup/list", "/list"):
            files = []
            if user_dir.exists():
                for p in sorted(user_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
                    if p.is_file() and p.name.startswith("chatapp-backup-"):
                        st = p.stat()
                        files.append({
                            "name": p.name,
                            "bytes": st.st_size,
                            "mtime": int(st.st_mtime),
                        })
            self._send_json(200, {"ok": True, "user": user_id, "files": files})
            return

        if path in ("/api/backup/latest", "/latest"):
            latest_zip = user_dir / "latest.zip"
            latest_json = user_dir / "latest.json"
            target = latest_zip if latest_zip.exists() else (latest_json if latest_json.exists() else None)
            if not target:
                self._send_json(404, {"ok": False, "error": "暂无备份文件"})
                return
            data = target.read_bytes()
            ctype = "application/zip" if target.suffix == ".zip" else "application/json"
            download_name = f"{user_id}-{target.name}" if MULTI_USER_MODE else target.name
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
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

        auth = self._authenticate()
        if not auth:
            return
        user_id, user_dir = auth

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
        user_dir.mkdir(parents=True, exist_ok=True)
        dest = user_dir / filename
        latest = user_dir / f"latest.{ext}"

        fd, tmp_path = tempfile.mkstemp(prefix=".upload-", dir=str(user_dir))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp_path, dest)
            shutil.copy2(dest, latest)
            prune_old_backups(user_dir)
        except Exception as exc:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            self._send_json(500, {"ok": False, "error": f"写入失败: {exc}"})
            return

        self._send_json(200, {"ok": True, "user": user_id, "file": filename, "bytes": len(data)})

    def log_message(self, fmt: str, *args) -> None:
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        sys.stdout.write(f"[{ts}] {self.address_string()} - {fmt % args}\n")
        sys.stdout.flush()


def main() -> None:
    global USER_TOKENS, MULTI_USER_MODE
    try:
        USER_TOKENS, MULTI_USER_MODE = load_user_tokens()
    except Exception as exc:
        sys.stderr.write(f"ERROR: 密钥配置错误: {exc}\n")
        sys.exit(1)

    if not USER_TOKENS:
        sys.stderr.write("ERROR: 请设置 BACKUP_TOKENS（多用户）或 BACKUP_TOKEN（单用户）！\n")
        sys.exit(1)

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    mode_desc = f"多用户 ({len(USER_TOKENS)} 人: {', '.join(USER_TOKENS.keys())})" if MULTI_USER_MODE else "单用户"
    server = ThreadingHTTPServer((HOST, PORT), BackupHandler)
    print(f"[milk-backup] Listening on http://{HOST}:{PORT} -> {BACKUP_DIR} | 模式: {mode_desc} | 保留 {KEEP_DAYS} 天")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
