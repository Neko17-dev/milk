# 服务器端每日备份接收服务部署说明

`backup-receiver.py` 仅依赖 Python 3 标准库，无需 `pip install`，默认监听本机 `127.0.0.1:8787`，将每天的备份保存到 `/data/milk-backups/`（自动保留最近 30 天，并同步更新 `latest.zip`）。

## 1. 在服务器创建 systemd 常驻服务

先生成一个随机密钥（记下来，后面网页端也要填这个）：

```bash
openssl rand -hex 24
```

创建 `/etc/systemd/system/milk-backup.service`（把 `替换成你的随机密钥` 改成上面生成的密钥）：

```ini
[Unit]
Description=Milk Daily Backup Receiver
After=network.target

[Service]
Type=simple
WorkingDirectory=/data/www/milk/server
Environment=BACKUP_TOKEN=替换成你的随机密钥
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

启动并设为开机自启：

```bash
mkdir -p /data/milk-backups
systemctl daemon-reload
systemctl enable --now milk-backup
systemctl status milk-backup
```

## 2. Nginx 增加 `/api/backup` 反向代理

在 `milk.starleave.cn` 对应的 Nginx `server { ... }` 块里加入：

```nginx
location /api/backup {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 200m;
    proxy_read_timeout 120s;
}
```

重载 Nginx：

```bash
nginx -t && systemctl reload nginx
```

## 3. 在网页端配置

1. 打开 `https://milk.starleave.cn/` → 设置 → **数据管理** → **服务器每日自动备份**；
2. 密钥（Token）填入第一步设置的 `BACKUP_TOKEN`（接口地址保持默认 `/api/backup`）；
3. 点「**立即上传**」测试，看到提示「云端备份上传成功」即完成，此后每天打开页面都会自动在后台上传一次。

## 4. 本地电脑拉回最新备份

随时在本地终端执行即可拉回最新一份 ZIP：

```bash
curl -H "X-Backup-Token: 替换成你的随机密钥" https://milk.starleave.cn/api/backup/latest -o milk-latest.zip
```
