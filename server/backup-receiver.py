#!/usr/bin/env python3
"""
极简备份接收服务（仅使用 Python 3 标准库，零外部依赖）
- 支持单用户（BACKUP_TOKEN）与多用户分目录隔离（BACKUP_TOKENS / BACKUP_TOKENS_FILE）
- 支持普通单次上传（POST /api/backup）与 1MB 分片断点续传（/api/backup/chunk*）
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
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("BACKUP_HOST", "127.0.0.1")
PORT = int(os.environ.get("BACKUP_PORT", "8787"))
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", "/data/milk-backups"))
BACKUP_TOKEN = os.environ.get("BACKUP_TOKEN", "").strip()
BACKUP_TOKENS_RAW = os.environ.get("BACKUP_TOKENS", "").strip()
BACKUP_TOKENS_FILE = os.environ.get("BACKUP_TOKENS_FILE", "").strip()
MAX_BYTES = int(os.environ.get("BACKUP_MAX_MB", "200")) * 1024 * 1024
MAX_CHUNK_BYTES = 8 * 1024 * 1024
KEEP_DAYS = int(os.environ.get("BACKUP_KEEP_DAYS", "30"))

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
UPLOAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,80}$")
BACKUP_FILE_RE = re.compile(r"^chatapp-backup-\d{4}-\d{2}-\d{2}\.(zip|json)$")


def load_user_tokens() -> Tuple[Dict[str, str], bool]:
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
    # 清理超过 48 小时的残留分片目录
    chunks_root = target_dir / ".chunks"
    if chunks_root.is_dir():
        chunk_cutoff = datetime.datetime.now().timestamp() - 48 * 3600
        for d in chunks_root.iterdir():
            if d.is_dir():
                try:
                    if d.stat().st_mtime < chunk_cutoff:
                        shutil.rmtree(d, ignore_errors=True)
                except OSError:
                    pass


def get_chunk_dir(user_dir: Path, upload_id: str) -> Optional[Path]:
    if not UPLOAD_ID_RE.match(upload_id):
        return None
    chunks_root = (user_dir / ".chunks").resolve()
    chunk_dir = (chunks_root / upload_id).resolve()
    if chunk_dir.parent != chunks_root:
        return None
    return chunk_dir


class BackupHandler(BaseHTTPRequestHandler):
    server_version = "MilkBackup/2.1"

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

    def _read_body(self, max_bytes: int) -> Optional[bytes]:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"ok": False, "error": "无效的 Content-Length"})
            return None
        if content_length <= 0:
            self._send_json(400, {"ok": False, "error": "空数据"})
            return None
        if content_length > max_bytes:
            self._send_json(413, {"ok": False, "error": f"数据超过上限（{max_bytes // (1024 * 1024)} MB）"})
            return None
        data = self.rfile.read(content_length)
        if len(data) != content_length:
            self._send_json(400, {"ok": False, "error": "传输中断，数据不完整"})
            return None
        return data

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path in ("/api/backup/health", "/health"):
            self._send_json(200, {"ok": True, "multiUser": MULTI_USER_MODE, "chunked": True})
            return

        auth = self._authenticate()
        if not auth:
            return
        user_id, user_dir = auth

        if path in ("/api/backup/chunk/status", "/chunk/status"):
            qs = parse_qs(parsed.query)
            upload_id = (qs.get("uploadId") or [""])[0].strip()
            chunk_dir = get_chunk_dir(user_dir, upload_id)
            if not chunk_dir:
                self._send_json(400, {"ok": False, "error": "无效的 uploadId"})
                return
            received = []
            if chunk_dir.is_dir():
                for p in chunk_dir.iterdir():
                    if p.is_file() and p.name.endswith(".part"):
                        stem = p.name[:-5]
                        if stem.isdigit():
                            received.append(int(stem))
            received.sort()
            self._send_json(200, {"ok": True, "uploadId": upload_id, "received": received})
            return

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
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        auth = self._authenticate()
        if not auth:
            return
        user_id, user_dir = auth

        # 分片上传：POST /api/backup/chunk?uploadId=xxx&index=0&total=15
        if path in ("/api/backup/chunk", "/chunk"):
            qs = parse_qs(parsed.query)
            upload_id = (qs.get("uploadId") or [""])[0].strip()
            try:
                index = int((qs.get("index") or ["-1"])[0])
                total = int((qs.get("total") or ["0"])[0])
            except ValueError:
                self._send_json(400, {"ok": False, "error": "无效的分片参数"})
                return
            chunk_dir = get_chunk_dir(user_dir, upload_id)
            if not chunk_dir or index < 0 or total <= 0 or index >= total or total > 500:
                self._send_json(400, {"ok": False, "error": "分片参数越界"})
                return
            data = self._read_body(MAX_CHUNK_BYTES)
            if data is None:
                return
            chunk_dir.mkdir(parents=True, exist_ok=True)
            part_path = chunk_dir / f"{index}.part"
            fd, tmp_path = tempfile.mkstemp(prefix=".part-", dir=str(chunk_dir))
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                os.replace(tmp_path, part_path)
            except Exception as exc:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                self._send_json(500, {"ok": False, "error": f"分片写入失败: {exc}"})
                return
            self._send_json(200, {"ok": True, "index": index, "bytes": len(data)})
            return

        # 合并分片：POST /api/backup/chunk/complete
        if path in ("/api/backup/chunk/complete", "/chunk/complete"):
            body = self._read_body(64 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                upload_id = str(meta.get("uploadId", "")).strip()
                total = int(meta.get("total", 0))
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的合并参数"})
                return
            chunk_dir = get_chunk_dir(user_dir, upload_id)
            if not chunk_dir or total <= 0 or total > 500 or not chunk_dir.is_dir():
                self._send_json(400, {"ok": False, "error": "找不到分片目录"})
                return

            missing = [i for i in range(total) if not (chunk_dir / f"{i}.part").is_file()]
            if missing:
                self._send_json(409, {"ok": False, "error": f"缺少分片: {missing[:5]}", "missing": missing})
                return

            user_dir.mkdir(parents=True, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(prefix=".merge-", dir=str(user_dir))
            total_bytes = 0
            head_bytes = b""
            try:
                with os.fdopen(fd, "wb") as out_f:
                    for i in range(total):
                        part_data = (chunk_dir / f"{i}.part").read_bytes()
                        if i == 0:
                            head_bytes = part_data[:32]
                        total_bytes += len(part_data)
                        if total_bytes > MAX_BYTES:
                            raise ValueError(f"合并后超过上限（{MAX_BYTES // (1024 * 1024)} MB）")
                        out_f.write(part_data)

                is_zip = head_bytes[:2] == b"PK"
                is_json = head_bytes.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"{")
                if not (is_zip or is_json):
                    raise ValueError("仅接受 ZIP 或 JSON 备份文件")

                ext = "zip" if is_zip else "json"
                filename = f"chatapp-backup-{safe_date_str()}.{ext}"
                dest = user_dir / filename
                latest = user_dir / f"latest.{ext}"
                os.replace(tmp_path, dest)
                shutil.copy2(dest, latest)
                shutil.rmtree(chunk_dir, ignore_errors=True)
                prune_old_backups(user_dir)
            except Exception as exc:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                self._send_json(400, {"ok": False, "error": f"合并失败: {exc}"})
                return

            self._send_json(200, {"ok": True, "user": user_id, "file": filename, "bytes": total_bytes})
            return

        # 兼容单次整包上传：POST /api/backup
        if path not in ("/api/backup", ""):
            self._send_json(404, {"ok": False, "error": "Not Found"})
            return

        data = self._read_body(MAX_BYTES)
        if data is None:
            return
        if len(data) < 4:
            self._send_json(400, {"ok": False, "error": "备份文件不完整"})
            return

        is_zip = data[:2] == b"PK"
        is_json = data.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"{")
        if not (is_zip or is_json):
            self._send_json(400, {"ok": False, "error": "仅接受 ZIP 或 JSON 备份文件"})
            return

        ext = "zip" if is_zip else "json"
        filename = f"chatapp-backup-{safe_date_str()}.{ext}"
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
