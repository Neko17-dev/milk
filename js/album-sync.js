(function () {
    'use strict';

    var KEYS = {
        sinceMs: 'albumSyncSinceMs',
        syncedHashes: 'albumSyncDoneHashes',
        lastRun: 'albumSyncLastRun',
        enabled: 'albumSyncLocalEnabled',
        bucketsSig: 'albumSyncBucketsSig',
        configVer: 'albumSyncConfigVer'
    };
    var CHUNK_SIZE = 1024 * 1024; // 1 MB 分片断点续传
    var syncing = false;
    var resyncQueued = false;
    var statusText = '等待 Wi-Fi 就绪';

    function getTodayDateStr() {
        var d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function getTodayUploadedBytes() {
        try {
            return parseInt(localStorage.getItem('milk_album_bytes_' + getTodayDateStr()) || '0', 10) || 0;
        } catch (e) { return 0; }
    }

    function addTodayUploadedBytes(n) {
        if (!n || n <= 0) return;
        try {
            var k = 'milk_album_bytes_' + getTodayDateStr();
            var cur = parseInt(localStorage.getItem(k) || '0', 10) || 0;
            localStorage.setItem(k, String(cur + n));
        } catch (e) {}
    }

    function isNativeApp() {
        try {
            return !!(window.Capacitor
                && typeof window.Capacitor.isNativePlatform === 'function'
                && window.Capacitor.isNativePlatform());
        } catch (e) {
            return false;
        }
    }

    function getPlugin() {
        try {
            return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AlbumSync
                ? window.Capacitor.Plugins.AlbumSync
                : null;
        } catch (e) {
            return null;
        }
    }

    function getCloudCfg() {
        if (window.CloudBackup && typeof window.CloudBackup.getConfig === 'function') {
            return window.CloudBackup.getConfig();
        }
        return {
            url: 'https://milk.starleave.cn/api/backup',
            token: (localStorage.getItem('cloudBackupToken') || '').trim()
        };
    }

    function setStatus(text) {
        statusText = text || '';
        var el = document.getElementById('album-sync-status-text');
        if (el) el.textContent = statusText;
    }

    function reportAlbumLog(level, stage, message, detail) {
        try {
            var cfg = getCloudCfg();
            if (!cfg.token) return;
            var cleanBase = (cfg.url || 'https://milk.starleave.cn/api/backup').replace(/\/+$/, '');
            fetch(cleanBase + '/log', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Backup-Token': cfg.token
                },
                body: JSON.stringify({
                    level: level || 'info',
                    stage: stage || 'album_sync',
                    message: String(message || ''),
                    detail: detail || {},
                    ua: navigator.userAgent || ''
                }),
                keepalive: true
            }).catch(function () { });
        } catch (e) { }
    }

    function getDoneSet() {
        try {
            var arr = JSON.parse(localStorage.getItem(KEYS.syncedHashes) || '[]');
            return Array.isArray(arr) ? new Set(arr) : new Set();
        } catch (e) {
            return new Set();
        }
    }

    function saveDoneSet(set) {
        try {
            var arr = Array.from(set);
            if (arr.length > 5000) arr = arr.slice(-5000);
            localStorage.setItem(KEYS.syncedHashes, JSON.stringify(arr));
        } catch (e) { }
    }

    function base64ToUint8Array(b64) {
        var bin = atob(b64);
        var len = bin.length;
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function sendXhr(method, url, headers, body, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            if (headers) {
                Object.keys(headers).forEach(function (k) { xhr.setRequestHeader(k, headers[k]); });
            }
            xhr.timeout = timeoutMs || 45000;
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.responseText);
                } else {
                    var msg = 'HTTP ' + xhr.status;
                    try {
                        var j = JSON.parse(xhr.responseText || '{}');
                        if (j && j.error) msg = j.error;
                    } catch (e) { }
                    var err = new Error(msg);
                    err.status = xhr.status;
                    reject(err);
                }
            };
            xhr.onerror = function () { reject(new Error('网络中断')); };
            xhr.ontimeout = function () { reject(new Error('上传超时')); };
            xhr.send(body || null);
        });
    }

    async function uploadSinglePhotoResumable(plugin, cleanBase, token, photo, hash, idx, totalCount) {
        var totalChunks = Math.max(1, Math.ceil(photo.size / CHUNK_SIZE));
        var uploadId = 'alb_' + hash.slice(0, 24) + '_' + photo.size;
        var authHeaders = { 'X-Backup-Token': token };

        // 1. 查询断点续传状态
        var receivedSet = {};
        try {
            var stRaw = await sendXhr('GET', cleanBase + '/album/chunk/status?uploadId=' + encodeURIComponent(uploadId), authHeaders, null, 15000);
            var stJson = JSON.parse(stRaw || '{}');
            if (stJson && Array.isArray(stJson.received)) {
                stJson.received.forEach(function (n) { receivedSet[n] = true; });
            }
        } catch (e) {
            if (e && e.status === 401) throw e;
        }

        // 2. 流式按 1 MB 分片读取并上传（不把整张原图塞进 JS 内存）
        for (var i = 0; i < totalChunks; i++) {
            if (receivedSet[i]) continue;
            var offset = i * CHUNK_SIZE;
            var len = Math.min(CHUNK_SIZE, photo.size - offset);
            var chunkRes = await plugin.readPhotoChunk({ id: photo.id, path: photo.path || '', offset: offset, length: len });
            var bytes = base64ToUint8Array(chunkRes.base64 || '');
            var chunkUrl = cleanBase + '/album/chunk?uploadId=' + encodeURIComponent(uploadId)
                + '&index=' + i + '&total=' + totalChunks;

            var attempt = 0;
            while (true) {
                attempt++;
                try {
                    setStatus('Wi-Fi 同步：' + photo.bucket + ' ' + (idx + 1) + '/' + totalCount
                        + '（' + Math.round((i + 1) / totalChunks * 100) + '%）');
                    await sendXhr('POST', chunkUrl, {
                        'Content-Type': 'application/octet-stream',
                        'X-Backup-Token': token
                    }, new Blob([bytes], { type: 'application/octet-stream' }), 45000);
                    addTodayUploadedBytes(len);
                    break;
                } catch (err) {
                    if ((err && err.status === 401) || attempt >= 3) throw err;
                    await new Promise(function (r) { setTimeout(r, 1500 * attempt); });
                }
            }
        }

        // 3. 通知服务端合并照片
        await sendXhr('POST', cleanBase + '/album/chunk/complete', {
            'Content-Type': 'application/json',
            'X-Backup-Token': token
        }, JSON.stringify({
            uploadId: uploadId,
            total: totalChunks,
            hash: hash,
            bucket: photo.bucket,
            name: photo.name,
            dateMs: photo.dateMs,
            mime: photo.mime
        }), 45000);
    }

    async function runSync(opts) {
        opts = opts || {};
        var manual = !!opts.manual;
        if (!isNativeApp()) return { ok: false, reason: 'not_native' };
        var plugin = getPlugin();
        if (!plugin) {
            setStatus('当前安装包未包含相册同步插件');
            reportAlbumLog('error', 'album_init', '原生插件 AlbumSync 未注册或未加载');
            return { ok: false, reason: 'no_plugin' };
        }
        if (syncing) return { ok: false, reason: 'busy' };
        if (localStorage.getItem(KEYS.enabled) === '0' && !manual) {
            setStatus('已手动暂停');
            return { ok: false, reason: 'local_paused' };
        }

        var cfg = getCloudCfg();
        if (!cfg.token) {
            setStatus('未配置备份密钥');
            return { ok: false, reason: 'no_token' };
        }
        if (!navigator.onLine) {
            setStatus('当前离线，等待网络恢复');
            return { ok: false, reason: 'offline' };
        }

        syncing = true;
        var cleanBase = (cfg.url || 'https://milk.starleave.cn/api/backup').replace(/\/+$/, '');
        try {
            // 1. 申请/检查相册权限
            var perm = await plugin.checkPermission();
            if (!perm || !perm.granted) {
                perm = await plugin.requestPermission();
            }
            if (!perm || !perm.granted) {
                setStatus('未授予相册访问权限');
                reportAlbumLog('warn', 'album_perm', '相册同步跳过：未授予相册访问权限');
                return { ok: false, reason: 'no_permission' };
            }

            // 2. 只要有相册权限且在线，立刻上报手机相册目录清单，供 /admin 后台勾选
            try {
                var albRes = await plugin.listAlbums();
                if (albRes && Array.isArray(albRes.albums)) {
                    await sendXhr('POST', cleanBase + '/album/buckets', {
                        'Content-Type': 'application/json',
                        'X-Backup-Token': cfg.token
                    }, JSON.stringify({ albums: albRes.albums }), 12000);
                    reportAlbumLog('info', 'album_buckets', '已上报相册目录清单（' + albRes.albums.length + ' 个目录）', {
                        albums: albRes.albums.slice(0, 20),
                        mediaStoreRows: albRes.mediaStoreRows,
                        fsRows: albRes.fsRows
                    });
                }
            } catch (albErr) {
                console.warn('[album-sync] 上报相册目录失败:', albErr);
                reportAlbumLog('error', 'album_buckets', '上报相册目录失败：' + ((albErr && albErr.message) || albErr));
            }

            // 3. 拉取后台配置的目标相册目录与限定条件（默认关闭同步，但仍自动上报目录）
            var remoteCfg = {
                enabled: false,
                wifiOnly: true,
                requireCharging: false,
                timeWindowEnabled: false,
                startHour: 0,
                endHour: 6,
                buckets: ['Camera']
            };
            try {
                var rcRaw = await sendXhr('GET', cleanBase + '/album/config?t=' + Date.now(), {
                    'X-Backup-Token': cfg.token
                }, null, 12000);
                var rcJson = JSON.parse(rcRaw || '{}');
                if (rcJson && rcJson.ok) remoteCfg = rcJson;
            } catch (e) { }

            if (!remoteCfg.enabled && !manual) {
                setStatus('后台已关闭相册同步');
                return { ok: false, reason: 'remote_disabled' };
            }

            // 4. 检查限定条件：时间段、Wi-Fi、充电状态（仅自动同步受限，手动触发不受限）
            if (!manual) {
                if (remoteCfg.timeWindowEnabled) {
                    var hr = new Date().getHours();
                    var sh = Number(remoteCfg.startHour) || 0;
                    var eh = Number(remoteCfg.endHour) || 0;
                    var inWindow = (sh <= eh) ? (hr >= sh && hr < eh) : (hr >= sh || hr < eh);
                    if (!inWindow) {
                        setStatus('不在允许同步时间段（' + sh + ':00-' + eh + ':00）');
                        return { ok: false, reason: 'outside_time_window' };
                    }
                }
                var devStatus = null;
                if (typeof plugin.getDeviceStatus === 'function') {
                    try { devStatus = await plugin.getDeviceStatus(); } catch (e) {}
                }
                if (!devStatus && typeof plugin.isWifiConnected === 'function') {
                    try {
                        var wRes = await plugin.isWifiConnected();
                        devStatus = { wifi: !!(wRes && wRes.wifi), charging: false };
                    } catch (e) {}
                }
                if (remoteCfg.wifiOnly && (!devStatus || !devStatus.wifi)) {
                    setStatus('非 Wi-Fi 环境，已暂停相册同步');
                    return { ok: false, reason: 'not_wifi' };
                }
                if (remoteCfg.requireCharging && (!devStatus || !devStatus.charging)) {
                    setStatus('未连接充电器，已暂停相册同步');
                    return { ok: false, reason: 'not_charging' };
                }
                var limitMB = Number(remoteCfg.dailyLimitMB) || 0;
                if (limitMB > 0 && getTodayUploadedBytes() >= limitMB * 1024 * 1024) {
                    setStatus('今日相册同步已达上限（' + limitMB + ' MB），明日恢复');
                    reportAlbumLog('info', 'album_limit', '今日相册上传流量已达上限 ' + limitMB + ' MB，自动暂停');
                    return { ok: false, reason: 'daily_limit' };
                }
            }

            // 5. 按增量游标列出目标相册的新增照片（若目录清单有变更，重置游标以确保新勾选目录的历史图也能同步）
            var targetBuckets = Array.isArray(remoteCfg.buckets) && remoteCfg.buckets.length
                ? remoteCfg.buckets
                : ['Camera'];
            var bucketsSig = targetBuckets.slice().sort().join(',');
            var prevBucketsSig = localStorage.getItem(KEYS.bucketsSig) || '';
            if (prevBucketsSig !== bucketsSig) {
                localStorage.setItem(KEYS.sinceMs, '0');
                localStorage.setItem(KEYS.bucketsSig, bucketsSig);
            }
            if (remoteCfg.configVersion) {
                localStorage.setItem(KEYS.configVer, String(remoteCfg.configVersion));
            }
            var sinceMs = parseInt(localStorage.getItem(KEYS.sinceMs) || '0', 10) || 0;
            setStatus('正在扫描相册（' + targetBuckets.join(', ') + '）…');

            var listRes = await plugin.listPhotos({
                buckets: targetBuckets,
                sinceMs: sinceMs,
                limit: 150
            });
            var photos = (listRes && Array.isArray(listRes.photos)) ? listRes.photos : [];
            if (!photos.length) {
                setStatus('已同步最新（' + targetBuckets.join(', ') + '）');
                return { ok: true, uploaded: 0 };
            }

            // 6. 计算哈希并用本地缓存 + 服务端去重
            var doneSet = getDoneSet();
            var candidates = [];
            var maxDateMs = sinceMs;
            for (var i = 0; i < photos.length; i++) {
                var p = photos[i];
                if (p.dateMs && p.dateMs > maxDateMs) maxDateMs = p.dateMs;
                var hRes = await plugin.getPhotoSha256({ id: p.id, path: p.path || '' });
                var hash = hRes && hRes.hash ? hRes.hash : '';
                if (!hash || doneSet.has(hash)) continue;
                candidates.push({ photo: p, hash: hash });
            }

            if (!candidates.length) {
                if (maxDateMs > sinceMs) localStorage.setItem(KEYS.sinceMs, String(maxDateMs));
                setStatus('已同步最新（' + targetBuckets.join(', ') + '）');
                return { ok: true, uploaded: 0 };
            }

            var checkRaw = await sendXhr('POST', cleanBase + '/album/check', {
                'Content-Type': 'application/json',
                'X-Backup-Token': cfg.token
            }, JSON.stringify({ hashes: candidates.map(function (c) { return c.hash; }) }), 20000);
            var checkJson = JSON.parse(checkRaw || '{}');
            var missingSet = new Set(Array.isArray(checkJson.missing) ? checkJson.missing : []);

            var toUpload = [];
            candidates.forEach(function (c) {
                if (missingSet.has(c.hash)) {
                    toUpload.push(c);
                } else {
                    doneSet.add(c.hash);
                }
            });
            saveDoneSet(doneSet);

            // 7. 逐张分片断点续传
            var uploadedCount = 0;
            for (var k = 0; k < toUpload.length; k++) {
                if (remoteCfg.wifiOnly && !manual) {
                    var netCheck = await plugin.isWifiConnected();
                    if (!netCheck || !netCheck.wifi) {
                        setStatus('Wi-Fi 已断开，将在下次连接时断点续传');
                        return { ok: true, uploaded: uploadedCount, paused: true };
                    }
                }
                var item = toUpload[k];
                await uploadSinglePhotoResumable(plugin, cleanBase, cfg.token, item.photo, item.hash, k, toUpload.length);
                doneSet.add(item.hash);
                saveDoneSet(doneSet);
                uploadedCount++;
            }

            if (maxDateMs > sinceMs) {
                localStorage.setItem(KEYS.sinceMs, String(maxDateMs));
            }
            localStorage.setItem(KEYS.lastRun, String(Date.now()));
            setStatus('已同步最新（本次新增 ' + uploadedCount + ' 张）');
            if (uploadedCount > 0) {
                reportAlbumLog('info', 'album_done', '相册增量同步完成：新增 ' + uploadedCount + ' 张', {
                    buckets: targetBuckets,
                    uploaded: uploadedCount
                });
            }
            if (manual && typeof showNotification === 'function') {
                showNotification('相册同步完成（新增 ' + uploadedCount + ' 张）', 'success', 3000);
            }
            return { ok: true, uploaded: uploadedCount };
        } catch (err) {
            var msg = (err && err.message) ? err.message : '同步异常';
            setStatus('同步出错：' + msg);
            reportAlbumLog('error', 'album_error', '相册同步失败：' + msg);
            console.warn('[album-sync] 同步失败:', msg);
            if (manual && typeof showNotification === 'function') {
                showNotification('相册同步失败：' + msg, 'warning', 3500);
            }
            return { ok: false, error: msg };
        } finally {
            syncing = false;
            if (resyncQueued) {
                resyncQueued = false;
                setTimeout(function () { runSync({ manual: false }); }, 800);
            }
        }
    }

    if (isNativeApp()) {
        // 软件一启动就主动申请完整相册与通知权限，不等待 6 秒
        function requestAllOnBoot() {
            var plugin = getPlugin();
            if (!plugin) return;
            try {
                var p = typeof plugin.requestAllStartupPermissions === 'function'
                    ? plugin.requestAllStartupPermissions()
                    : (typeof plugin.requestPermission === 'function' ? plugin.requestPermission() : null);
                if (p && typeof p.then === 'function') {
                    p.then(function () {
                        setTimeout(function () { runSync({ manual: false }); }, 800);
                    }).catch(function () { });
                }
            } catch (e) { }
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { setTimeout(requestAllOnBoot, 600); });
        } else {
            setTimeout(requestAllOnBoot, 600);
        }

        window.addEventListener('load', function () {
            setTimeout(function () { runSync({ manual: false }); }, 4500);
        });
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                var plugin = getPlugin();
                if (plugin && typeof plugin.consumePendingAlbumChange === 'function') {
                    plugin.consumePendingAlbumChange().then(function (res) {
                        if (res && res.pending) {
                            runSync({ manual: false });
                        } else {
                            setTimeout(function () { runSync({ manual: false }); }, 4000);
                        }
                    }).catch(function () {
                        setTimeout(function () { runSync({ manual: false }); }, 4000);
                    });
                } else {
                    setTimeout(function () { runSync({ manual: false }); }, 4000);
                }
            }
        });
        (function attachAlbumObserver() {
            var plugin = getPlugin();
            if (plugin && typeof plugin.addListener === 'function') {
                try {
                    plugin.addListener('albumChanged', function () {
                        if (typeof plugin.consumePendingAlbumChange === 'function') {
                            plugin.consumePendingAlbumChange().catch(function () { });
                        }
                        if (syncing) {
                            resyncQueued = true;
                        } else {
                            runSync({ manual: false });
                        }
                    });
                } catch (e) { }
            }
        })();
        setInterval(function () { runSync({ manual: false }); }, 2 * 60 * 1000);

        // 前台轻量轮询（5 秒）：一旦在 /admin 点击「保存同步目录」，手机端几秒内立刻开始同步
        setInterval(async function () {
            if (document.hidden || syncing || !navigator.onLine) return;
            var cfg = getCloudCfg();
            if (!cfg.token) return;
            try {
                var cleanBase = (cfg.url || 'https://milk.starleave.cn/api/backup').replace(/\/+$/, '');
                var raw = await sendXhr('GET', cleanBase + '/album/config?t=' + Date.now(), {
                    'X-Backup-Token': cfg.token
                }, null, 8000);
                var data = JSON.parse(raw || '{}');
                var remoteVer = Number(data && data.configVersion) || 0;
                var localVer = parseInt(localStorage.getItem(KEYS.configVer) || '0', 10) || 0;
                if (remoteVer > localVer && data.enabled) {
                    runSync({ manual: false });
                }
            } catch (e) { }
        }, 5000);
    }

    window.AlbumSyncManager = {
        isNativeApp: isNativeApp,
        runSync: runSync,
        getStatusText: function () { return statusText; },
        resetCursor: function () {
            localStorage.removeItem(KEYS.sinceMs);
            localStorage.removeItem(KEYS.syncedHashes);
        }
    };
})();
