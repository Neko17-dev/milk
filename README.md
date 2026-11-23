# 传讯（Milk）项目完整说明文档

本项目基于上游 [`aielin17/milk`](https://github.com/aielin17/milk) 二次定制部署，在保留完整纯前端聊天体验的基础上，扩展了 **PWA 离线与桌面安装、数据持久化加固、多用户每日云端分片备份、客户端异常日志回传、`/admin` 只读备份查看器、网页即时热更新** 以及 **Android 原生 App（Capacitor + 强制更新通道 + GitHub Actions 自动打包）**。

---

## 一、核心功能一览

- **PWA 桌面应用与热更新**
  - 支持离线访问、双端（Android / PC / iOS Safari）底部安装引导，以及「设置 → 安装到桌面」一键触发按钮；
  - 进页第一步检查 `/version.json` 的 `webVersion`，发现新版本自动清理旧缓存并刷新；`sw.js` 对 HTML/JS/CSS 采用网络优先，发版即生效。
- **本地数据持久化与防丢失加固**
  - 主数据存储在浏览器 IndexedDB（`localForage`），启动时自动申请 `navigator.storage.persist()` 持久化存储保护；
  - 数据管理页调用 `navigator.storage.estimate()` 展示真实可用配额与持久化状态；
  - `localStorage` 紧急兜底备份自动剥离 2 KB 以上 Base64 媒体数据，避免因超 5 MB 配额写入失败。
- **多用户每日云端自动备份（1 MB 分片断点续传 + 日志回传）**
  - 前端每天首次打开页面自动将全量 v5 ZIP（图片直存 `STORE`、文本 `DEFLATE`，打包 1～2 秒完成）按 **1 MB 分片**上传到自建服务器，支持弱网重试与断点续传；
  - 后端按用户 Token 自动分文件夹隔离保存，自动保留最近 30 天并维护 `latest.zip`；
  - 客户端自动回传备份各阶段状态与异常日志，方便远程排查问题。
- **`/admin` 只读备份查看后台**
  - 独立 `ADMIN_TOKEN` 鉴权，严格只读（无任何编辑、删除入口）；
  - 支持按用户 → 备份日期 → 会话在线解压浏览聊天记录、关键词搜索、仅看图片、点击看大图、下载原包、查看客户端上报的备份日志。
- **Android 原生 App 封装与强制更新通道**
  - 使用 Capacitor 6 封装现有前端（`targetSdkVersion = 29`，兼容传统外部存储与通知/相册权限）；
  - 启动时检测 `version.json`，支持普通更新提示与**不可跳过的强制更新弹窗**；
  - 内置 GitHub Actions 工作流，无需本地安装 Android Studio 即可云端一键编译可安装 `.apk`。

---

## 二、项目目录结构

```text
milk/
├── index.html                        # 主页面（含 <head> 首步热更新检测与 PWA 安装事件捕获）
├── manifest.json                     # PWA 清单文件
├── sw.js                             # Service Worker（网络优先代码资源、放行 /api/ /admin /version.json）
├── version.json                      # 统一版本控制文件（同时管理 APK 更新与网页 webVersion 热更新）
├── css/
│   └── styles.css                    # 全局样式
├── icons/                            # PWA 与 Android 启动图标（72 ~ 512 px）
├── js/
│   ├── config.js / state.js / utils.js
│   ├── core.js                       # 核心聊天逻辑、IndexedDB 读写、去大图 localStorage 紧急兜底
│   ├── data.js                       # 数据管理面板（真实配额统计、云端每日备份入口）
│   ├── backup-engine.js              # v5 ZIP 打包/解包引擎（含 createBackupBlob 分片打包优化）
│   ├── cloud-backup.js               # 每日云端自动备份、1MB 分片断点续传、URL 密钥自动填入、日志上报
│   ├── pwa-install.js                # PWA 双端安装引导卡片与设置页手动触发入口
│   ├── app-updater.js                # Android 原生 App 版本检测与强制更新弹窗
│   ├── app.js                        # 应用初始化、持久化存储申请、生命周期监听
│   ├── features.js / listeners.js / games.js / onboarding.js
│   └── features/                     # 通话、信封、群聊、心情、回复库、主题编辑器等子模块
├── admin/
│   └── index.html                    # https://milk.starleave.cn/admin 只读备份与日志查看器
├── server/
│   ├── backup-receiver.py            # 零依赖 Python 3 备份接收与只读管理接口服务
│   └── README.md                     # 服务器部署速查说明（systemd + Caddy）
├── app/
│   ├── package.json                  # Capacitor Android 依赖配置
│   ├── capacitor.config.json         # App ID（cn.starleave.milk）、应用名与 WebView 配置
│   ├── scripts/sync-web.mjs          # 同步根目录静态网页到 app/www 并注入当前 App 版本号
│   ├── scripts/configure-android.mjs # 写入 targetSdk=29、版本号、图标、权限与可选 Release 签名
│   └── README.md                     # Android 构建与发版说明
└── .github/workflows/
    └── build-android.yml             # GitHub Actions 云端自动编译 Android APK 工作流
```

---

## 三、服务器部署（frp + Caddy + systemd）

### 1. 拉取项目代码

```bash
cd /data/www/milk
git pull origin main
```

### 2. 配置并启动备份接收服务（多用户隔离 + 只读管理）

先为每位用户和管理员分别生成随机密钥：

```bash
openssl rand -hex 24
```

创建 `/etc/systemd/system/milk-backup.service`：

```ini
[Unit]
Description=Milk Daily Backup Receiver
After=network.target

[Service]
Type=simple
WorkingDirectory=/data/www/milk/server
Environment=BACKUP_TOKENS=yanyu:用户1密钥,alice:用户2密钥
Environment=ADMIN_TOKEN=管理员独立密钥
Environment=BACKUP_DIR=/data/milk-backups
Environment=BACKUP_PORT=8787
Environment=BACKUP_KEEP_DAYS=30
Environment=BACKUP_MAX_MB=200
ExecStart=/usr/bin/python3 /data/www/milk/server/backup-receiver.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

> - 用户较多时，可改用 JSON 文件：`Environment=BACKUP_TOKENS_FILE=/data/milk-backups/tokens.json`（格式 `{"yanyu":"密钥1","alice":"密钥2"}`，建议 `chmod 600`）。
> - 单用户模式仍向下兼容 `Environment=BACKUP_TOKEN=单个密钥`。
> - 用户名仅允许字母、数字、`_`、`-`（最长 32 位），服务端已做严格路径穿越校验。

启动并设为开机自启：

```bash
mkdir -p /data/milk-backups
systemctl daemon-reload
systemctl enable --now milk-backup
systemctl status milk-backup --no-pager
```

多用户备份目录结构如下：

```text
/data/milk-backups/
├── yanyu/
│   ├── chatapp-backup-2026-11-23.zip
│   ├── latest.zip
│   └── backup.log.jsonl
└── alice/
    ├── chatapp-backup-2026-11-23.zip
    ├── latest.zip
    └── backup.log.jsonl
```

### 3. 配置 Caddy 反向代理（frp 无需修改）

在 `Caddyfile` 对应站点块中加入：

```caddyfile
milk.starleave.cn {
    # 1. 备份与管理 API 反代到本机 Python 服务
    handle /api/backup* {
        request_body {
            max_size 200MB
        }
        reverse_proxy 127.0.0.1:8787
    }

    # 2. 禁止强缓存 sw.js 和 version.json，确保热更新即时生效
    @nocache path /sw.js /version.json
    header @nocache Cache-Control "no-cache"

    # 3. 静态站点文件
    handle {
        root * /data/www/milk
        file_server
    }
}
```

校验并重载 Caddy：

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
curl https://milk.starleave.cn/api/backup/health
```

---

## 四、后端 API 接口清单

所有接口均由 `server/backup-receiver.py` 提供，经 Caddy 反代到 `/api/backup*`：

| 方法与路径 | 鉴权 Header | 说明 |
| --- | --- | --- |
| `GET /api/backup/health` | 无 | 健康检查，返回服务状态、是否多用户、是否启用管理接口 |
| `POST /api/backup` | `X-Backup-Token` | 单次整包上传（向下兼容） |
| `GET /api/backup/chunk/status?uploadId=...` | `X-Backup-Token` | 查询服务器已收到的分片序号（断点续传） |
| `POST /api/backup/chunk?uploadId=...&index=0&total=15` | `X-Backup-Token` | 上传单个 1 MB 分片 |
| `POST /api/backup/chunk/complete` | `X-Backup-Token` | 合并并校验全部分片、落盘与清理旧备份 |
| `POST /api/backup/log` | `X-Backup-Token` | 客户端上报备份日志与异常详情（每用户保留最近 200 条） |
| `GET /api/backup/list` | `X-Backup-Token` | 列出当前用户自己的备份文件 |
| `GET /api/backup/latest` | `X-Backup-Token` | 下载当前用户最新一份备份包 |
| `GET /api/backup/admin/users` | `X-Admin-Token` | 管理员只读：列出所有用户目录与历史备份清单 |
| `GET /api/backup/admin/backup?user=...&file=...` | `X-Admin-Token` | 管理员只读：下载指定用户的指定备份文件 |
| `GET /api/backup/admin/logs?user=...&limit=100` | `X-Admin-Token` | 管理员只读：查看指定用户或全部用户的客户端备份日志 |

---

## 五、日常使用指南

### 1. 给用户分发一键云端备份链接

直接把对应用户的专属链接发给对方在浏览器打开一次：

```text
https://milk.starleave.cn/#backup_token=该用户的专属密钥
```

- 打开后会自动保存密钥、开启「每天自动上传」，并**立即抹除地址栏中的密钥参数**；
- 也可在「设置 → 数据管理 → 服务器每日自动备份」中手动配置、查看实时分片进度或点击「立即上传」。

### 2. 在线只读查看备份与异常日志（`/admin`）

访问：

```text
https://milk.starleave.cn/admin
```

输入 `ADMIN_TOKEN`（或访问 `https://milk.starleave.cn/admin/#admin_token=管理员密钥` 自动填入并清除地址栏）即可：
- 选择左侧**用户目录 → 历史备份日期 → 会话**在线查看聊天记录；
- 使用顶部**关键词搜索**、**仅看图片**、**查看备份日志**（定位上传失败阶段与设备信息）与**下载原包**。

### 3. 本地电脑拉回某用户最新备份

```bash
curl -H "X-Backup-Token: 该用户的专属密钥" https://milk.starleave.cn/api/backup/latest -o milk-latest.zip
```

---

## 六、版本管理与更新发布（`version.json`）

根目录的 `version.json` 同时控制 **网页热更新** 与 **Android APK 更新**，两套字段互相独立：

```json
{
  "version": "1.0.0",
  "versionCode": 1,
  "minVersionCode": 1,
  "forceUpdate": false,
  "webVersion": "2026.11.23.1",
  "changelog": "更新说明文案",
  "downloadUrl": "https://milk.starleave.cn/download/milk-latest.apk"
}
```

| 场景 | 需要修改的字段 | 效果 |
| --- | --- | --- |
| **仅更新网页 / PWA** | 修改 `webVersion`（如 `2026.11.23.2`） | 所有网页/PWA 用户进页第一步自动清缓存并刷新热更新，**不会**触发 APK 弹窗 |
| **APK 普通提醒更新** | 调大 `version` 与 `versionCode`，`forceUpdate: false` | App 启动弹出更新提示，用户可点「稍后再说」或「立即下载更新」 |
| **APK 强制更新** | 调大 `versionCode`，并设 `forceUpdate: true` 或将 `minVersionCode` 提高到高于旧版 `versionCode` | 旧版 App 启动弹出**不可关闭的强制更新弹窗**，必须下载新 APK |

---

## 七、Android APK 云端自动构建（GitHub Actions）

无需本地安装 Android Studio：

1. 打开 GitHub 仓库 → **Actions** → **Build Android APK** → 点击 **Run workflow**；
2. 填写 `version_name`（如 `1.0.1`）与递增的 `version_code`（如 `2`），等待 2～3 分钟即可在页面底部 **Artifacts** 下载 `.apk`；
3. 若推送版本 Tag（如 `git tag v1.0.1 && git push origin v1.0.1`），会自动构建并发布到 GitHub Releases；
4. 如需正式签名 Release APK，在仓库 `Settings → Secrets and variables → Actions` 中添加：
   - `ANDROID_KEYSTORE_BASE64`
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`
5. 将编译好的 APK 放到服务器 `/data/www/milk/download/milk-latest.apk` 并更新 `version.json`，即可向所有 App 用户推送更新。

---

## 八、常用运维与上游同步命令

### 服务器拉取最新代码并重启备份服务

```bash
cd /data/www/milk && git pull origin main && systemctl restart milk-backup
```

### 查看备份服务运行日志

```bash
journalctl -u milk-backup -n 30 --no-pager
```

### 检查上游 `aielin17/milk` 更新

```bash
git fetch upstream
git log HEAD..upstream/main --oneline
```
