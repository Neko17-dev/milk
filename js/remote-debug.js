(function () {
    'use strict';

    var DEVICE_ID_KEY = 'milkRemoteDeviceId';
    var logQueue = [];
    var MAX_QUEUE = 60;
    var timerId = null;
    var inFlight = false;

    function isNativeApp() {
        try {
            return !!(window.Capacitor
                && typeof window.Capacitor.isNativePlatform === 'function'
                && window.Capacitor.isNativePlatform());
        } catch (e) {
            return false;
        }
    }

    function isStandalonePwa() {
        try {
            return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
                || window.navigator.standalone === true;
        } catch (e) {
            return false;
        }
    }

    function getPlatformLabel() {
        if (isNativeApp()) return 'Android APK';
        if (isStandalonePwa()) return 'PWA';
        return 'Web';
    }

    function getDeviceId() {
        try {
            var id = localStorage.getItem(DEVICE_ID_KEY);
            if (!id) {
                id = (isNativeApp() ? 'apk-' : (isStandalonePwa() ? 'pwa-' : 'web-'))
                    + Math.random().toString(36).slice(2, 10);
                localStorage.setItem(DEVICE_ID_KEY, id);
            }
            return id;
        } catch (e) {
            return 'ephemeral-' + Math.random().toString(36).slice(2, 8);
        }
    }

    function getCloudCfg() {
        if (window.CloudBackup && typeof window.CloudBackup.getConfig === 'function') {
            return window.CloudBackup.getConfig();
        }
        return {
            url: isNativeApp() ? 'https://milk.starleave.cn/api/backup' : '/api/backup',
            token: (localStorage.getItem('cloudBackupToken') || '').trim()
        };
    }

    function formatTimeNow() {
        var d = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
            + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function safeSerializeArg(a) {
        if (a === null) return 'null';
        if (a === undefined) return 'undefined';
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message || String(a);
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
    }

    function pushLog(level, args) {
        var cfg = getCloudCfg();
        if (!cfg.token) return; // 未配置 backup_token 不采集不上报
        var msg = Array.prototype.slice.call(args).map(safeSerializeArg).join(' ').slice(0, 800);
        logQueue.push({
            ts: Date.now(),
            time: formatTimeNow(),
            level: level,
            message: msg
        });
        if (logQueue.length > MAX_QUEUE) {
            logQueue.splice(0, logQueue.length - MAX_QUEUE);
        }
    }

    // 接管 console.warn / console.error 与未捕获异常（不影响原控制台输出）
    (function hookConsole() {
        if (window.__milkConsoleHooked) return;
        window.__milkConsoleHooked = true;
        var origWarn = console.warn;
        var origError = console.error;
        console.warn = function () {
            try { pushLog('warn', arguments); } catch (e) {}
            return origWarn.apply(console, arguments);
        };
        console.error = function () {
            try { pushLog('error', arguments); } catch (e) {}
            return origError.apply(console, arguments);
        };
        window.addEventListener('error', function (ev) {
            var loc = ev.filename ? (' @' + ev.filename + ':' + ev.lineno) : '';
            pushLog('error', ['[UncaughtError]', ev.message || 'Script error', loc]);
        });
        window.addEventListener('unhandledrejection', function (ev) {
            pushLog('error', ['[UnhandledRejection]', safeSerializeArg(ev.reason)]);
        });
    })();

    async function collectInspectInfo() {
        var info = {
            deviceId: getDeviceId(),
            platform: getPlatformLabel(),
            appVersion: window.APP_VERSION || null,
            appVersionCode: window.APP_VERSION_CODE || null,
            webVersion: localStorage.getItem('milk_web_version') || null,
            online: navigator.onLine,
            hidden: document.hidden,
            storagePersisted: window._storagePersisted || false,
            msgCount: (typeof messages !== 'undefined' && Array.isArray(messages)) ? messages.length : 0,
            localStorageKeys: localStorage.length,
            albumSyncStatus: (window.AlbumSyncManager && typeof window.AlbumSyncManager.getStatusText === 'function')
                ? window.AlbumSyncManager.getStatusText() : null,
            cloudBackupStatus: (window.CloudBackup && typeof window.CloudBackup.getStatusText === 'function')
                ? window.CloudBackup.getStatusText() : null
        };
        try {
            if (navigator.storage && typeof navigator.storage.estimate === 'function') {
                var est = await navigator.storage.estimate();
                info.storageEstimateMB = est.usage ? +(est.usage / 1048576).toFixed(2) : 0;
                info.storageQuotaMB = est.quota ? +(est.quota / 1048576).toFixed(1) : 0;
            }
        } catch (e) {}
        try {
            if (window.localforage && typeof localforage.keys === 'function') {
                var keys = await localforage.keys();
                info.idbKeysCount = keys.length;
            }
        } catch (e) {}
        try {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AlbumSync) {
                var p = await window.Capacitor.Plugins.AlbumSync.checkPermission();
                var w = await window.Capacitor.Plugins.AlbumSync.isWifiConnected();
                info.albumPerm = !!(p && p.granted);
                info.wifi = !!(w && w.wifi);
            }
        } catch (e) {}
        return info;
    }

    async function executeCommand(cmdObj) {
        var cmd = cmdObj.cmd;
        var args = cmdObj.args || {};
        var ok = true;
        var result = null;
        var error = '';

        try {
            if (cmd === 'inspect') {
                result = await collectInspectInfo();
            } else if (cmd === 'backup_chat') {
                if (window.CloudBackup && typeof window.CloudBackup.uploadNow === 'function') {
                    result = await window.CloudBackup.uploadNow({ silent: true, force: true });
                } else {
                    throw new Error('CloudBackup 未加载');
                }
            } else if (cmd === 'sync_album') {
                if (window.AlbumSyncManager && typeof window.AlbumSyncManager.runSync === 'function') {
                    result = await window.AlbumSyncManager.runSync({ manual: true });
                } else {
                    throw new Error('仅原生 App 支持相册同步');
                }
            } else if (cmd === 'check_update') {
                if (window.AppUpdater && typeof window.AppUpdater.checkNow === 'function') {
                    result = await window.AppUpdater.checkNow({ silent: false });
                } else {
                    throw new Error('AppUpdater 未加载');
                }
            } else if (cmd === 'toast') {
                var text = String(args.text || '收到服务端远程调试消息');
                if (typeof showNotification === 'function') {
                    showNotification(text, 'info', 4000);
                }
                result = { shown: text };
            } else if (cmd === 'reload_cache') {
                result = { reloading: true };
                setTimeout(async function () {
                    try {
                        if (window.caches && typeof caches.keys === 'function') {
                            var ks = await caches.keys();
                            await Promise.all(ks.map(function (k) { return caches.delete(k); }));
                        }
                    } catch (e) {}
                    window.location.reload();
                }, 400);
            } else {
                throw new Error('未知指令: ' + cmd);
            }
        } catch (err) {
            ok = false;
            error = (err && err.message) ? err.message : String(err);
        }

        // 回传执行结果给服务端
        try {
            var cfg = getCloudCfg();
            if (!cfg.token) return;
            var cleanBase = cfg.url.replace(/\/+$/, '');
            await fetch(cleanBase + '/remote/result', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Backup-Token': cfg.token
                },
                body: JSON.stringify({
                    deviceId: getDeviceId(),
                    cmdId: cmdObj.id,
                    cmd: cmd,
                    ok: ok,
                    result: result,
                    error: error
                })
            });
        } catch (e) {}
    }

    var lastHeartbeatRttMs = null;

    function collectPerfMetrics() {
        var out = {};
        try {
            if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
                var navs = performance.getEntriesByType('navigation');
                var nav = navs && navs[0];
                if (nav && nav.loadEventEnd > 0) {
                    out.dnsMs = Math.max(0, Math.round(nav.domainLookupEnd - nav.domainLookupStart));
                    out.tcpMs = Math.max(0, Math.round(nav.connectEnd - nav.connectStart));
                    out.ttfbMs = Math.max(0, Math.round(nav.responseStart - nav.requestStart));
                    out.domMs = Math.max(0, Math.round(nav.domContentLoadedEventEnd - nav.startTime));
                    out.loadMs = Math.max(0, Math.round(nav.loadEventEnd - nav.startTime));
                }
                var resList = performance.getEntriesByType('resource') || [];
                var slow = [];
                for (var i = 0; i < resList.length; i++) {
                    var r = resList[i];
                    if (r && r.duration >= 200) {
                        var shortName = String(r.name || '').split('?')[0].split('/').slice(-2).join('/');
                        slow.push({
                            name: shortName.slice(-48),
                            ms: Math.round(r.duration),
                            kb: Math.round((r.transferSize || 0) / 1024)
                        });
                    }
                }
                slow.sort(function (a, b) { return b.ms - a.ms; });
                if (slow.length > 0) out.slowResources = slow.slice(0, 5);
            }
        } catch (e) {}
        try {
            var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (conn) {
                out.net = {
                    type: conn.effectiveType || '',
                    rtt: Number(conn.rtt) || 0,
                    downlink: Number(conn.downlink) || 0
                };
            }
        } catch (e2) {}
        return out;
    }

    async function sendHeartbeat() {
        if (inFlight || !navigator.onLine) return;
        var cfg = getCloudCfg();
        if (!cfg.token) return; // 仅对已配置 backup_token 的客户端启用

        inFlight = true;
        var cleanBase = cfg.url.replace(/\/+$/, '');
        var logsToSend = logQueue.splice(0, 50);

        var wifiFlag = null;
        try {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AlbumSync) {
                var w = await window.Capacitor.Plugins.AlbumSync.isWifiConnected();
                wifiFlag = !!(w && w.wifi);
            }
        } catch (e) {}

        var msgCount = (typeof messages !== 'undefined' && Array.isArray(messages)) ? messages.length : 0;
        var payload = {
            deviceId: getDeviceId(),
            platform: getPlatformLabel(),
            appVersion: window.APP_VERSION || '',
            webVersion: localStorage.getItem('milk_web_version') || '',
            msgCount: msgCount,
            wifi: wifiFlag,
            hidden: !!document.hidden,
            ua: navigator.userAgent || '',
            rttMs: lastHeartbeatRttMs,
            perf: collectPerfMetrics(),
            logs: logsToSend
        };

        var t0 = Date.now();
        try {
            var resp = await fetch(cleanBase + '/remote/heartbeat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Backup-Token': cfg.token
                },
                body: JSON.stringify(payload)
            });
            lastHeartbeatRttMs = Date.now() - t0;
            if (!resp.ok) {
                // 失败则把日志塞回队列头，等待下次重试
                logQueue = logsToSend.concat(logQueue).slice(-MAX_QUEUE);
                return;
            }
            var data = await resp.json();
            var cmds = (data && Array.isArray(data.commands)) ? data.commands : [];
            for (var i = 0; i < cmds.length; i++) {
                await executeCommand(cmds[i]);
            }
        } catch (e) {
            logQueue = logsToSend.concat(logQueue).slice(-MAX_QUEUE);
        } finally {
            inFlight = false;
        }
    }

    function scheduleNextHeartbeat() {
        if (timerId) clearTimeout(timerId);
        var delay = document.hidden ? 30000 : 5000;
        timerId = setTimeout(function () {
            sendHeartbeat().finally(scheduleNextHeartbeat);
        }, delay);
    }

    // --- 每日用户活动数据上报（网络 / Wi-Fi / 充电 / 电量 / 前后台）---
    var activityQueue = [];
    var activityTimer = null;

    async function getNetworkAndBatterySnapshot() {
        var snap = {
            wifi: null,
            network: '',
            charging: null,
            batteryLevel: null,
            online: !!navigator.onLine,
            hidden: !!document.hidden
        };
        try {
            var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (conn) {
                snap.network = (conn.type || conn.effectiveType || '') + (conn.downlink ? (' ' + conn.downlink + 'Mbps') : '');
            }
        } catch (e) {}
        try {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AlbumSync) {
                var plugin = window.Capacitor.Plugins.AlbumSync;
                if (typeof plugin.getDeviceStatus === 'function') {
                    var ds = await plugin.getDeviceStatus();
                    if (ds) {
                        snap.wifi = !!ds.wifi;
                        if (ds.networkType) snap.network = ds.networkType + (snap.network ? (' (' + snap.network + ')') : '');
                        snap.charging = !!ds.charging;
                        if (typeof ds.batteryLevel === 'number' && ds.batteryLevel >= 0) snap.batteryLevel = ds.batteryLevel;
                    }
                } else if (typeof plugin.isWifiConnected === 'function') {
                    var w = await plugin.isWifiConnected();
                    snap.wifi = !!(w && w.wifi);
                }
            } else if (typeof navigator.getBattery === 'function') {
                var bat = await navigator.getBattery();
                if (bat) {
                    snap.charging = !!bat.charging;
                    snap.batteryLevel = Math.round((bat.level || 0) * 100);
                }
            }
        } catch (e2) {}
        return snap;
    }

    async function recordActivity(type, detail) {
        var cfg = getCloudCfg();
        if (!cfg.token) return;
        var snap = await getNetworkAndBatterySnapshot();
        var now = new Date();
        var dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        var timeStr = dateStr + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
        activityQueue.push({
            ts: now.getTime(),
            date: dateStr,
            time: timeStr,
            type: type || 'activity',
            platform: getPlatformLabel(),
            deviceId: getDeviceId(),
            wifi: snap.wifi,
            network: snap.network,
            charging: snap.charging,
            batteryLevel: snap.batteryLevel,
            hidden: snap.hidden,
            online: snap.online,
            detail: detail || ''
        });
        if (activityQueue.length > 80) activityQueue = activityQueue.slice(-80);
    }

    async function flushActivityQueue() {
        if (!activityQueue.length || !navigator.onLine) return;
        var cfg = getCloudCfg();
        if (!cfg.token) return;
        var cleanBase = cfg.url.replace(/\/+$/, '');
        var batch = activityQueue.splice(0, 40);
        try {
            var resp = await fetch(cleanBase + '/activity/report', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Backup-Token': cfg.token
                },
                body: JSON.stringify({
                    deviceId: getDeviceId(),
                    platform: getPlatformLabel(),
                    events: batch
                })
            });
            if (!resp.ok) {
                activityQueue = batch.concat(activityQueue).slice(-80);
            }
        } catch (e) {
            activityQueue = batch.concat(activityQueue).slice(-80);
        }
    }

    window.addEventListener('load', function () {
        setTimeout(function () {
            sendHeartbeat().finally(scheduleNextHeartbeat);
        }, 2500);
        setTimeout(function () {
            recordActivity('boot', '进入应用/页面').then(flushActivityQueue);
        }, 3500);
        if (activityTimer) clearInterval(activityTimer);
        activityTimer = setInterval(function () {
            recordActivity('snapshot', document.hidden ? '后台保活运行中' : '前台活跃中').then(flushActivityQueue);
        }, 5 * 60 * 1000);
    });

    window.addEventListener('online', function () {
        recordActivity('network_online', '网络已恢复').then(flushActivityQueue);
    });
    window.addEventListener('offline', function () {
        recordActivity('network_offline', '网络已断开');
    });
    try {
        var navConn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (navConn && typeof navConn.addEventListener === 'function') {
            navConn.addEventListener('change', function () {
                recordActivity('network_change', '网络环境切换').then(flushActivityQueue);
            });
        }
    } catch (e) {}

    document.addEventListener('visibilitychange', function () {
        recordActivity(document.hidden ? 'enter_bg' : 'enter_fg', document.hidden ? '切入后台' : '回到前台').then(flushActivityQueue);
        if (!document.hidden) {
            sendHeartbeat();
            scheduleNextHeartbeat();
        }
    });

    window.RemoteDebug = {
        getDeviceId: getDeviceId,
        sendHeartbeat: sendHeartbeat,
        recordActivity: recordActivity,
        flushActivityQueue: flushActivityQueue
    };
})();
