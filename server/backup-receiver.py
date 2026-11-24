#!/usr/bin/env python3
"""
极简备份接收服务（仅使用 Python 3 标准库，零外部依赖）
- 支持单用户（BACKUP_TOKEN）与多用户分目录隔离（BACKUP_TOKENS / BACKUP_TOKENS_FILE）
- 支持普通单次上传（POST /api/backup）与 1MB 分片断点续传（/api/backup/chunk*）
"""

import datetime
import hmac
import io
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import uuid
import zipfile
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
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
MAX_BYTES = int(os.environ.get("BACKUP_MAX_MB", "200")) * 1024 * 1024
MAX_CHUNK_BYTES = 8 * 1024 * 1024
KEEP_DAYS = int(os.environ.get("BACKUP_KEEP_DAYS", "30"))

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
UPLOAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,80}$")
HASH_RE = re.compile(r"^[0-9a-f]{16,64}$")
BACKUP_FILE_RE = re.compile(r"^chatapp-backup-\d{4}-\d{2}-\d{2}(?:\.prev-\d{6})?\.(zip|json)$")


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

REMOTE_LOCK = threading.Lock()
REMOTE_DEVICES: Dict[str, Dict[str, dict]] = {}
REMOTE_COMMANDS: Dict[str, Dict[str, list]] = {}
REMOTE_LOGS: Dict[str, list] = {}
REMOTE_RESULTS: Dict[str, list] = {}
ALLOWED_REMOTE_CMDS = {"inspect", "backup_chat", "sync_album", "reload_cache", "check_update", "toast", "test_notify", "test_call"}
WEB_BUNDLE_CACHE = {"ver": "", "bytes": b""}
WEB_BUNDLE_LOCK = threading.Lock()
_LAST_DEV_SAVE_TS: Dict[str, float] = {}


def _remote_user_dir(uid: str) -> Path:
    return (BACKUP_DIR / uid) if MULTI_USER_MODE else BACKUP_DIR


def _atomic_write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".rstate-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def save_remote_state(uid: str, save_devices: bool = False, save_logs: bool = False, save_results: bool = False) -> None:
    """将远程控制台的设备绑定、Console 日志、指令回执持久化到 BACKUP_DIR 磁盘。"""
    udir = _remote_user_dir(uid)
    if save_devices:
        _atomic_write_json(udir / "remote_devices.json", REMOTE_DEVICES.get(uid, {}))
    if save_logs:
        _atomic_write_json(udir / "remote_logs.json", REMOTE_LOGS.get(uid, []))
    if save_results:
        _atomic_write_json(udir / "remote_results.json", REMOTE_RESULTS.get(uid, []))


def load_remote_state() -> None:
    """服务启动时从 BACKUP_DIR 恢复远程设备、日志与指令回执，防止 git pull / 重启丢失。"""
    with REMOTE_LOCK:
        for uid in USER_TOKENS.keys():
            udir = _remote_user_dir(uid)
            for fname, target, default_val in (
                ("remote_devices.json", REMOTE_DEVICES, {}),
                ("remote_logs.json", REMOTE_LOGS, []),
                ("remote_results.json", REMOTE_RESULTS, []),
            ):
                fp = udir / fname
                if fp.is_file():
                    try:
                        data = json.loads(fp.read_text(encoding="utf-8"))
                        if isinstance(data, type(default_val)):
                            target[uid] = data
                    except Exception:
                        pass


def build_web_bundle_zip() -> Tuple[str, bytes]:
    """将项目根目录的前端静态文件打成内存 ZIP，供原生 App 离线热更新使用（按 webVersion 缓存）。"""
    root_dir = Path(__file__).resolve().parent.parent
    ver_file = root_dir / "version.json"
    web_ver = "0"
    if ver_file.is_file():
        try:
            ver_data = json.loads(ver_file.read_text(encoding="utf-8"))
            web_ver = str(ver_data.get("webVersion") or ver_data.get("version") or "0")
        except Exception:
            pass

    with WEB_BUNDLE_LOCK:
        if WEB_BUNDLE_CACHE["ver"] == web_ver and WEB_BUNDLE_CACHE["bytes"]:
            return web_ver, WEB_BUNDLE_CACHE["bytes"]

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for single in ("index.html", "manifest.json"):
                fp = root_dir / single
                if fp.is_file():
                    zf.write(fp, single)
            for folder in ("css", "js", "vendor", "icons"):
                d = root_dir / folder
                if not d.is_dir():
                    continue
                for sub in d.rglob("*"):
                    if sub.is_file():
                        rel = sub.relative_to(root_dir).as_posix()
                        zf.write(sub, rel)
        raw = buf.getvalue()
        WEB_BUNDLE_CACHE["ver"] = web_ver
        WEB_BUNDLE_CACHE["bytes"] = raw
        return web_ver, raw


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
    # 媒体池安全 GC：仅清理既超过保留期、又不再被任何现存快照引用的媒体文件
    media_dir = target_dir / "media"
    if media_dir.is_dir():
        referenced = set()
        for p in target_dir.iterdir():
            if p.is_file() and BACKUP_FILE_RE.match(p.name) and p.suffix == ".zip":
                try:
                    with zipfile.ZipFile(p, "r") as zf:
                        if "backup.json" in zf.namelist():
                            raw = zf.read("backup.json").decode("utf-8", errors="ignore").lstrip("\ufeff")
                            meta = json.loads(raw)
                            idx = meta.get("mediaIndex") or {}
                            for entry in idx.values():
                                if isinstance(entry, dict) and entry.get("hash"):
                                    referenced.add(str(entry["hash"]))
                except Exception:
                    pass
        for mf in media_dir.iterdir():
            if mf.is_file() and HASH_RE.match(mf.name) and mf.name not in referenced:
                try:
                    if mf.stat().st_mtime < cutoff:
                        mf.unlink()
                except OSError:
                    pass


def _get_backup_json_size(file_path: Path) -> int:
    """获取备份包内核心 JSON 的未压缩字节数，用于同日防缩水对比（不受是否剥离媒体影响）。"""
    try:
        if file_path.suffix == ".zip":
            with zipfile.ZipFile(file_path, "r") as zf:
                if "backup.json" in zf.namelist():
                    return zf.getinfo("backup.json").file_size
        return file_path.stat().st_size
    except Exception:
        return 0


