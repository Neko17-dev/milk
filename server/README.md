# 服务器端每日备份接收服务部署说明

`backup-receiver.py` 仅依赖 Python 3 标准库，无需 `pip install`，默认监听本机 `127.0.0.1:8787`，将每天的备份保存到 `/data/milk-backups/`（自动保留最近 30 天，并同步更新 `latest.zip`）。

## 1. 在服务器创建 systemd 常驻服务

### 多用户模式（推荐：每位用户独立文件夹，互不干扰）

为每位用户生成一个随机密钥：

```bash
openssl rand -hex 24
```

**方式 A：直接在 systemd 环境变量配置 `BACKUP_TOKENS`**（格式 `用户名:密钥,用户名2:密钥2`，用户名仅限字母/数字/`_`/`-`）：

创建 `/etc/systemd/system/milk-backup.service`：

```ini
[Unit]
Description=Milk Daily Backup Receiver
After=network.target

[Service]
Type=simple
WorkingDirectory=/data/www/milk/server
Environment=BACKUP_TOKENS=alice:密钥A,bob:密钥B
Environment=ADMIN_TOKEN=管理员只读查看密钥
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

**方式 B：用户较多时使用独立 JSON 文件 `BACKUP_TOKENS_FILE`**（权限设为 `600`）：

```json
{
  "alice": "密钥A",
  "bob": "密钥B"
}
```
在 `milk-backup.service` 中把 `BACKUP_TOKENS=...` 换成 `Environment=BACKUP_TOKENS_FILE=/data/milk-backups/tokens.json` 即可。

备份目录结构会自动隔离为：
```text
/data/milk-backups/
├── alice/
│   ├── chatapp-backup-2026-11-23.zip
│   └── latest.zip
└── bob/
    ├── chatapp-backup-2026-11-23.zip
    └── latest.zip
```

*(单用户兼容：如果只配 `Environment=BACKUP_TOKEN=单个密钥`，仍直接保存在 `/data/milk-backups/` 根目录。)*

启动并设为开机自启：

```bash
mkdir -p /data/milk-backups
systemctl daemon-reload
systemctl enable --now milk-backup
systemctl status milk-backup
```

## 2. Caddy 增加 `/api/backup` 反向代理（适配 frp + Caddy）

在 `Caddyfile` 对应站点块（`milk.starleave.cn` 或 frp 指向的 `:端口`）里加入：

```caddyfile
    # 1. 备份接口反代到本机 Python 服务
    handle /api/backup* {
        request_body {
            max_size 200MB
        }
        reverse_proxy 127.0.0.1:8787
    }

    # 2. 防止 sw.js 被强缓存，发版后 PWA 立刻刷新
    @sw path /sw.js
    header @sw Cache-Control "no-cache"

    # 3. 其余静态文件
    handle {
        root * /data/www/milk
        file_server
    }
```

重载 Caddy（**frp 无需改任何配置**，因为共用同一个域名和端口）：

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

## 3. 在网页端配置

**方式一（推荐，一键自动填入）：**
直接在手机或电脑浏览器访问（推荐使用 `#` 形式，密钥不会进入服务器日志，打开后地址栏会自动抹除密钥）：

```
https://milk.starleave.cn/#backup_token=替换成你的随机密钥
```

*(也兼容 `https://milk.starleave.cn/?backup_token=替换成你的随机密钥`)*

**方式二（手动填写）：**
1. 打开 `https://milk.starleave.cn/` → 设置 → **数据管理** → **服务器每日自动备份**；
2. 密钥（Token）填入第一步设置的 `BACKUP_TOKEN`（接口地址保持默认 `/api/backup`）；
3. 点「**立即上传**」测试，看到提示「云端备份上传成功」即完成，此后每天打开页面都会自动在后台上传一次。

## 4. 在线只读查看所有用户备份（`/admin`）

在 `milk-backup.service` 配置 `ADMIN_TOKEN` 并重启服务后，直接访问：

```
https://milk.starleave.cn/admin
```

输入 `ADMIN_TOKEN`（或使用 `https://milk.starleave.cn/admin/#admin_token=管理员密钥` 自动填入并清除地址栏）即可只读浏览所有用户的历史备份、搜索消息和查看图片，无任何修改/删除入口。

## 5. 本地电脑拉回最新备份

随时在本地终端执行即可拉回最新一份 ZIP：

```bash
curl -H "X-Backup-Token: 替换成你的随机密钥" https://milk.starleave.cn/api/backup/latest -o milk-latest.zip
```
