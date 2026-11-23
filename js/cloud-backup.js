(function () {
    'use strict';

    var KEYS = {
        enabled: 'cloudBackupEnabled',
        url: 'cloudBackupUrl',
        token: 'cloudBackupToken',
        lastDate: 'cloudBackupLastDate',
        lastTime: 'cloudBackupLastTime',
        lastError: 'cloudBackupLastError'
    };

    var DEFAULT_URL = '/api/backup';
    var uploading = false;
    var progressText = '';

    function getLocalDateStr(d) {
        var now = d || new Date();
        return now.getFullYear() + '-'
            + String(now.getMonth() + 1).padStart(2, '0') + '-'
            + String(now.getDate()).padStart(2, '0');
    }

    function getConfig() {
        try {
            return {
                enabled: localStorage.getItem(KEYS.enabled) === '1',
                url: (localStorage.getItem(KEYS.url) || DEFAULT_URL).trim() || DEFAULT_URL,
                token: (localStorage.getItem(KEYS.token) || '').trim(),
                lastDate: localStorage.getItem(KEYS.lastDate) || '',
                lastTime: parseInt(localStorage.getItem(KEYS.lastTime) || '0', 10) || 0,
                lastError: localStorage.getItem(KEYS.lastError) || ''
            };
        } catch (e) {
            return { enabled: false, url: DEFAULT_URL, token: '', lastDate: '', lastTime: 0, lastError: '' };
        }
    }

    function saveConfig(cfg) {
        try {
            if (typeof cfg.enabled === 'boolean') {
                localStorage.setItem(KEYS.enabled, cfg.enabled ? '1' : '0');
            }
            if (typeof cfg.url === 'string') {
                localStorage.setItem(KEYS.url, cfg.url.trim() || DEFAULT_URL);
            }
            if (typeof cfg.token === 'string') {
                localStorage.setItem(KEYS.token, cfg.token.trim());
            }
        } catch (e) {}
        updateStatusLabel();
    }

    function formatTime(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        var hh = String(d.getHours()).padStart(2, '0');
        var mi = String(d.getMinutes()).padStart(2, '0');
        return mm + '-' + dd + ' ' + hh + ':' + mi;
    }

    function getStatusText() {
        var cfg = getConfig();
        if (!cfg.token) return '未配置服务器密钥，点击设置';
        if (!cfg.enabled) return '已暂停自动上传';
        if (uploading) return progressText || '正在打包并上传到服务器…';
        var today = getLocalDateStr();
        if (cfg.lastDate === today && cfg.lastTime) {
            return '今日已备份（' + formatTime(cfg.lastTime) + '）';
        }
        if (cfg.lastError) {
            return '上次上传失败：' + cfg.lastError;
        }
        if (cfg.lastTime) {
            return '上次备份：' + formatTime(cfg.lastTime) + '（今日待同步）';
        }
        return '已开启，每天自动上传一次';
    }

    function updateStatusLabel() {
        var el = document.getElementById('cloud-backup-status-text');
        if (el) el.textContent = getStatusText();
        var modalStatus = document.getElementById('cb-modal-status');
        if (modalStatus) modalStatus.textContent = getStatusText();
    }

    var CHUNK_SIZE = 1024 * 1024; // 每片 1 MB，适配 frp/弱网并支持断点续传

    function setProgress(text) {
        progressText = text || '';
        updateStatusLabel();
    }

    function sendXhr(method, url, headers, body, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            if (headers) {
                Object.keys(headers).forEach(function (k) {
                    xhr.setRequestHeader(k, headers[k]);
                });
            }
            xhr.timeout = timeoutMs || 45000;
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.responseText);
                } else {
                    var errMsg = 'HTTP ' + xhr.status;
                    try {
                        var errJson = JSON.parse(xhr.responseText || '{}');
                        if (errJson && errJson.error) errMsg = errJson.error;
                    } catch (e) {}
                    var err = new Error(errMsg);
                    err.status = xhr.status;
                    reject(err);
                }
            };
            xhr.onerror = function () { reject(new Error('网络连接中断')); };
            xhr.ontimeout = function () { reject(new Error('分片上传超时')); };
            xhr.send(body || null);
        });
    }

    async function computeUploadId(blob, dateStr) {
        var sample = blob.slice(0, Math.min(blob.size, 65536));
        var buf = await sample.arrayBuffer();
        var bytes = new Uint8Array(buf);
        var h1 = 0x811c9dc5;
        for (var i = 0; i < bytes.length; i++) {
            h1 ^= bytes[i];
            h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
        }
        return (dateStr || getLocalDateStr()) + '_' + blob.size + '_' + h1.toString(16);
    }

    async function uploadChunkedResumable(baseUrl, token, result, onProgress) {
        var cleanBase = baseUrl.replace(/\/+$/, '');
        var blob = result.blob;
        var totalChunks = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));
        var uploadId = await computeUploadId(blob, result.dateStr);
        var authHeaders = { 'X-Backup-Token': token };

        // 1. 查询服务器已收到的分片（断点续传）
        var receivedSet = {};
        try {
            var statusRaw = await sendXhr(
                'GET',
                cleanBase + '/chunk/status?uploadId=' + encodeURIComponent(uploadId),
                authHeaders,
                null,
                15000
            );
            var statusJson = JSON.parse(statusRaw || '{}');
            if (statusJson && Array.isArray(statusJson.received)) {
                statusJson.received.forEach(function (idx) { receivedSet[idx] = true; });
            }
        } catch (e) {
            if (e && e.status === 401) throw e;
            // 若旧版后端尚未升级分片接口（404），自动回退单次上传
            if (e && e.status === 404) {
                return await sendXhr('POST', cleanBase, {
                    'Content-Type': 'application/octet-stream',
                    'X-Backup-Token': token,
                    'X-Backup-Filename': result.filename
                }, blob, 180000);
            }
        }

        var doneChunks = Object.keys(receivedSet).length;
        if (doneChunks > 0) {
            console.log('[cloud-backup] 断点续传：服务器已有 ' + doneChunks + '/' + totalChunks + ' 片，继续上传剩余分片');
        }

        // 2. 逐片上传（每片 1 MB，失败自动重试最多 3 次）
        for (var i = 0; i < totalChunks; i++) {
            if (receivedSet[i]) {
                if (typeof onProgress === 'function') onProgress(i + 1, totalChunks, true);
                continue;
            }
            var start = i * CHUNK_SIZE;
            var end = Math.min(blob.size, start + CHUNK_SIZE);
            var chunkBlob = blob.slice(start, end);
            var chunkUrl = cleanBase + '/chunk?uploadId=' + encodeURIComponent(uploadId)
                + '&index=' + i + '&total=' + totalChunks;

            var attempt = 0;
            while (true) {
                attempt++;
                try {
                    if (typeof onProgress === 'function') onProgress(i, totalChunks, false, attempt);
                    await sendXhr('POST', chunkUrl, {
                        'Content-Type': 'application/octet-stream',
                        'X-Backup-Token': token
                    }, chunkBlob, 45000);
                    break;
                } catch (err) {
                    if ((err && err.status === 401) || attempt >= 3) throw err;
                    await new Promise(function (r) { setTimeout(r, 1500 * attempt); });
                }
            }
            if (typeof onProgress === 'function') onProgress(i + 1, totalChunks, false);
        }

        // 3. 通知服务器合并所有分片
        if (typeof onProgress === 'function') onProgress(totalChunks, totalChunks, false, 0, true);
        return await sendXhr('POST', cleanBase + '/chunk/complete', {
            'Content-Type': 'application/json',
            'X-Backup-Token': token
        }, JSON.stringify({ uploadId: uploadId, total: totalChunks }), 60000);
    }

    async function uploadNow(opts) {
        opts = opts || {};
        var silent = !!opts.silent;
        if (uploading) return { ok: false, reason: 'busy' };

        var cfg = getConfig();
        if (!cfg.token) {
            if (!silent && typeof showNotification === 'function') {
                showNotification('请先填写服务器备份密钥（Token）', 'warning', 3000);
            }
            return { ok: false, reason: 'no_token' };
        }

        if (silent) {
            var currentMsgs = (typeof messages !== 'undefined' && Array.isArray(messages))
                ? messages
                : (Array.isArray(window.messages) ? window.messages : []);
            if (currentMsgs.length === 0) {
                console.log('[cloud-backup] 当前无聊天记录，跳过静默上传以防覆盖');
                return { ok: false, reason: 'empty' };
            }
        }

        if (!window.ChatBackup || typeof window.ChatBackup.createBackupBlob !== 'function') {
            if (!silent && typeof showNotification === 'function') {
                showNotification('备份引擎尚未就绪，请稍后再试', 'warning', 3000);
            }
            return { ok: false, reason: 'no_engine' };
        }

        uploading = true;
        setProgress('正在读取本地数据…');
        if (!silent && typeof showNotification === 'function') {
            showNotification('开始打包并分片上传备份…', 'info', 3000);
        }

        try {
            var result = await window.ChatBackup.createBackupBlob(null, function (p) {
                if (p && p.text) setProgress(p.text);
            });
            var totalMB = (result.blob.size / 1048576).toFixed(2);
            setProgress('打包完成（' + totalMB + ' MB），检查续传进度…');
            console.log('[cloud-backup] 打包完成:', result.filename, totalMB + ' MB，开始分片上传');

            await uploadChunkedResumable(cfg.url, cfg.token, result, function (done, total, skipped, attempt, merging) {
                if (merging) {
                    setProgress('分片上传完成，正在合并校验…');
                    return;
                }
                var pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
                var retryTag = attempt > 1 ? '（重试 ' + attempt + '/3）' : '';
                var resumeTag = skipped ? '（断点跳过）' : '';
                setProgress('分片上传：' + pct + '%（' + done + '/' + total + ' 片，共 ' + totalMB + ' MB）' + retryTag + resumeTag);
            });

            var today = getLocalDateStr();
            localStorage.setItem(KEYS.lastDate, today);
            localStorage.setItem(KEYS.lastTime, String(Date.now()));
            localStorage.removeItem(KEYS.lastError);

            console.log('[cloud-backup] 上传成功:', result.filename, totalMB + ' MB');
            if (!silent && typeof showNotification === 'function') {
                showNotification('云端备份上传成功（' + totalMB + ' MB）', 'success', 3500);
            }
            return { ok: true, filename: result.filename, size: result.blob.size };
        } catch (err) {
            var msg = (err && err.message) ? err.message : '网络错误';
            try { localStorage.setItem(KEYS.lastError, msg); } catch (e) {}
            console.warn('[cloud-backup] 上传失败:', msg);
            if (!silent && typeof showNotification === 'function') {
                showNotification('云端备份失败：' + msg, 'error', 4500);
            }
            return { ok: false, error: msg };
        } finally {
            uploading = false;
            progressText = '';
            updateStatusLabel();
        }
    }

    function maybeAutoBackup() {
        var cfg = getConfig();
        if (!cfg.enabled || !cfg.token) return;
        if (cfg.lastDate === getLocalDateStr()) return;
        if (!navigator.onLine) return;
        uploadNow({ silent: true });
    }

    function injectModalStyles() {
        if (document.getElementById('cb-modal-style')) return;
        var s = document.createElement('style');
        s.id = 'cb-modal-style';
        s.textContent = [
            '#cb-config-overlay {',
            '  position: fixed; inset: 0; z-index: 10050;',
            '  background: rgba(0, 0, 0, 0.45);',
            '  display: flex; align-items: center; justify-content: center;',
            '  padding: 16px;',
            '}',
            '#cb-config-card {',
            '  width: min(92vw, 390px);',
            '  background: var(--secondary-bg, #ffffff);',
            '  color: var(--text-primary, #1a1a1a);',
            '  border: 1px solid var(--border-color, #ebebeb);',
            '  border-radius: 16px;',
            '  padding: 18px;',
            '  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.22);',
            '  font-family: var(--font-family, sans-serif);',
            '}',
            '.cb-title { font-size: 16px; font-weight: 600; margin-bottom: 4px; }',
            '.cb-sub { font-size: 12px; color: var(--text-secondary, #7a7a7a); margin-bottom: 14px; line-height: 1.5; }',
            '.cb-field { margin-bottom: 12px; }',
            '.cb-label { display: block; font-size: 12px; color: var(--text-secondary, #7a7a7a); margin-bottom: 5px; }',
            '.cb-input {',
            '  width: 100%; box-sizing: border-box;',
            '  padding: 9px 11px; border-radius: 10px;',
            '  border: 1px solid var(--border-color, #dcdcdc);',
            '  background: var(--primary-bg, #f7f7f7);',
            '  color: var(--text-primary, #1a1a1a);',
            '  font-size: 13px; outline: none;',
            '}',
            '.cb-check-row { display: flex; align-items: center; justify-content: space-between; margin: 12px 0; font-size: 13px; }',
            '.cb-status { font-size: 12px; color: var(--text-secondary, #7a7a7a); padding: 8px 10px; border-radius: 8px; background: var(--primary-bg, #f7f7f7); margin-bottom: 14px; }',
            '.cb-actions { display: flex; gap: 8px; justify-content: flex-end; }',
            '.cb-btn {',
            '  border: none; border-radius: 10px; padding: 8px 14px;',
            '  font-size: 13px; cursor: pointer; font-weight: 500;',
            '}',
            '.cb-btn-ghost { background: var(--primary-bg, #f0f0f0); color: var(--text-primary, #1a1a1a); }',
            '.cb-btn-primary { background: var(--accent-color, #1a1a1a); color: #ffffff; }'
        ].join('\n');
        document.head.appendChild(s);
    }

    function openConfigModal() {
        injectModalStyles();
        var old = document.getElementById('cb-config-overlay');
        if (old) old.remove();

        var cfg = getConfig();
        var overlay = document.createElement('div');
        overlay.id = 'cb-config-overlay';
        overlay.innerHTML = ''
            + '<div id="cb-config-card">'
            +   '<div class="cb-title">服务器每日自动备份</div>'
            +   '<div class="cb-sub">每天首次打开页面时，后台自动将全量 ZIP 备份上传到你的服务器。</div>'
            +   '<div class="cb-field">'
            +     '<label class="cb-label">上传接口地址</label>'
            +     '<input class="cb-input" id="cb-url-input" type="text" placeholder="/api/backup">'
            +   '</div>'
            +   '<div class="cb-field">'
            +     '<label class="cb-label">备份密钥（Token）</label>'
            +     '<input class="cb-input" id="cb-token-input" type="password" placeholder="填写服务器端配置的 BACKUP_TOKEN" autocomplete="off">'
            +   '</div>'
            +   '<label class="cb-check-row">'
            +     '<span>开启每天自动上传</span>'
            +     '<input type="checkbox" id="cb-enabled-input">'
            +   '</label>'
            +   '<div class="cb-status" id="cb-modal-status"></div>'
            +   '<div class="cb-actions">'
            +     '<button type="button" class="cb-btn cb-btn-ghost" id="cb-close-btn">关闭</button>'
            +     '<button type="button" class="cb-btn cb-btn-ghost" id="cb-test-btn">立即上传</button>'
            +     '<button type="button" class="cb-btn cb-btn-primary" id="cb-save-btn">保存</button>'
            +   '</div>'
            + '</div>';

        document.body.appendChild(overlay);

        var urlInput = overlay.querySelector('#cb-url-input');
        var tokenInput = overlay.querySelector('#cb-token-input');
        var enabledInput = overlay.querySelector('#cb-enabled-input');
        urlInput.value = cfg.url;
        tokenInput.value = cfg.token;
        enabledInput.checked = cfg.token ? cfg.enabled : true;
        updateStatusLabel();

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) overlay.remove();
        });
        overlay.querySelector('#cb-close-btn').addEventListener('click', function () {
            overlay.remove();
        });
        overlay.querySelector('#cb-save-btn').addEventListener('click', function () {
            saveConfig({
                url: urlInput.value,
                token: tokenInput.value,
                enabled: enabledInput.checked
            });
            if (typeof showNotification === 'function') {
                showNotification('云端备份配置已保存', 'success', 2500);
            }
            overlay.remove();
        });
        overlay.querySelector('#cb-test-btn').addEventListener('click', function () {
            saveConfig({
                url: urlInput.value,
                token: tokenInput.value,
                enabled: enabledInput.checked
            });
            uploadNow({ silent: false });
        });
    }

    function applyTokenFromUrl() {
        try {
            var token = '';
            var cleaned = false;
            var urlObj = new URL(window.location.href);

            // 1. 优先支持 Hash：https://milk.starleave.cn/#backup_token=xxx（不会进入服务器访问日志，更安全）
            if (urlObj.hash && urlObj.hash.length > 1) {
                var hashParams = new URLSearchParams(urlObj.hash.slice(1));
                if (hashParams.has('backup_token')) {
                    token = (hashParams.get('backup_token') || '').trim();
                    hashParams.delete('backup_token');
                    var restHash = hashParams.toString();
                    urlObj.hash = restHash ? ('#' + restHash) : '';
                    cleaned = true;
                }
            }

            // 2. 同时兼容 Query：https://milk.starleave.cn/?backup_token=xxx
            if (!token && urlObj.searchParams.has('backup_token')) {
                token = (urlObj.searchParams.get('backup_token') || '').trim();
                urlObj.searchParams.delete('backup_token');
                cleaned = true;
            }

            if (cleaned && window.history && typeof window.history.replaceState === 'function') {
                window.history.replaceState(null, '', urlObj.pathname + urlObj.search + urlObj.hash);
            }

            if (token) {
                saveConfig({ token: token, enabled: true });
                console.log('[cloud-backup] 已从链接自动配置备份密钥并开启每日自动上传');
                window.addEventListener('load', function () {
                    setTimeout(function () {
                        if (typeof showNotification === 'function') {
                            showNotification('已自动填入服务器备份密钥并开启每日备份', 'success', 3500);
                        }
                    }, 1800);
                });
            }
        } catch (e) {
            console.warn('[cloud-backup] 解析链接密钥失败:', e);
        }
    }

    applyTokenFromUrl();

    window.addEventListener('load', function () {
        setTimeout(maybeAutoBackup, 12000);
    });

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            setTimeout(maybeAutoBackup, 5000);
        }
    });

    window.CloudBackup = {
        getConfig: getConfig,
        configure: saveConfig,
        uploadNow: uploadNow,
        openConfigModal: openConfigModal,
        updateStatusLabel: updateStatusLabel,
        getStatusText: getStatusText
    };
})();