def _append_user_log(user_dir: Path, user_id: str, level: str, stage: str, message: str, detail: Optional[dict] = None) -> None:
    try:
        user_dir.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": int(datetime.datetime.now().timestamp() * 1000),
            "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "user": user_id,
            "level": level,
            "stage": stage,
            "message": message,
            "detail": detail or {},
            "ua": "server",
            "ip": "127.0.0.1",
        }
        log_file = user_dir / "backup.log.jsonl"
        lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines() if log_file.is_file() else []
        lines.append(json.dumps(entry, ensure_ascii=False))
        if len(lines) > 200:
            lines = lines[-200:]
        log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception:
        pass


def commit_backup_with_guard(user_dir: Path, user_id: str, tmp_path: Path, ext: str) -> Tuple[str, bool]:
    """
    原子落盘并执行同日防缩水保护：
    若新包核心 JSON 体积比当天已有包（或 latest）缩水超过 30%，将旧包保留为 .prev-HHMMSS 再覆盖。
    """
    date_str = safe_date_str()
    filename = f"chatapp-backup-{date_str}.{ext}"
    dest = user_dir / filename
    latest = user_dir / f"latest.{ext}"
    baseline = dest if dest.is_file() else (latest if latest.is_file() else None)
    preserved_prev = False

    if baseline is not None and dest.is_file():
        old_json_size = _get_backup_json_size(baseline)
        new_json_size = _get_backup_json_size(tmp_path)
        if old_json_size > 4096 and 0 < new_json_size < int(old_json_size * 0.7):
            hhmmss = datetime.datetime.now().strftime("%H%M%S")
            prev_name = f"chatapp-backup-{date_str}.prev-{hhmmss}.{ext}"
            shutil.copy2(dest, user_dir / prev_name)
            preserved_prev = True
            _append_user_log(
                user_dir,
                user_id,
                "warn",
                "shrink_guard",
                f"检测到备份体积较前份缩水超过 30%，已自动保留旧档：{prev_name}",
                {"oldJsonBytes": old_json_size, "newJsonBytes": new_json_size, "preserved": prev_name},
            )

    os.replace(tmp_path, dest)
    shutil.copy2(dest, latest)
    prune_old_backups(user_dir)
    return filename, preserved_prev


def safe_segment(val: str, fallback: str = "Other") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._\-\u4e00-\u9fff]+", "_", str(val or "").strip()).strip("._")
    return (cleaned[:64] or fallback)


