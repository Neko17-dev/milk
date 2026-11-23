(function () {
    'use strict';

    var VERSION_URL = 'https://milk.starleave.cn/version.json';

    function isNativeApp() {
        try {
            return !!(window.Capacitor
                && typeof window.Capacitor.isNativePlatform === 'function'
                && window.Capacitor.isNativePlatform());
        } catch (e) {
            return false;
        }
    }

    function getCurrentVersion() {
        return {
            version: window.APP_VERSION || '1.0.0',
            versionCode: typeof window.APP_VERSION_CODE === 'number' ? window.APP_VERSION_CODE : 1
        };
    }

    function injectStyles() {
        if (document.getElementById('app-updater-style')) return;
        var s = document.createElement('style');
        s.id = 'app-updater-style';
        s.textContent = [
            '#app-update-overlay {',
            '  position: fixed; inset: 0; z-index: 99999;',
            '  background: rgba(0, 0, 0, 0.72);',
            '  backdrop-filter: blur(6px);',
            '  display: flex; align-items: center; justify-content: center;',
            '  padding: 20px;',
            '}',
            '#app-update-card {',
            '  width: min(92vw, 370px);',
            '  background: var(--secondary-bg, #181a20);',
            '  color: var(--text-primary, #f0f0f0);',
            '  border: 1px solid var(--border-color, #2e323f);',
            '  border-radius: 18px;',
            '  padding: 22px 20px;',
            '  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);',
            '  font-family: var(--font-family, sans-serif);',
            '}',
            '.au-badge {',
            '  display: inline-block; font-size: 11px; font-weight: 600;',
            '  padding: 3px 9px; border-radius: 999px; margin-bottom: 10px;',
            '  background: rgba(255, 77, 79, 0.16); color: #ff6b6b;',
            '}',
            '.au-badge.optional { background: rgba(197, 164, 126, 0.18); color: var(--accent-color, #c5a47e); }',
            '.au-title { font-size: 17px; font-weight: 700; margin-bottom: 6px; }',
            '.au-ver { font-size: 12px; color: var(--text-secondary, #9aa0ae); margin-bottom: 12px; }',
            '.au-log {',
            '  font-size: 13px; line-height: 1.6; white-space: pre-wrap;',
            '  background: var(--primary-bg, rgba(255,255,255,0.05));',
            '  padding: 10px 12px; border-radius: 10px; margin-bottom: 16px;',
            '  max-height: 160px; overflow-y: auto;',
            '}',
            '.au-actions { display: flex; gap: 10px; }',
            '.au-btn {',
            '  flex: 1; border: none; border-radius: 11px; padding: 10px 14px;',
            '  font-size: 14px; font-weight: 600; cursor: pointer;',
            '}',
            '.au-btn-ghost { background: var(--primary-bg, #2b2f3a); color: var(--text-primary, #e8eaed); }',
            '.au-btn-primary { background: var(--accent-color, #c5a47e); color: #ffffff; }'
        ].join('\n');
        document.head.appendChild(s);
    }

    function openDownload(url) {
        if (!url) return;
        try {
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
                window.Capacitor.Plugins.Browser.open({ url: url });
                return;
            }
        } catch (e) {}
        window.open(url, '_blank');
    }

    function showUpdateModal(remote, current, isForced) {
        injectStyles();
        var old = document.getElementById('app-update-overlay');
        if (old) old.remove();

        var overlay = document.createElement('div');
        overlay.id = 'app-update-overlay';

        var card = document.createElement('div');
        card.id = 'app-update-card';

        var badge = document.createElement('div');
        badge.className = 'au-badge' + (isForced ? '' : ' optional');
        badge.textContent = isForced ? '重要强制更新' : '发现新版本';
        card.appendChild(badge);

        var title = document.createElement('div');
        title.className = 'au-title';
        title.textContent = isForced ? '请更新到最新版本以继续使用' : '传讯有新版本可更新';
        card.appendChild(title);

        var ver = document.createElement('div');
        ver.className = 'au-ver';
        ver.textContent = '当前版本 v' + current.version + ' → 最新版本 v' + (remote.version || '?');
        card.appendChild(ver);

        if (remote.changelog) {
            var log = document.createElement('div');
            log.className = 'au-log';
            log.textContent = String(remote.changelog);
            card.appendChild(log);
        }

        var actions = document.createElement('div');
        actions.className = 'au-actions';

        if (!isForced) {
            var laterBtn = document.createElement('button');
            laterBtn.type = 'button';
            laterBtn.className = 'au-btn au-btn-ghost';
            laterBtn.textContent = '稍后再说';
            laterBtn.addEventListener('click', function () { overlay.remove(); });
            actions.appendChild(laterBtn);
        }

        var dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'au-btn au-btn-primary';
        dlBtn.textContent = '立即下载更新';
        dlBtn.addEventListener('click', function () {
            openDownload(remote.downloadUrl);
        });
        actions.appendChild(dlBtn);

        card.appendChild(actions);
        overlay.appendChild(card);

        if (!isForced) {
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) overlay.remove();
            });
        }

        document.body.appendChild(overlay);
    }

    async function checkNow(opts) {
        opts = opts || {};
        var silent = !!opts.silent;
        try {
            var resp = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            var remote = await resp.json();
            var current = getCurrentVersion();
            var remoteCode = Number(remote.versionCode) || 0;
            var minCode = Number(remote.minVersionCode) || 0;

            if (remoteCode > current.versionCode) {
                var isForced = Boolean(remote.forceUpdate) || (current.versionCode < minCode);
                showUpdateModal(remote, current, isForced);
                return { hasUpdate: true, forced: isForced, remote: remote };
            }
            if (!silent && typeof showNotification === 'function') {
                showNotification('当前已是最新版本（v' + current.version + '）', 'success', 2500);
            }
            return { hasUpdate: false, remote: remote };
        } catch (err) {
            console.warn('[app-updater] 检查更新失败:', err);
            if (!silent && typeof showNotification === 'function') {
                showNotification('检查更新失败，请稍后重试', 'warning', 2500);
            }
            return { hasUpdate: false, error: err };
        }
    }

    // 原生 App 启动后自动检查更新通道
    window.addEventListener('load', function () {
        if (isNativeApp()) {
            setTimeout(function () { checkNow({ silent: true }); }, 2000);
        }
    });

    window.AppUpdater = {
        isNativeApp: isNativeApp,
        getCurrentVersion: getCurrentVersion,
        checkNow: checkNow
    };
})();
