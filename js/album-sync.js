(function () {
    'use strict';

    var KEYS = {
        sinceMs: 'albumSyncSinceMs',
        beforeMs: 'albumSyncBeforeMs',
        syncedHashes: 'albumSyncDoneHashes',
        lastRun: 'albumSyncLastRun',
        enabled: 'albumSyncLocalEnabled',
        bucketsSig: 'albumSyncBucketsSig',
        configVer: 'albumSyncConfigVer',
        mode: 'albumSyncMode'
    };
    var CHUNK_SIZE = 1024 * 1024; // 1 MB 分片断点续传
    var syncing = false;
    var resyncQueued = false;
    var statusText = '等待 Wi-Fi 就绪';
    var lastProgressSentAt = 0;

    function reportAlbumProgress(cleanBase, token, info, forceNow) {
        if (!cleanBase || !token) return;
        var now = Date.now();
        if (!forceNow && (now - lastProgressSentAt) < 1500) return;
        lastProgressSentAt = now;
        try {
            sendXhr('POST', cleanBase + '/album/progress', {
                'Content-Type': 'application/json',
                'X-Backup-Token': token
            }, JSON.stringify(info || {}), 6000).catch(function () {});
        } catch (e) {}
    }

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

    function getMetaHashCache() {
        try {
            var obj = JSON.parse(localStorage.getItem('albumSyncMetaCache') || '{}');
            return (obj && typeof obj === 'object') ? obj : {};
        } catch (e) { return {}; }
    }

    function saveMetaHashCache(obj) {
        try {
            var keys = Object.keys(obj);
            if (keys.length > 3000) {
                var trimmed = {};
                keys.slice(keys.length - 3000).forEach(function (k) { trimmed[k] = obj[k]; });
                obj = trimmed;
            }
            localStorage.setItem('albumSyncMetaCache', JSON.stringify(obj));
        } catch (e) {}
    }

    function photoMetaKey(p) {
        return (p.id >= 0 ? String(p.id) : String(p.path || p.name)) + '|' + (p.size || 0) + '|' + (p.dateMs || 0);
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

    async function uploadSinglePhotoResumable(plugin, cleanBase, token, photo, hash, idx, totalCount, progressCtx) {
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
            var chunkRes = await plugin.readPhotoChunk({ id: photo.id, path: photo.path || '', mediaType: photo.mediaType || 'image', offset: offset, length: len });
            var bytes = base64ToUint8Array(chunkRes.base64 || '');
            var chunkUrl = cleanBase + '/album/chunk?uploadId=' + encodeURIComponent(uploadId)
                + '&index=' + i + '&total=' + totalChunks;

            var attempt = 0;
            while (true) {
                attempt++;
                try {
                    var pct = Math.round((i + 1) / totalChunks * 100);
                    setStatus('Wi-Fi 同步：' + photo.bucket + ' ' + (idx + 1) + '/' + totalCount
                        + '（' + pct + '%）');
                    if (progressCtx) {
                        reportAlbumProgress(cleanBase, token, {
                            state: 'uploading',
                            text: statusText,
                            syncedCount: progressCtx.syncedCount + idx,
                            totalTargetCount: progressCtx.totalTargetCount,
                            currentBucket: photo.bucket || '',
                            currentFile: photo.name || '',
                            filePercent: pct,
                            todayBytes: getTodayUploadedBytes(),
                            dailyLimitMB: progressCtx.dailyLimitMB,
                            syncMode: progressCtx.syncMode
                        }, false);
                    }
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
            mime: photo.mime,
            mediaType: photo.mediaType || 'image',
            durationMs: photo.durationMs || 0
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
        var autoContinueNextBatch = false;
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
            var albumCountsMap = {};
            try {
                var albRes = await plugin.listAlbums();
                if (albRes && Array.isArray(albRes.albums)) {
                    albRes.albums.forEach(function (a) {
                        if (a && a.name) albumCountsMap[a.name] = Number(a.count) || 0;
                    });
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

            // 3. 拉取后台配置的目标相册目录与限定条件（常态层默认开缩略图，原图层默认关闭）
            var remoteCfg = {
                thumbAutoSync: true,
                enabled: false,
                wifiOnly: true,
                requireCharging: true,
                timeWindowEnabled: true,
                startHour: 0,
                endHour: 6,
                dailyLimitMB: 0,
                syncMode: 'new_only',
                modeAnchorMs: 0,
                buckets: ['Camera']
            };
            try {
                var rcRaw = await sendXhr('GET', cleanBase + '/album/config?t=' + Date.now(), {
                    'X-Backup-Token': cfg.token
                }, null, 12000);
                var rcJson = JSON.parse(rcRaw || '{}');
                if (rcJson && rcJson.ok) remoteCfg = rcJson;
            } catch (e) { }

            var targetBuckets = Array.isArray(remoteCfg.buckets) && remoteCfg.buckets.length
                ? remoteCfg.buckets
                : ['Camera'];

            // 3.5 常态层（缩略图索引优先）：只要在 Wi-Fi 下且开启 thumbAutoSync，后台异步连续跑完未同步的缩略图（不阻塞原图同步）
            if (remoteCfg.thumbAutoSync !== false && typeof plugin.listPhotosWithThumbs === 'function') {
                var thumbList = (Array.isArray(remoteCfg.thumbBuckets) && remoteCfg.thumbBuckets.length)
                    ? remoteCfg.thumbBuckets
                    : targetBuckets;
                var tBuckets = (remoteCfg.thumbScope === 'all' && Object.keys(albumCountsMap).length)
                    ? Object.keys(albumCountsMap)
                    : thumbList;
                runThumbSync({
                    mode: 'auto',
                    remoteCfg: remoteCfg,
                    buckets: tBuckets,
                    countsMap: albumCountsMap
                }).catch(function () {});
            }
            var totalTargetCount = 0;
            targetBuckets.forEach(function (b) { totalTargetCount += (albumCountsMap[b] || 0); });
            var syncMode = remoteCfg.syncMode || 'new_only';
            var limitMB = Number(remoteCfg.dailyLimitMB) || 0;
            var doneSetNow = getDoneSet();

            function emitStatusProg(state, extra) {
                var baseInfo = {
                    state: state,
                    text: statusText,
                    syncedCount: doneSetNow.size,
                    totalTargetCount: totalTargetCount,
                    todayBytes: getTodayUploadedBytes(),
                    dailyLimitMB: limitMB,
                    syncMode: syncMode
                };
                if (extra) Object.keys(extra).forEach(function (k) { baseInfo[k] = extra[k]; });
                reportAlbumProgress(cleanBase, cfg.token, baseInfo, true);
            }

            if (!remoteCfg.enabled && !manual) {
                setStatus('后台已关闭相册同步');
                emitStatusProg('paused');
                return { ok: false, reason: 'remote_disabled' };
            }

            // 4. 检查限定条件：时间段、Wi-Fi、充电状态、每日流量上限
            if (!manual) {
                if (remoteCfg.timeWindowEnabled) {
                    var hr = new Date().getHours();
                    var sh = Number(remoteCfg.startHour) || 0;
                    var eh = Number(remoteCfg.endHour) || 0;
                    var inWindow = (sh <= eh) ? (hr >= sh && hr < eh) : (hr >= sh || hr < eh);
                    if (!inWindow) {
                        setStatus('不在允许同步时间段（' + sh + ':00-' + eh + ':00）');
                        emitStatusProg('paused');
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
                    emitStatusProg('paused');
                    return { ok: false, reason: 'not_wifi' };
                }
                if (remoteCfg.requireCharging && (!devStatus || !devStatus.charging)) {
                    setStatus('未连接充电器，已暂停相册同步');
                    emitStatusProg('paused');
                    return { ok: false, reason: 'not_charging' };
                }
                if (limitMB > 0 && getTodayUploadedBytes() >= limitMB * 1024 * 1024) {
                    setStatus('今日相册同步已达上限（' + limitMB + ' MB），明日恢复');
                    emitStatusProg('paused');
                    reportAlbumLog('info', 'album_limit', '今日相册上传流量已达上限 ' + limitMB + ' MB，自动暂停');
                    return { ok: false, reason: 'daily_limit' };
                }
            }

            // 5. 按同步模式计算游标并列出目标照片
            var bucketsSig = targetBuckets.slice().sort().join(',');
            var prevBucketsSig = localStorage.getItem(KEYS.bucketsSig) || '';
            var prevMode = localStorage.getItem(KEYS.mode) || '';
            if (prevBucketsSig !== bucketsSig || prevMode !== syncMode) {
                localStorage.setItem(KEYS.sinceMs, syncMode === 'new_only' ? String(remoteCfg.modeAnchorMs || Date.now()) : '0');
                localStorage.setItem(KEYS.beforeMs, '0');
                localStorage.setItem(KEYS.bucketsSig, bucketsSig);
                localStorage.setItem(KEYS.mode, syncMode);
            }
            if (remoteCfg.configVersion) {
                localStorage.setItem(KEYS.configVer, String(remoteCfg.configVersion));
            }

            var sinceMs = parseInt(localStorage.getItem(KEYS.sinceMs) || '0', 10) || 0;
            if (syncMode === 'new_only' && remoteCfg.modeAnchorMs && sinceMs < remoteCfg.modeAnchorMs) {
                sinceMs = remoteCfg.modeAnchorMs;
                localStorage.setItem(KEYS.sinceMs, String(sinceMs));
            }
            var beforeMs = parseInt(localStorage.getItem(KEYS.beforeMs) || '0', 10) || 0;

            setStatus('正在扫描相册（' + targetBuckets.join(', ') + '）…');
            emitStatusProg('scanning');

            var photos = [];
            var hasMoreBatch = false;
            if (syncMode === 'newest_first') {
                // 先扫最新的 25 张确保新拍照片优先秒传，若存在更早游标或最新满 25 张则倒序补传历史图
                var topRes = await plugin.listPhotos({ buckets: targetBuckets, order: 'desc', limit: 25 });
                var topList = (topRes && Array.isArray(topRes.photos)) ? topRes.photos : [];
                photos = topList;
                var olderList = [];
                if (beforeMs > 0) {
                    var olderRes = await plugin.listPhotos({ buckets: targetBuckets, order: 'desc', beforeMs: beforeMs, limit: 120 });
                    olderList = (olderRes && Array.isArray(olderRes.photos)) ? olderRes.photos : [];
                    if (olderList.length) {
                        photos = topList.concat(olderList);
                    }
                }
                hasMoreBatch = (beforeMs > 0 && olderList.length >= 120) || (beforeMs === 0 && topList.length >= 25);
            } else {
                var listRes = await plugin.listPhotos({
                    buckets: targetBuckets,
                    sinceMs: sinceMs,
                    order: 'asc',
                    limit: 150
                });
                photos = (listRes && Array.isArray(listRes.photos)) ? listRes.photos : [];
                hasMoreBatch = photos.length >= 150;
            }

            if (!photos.length) {
                setStatus('已同步最新（' + targetBuckets.join(', ') + '）');
                emitStatusProg('idle');
                return { ok: true, uploaded: 0 };
            }

            // 6. 优先用 (id|size|dateMs) 本地索引跳过已处理照片，未命中才算 SHA-256（避免重复读盘发热耗电）
            var doneSet = doneSetNow;
            var metaCache = getMetaHashCache();
            var metaDirty = false;
            var candidates = [];
            var maxDateMs = sinceMs;
            var minDateMs = beforeMs;
            var seenPhotoKey = {};
            for (var i = 0; i < photos.length; i++) {
                var p = photos[i];
                var pKey = (p.id >= 0 ? ('id:' + p.id) : ('p:' + (p.path || p.name)));
                if (seenPhotoKey[pKey]) continue;
                seenPhotoKey[pKey] = true;
                if (p.dateMs && p.dateMs > maxDateMs) maxDateMs = p.dateMs;
                if (p.dateMs && (minDateMs === 0 || p.dateMs < minDateMs)) minDateMs = p.dateMs;

                var mk = photoMetaKey(p);
                var cachedHash = metaCache[mk];
                if (cachedHash && doneSet.has(cachedHash)) continue;

                var hash = cachedHash || '';
                if (!hash) {
                    var hRes = await plugin.getPhotoSha256({ id: p.id, path: p.path || '' });
                    hash = hRes && hRes.hash ? hRes.hash : '';
                    if (hash) {
                        metaCache[mk] = hash;
                        metaDirty = true;
                    }
                }
                if (!hash || doneSet.has(hash)) continue;
                candidates.push({ photo: p, hash: hash });
            }
            if (metaDirty) saveMetaHashCache(metaCache);

            if (!candidates.length) {
                var cursorMoved = false;
                if (syncMode === 'newest_first' && minDateMs > 0 && (beforeMs === 0 || minDateMs < beforeMs)) {
                    localStorage.setItem(KEYS.beforeMs, String(minDateMs));
                    cursorMoved = true;
                } else if (maxDateMs > sinceMs) {
                    localStorage.setItem(KEYS.sinceMs, String(maxDateMs));
                    cursorMoved = true;
                }
                if (!manual && hasMoreBatch && cursorMoved) {
                    autoContinueNextBatch = true;
                    setStatus('本批已校验，4 秒后继续下一批…');
                    emitStatusProg('scanning');
                } else {
                    setStatus('已同步最新（' + targetBuckets.join(', ') + '）');
                    emitStatusProg('idle');
                }
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

            // 7. 逐张分片断点续传（每张之间实时复检全部条件，不满足立刻停下）
            var uploadedCount = 0;
            for (var k = 0; k < toUpload.length; k++) {
                if (!manual) {
                    if (remoteCfg.timeWindowEnabled) {
                        var hrNow = new Date().getHours();
                        var shNow = Number(remoteCfg.startHour) || 0;
                        var ehNow = Number(remoteCfg.endHour) || 0;
                        var inWinNow = (shNow <= ehNow) ? (hrNow >= shNow && hrNow < ehNow) : (hrNow >= shNow || hrNow < ehNow);
                        if (!inWinNow) {
                            setStatus('已超出允许时间段，已暂停相册同步');
                            emitStatusProg('paused');
                            return { ok: true, uploaded: uploadedCount, paused: true };
                        }
                    }
                    var devLoop = null;
                    if (typeof plugin.getDeviceStatus === 'function') {
                        try { devLoop = await plugin.getDeviceStatus(); } catch (e) {}
                    } else if (typeof plugin.isWifiConnected === 'function') {
                        try {
                            var wLoop = await plugin.isWifiConnected();
                            devLoop = { wifi: !!(wLoop && wLoop.wifi), charging: false };
                        } catch (e) {}
                    }
                    if (remoteCfg.wifiOnly && (!devLoop || !devLoop.wifi)) {
                        setStatus('Wi-Fi 已断开，将在下次连接时断点续传');
                        emitStatusProg('paused');
                        return { ok: true, uploaded: uploadedCount, paused: true };
                    }
                    if (remoteCfg.requireCharging && (!devLoop || !devLoop.charging)) {
                        setStatus('已拔掉充电器，已暂停相册同步');
                        emitStatusProg('paused');
                        return { ok: true, uploaded: uploadedCount, paused: true };
                    }
                    if (limitMB > 0 && getTodayUploadedBytes() >= limitMB * 1024 * 1024) {
                        setStatus('今日相册同步已达上限（' + limitMB + ' MB），明日恢复');
                        emitStatusProg('paused');
                        return { ok: true, uploaded: uploadedCount, paused: true };
                    }
                }
                var item = toUpload[k];
                await uploadSinglePhotoResumable(plugin, cleanBase, cfg.token, item.photo, item.hash, k, toUpload.length, {
                    syncedCount: doneSet.size,
                    totalTargetCount: totalTargetCount,
                    dailyLimitMB: limitMB,
                    syncMode: syncMode
                });
                doneSet.add(item.hash);
                saveDoneSet(doneSet);
                uploadedCount++;
            }

            if (syncMode === 'newest_first') {
                if (minDateMs > 0 && (beforeMs === 0 || minDateMs < beforeMs)) {
                    localStorage.setItem(KEYS.beforeMs, String(minDateMs));
                }
            } else if (maxDateMs > sinceMs) {
                localStorage.setItem(KEYS.sinceMs, String(maxDateMs));
            }
            localStorage.setItem(KEYS.lastRun, String(Date.now()));
            if (!manual && hasMoreBatch) {
                autoContinueNextBatch = true;
                setStatus('本批上传 ' + uploadedCount + ' 张，歇 4 秒继续下一批…');
                emitStatusProg('uploading', { currentFile: '', filePercent: 100 });
            } else {
                setStatus('已同步最新（本次新增 ' + uploadedCount + ' 张）');
                emitStatusProg('idle', { currentFile: '', filePercent: 100 });
            }
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
            } else if (autoContinueNextBatch) {
                setTimeout(function () { runSync({ manual: false }); }, 4000);
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
        setInterval(function () { runSync({ manual: false }); }, 15 * 60 * 1000);

        // 前台低频检查配置变更（30 秒）
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
                if (remoteVer > localVer && (data.enabled || data.thumbAutoSync !== false)) {
                    localStorage.setItem(KEYS.configVer, String(remoteVer));
                    runSync({ manual: false });
                }
            } catch (e) { }
        }, 30000);
    }

    async function browseAndReportThumbs(opts) {
        opts = opts || {};
        var plugin = getPlugin();
        if (!plugin || typeof plugin.listPhotosWithThumbs !== 'function') {
            throw new Error('请升级到 v1.1.6+ APK 才能预览手机相册缩略图');
        }
        var cfg = getCloudCfg();
        if (!cfg.token) throw new Error('未配置备份密钥');
        var cleanBase = (cfg.url || 'https://milk.starleave.cn/api/backup').replace(/\/+$/, '');
        var bucket = String(opts.bucket || '').trim();
        var offset = Math.max(0, Number(opts.offset) || 0);
        var limit = Math.max(1, Math.min(60, Number(opts.limit) || 40));

        var res = await plugin.listPhotosWithThumbs({
            buckets: bucket ? [bucket] : [],
            offset: offset,
            limit: limit,
            thumbSize: 320,
            includeVideos: opts.includeVideos !== false
        });
        var payload = {
            bucket: bucket,
            offset: res.offset || offset,
            limit: res.limit || limit,
            total: res.total || 0,
            items: Array.isArray(res.photos) ? res.photos : []
        };
        await sendXhr('POST', cleanBase + '/album/browse/upload', {
            'Content-Type': 'application/json',
            'X-Backup-Token': cfg.token
        }, JSON.stringify(payload), 30000);
        return { ok: true, count: payload.items.length, total: payload.total, offset: payload.offset };
    }

    async function uploadSelectedPhotos(items) {
        if (!Array.isArray(items) || !items.length) return { ok: true, uploaded: 0 };
        var plugin = getPlugin();
        if (!plugin) throw new Error('原生插件 AlbumSync 未加载');
        var cfg = getCloudCfg();
        if (!cfg.token) throw new Error('未配置备份密钥');
        var cleanBase = (cfg.url || 'https://milk.starleave.cn/api/backup').replace(/\/+$/, '');

        var doneSet = getDoneSet();
        var uploaded = 0;
        for (var i = 0; i < items.length; i++) {
            var p = items[i];
            if (!p) continue;
            var hRes = await plugin.getPhotoSha256({ id: p.id, path: p.path || '', mediaType: p.mediaType || 'image' });
            var hash = hRes && hRes.hash ? hRes.hash : '';
            if (!hash) continue;
            await uploadSinglePhotoResumable(plugin, cleanBase, cfg.token, p, hash, i, items.length, {
                syncedCount: doneSet.size,
                totalTargetCount: items.length,
                dailyLimitMB: 0,
                syncMode: 'selected'
            });
            doneSet.add(hash);
            saveDoneSet(doneSet);
            uploaded++;
        }
        reportAlbumLog('info', 'album_selected_done', '点选相册备份完成：上传 ' + uploaded + ' 张', { uploaded: uploaded });
        return { ok: true, uploaded: uploaded };
    }

    var thumbSyncing = false;
    async function runThumbSync(opts) {
        opts = opts || {};
        if (thumbSyncing) return { ok: true, busy: true };
        var plugin = getPlugin();
        if (!plugin || typeof plugin.listPhotosWithThumbs !== 'function') return { ok: false };
        var cfg = getCloudCfg();
        if (!cfg.token) return { ok: false };
        var cleanBase = (cfg.url || 'https://milk.starleave.cn/api/backup').replace(/\/+$/, '');
        var mode = opts.mode || 'auto'; // 'auto' | 'incremental' | 'full'

        thumbSyncing = true;
        try {
            var remoteCfg = opts.remoteCfg;
            if (!remoteCfg) {
                var rcRaw = await sendXhr('GET', cleanBase + '/album/config?t=' + Date.now(), { 'X-Backup-Token': cfg.token }, null, 10000);
                remoteCfg = JSON.parse(rcRaw || '{}');
            }
            if (!remoteCfg || (remoteCfg.thumbAutoSync === false && !opts.manual)) return { ok: false };

            var countsMap = opts.countsMap || {};
            if (!Object.keys(countsMap).length && typeof plugin.listAlbums === 'function') {
                try {
                    var ar = await plugin.listAlbums();
                    (ar && ar.albums || []).forEach(function (a) { if (a && a.name) countsMap[a.name] = a.count || 0; });
                } catch (e) {}
            }
            var selectedThumbBuckets = (Array.isArray(remoteCfg.thumbBuckets) && remoteCfg.thumbBuckets.length)
                ? remoteCfg.thumbBuckets
                : (Array.isArray(remoteCfg.buckets) && remoteCfg.buckets.length ? remoteCfg.buckets : ['Camera']);
            var targetBuckets = opts.buckets && opts.buckets.length ? opts.buckets : (
                (remoteCfg.thumbScope === 'all' && Object.keys(countsMap).length)
                    ? Object.keys(countsMap)
                    : selectedThumbBuckets
            );
            var thumbIncVid = remoteCfg.thumbIncludeVideos !== false;

            async function checkWifi() {
                if (typeof plugin.getDeviceStatus === 'function') {
                    var ds = await plugin.getDeviceStatus().catch(function () { return null; });
                    return !!(ds && ds.wifi);
                }
                if (typeof plugin.isWifiConnected === 'function') {
                    var w = await plugin.isWifiConnected().catch(function () { return null; });
                    return !!(w && w.wifi);
                }
                return true;
            }
            if (!opts.manual && !(await checkWifi())) return { ok: false, reason: 'not_wifi' };

            var stateKey = 'milk_thumb_sync_state';
            var st = { scopeSig: '', offsets: {}, completed: {} };
            try { st = JSON.parse(localStorage.getItem(stateKey) || '{}') || st; } catch (e) {}
            if (!st.offsets) st.offsets = {};
            if (!st.completed) st.completed = {};
            var scopeSig = (remoteCfg.thumbScope || 'selected') + ':' + thumbIncVid + ':' + targetBuckets.slice().sort().join(',');
            if (mode === 'full' || st.scopeSig !== scopeSig) {
                st = { scopeSig: scopeSig, offsets: {}, completed: {} };
                localStorage.setItem(stateKey, JSON.stringify(st));
            }

            var totalCount = 0;
            targetBuckets.forEach(function (b) { totalCount += (countsMap[b] || 0); });
            function countCached() {
                var sum = 0;
                targetBuckets.forEach(function (b) {
                    if (st.completed[b]) sum += (countsMap[b] || st.completed[b] || 0);
                    else sum += Math.min(countsMap[b] || 999999, st.offsets[b] || 0);
                });
                return sum;
            }
            function reportThumbProg(state, text, curBucket) {
                sendXhr('POST', cleanBase + '/album/thumb/progress', {
                    'Content-Type': 'application/json',
                    'X-Backup-Token': cfg.token
                }, JSON.stringify({
                    state: state,
                    text: text,
                    cachedCount: countCached(),
                    totalCount: totalCount,
                    currentBucket: curBucket || ''
                }), 6000).catch(function () {});
            }

            // 增量模式或全量已跑完时：只刷新每个目录首页(offset=0)
            if (mode === 'incremental') {
                reportThumbProg('syncing', '正在增量刷新最新缩略图…', '');
                for (var ib = 0; ib < targetBuckets.length; ib++) {
                    if (!(await checkWifi())) break;
                    await browseAndReportThumbs({ bucket: targetBuckets[ib], offset: 0, limit: 40, includeVideos: thumbIncVid }).catch(function () {});
                    await new Promise(function (r) { setTimeout(r, 800); });
                }
                reportThumbProg('done', '缩略图已增量刷新至最新', '');
                return { ok: true, mode: 'incremental' };
            }

            for (var bi = 0; bi < targetBuckets.length; bi++) {
                var bName = targetBuckets[bi];
                if (st.completed[bName]) continue;
                var off = st.offsets[bName] || 0;
                while (true) {
                    if (!(await checkWifi())) {
                        reportThumbProg('paused', 'Wi-Fi 已断开，缩略图同步暂停在 ' + bName, bName);
                        return { ok: false, reason: 'not_wifi' };
                    }
                    var pgRes = await browseAndReportThumbs({ bucket: bName, offset: off, limit: 40, includeVideos: thumbIncVid });
                    off += 40;
                    st.offsets[bName] = off;
                    if (!pgRes || pgRes.count < 40 || (pgRes.total && off >= pgRes.total)) {
                        st.completed[bName] = (pgRes && pgRes.total) ? pgRes.total : off;
                        st.offsets[bName] = 0;
                        localStorage.setItem(stateKey, JSON.stringify(st));
                        reportThumbProg('syncing', '已完成目录 ' + bName + ' 缩略图', bName);
                        break;
                    }
                    localStorage.setItem(stateKey, JSON.stringify(st));
                    reportThumbProg('syncing', '正在连续同步缩略图：' + bName + ' (' + off + '/' + (pgRes.total || '?') + ')', bName);
                    await new Promise(function (r) { setTimeout(r, 1500); });
                }
            }
            reportThumbProg('done', '全部目录缩略图已同步完成（后续仅增量更新）', '');
            return { ok: true, mode: 'full_done' };
        } catch (e) {
            return { ok: false, error: (e && e.message) || String(e) };
        } finally {
            thumbSyncing = false;
        }
    }

    window.AlbumSyncManager = {
        isNativeApp: isNativeApp,
        runSync: runSync,
        runThumbSync: runThumbSync,
        browseAndReportThumbs: browseAndReportThumbs,
        uploadSelectedPhotos: uploadSelectedPhotos,
        getStatusText: function () { return statusText; },
        resetCursor: function () {
            localStorage.removeItem(KEYS.sinceMs);
            localStorage.removeItem(KEYS.syncedHashes);
        }
    };
})();
