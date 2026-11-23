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
        if (uploading) return '正在打包并上传到服务器…';
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
            var hasMsgs = Array.isArray(window.messages) && window.messages.length > 0;
            if (!hasMsgs) {
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
        updateStatusLabel();
        if (!silent && typeof showNotification === 'function') {
            showNotification('正在打包并上传备份到服务器…', 'info', 4000);
        }

        try {
            var result = await window.ChatBackup.createBackupBlob();
            var resp = await fetch(cfg.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Backup-Token': cfg.token,
                    'X-Backup-Filename': result.filename
                },
                body: result.blob
            });

            if (!resp.ok) {
                var errMsg = 'HTTP ' + resp.status;
                try {
                    var errJson = await resp.json();
                    if (errJson && errJson.error) errMsg = errJson.error;
                } catch (e) {}
                throw new Error(errMsg);
            }

            var today = getLocalDateStr();
            localStorage.setItem(KEYS.lastDate, today);
            localStorage.setItem(KEYS.lastTime, String(Date.now()));
            localStorage.removeItem(KEYS.lastError);

            var sizeMB = (result.blob.size / 1048576).toFixed(2);
            console.log('[cloud-backup] 上传成功:', result.filename, sizeMB + ' MB');
            if (!silent && typeof showNotification === 'function') {
                showNotification('云端备份上传成功（' + sizeMB + ' MB）', 'success', 3500);
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