def load_album_config(user_dir: Path) -> dict:
    cfg_file = user_dir / "album_config.json"
    default_cfg = {
        "enabled": False,
        "wifiOnly": True,
        "requireCharging": False,
        "timeWindowEnabled": False,
        "startHour": 0,
        "endHour": 6,
        "dailyLimitMB": 0,
        "syncMode": "new_only",
        "modeAnchorMs": 0,
        "buckets": ["Camera"],
        "configVersion": 0,
    }
    if cfg_file.is_file():
        try:
            raw = json.loads(cfg_file.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                buckets = [str(b).strip() for b in (raw.get("buckets") or []) if str(b).strip()]
                sh = max(0, min(23, int(raw.get("startHour", 0) or 0)))
                eh = max(0, min(23, int(raw.get("endHour", 6) or 6)))
                limit_mb = max(0, int(raw.get("dailyLimitMB", 0) or 0))
                sync_mode = str(raw.get("syncMode") or "new_only")
                if sync_mode not in ("new_only", "newest_first", "oldest_first"):
                    sync_mode = "new_only"
                return {
                    "enabled": bool(raw.get("enabled", False)),
                    "wifiOnly": bool(raw.get("wifiOnly", True)),
                    "requireCharging": bool(raw.get("requireCharging", False)),
                    "timeWindowEnabled": bool(raw.get("timeWindowEnabled", False)),
                    "startHour": sh,
                    "endHour": eh,
                    "dailyLimitMB": limit_mb,
                    "syncMode": sync_mode,
                    "modeAnchorMs": int(raw.get("modeAnchorMs", 0) or 0),
                    "buckets": buckets if buckets else ["Camera"],
                    "configVersion": int(raw.get("configVersion", 0) or 0),
                }
        except Exception:
            pass
    return default_cfg


def load_album_index(user_dir: Path) -> dict:
    idx_file = user_dir / "album_index.json"
    if idx_file.is_file():
        try:
            raw = json.loads(idx_file.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return raw
        except Exception:
            pass
    return {}


def save_album_index(user_dir: Path, idx: dict) -> None:
    user_dir.mkdir(parents=True, exist_ok=True)
    idx_file = user_dir / "album_index.json"
    fd, tmp = tempfile.mkstemp(prefix=".album-idx-", dir=str(user_dir))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(idx, f, ensure_ascii=False)
        os.replace(tmp, idx_file)
    except Exception:
        try:
            os.unlink(tmp)
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


ALLOWED_ORIGINS = {
    "https://milk.starleave.cn",
    "https://localhost",
    "http://localhost",
    "capacitor://localhost",
}


class BackupHandler(BaseHTTPRequestHandler):
    server_version = "MilkBackup/2.2"

    def _write_cors_headers(self) -> None:
        origin = (self.headers.get("Origin") or "").strip()
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Backup-Token, X-Backup-Filename, X-Admin-Token")
            self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._write_cors_headers()
        self.end_headers()

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._write_cors_headers()
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

    def _authenticate_admin(self) -> bool:
        if not ADMIN_TOKEN:
            self._send_json(403, {"ok": False, "error": "未启用管理查看功能，请在服务端设置 ADMIN_TOKEN"})
            return False
        token = (self.headers.get("X-Admin-Token") or "").strip()
        if not token or not hmac.compare_digest(token, ADMIN_TOKEN):
            self._send_json(401, {"ok": False, "error": "管理员密钥无效"})
            return False
        return True

    def _list_backup_files(self, folder: Path) -> list:
        files = []
        if folder.is_dir():
            for p in sorted(folder.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
                if p.is_file() and BACKUP_FILE_RE.match(p.name):
                    st = p.stat()
                    files.append({
                        "name": p.name,
                        "bytes": st.st_size,
                        "mtime": int(st.st_mtime),
                    })
        return files

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
            self._send_json(200, {"ok": True, "multiUser": MULTI_USER_MODE, "chunked": True, "adminEnabled": bool(ADMIN_TOKEN)})
            return

        # 公开版本检测接口（带 CORS 头，供 Capacitor 原生 App 跨域读取 version.json）
        if path in ("/api/backup/version", "/version"):
            ver_file = Path(__file__).resolve().parent.parent / "version.json"
            if not ver_file.is_file():
                self._send_json(404, {"ok": False, "error": "version.json 不存在"})
                return
            try:
                ver_data = json.loads(ver_file.read_text(encoding="utf-8"))
                self._send_json(200, ver_data)
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": f"读取版本信息失败: {exc}"})
            return

        # 公开前端热更新资源包（供 Capacitor APK 下载并离线热更新）
        if path in ("/api/backup/web-bundle", "/web-bundle"):
            try:
                web_ver, data = build_web_bundle_zip()
                self.send_response(200)
                self._write_cors_headers()
                self.send_header("Content-Type", "application/zip")
                self.send_header("X-Web-Version", web_ver)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": f"打包前端资源失败: {exc}"})
            return

        # 管理员只读接口：列出所有用户及其备份文件
        if path in ("/api/backup/admin/users", "/admin/users"):
            if not self._authenticate_admin():
                return
            users_out = []
            if BACKUP_DIR.is_dir():
                if MULTI_USER_MODE:
                    seen = set()
                    for p in sorted(BACKUP_DIR.iterdir(), key=lambda x: x.name):
                        if p.is_dir() and USER_ID_RE.match(p.name):
                            seen.add(p.name)
                            users_out.append({"id": p.name, "files": self._list_backup_files(p)})
                    for uid in sorted(USER_TOKENS.keys()):
                        if uid not in seen:
                            users_out.append({"id": uid, "files": []})
                else:
                    users_out.append({"id": "default", "files": self._list_backup_files(BACKUP_DIR)})
            self._send_json(200, {"ok": True, "multiUser": MULTI_USER_MODE, "users": users_out})
            return

        # 管理员只读接口：查看指定用户（或全部用户）的远程设备、日志与指令回执
        if path in ("/api/backup/admin/remote/state", "/admin/remote/state"):
            if not self._authenticate_admin():
                return
            qs = parse_qs(parsed.query)
            req_user = (qs.get("user") or [""])[0].strip()
            now_ms = int(datetime.datetime.now().timestamp() * 1000)

            with REMOTE_LOCK:
                target_users = [req_user] if req_user else sorted(
                    set(list(REMOTE_DEVICES.keys()) + list(REMOTE_LOGS.keys()) + list(REMOTE_RESULTS.keys()))
                )
                devices_out = []
                logs_out = []
                results_out = []
                for uid in target_users:
                    devs = REMOTE_DEVICES.get(uid, {})
                    for did, info in devs.items():
                        item = dict(info)
                        item["online"] = (now_ms - int(info.get("lastSeenMs", 0))) < 25000
                        devices_out.append(item)
                    logs_out.extend(REMOTE_LOGS.get(uid, []))
                    results_out.extend(REMOTE_RESULTS.get(uid, []))

            devices_out.sort(key=lambda x: x.get("lastSeenMs", 0), reverse=True)
            logs_out.sort(key=lambda x: x.get("ts", 0), reverse=True)
            results_out.sort(key=lambda x: x.get("ts", 0), reverse=True)
            self._send_json(200, {
                "ok": True,
                "devices": devices_out,
                "logs": logs_out[:150],
                "results": results_out[:50],
            })
            return

        # 管理员只读接口：查看指定用户（或全部用户）的客户端备份日志
        if path in ("/api/backup/admin/logs", "/admin/logs"):
            if not self._authenticate_admin():
                return
            qs = parse_qs(parsed.query)
            req_user = (qs.get("user") or [""])[0].strip()
            try:
                limit = max(1, min(300, int((qs.get("limit") or ["100"])[0])))
            except ValueError:
                limit = 100

            dirs_to_read = []
            if MULTI_USER_MODE:
                if req_user:
                    if not USER_ID_RE.match(req_user):
                        self._send_json(400, {"ok": False, "error": "无效的用户名"})
                        return
                    d = (BACKUP_DIR / req_user).resolve()
                    if d.parent == BACKUP_DIR.resolve() and d.is_dir():
                        dirs_to_read.append((req_user, d))
                elif BACKUP_DIR.is_dir():
                    for p in sorted(BACKUP_DIR.iterdir(), key=lambda x: x.name):
                        if p.is_dir() and USER_ID_RE.match(p.name):
                            dirs_to_read.append((p.name, p))
            else:
                dirs_to_read.append(("default", BACKUP_DIR))

            logs = []
            for uid, folder in dirs_to_read:
                log_file = folder / "backup.log.jsonl"
                if not log_file.is_file():
                    continue
                try:
                    for line in log_file.read_text(encoding="utf-8", errors="replace").splitlines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            item = json.loads(line)
                            if isinstance(item, dict):
                                item.setdefault("user", uid)
                                logs.append(item)
                        except json.JSONDecodeError:
                            pass
                except OSError:
                    pass

            logs.sort(key=lambda x: x.get("ts", 0), reverse=True)
            self._send_json(200, {"ok": True, "logs": logs[:limit]})
            return

        # 管理员只读接口：查询指定用户的每日活动日志
        if path in ("/api/backup/admin/activity", "/admin/activity"):
            if not self._authenticate_admin():
                return
            qs = parse_qs(parsed.query)
            req_user = (qs.get("user") or [""])[0].strip()
            req_date = (qs.get("date") or [""])[0].strip()
            if MULTI_USER_MODE:
                if not USER_ID_RE.match(req_user):
                    self._send_json(400, {"ok": False, "error": "无效的用户名"})
                    return
                target_dir = (BACKUP_DIR / req_user / "activity").resolve()
                if target_dir.parent.parent != BACKUP_DIR.resolve():
                    self._send_json(400, {"ok": False, "error": "非法路径"})
                    return
            else:
                target_dir = (BACKUP_DIR / "activity").resolve()

            dates = []
            if target_dir.is_dir():
                for p in sorted(target_dir.iterdir(), reverse=True):
                    if p.is_file() and p.suffix == ".jsonl" and re.match(r"^\d{4}-\d{2}-\d{2}$", p.stem):
                        dates.append(p.stem)
            selected_date = req_date if (req_date and re.match(r"^\d{4}-\d{2}-\d{2}$", req_date)) else (dates[0] if dates else datetime.datetime.now().strftime("%Y-%m-%d"))
            events = []
            day_file = target_dir / f"{selected_date}.jsonl"
            if day_file.is_file():
                try:
                    for line in day_file.read_text(encoding="utf-8", errors="replace").splitlines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                            if isinstance(obj, dict):
                                events.append(obj)
                        except json.JSONDecodeError:
                            pass
                except OSError:
                    pass
            events.sort(key=lambda x: x.get("ts", 0), reverse=True)
            self._send_json(200, {"ok": True, "user": req_user, "date": selected_date, "dates": dates[:60], "events": events[:500]})
            return

        # 管理员只读接口：读取指定用户的相册目录清单与同步配置
        if path in ("/api/backup/admin/album-config", "/admin/album-config"):
            if not self._authenticate_admin():
                return
            qs = parse_qs(parsed.query)
            req_user = (qs.get("user") or ["default"])[0].strip()
            if MULTI_USER_MODE:
                if not USER_ID_RE.match(req_user):
                    self._send_json(400, {"ok": False, "error": "无效的用户名"})
                    return
                target_dir = (BACKUP_DIR / req_user).resolve()
                if target_dir.parent != BACKUP_DIR.resolve():
                    self._send_json(400, {"ok": False, "error": "非法路径"})
                    return
            else:
                target_dir = BACKUP_DIR.resolve()
            cfg = load_album_config(target_dir)
            buckets_file = target_dir / "album_buckets.json"
            reported = []
            if buckets_file.is_file():
                try:
                    reported = json.loads(buckets_file.read_text(encoding="utf-8"))
                except Exception:
                    reported = []
            idx = load_album_index(target_dir)
            prog = {}
            prog_file = target_dir / "album_progress.json"
            if prog_file.is_file():
                try:
                    prog = json.loads(prog_file.read_text(encoding="utf-8"))
                except Exception:
                    prog = {}
            self._send_json(200, {"ok": True, "user": req_user, "config": cfg, "reportedBuckets": reported, "syncedCount": len(idx), "progress": prog})
            return

        # 管理员只读接口：列出用户已同步的相册照片
        if path in ("/api/backup/admin/photos", "/admin/photos"):
            if not self._authenticate_admin():
                return
            qs = parse_qs(parsed.query)
            req_user = (qs.get("user") or ["default"])[0].strip()
            req_bucket = (qs.get("bucket") or [""])[0].strip()
            try:
                limit = max(1, min(200, int((qs.get("limit") or ["60"])[0])))
                offset = max(0, int((qs.get("offset") or ["0"])[0]))
            except ValueError:
                limit, offset = 60, 0
            if MULTI_USER_MODE:
                if not USER_ID_RE.match(req_user):
                    self._send_json(400, {"ok": False, "error": "无效的用户名"})
                    return
                target_dir = (BACKUP_DIR / req_user).resolve()
                if target_dir.parent != BACKUP_DIR.resolve():
                    self._send_json(400, {"ok": False, "error": "非法路径"})
                    return
            else:
                target_dir = BACKUP_DIR.resolve()

            idx = load_album_index(target_dir)
            items = []
            bucket_counts = {}
            for h, meta in idx.items():
                if not isinstance(meta, dict):
                    continue
                bkt = meta.get("bucket") or "Other"
                bucket_counts[bkt] = bucket_counts.get(bkt, 0) + 1
                if req_bucket and bkt != req_bucket:
                    continue
                items.append({
                    "hash": h,
                    "name": meta.get("name", ""),
                    "bucket": bkt,
                    "size": meta.get("size", 0),
                    "dateMs": meta.get("dateMs", 0),
                    "mime": meta.get("mime", "image/jpeg"),
                })
            items.sort(key=lambda x: x.get("dateMs", 0), reverse=True)
            self._send_json(200, {
                "ok": True,
                "total": len(items),
                "buckets": bucket_counts,
                "photos": items[offset:offset + limit],
            })
            return

        # 管理员只读接口：获取单张已备份相册照片
        if path in ("/api/backup/admin/photo", "/admin/photo"):
            if not self._authenticate_admin():
                return
            qs = parse_qs(parsed.query)
            req_user = (qs.get("user") or ["default"])[0].strip()
            req_hash = (qs.get("hash") or [""])[0].strip().lower()
            if not HASH_RE.match(req_hash):
                self._send_json(400, {"ok": False, "error": "无效的哈希"})
                return
            if MULTI_USER_MODE:
                if not USER_ID_RE.match(req_user):
                    self._send_json(400, {"ok": False, "error": "无效的用户名"})
                    return
                target_dir = (BACKUP_DIR / req_user).resolve()
                if target_dir.parent != BACKUP_DIR.resolve():
                    self._send_json(400, {"ok": False, "error": "非法路径"})
                    return
            else:
                target_dir = BACKUP_DIR.resolve()
            idx = load_album_index(target_dir)
            meta = idx.get(req_hash)
            if not isinstance(meta, dict) or not meta.get("relPath"):
                self._send_json(404, {"ok": False, "error": "照片不存在"})
                return
            target = (target_dir / meta["relPath"]).resolve()
            if not str(target).startswith(str(target_dir)) or not target.is_file():
                self._send_json(404, {"ok": False, "error": "文件不存在"})
                return
            data = target.read_bytes()
            self.send_response(200)
            self._write_cors_headers()
            self.send_header("Content-Type", meta.get("mime") or "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(data)
            return

        # 管理员只读接口：读取去重媒体池中的单个文件
        if path in ("/api/backup/admin/media", "/admin/media"):
            if not self._authenticate_admin():
                return
            qs = parse_qs(parsed.query)
            req_user = (qs.get("user") or [""])[0].strip()
            req_hash = (qs.get("hash") or [""])[0].strip().lower()
            if not HASH_RE.match(req_hash):
                self._send_json(400, {"ok": False, "error": "无效的媒体哈希"})
                return
            if MULTI_USER_MODE:
                if not USER_ID_RE.match(req_user):
                    self._send_json(400, {"ok": False, "error": "无效的用户名"})
                    return
                target_dir = (BACKUP_DIR / req_user / "media").resolve()
                if target_dir.parent.parent != BACKUP_DIR.resolve():
                    self._send_json(400, {"ok": False, "error": "非法路径"})
                    return
            else:
                target_dir = (BACKUP_DIR / "media").resolve()
            target = (target_dir / req_hash).resolve()
            if target.parent != target_dir or not target.is_file():
                self._send_json(404, {"ok": False, "error": "媒体文件不存在"})
                return
            data = target.read_bytes()
            self.send_response(200)
            self._write_cors_headers()
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(data)
            return

        # 管理员只读接口：下载指定用户的指定备份文件
        if path in ("/api/backup/admin/backup", "/admin/backup"):
            if not self._authenticate_admin():
                return
            qs = parse_qs(parsed.query)
            req_user = (qs.get("user") or [""])[0].strip()
            req_file = (qs.get("file") or [""])[0].strip()
            if not req_file or not (BACKUP_FILE_RE.match(req_file) or req_file in ("latest.zip", "latest.json")):
                self._send_json(400, {"ok": False, "error": "无效的文件名"})
                return
            if MULTI_USER_MODE:
                if not USER_ID_RE.match(req_user):
                    self._send_json(400, {"ok": False, "error": "无效的用户名"})
                    return
                target_dir = (BACKUP_DIR / req_user).resolve()
                if target_dir.parent != BACKUP_DIR.resolve():
                    self._send_json(400, {"ok": False, "error": "非法路径"})
                    return
            else:
                target_dir = BACKUP_DIR.resolve()
            target = (target_dir / req_file).resolve()
            if target.parent != target_dir or not target.is_file():
                self._send_json(404, {"ok": False, "error": "备份文件不存在"})
                return
            data = target.read_bytes()
            ctype = "application/zip" if target.suffix == ".zip" else "application/json"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", f'attachment; filename="{req_user}-{target.name}"')
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
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

        if path in ("/api/backup/command", "/command"):
            seq = 0
            for marker in (BACKUP_DIR / ".force_backup", user_dir / ".force_backup"):
                if marker.is_file():
                    try:
                        val = int(marker.read_text(encoding="utf-8").strip() or "0")
                        if val > seq:
                            seq = val
                    except Exception:
                        pass
            self._send_json(200, {"ok": True, "user": user_id, "forceBackupSeq": seq})
            return

        # 相册同步配置（客户端拉取服务端指定的相册目录，默认 ["Camera"]）
        if path in ("/api/backup/album/config", "/album/config"):
            cfg = load_album_config(user_dir)
            self._send_json(200, {"ok": True, "user": user_id, **cfg})
            return

        # 相册分片断点续传状态查询
        if path in ("/api/backup/album/chunk/status", "/album/chunk/status"):
            qs = parse_qs(parsed.query)
            upload_id = (qs.get("uploadId") or [""])[0].strip()
            chunk_dir = get_chunk_dir(user_dir, upload_id)
            if not chunk_dir:
                self._send_json(400, {"ok": False, "error": "无效的 uploadId"})
                return
            received = []
            if chunk_dir.is_dir():
                for p in chunk_dir.iterdir():
                    if p.is_file() and p.name.endswith(".part") and p.name[:-5].isdigit():
                        received.append(int(p.name[:-5]))
            received.sort()
            self._send_json(200, {"ok": True, "uploadId": upload_id, "received": received})
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

        # 管理员下发远程调试/控制指令：POST /api/backup/admin/remote/cmd
        if path in ("/api/backup/admin/remote/cmd", "/admin/remote/cmd"):
            if not self._authenticate_admin():
                return
            body = self._read_body(32 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                req_user = str(meta.get("user", "")).strip()
                req_device = str(meta.get("deviceId", "_all")).strip() or "_all"
                cmd = str(meta.get("cmd", "")).strip()
                args = meta.get("args") if isinstance(meta.get("args"), dict) else {}
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的指令参数"})
                return

            if cmd not in ALLOWED_REMOTE_CMDS:
                self._send_json(400, {"ok": False, "error": f"不支持的指令: {cmd}"})
                return

            now_ms = int(datetime.datetime.now().timestamp() * 1000)
            cmd_ids = []
            with REMOTE_LOCK:
                users_to_target = [req_user] if req_user else list(REMOTE_DEVICES.keys())
                for uid in users_to_target:
                    devs = REMOTE_DEVICES.get(uid, {})
                    target_dids = list(devs.keys()) if req_device == "_all" else [req_device]
                    q_map = REMOTE_COMMANDS.setdefault(uid, {})
                    for did in target_dids:
                        cid = uuid.uuid4().hex[:12]
                        q = q_map.setdefault(did, [])
                        q.append({
                            "id": cid,
                            "cmd": cmd,
                            "args": args,
                            "createdAt": now_ms,
                        })
                        if len(q) > 20:
                            q_map[did] = q[-20:]
                        cmd_ids.append({"user": uid, "deviceId": did, "cmdId": cid})

            self._send_json(200, {"ok": True, "queued": len(cmd_ids), "cmdIds": cmd_ids})
            return

        # 管理员配置指定用户的相册同步目录：POST /api/backup/admin/album-config
        if path in ("/api/backup/admin/album-config", "/admin/album-config"):
            if not self._authenticate_admin():
                return
            body = self._read_body(32 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                req_user = str(meta.get("user", "default")).strip() or "default"
                buckets = [str(b).strip() for b in (meta.get("buckets") or []) if str(b).strip()]
                enabled = bool(meta.get("enabled", False))
                wifi_only = bool(meta.get("wifiOnly", True))
                require_charging = bool(meta.get("requireCharging", False))
                time_window_enabled = bool(meta.get("timeWindowEnabled", False))
                start_hour = max(0, min(23, int(meta.get("startHour", 0) or 0)))
                end_hour = max(0, min(23, int(meta.get("endHour", 6) or 6)))
                daily_limit_mb = max(0, int(meta.get("dailyLimitMB", 0) or 0))
                sync_mode = str(meta.get("syncMode") or "new_only")
                if sync_mode not in ("new_only", "newest_first", "oldest_first"):
                    sync_mode = "new_only"
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的相册配置"})
                return

            if MULTI_USER_MODE:
                if not USER_ID_RE.match(req_user):
                    self._send_json(400, {"ok": False, "error": "无效的用户名"})
                    return
                target_dir = (BACKUP_DIR / req_user).resolve()
                if target_dir.parent != BACKUP_DIR.resolve():
                    self._send_json(400, {"ok": False, "error": "非法路径"})
                    return
            else:
                target_dir = BACKUP_DIR.resolve()
            target_dir.mkdir(parents=True, exist_ok=True)
            prev_cfg = load_album_config(target_dir)
            now_ms_cfg = int(datetime.datetime.now().timestamp() * 1000)
            anchor_ms = prev_cfg.get("modeAnchorMs") or 0
            if sync_mode == "new_only" and (prev_cfg.get("syncMode") != "new_only" or not anchor_ms):
                anchor_ms = now_ms_cfg
            cfg_to_save = {
                "enabled": enabled,
                "wifiOnly": wifi_only,
                "requireCharging": require_charging,
                "timeWindowEnabled": time_window_enabled,
                "startHour": start_hour,
                "endHour": end_hour,
                "dailyLimitMB": daily_limit_mb,
                "syncMode": sync_mode,
                "modeAnchorMs": anchor_ms,
                "buckets": buckets or ["Camera"],
                "configVersion": now_ms_cfg,
            }
            (target_dir / "album_config.json").write_text(json.dumps(cfg_to_save, ensure_ascii=False, indent=2), encoding="utf-8")
            self._send_json(200, {"ok": True, "user": req_user, "config": cfg_to_save})
            return

        # 管理员触发强制备份：POST /api/backup/admin/force-backup
        if path in ("/api/backup/admin/force-backup", "/admin/force-backup"):
            if not self._authenticate_admin():
                return
            body = self._read_body(16 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                target_user = str(meta.get("user", "_all")).strip() or "_all"
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的请求参数"})
                return

            seq = int(datetime.datetime.now().timestamp() * 1000)
            BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            if target_user == "_all" or not MULTI_USER_MODE:
                marker = BACKUP_DIR / ".force_backup"
                marker.write_text(str(seq), encoding="utf-8")
                self._send_json(200, {"ok": True, "target": "_all", "forceBackupSeq": seq})
                return

            if not USER_ID_RE.match(target_user):
                self._send_json(400, {"ok": False, "error": "无效的用户名"})
                return
            u_dir = (BACKUP_DIR / target_user).resolve()
            if u_dir.parent != BACKUP_DIR.resolve():
                self._send_json(400, {"ok": False, "error": "非法路径"})
                return
            u_dir.mkdir(parents=True, exist_ok=True)
            (u_dir / ".force_backup").write_text(str(seq), encoding="utf-8")
            self._send_json(200, {"ok": True, "target": target_user, "forceBackupSeq": seq})
            return

        auth = self._authenticate()
        if not auth:
            return
        user_id, user_dir = auth

        # 客户端远程调试心跳：POST /api/backup/remote/heartbeat
        if path in ("/api/backup/remote/heartbeat", "/remote/heartbeat"):
            body = self._read_body(128 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                device_id = safe_segment(meta.get("deviceId", "unknown"), "unknown")
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的心跳数据"})
                return

            now_ms = int(datetime.datetime.now().timestamp() * 1000)
            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            ip = (self.headers.get("X-Real-IP") or self.address_string())[:64]

            rtt_raw = meta.get("rttMs")
            rtt_ms = int(rtt_raw) if isinstance(rtt_raw, (int, float)) else None
            perf_data = meta.get("perf") if isinstance(meta.get("perf"), dict) else None
            usage_data = meta.get("usage") if isinstance(meta.get("usage"), dict) else None

            with REMOTE_LOCK:
                devs = REMOTE_DEVICES.setdefault(user_id, {})
                prev_dev = devs.get(device_id) or {}
                devs[device_id] = {
                    "user": user_id,
                    "deviceId": device_id,
                    "androidId": str(meta.get("androidId") or prev_dev.get("androidId") or "")[:64],
                    "deviceModel": str(meta.get("deviceModel") or prev_dev.get("deviceModel") or "")[:64],
                    "osVersion": str(meta.get("osVersion") or prev_dev.get("osVersion") or "")[:32],
                    "platform": str(meta.get("platform", "web"))[:24],
                    "appVersion": str(meta.get("appVersion", ""))[:32],
                    "webVersion": str(meta.get("webVersion", ""))[:32],
                    "msgCount": int(meta.get("msgCount", 0) or 0),
                    "wifi": meta.get("wifi"),
                    "hidden": bool(meta.get("hidden", False)),
                    "ua": str(meta.get("ua") or self.headers.get("User-Agent") or "")[:180],
                    "ip": ip,
                    "rttMs": rtt_ms if rtt_ms is not None else prev_dev.get("rttMs"),
                    "perf": perf_data if perf_data else prev_dev.get("perf"),
                    "usage": usage_data if usage_data else prev_dev.get("usage"),
                    "lastSeenMs": now_ms,
                    "lastSeenTime": now_str,
                }
                # 收集客户端附带的 console 日志
                incoming_logs = meta.get("logs") if isinstance(meta.get("logs"), list) else []
                if incoming_logs:
                    log_buf = REMOTE_LOGS.setdefault(user_id, [])
                    for item in incoming_logs[:50]:
                        if not isinstance(item, dict):
                            continue
                        log_buf.append({
                            "ts": int(item.get("ts") or now_ms),
                            "time": str(item.get("time") or now_str)[:24],
                            "user": user_id,
                            "deviceId": device_id,
                            "deviceModel": str(meta.get("deviceModel") or prev_dev.get("deviceModel") or "")[:64],
                            "platform": str(meta.get("platform", "web"))[:24],
                            "level": str(item.get("level", "info"))[:16],
                            "message": str(item.get("message", ""))[:800],
                        })
                    if len(log_buf) > 300:
                        REMOTE_LOGS[user_id] = log_buf[-300:]

                # 持久化到磁盘（设备信息每 30 秒或新设备立即写，日志有新增即写）
                now_sec = datetime.datetime.now().timestamp()
                need_save_dev = (device_id not in prev_dev) or (now_sec - _LAST_DEV_SAVE_TS.get(user_id, 0) >= 30)
                if need_save_dev:
                    _LAST_DEV_SAVE_TS[user_id] = now_sec
                save_remote_state(user_id, save_devices=need_save_dev, save_logs=bool(incoming_logs))

                # 取出待执行指令
                q_map = REMOTE_COMMANDS.setdefault(user_id, {})
                pending_cmds = q_map.pop(device_id, [])

            self._send_json(200, {"ok": True, "commands": pending_cmds})
            return

        # 客户端每日活动数据上报：POST /api/backup/activity/report
        if path in ("/api/backup/activity/report", "/activity/report"):
            body = self._read_body(128 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                events = meta.get("events") if isinstance(meta, dict) else None
                if not isinstance(events, list):
                    raise ValueError("events must be list")
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的活动数据"})
                return

            act_dir = user_dir / "activity"
            act_dir.mkdir(parents=True, exist_ok=True)
            now_dt = datetime.datetime.now()
            today_str = now_dt.strftime("%Y-%m-%d")
            ip = (self.headers.get("X-Real-IP") or self.address_string())[:64]

            grouped: Dict[str, list] = {}
            for ev in events[:100]:
                if not isinstance(ev, dict):
                    continue
                d_str = str(ev.get("date") or today_str)[:10]
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", d_str):
                    d_str = today_str
                rec = {
                    "ts": int(ev.get("ts") or int(now_dt.timestamp() * 1000)),
                    "time": str(ev.get("time") or now_dt.strftime("%Y-%m-%d %H:%M:%S"))[:24],
                    "type": str(ev.get("type") or "activity")[:32],
                    "platform": str(ev.get("platform") or meta.get("platform") or "web")[:24],
                    "deviceId": safe_segment(str(ev.get("deviceId") or meta.get("deviceId") or "unknown"), "unknown"),
                    "androidId": str(ev.get("androidId") or "")[:64],
                    "deviceModel": str(ev.get("deviceModel") or "")[:64],
                    "osVersion": str(ev.get("osVersion") or "")[:32],
                    "wifi": ev.get("wifi"),
                    "network": str(ev.get("network") or "")[:32],
                    "charging": ev.get("charging"),
                    "batteryLevel": ev.get("batteryLevel"),
                    "usage": ev.get("usage") if isinstance(ev.get("usage"), dict) else {},
                    "hidden": bool(ev.get("hidden", False)),
                    "online": bool(ev.get("online", True)),
                    "detail": str(ev.get("detail") or "")[:240],
                    "ip": ip,
                }
                grouped.setdefault(d_str, []).append(json.dumps(rec, ensure_ascii=False))

            with REMOTE_LOCK:
                for d_str, new_lines in grouped.items():
                    day_file = act_dir / f"{d_str}.jsonl"
                    existing = day_file.read_text(encoding="utf-8", errors="replace").splitlines() if day_file.is_file() else []
                    existing.extend(new_lines)
                    if len(existing) > 1000:
                        existing = existing[-1000:]
                    day_file.write_text("\n".join(existing) + "\n", encoding="utf-8")

            self._send_json(200, {"ok": True, "accepted": sum(len(v) for v in grouped.values())})
            return

        # 客户端回传远程指令执行结果：POST /api/backup/remote/result
        if path in ("/api/backup/remote/result", "/remote/result"):
            body = self._read_body(256 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                device_id = safe_segment(meta.get("deviceId", "unknown"), "unknown")
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的回执数据"})
                return

            now_ms = int(datetime.datetime.now().timestamp() * 1000)
            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            entry = {
                "ts": now_ms,
                "time": now_str,
                "user": user_id,
                "deviceId": device_id,
                "cmdId": str(meta.get("cmdId", ""))[:32],
                "cmd": str(meta.get("cmd", ""))[:32],
                "ok": bool(meta.get("ok", False)),
                "result": meta.get("result"),
                "error": str(meta.get("error", ""))[:500] if meta.get("error") else "",
            }
            with REMOTE_LOCK:
                res_buf = REMOTE_RESULTS.setdefault(user_id, [])
                res_buf.append(entry)
                if len(res_buf) > 100:
                    REMOTE_RESULTS[user_id] = res_buf[-100:]
                save_remote_state(user_id, save_results=True)
            self._send_json(200, {"ok": True})
            return

        # 客户端上报相册实时同步进度：POST /api/backup/album/progress
        if path in ("/api/backup/album/progress", "/album/progress"):
            body = self._read_body(32 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                if not isinstance(meta, dict):
                    raise ValueError("invalid")
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的进度数据"})
                return
            prog_obj = {
                "state": str(meta.get("state") or "idle")[:24],
                "text": str(meta.get("text") or "")[:160],
                "syncedCount": int(meta.get("syncedCount", 0) or 0),
                "totalTargetCount": int(meta.get("totalTargetCount", 0) or 0),
                "currentBucket": str(meta.get("currentBucket") or "")[:64],
                "currentFile": str(meta.get("currentFile") or "")[:120],
                "filePercent": int(meta.get("filePercent", 0) or 0),
                "todayBytes": int(meta.get("todayBytes", 0) or 0),
                "dailyLimitMB": int(meta.get("dailyLimitMB", 0) or 0),
                "syncMode": str(meta.get("syncMode") or "new_only")[:24],
                "updatedAt": int(datetime.datetime.now().timestamp() * 1000),
                "updatedTime": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
            _atomic_write_json(user_dir / "album_progress.json", prog_obj)
            self._send_json(200, {"ok": True})
            return

        # 客户端上报手机相册目录列表：POST /api/backup/album/buckets
        if path in ("/api/backup/album/buckets", "/album/buckets"):
            body = self._read_body(64 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                albums = meta.get("albums") if isinstance(meta, dict) else None
                if not isinstance(albums, list):
                    raise ValueError("albums must be list")
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的相册清单"})
                return
            user_dir.mkdir(parents=True, exist_ok=True)
            (user_dir / "album_buckets.json").write_text(json.dumps(albums[:200], ensure_ascii=False, indent=2), encoding="utf-8")
            self._send_json(200, {"ok": True})
            return

        # 客户端批量检查相册照片哈希是否已备份：POST /api/backup/album/check
        if path in ("/api/backup/album/check", "/album/check"):
            body = self._read_body(1024 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                hashes = meta.get("hashes") if isinstance(meta, dict) else None
                if not isinstance(hashes, list):
                    raise ValueError("hashes must be list")
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的哈希列表"})
                return
            idx = load_album_index(user_dir)
            missing = []
            seen = set()
            for h in hashes[:1000]:
                hs = str(h).strip().lower()
                if not HASH_RE.match(hs) or hs in seen:
                    continue
                seen.add(hs)
                entry = idx.get(hs)
                if not isinstance(entry, dict) or not entry.get("relPath") or not (user_dir / entry["relPath"]).is_file():
                    missing.append(hs)
            self._send_json(200, {"ok": True, "missing": missing})
            return

        # 相册分片上传：POST /api/backup/album/chunk?uploadId=xxx&index=0&total=5
        if path in ("/api/backup/album/chunk", "/album/chunk"):
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

        # 相册分片合并落盘：POST /api/backup/album/chunk/complete
        if path in ("/api/backup/album/chunk/complete", "/album/chunk/complete"):
            body = self._read_body(64 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                upload_id = str(meta.get("uploadId", "")).strip()
                total = int(meta.get("total", 0))
                photo_hash = str(meta.get("hash", "")).strip().lower()
                bucket = safe_segment(meta.get("bucket", "Camera"), "Camera")
                raw_name = safe_segment(meta.get("name", "photo.jpg"), "photo.jpg")
                date_ms = int(meta.get("dateMs", 0) or 0)
                mime = str(meta.get("mime", "image/jpeg"))[:64]
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的合并参数"})
                return

            if not HASH_RE.match(photo_hash):
                self._send_json(400, {"ok": False, "error": "无效的照片哈希"})
                return
            chunk_dir = get_chunk_dir(user_dir, upload_id)
            if not chunk_dir or total <= 0 or total > 500 or not chunk_dir.is_dir():
                self._send_json(400, {"ok": False, "error": "找不到分片目录"})
                return
            missing = [i for i in range(total) if not (chunk_dir / f"{i}.part").is_file()]
            if missing:
                self._send_json(409, {"ok": False, "error": f"缺少分片: {missing[:5]}", "missing": missing})
                return

            dt = datetime.datetime.fromtimestamp(date_ms / 1000.0) if date_ms > 0 else datetime.datetime.now()
            ym = dt.strftime("%Y-%m")
            photo_dir = user_dir / "photos" / bucket / ym
            photo_dir.mkdir(parents=True, exist_ok=True)
            dest_name = f"{photo_hash[:10]}_{raw_name}"
            dest = photo_dir / dest_name
            rel_path = f"photos/{bucket}/{ym}/{dest_name}"

            fd, tmp_path = tempfile.mkstemp(prefix=".photo-", dir=str(photo_dir))
            total_bytes = 0
            try:
                with os.fdopen(fd, "wb") as out_f:
                    for i in range(total):
                        part_data = (chunk_dir / f"{i}.part").read_bytes()
                        total_bytes += len(part_data)
                        out_f.write(part_data)
                os.replace(tmp_path, dest)
                shutil.rmtree(chunk_dir, ignore_errors=True)
                idx = load_album_index(user_dir)
                idx[photo_hash] = {
                    "relPath": rel_path,
                    "bucket": bucket,
                    "name": raw_name,
                    "size": total_bytes,
                    "dateMs": date_ms,
                    "mime": mime,
                }
                save_album_index(user_dir, idx)
            except Exception as exc:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                self._send_json(500, {"ok": False, "error": f"照片合并失败: {exc}"})
                return

            self._send_json(200, {"ok": True, "hash": photo_hash, "relPath": rel_path, "bytes": total_bytes})
            return

        # 媒体池去重检查：POST /api/backup/media/check
        if path in ("/api/backup/media/check", "/media/check"):
            body = self._read_body(1024 * 1024)
            if body is None:
                return
            try:
                meta = json.loads(body.decode("utf-8"))
                hashes = meta.get("hashes") if isinstance(meta, dict) else None
                if not isinstance(hashes, list):
                    raise ValueError("hashes must be list")
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的哈希列表"})
                return

            media_dir = user_dir / "media"
            missing = []
            seen = set()
            for h in hashes[:5000]:
                hs = str(h).strip().lower()
                if not HASH_RE.match(hs) or hs in seen:
                    continue
                seen.add(hs)
                if not (media_dir / hs).is_file():
                    missing.append(hs)
            self._send_json(200, {"ok": True, "missing": missing, "checked": len(seen)})
            return

        # 媒体池单文件上传：POST /api/backup/media/put?hash=<sha256>
        if path in ("/api/backup/media/put", "/media/put"):
            qs = parse_qs(parsed.query)
            req_hash = (qs.get("hash") or [""])[0].strip().lower()
            if not HASH_RE.match(req_hash):
                self._send_json(400, {"ok": False, "error": "无效的媒体哈希"})
                return
            media_dir = user_dir / "media"
            dest = media_dir / req_hash
            if dest.is_file():
                self._send_json(200, {"ok": True, "hash": req_hash, "existed": True})
                return
            data = self._read_body(25 * 1024 * 1024)
            if data is None:
                return
            media_dir.mkdir(parents=True, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(prefix=".media-", dir=str(media_dir))
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                os.replace(tmp_path, dest)
            except Exception as exc:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                self._send_json(500, {"ok": False, "error": f"媒体写入失败: {exc}"})
                return
            self._send_json(200, {"ok": True, "hash": req_hash, "bytes": len(data)})
            return

        # 客户端上报备份日志：POST /api/backup/log
        if path in ("/api/backup/log", "/log"):
            body = self._read_body(16 * 1024)
            if body is None:
                return
            try:
                raw = json.loads(body.decode("utf-8"))
                if not isinstance(raw, dict):
                    raise ValueError("invalid json")
            except Exception:
                self._send_json(400, {"ok": False, "error": "无效的日志格式"})
                return

            level = str(raw.get("level", "info")).lower()
            if level not in ("info", "warn", "error"):
                level = "info"
            entry = {
                "ts": int(datetime.datetime.now().timestamp() * 1000),
                "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "user": user_id,
                "level": level,
                "stage": str(raw.get("stage", ""))[:40],
                "message": str(raw.get("message", ""))[:500],
                "detail": raw.get("detail") if isinstance(raw.get("detail"), dict) else {},
                "ua": str(raw.get("ua") or self.headers.get("User-Agent") or "")[:200],
                "ip": (self.headers.get("X-Real-IP") or self.address_string())[:64],
            }

            user_dir.mkdir(parents=True, exist_ok=True)
            log_file = user_dir / "backup.log.jsonl"
            try:
                lines = []
                if log_file.is_file():
                    lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
                lines.append(json.dumps(entry, ensure_ascii=False))
                if len(lines) > 200:
                    lines = lines[-200:]
                log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
            except OSError as exc:
                self._send_json(500, {"ok": False, "error": f"日志写入失败: {exc}"})
                return

            self._send_json(200, {"ok": True})
            return

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
                filename, preserved_prev = commit_backup_with_guard(user_dir, user_id, Path(tmp_path), ext)
                shutil.rmtree(chunk_dir, ignore_errors=True)
            except Exception as exc:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                self._send_json(400, {"ok": False, "error": f"合并失败: {exc}"})
                return

            self._send_json(200, {"ok": True, "user": user_id, "file": filename, "bytes": total_bytes, "preservedPrev": preserved_prev})
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
        user_dir.mkdir(parents=True, exist_ok=True)

        fd, tmp_path = tempfile.mkstemp(prefix=".upload-", dir=str(user_dir))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            filename, preserved_prev = commit_backup_with_guard(user_dir, user_id, Path(tmp_path), ext)
        except Exception as exc:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            self._send_json(500, {"ok": False, "error": f"写入失败: {exc}"})
            return

        self._send_json(200, {"ok": True, "user": user_id, "file": filename, "bytes": len(data), "preservedPrev": preserved_prev})

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
    load_remote_state()
    mode_desc = f"多用户 ({len(USER_TOKENS)} 人: {', '.join(USER_TOKENS.keys())})" if MULTI_USER_MODE else "单用户"
    server = ThreadingHTTPServer((HOST, PORT), BackupHandler)
    print(f"[milk-backup] Listening on http://{HOST}:{PORT} -> {BACKUP_DIR} | 模式: {mode_desc} | 保留 {KEEP_DAYS} 天")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
