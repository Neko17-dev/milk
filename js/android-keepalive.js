(function () {
    'use strict';

    var HIDE_GUIDE_KEY = 'milkKeepAliveGuideDismissed';

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

    function injectStyles() {
        if (document.getElementById('aka-style')) return;
        var s = document.createElement('style');
        s.id = 'aka-style';
        s.textContent = [
            '#aka-overlay {',
            '  position: fixed; inset: 0; z-index: 99980;',
            '  background: rgba(0, 0, 0, 0.62); backdrop-filter: blur(5px);',
            '  display: flex; align-items: center; justify-content: center; padding: 16px;',
            '}',
            '#aka-card {',
            '  width: min(94vw, 400px); max-height: 86vh; overflow-y: auto;',
            '  background: var(--secondary-bg, #ffffff); color: var(--text-primary, #1a1a1a);',
            '  border: 1px solid var(--border-color, #ebebeb); border-radius: 18px;',
            '  padding: 20px 18px; box-shadow: 0 18px 46px rgba(0,0,0,0.32);',
            '  font-family: var(--font-family, sans-serif);',
            '}',
            '.aka-title { font-size: 16px; font-weight: 700; margin-bottom: 4px; }',
            '.aka-sub { font-size: 12px; color: var(--text-secondary, #7a7a7a); margin-bottom: 14px; line-height: 1.5; }',
            '.aka-row {',
            '  display: flex; align-items: center; justify-content: space-between; gap: 10px;',
            '  padding: 10px 12px; border-radius: 12px; margin-bottom: 8px;',
            '  background: var(--primary-bg, #f6f6f6); border: 1px solid var(--border-color, #ececec);',
            '}',
            '.aka-row-info { flex: 1; min-width: 0; }',
            '.aka-row-name { font-size: 13px; font-weight: 600; }',
            '.aka-row-desc { font-size: 11px; color: var(--text-secondary, #7a7a7a); margin-top: 2px; }',
            '.aka-tag-ok { color: #2ca87f; font-weight: 600; }',
            '.aka-tag-warn { color: #e07a00; font-weight: 600; }',
            '.aka-btn {',
            '  border: none; border-radius: 9px; padding: 6px 11px; font-size: 12px;',
            '  font-weight: 600; cursor: pointer; white-space: nowrap;',
            '  background: var(--accent-color, #1a1a1a); color: #ffffff;',
            '}',
            '.aka-btn.ghost { background: rgba(128,128,128,0.14); color: var(--text-primary, #1a1a1a); }',
            '.aka-footer { display: flex; gap: 8px; margin-top: 14px; }',
            '.aka-footer .aka-btn { flex: 1; padding: 9px 12px; font-size: 13px; }'
        ].join('\n');
        document.head.appendChild(s);
    }

    async function refreshModalContent(card) {
        var plugin = getPlugin();
        if (!plugin || typeof plugin.getSystemStatus !== 'function') return;
        var st = await plugin.getSystemStatus();

        var mediaOk = !!st.media;
        var notifOk = !!st.notification;
        var batOk = !!st.batteryUnrestricted;
        var overlayOk = !!st.overlay;
        var svcOn = !!st.keepAliveService;

        var rowsEl = card.querySelector('#aka-rows');
        rowsEl.innerHTML = ''
            + '<div class="aka-row">'
            +   '<div class="aka-row-info">'
            +     '<div class="aka-row-name">完整相册权限 <span class="' + (mediaOk ? 'aka-tag-ok' : 'aka-tag-warn') + '">(' + (mediaOk ? '已开启' : '未完整授权') + ')</span></div>'
            +     '<div class="aka-row-desc">用于保活请选择「始终全部允许」</div>'
            +   '</div>'
            +   '<button type="button" class="aka-btn ' + (mediaOk ? 'ghost' : '') + '" id="aka-req-media">' + (mediaOk ? '已就绪' : '去授权') + '</button>'
            + '</div>'
            + '<div class="aka-row">'
            +   '<div class="aka-row-info">'
            +     '<div class="aka-row-name">通知与任务栏权限 <span class="' + (notifOk ? 'aka-tag-ok' : 'aka-tag-warn') + '">(' + (notifOk ? '已开启' : '未开启') + ')</span></div>'
            +     '<div class="aka-row-desc">用于任务栏常驻保活与后台消息提醒</div>'
            +   '</div>'
            +   '<button type="button" class="aka-btn ' + (notifOk ? 'ghost' : '') + '" id="aka-req-notif">' + (notifOk ? '已就绪' : '去开启') + '</button>'
            + '</div>'
            + '<div class="aka-row">'
            +   '<div class="aka-row-info">'
            +     '<div class="aka-row-name">后台电池：无限制 <span class="' + (batOk ? 'aka-tag-ok' : 'aka-tag-warn') + '">(' + (batOk ? '已设为无限制' : '受系统限制') + ')</span></div>'
            +     '<div class="aka-row-desc">关闭系统省电/电池优化，防止切后台被杀进程</div>'
            +   '</div>'
            +   '<button type="button" class="aka-btn ' + (batOk ? 'ghost' : '') + '" id="aka-req-battery">' + (batOk ? '已设置' : '去关闭限制') + '</button>'
            + '</div>'
            + '<div class="aka-row">'
            +   '<div class="aka-row-info">'
            +     '<div class="aka-row-name">开机自启动与后台保护</div>'
            +     '<div class="aka-row-desc">在系统设置中打开「允许自启动 / 后台运行」</div>'
            +   '</div>'
            +   '<button type="button" class="aka-btn" id="aka-req-autostart">去开启</button>'
            + '</div>'
            + '<div class="aka-row">'
            +   '<div class="aka-row-info">'
            +     '<div class="aka-row-name">后台通话悬浮窗权限 <span class="' + (overlayOk ? 'aka-tag-ok' : 'aka-tag-warn') + '">(' + (overlayOk ? '已开启' : '未开启') + ')</span></div>'
            +     '<div class="aka-row-desc">退出软件到桌面或切到其他应用时置顶显示通话悬浮条</div>'
            +   '</div>'
            +   '<button type="button" class="aka-btn ' + (overlayOk ? 'ghost' : '') + '" id="aka-req-overlay">' + (overlayOk ? '已就绪' : '去开启') + '</button>'
            + '</div>'
            + '<div class="aka-row">'
            +   '<div class="aka-row-info">'
            +     '<div class="aka-row-name">任务栏常驻通知保活 <span class="' + (svcOn ? 'aka-tag-ok' : 'aka-tag-warn') + '">(' + (svcOn ? '运行中' : '已关闭') + ')</span></div>'
            +     '<div class="aka-row-desc">在通知栏常驻低打扰图标，提高系统进程优先级</div>'
            +   '</div>'
            +   '<button type="button" class="aka-btn ' + (svcOn ? 'ghost' : '') + '" id="aka-toggle-svc">' + (svcOn ? '关闭' : '开启') + '</button>'
            + '</div>';

        rowsEl.querySelector('#aka-req-media').addEventListener('click', async function () {
            try {
                await plugin.requestAllStartupPermissions();
                var after = await plugin.getSystemStatus();
                if (!after.media && typeof plugin.openAppSettings === 'function') {
                    await plugin.openAppSettings();
                }
            } catch (e) {
                if (typeof plugin.openAppSettings === 'function') plugin.openAppSettings();
            }
            setTimeout(function () { refreshModalContent(card); }, 600);
        });

        rowsEl.querySelector('#aka-req-notif').addEventListener('click', async function () {
            try {
                await plugin.requestAllStartupPermissions();
                var after = await plugin.getSystemStatus();
                if (!after.notification && typeof plugin.openAppSettings === 'function') {
                    await plugin.openAppSettings();
                }
            } catch (e) {
                if (typeof plugin.openAppSettings === 'function') plugin.openAppSettings();
            }
            setTimeout(function () { refreshModalContent(card); }, 600);
        });

        rowsEl.querySelector('#aka-req-battery').addEventListener('click', async function () {
            try { await plugin.requestBatteryUnrestricted(); } catch (e) {}
            setTimeout(function () { refreshModalContent(card); }, 1000);
        });

        rowsEl.querySelector('#aka-req-autostart').addEventListener('click', async function () {
            try { await plugin.openAutoStartSettings(); } catch (e) {}
        });

        rowsEl.querySelector('#aka-req-overlay').addEventListener('click', async function () {
            try {
                if (typeof plugin.requestOverlayPermission === 'function') {
                    await plugin.requestOverlayPermission();
                }
            } catch (e) {}
        });

        rowsEl.querySelector('#aka-toggle-svc').addEventListener('click', async function () {
            try {
                await plugin.setKeepAliveNotification({ enabled: !svcOn });
            } catch (e) {}
            refreshModalContent(card);
        });
    }

    async function openKeepAliveGuide() {
        var plugin = getPlugin();
        if (!plugin || typeof plugin.getSystemStatus !== 'function') {
            if (typeof showNotification === 'function') {
                showNotification('当前 APK 版本暂不支持原生保活检测，请升级到新版', 'info', 3000);
            }
            return;
        }
        injectStyles();
        var old = document.getElementById('aka-overlay');
        if (old) old.remove();

        var overlay = document.createElement('div');
        overlay.id = 'aka-overlay';
        overlay.innerHTML = ''
            + '<div id="aka-card">'
            +   '<div class="aka-title">权限与后台保活设置</div>'
            +   '<div class="aka-sub">为了确保消息提醒与电话不被系统杀后台，建议完成以下设置：</div>'
            +   '<div id="aka-rows"></div>'
            +   '<div class="aka-footer">'
            +     '<button type="button" class="aka-btn ghost" id="aka-dismiss-btn">不再提示</button>'
            +     '<button type="button" class="aka-btn" id="aka-close-btn">完成</button>'
            +   '</div>'
            + '</div>';
        document.body.appendChild(overlay);

        var card = overlay.querySelector('#aka-card');
        await refreshModalContent(card);

        var onVis = function () {
            if (!document.hidden && document.body.contains(card)) {
                refreshModalContent(card);
            }
        };
        document.addEventListener('visibilitychange', onVis);

        function close() {
            document.removeEventListener('visibilitychange', onVis);
            overlay.remove();
        }
        overlay.querySelector('#aka-close-btn').addEventListener('click', close);
        overlay.querySelector('#aka-dismiss-btn').addEventListener('click', function () {
            try { localStorage.setItem(HIDE_GUIDE_KEY, '1'); } catch (e) {}
            close();
        });
    }

    async function startupCheckAndKeepAlive() {
        if (!isNativeApp()) return;
        var plugin = getPlugin();
        if (!plugin || typeof plugin.getSystemStatus !== 'function') return;

        try {
            var st = await plugin.getSystemStatus();
            // 1. 若权限不全，启动即重新请求
            if (!st.media || !st.notification) {
                if (typeof plugin.requestAllStartupPermissions === 'function') {
                    await plugin.requestAllStartupPermissions().catch(function () {});
                }
                st = await plugin.getSystemStatus();
            }

            // 2. 若系统通知已授权且用户从未手动关闭应用内通知开关，自动开启 notifEnabled
            if (st.notification) {
                try {
                    if (localStorage.getItem('notifEnabled') === null) {
                        localStorage.setItem('notifEnabled', '1');
                        var nChk = document.getElementById('notif-toggle');
                        if (nChk) nChk.checked = true;
                    }
                } catch (e) {}
            }

            // 3. 默认开启任务栏常驻通知保活服务
            if (st.keepAliveService && typeof plugin.setKeepAliveNotification === 'function') {
                plugin.setKeepAliveNotification({ enabled: true }).catch(function () {});
            }

            // 3. 若权限仍不全或尚未关闭电池优化，且未勾选「不再提示」，弹出保活引导卡片
            var dismissed = false;
            try { dismissed = localStorage.getItem(HIDE_GUIDE_KEY) === '1'; } catch (e) {}
            if (!dismissed && (!st.media || !st.notification || !st.batteryUnrestricted || !st.overlay)) {
                setTimeout(openKeepAliveGuide, 1200);
            }
        } catch (e) {
            console.warn('[keepalive] 启动检测异常:', e);
        }
    }

    function injectSettingsButton() {
        if (!isNativeApp()) return;
        var btnContainer = document.querySelector('#settings-modal .modal-buttons');
        if (!btnContainer || document.getElementById('app-keepalive-btn')) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'app-keepalive-btn';
        btn.className = 'modal-btn modal-btn-secondary';
        btn.textContent = '权限与保活';
        btn.addEventListener('click', function () {
            if (typeof hideModal === 'function') {
                var m = document.getElementById('settings-modal');
                if (m) hideModal(m);
            }
            openKeepAliveGuide();
        });
        btnContainer.insertBefore(btn, btnContainer.lastElementChild);
    }

    if (isNativeApp()) {
        window.addEventListener('load', function () {
            injectSettingsButton();
            setTimeout(startupCheckAndKeepAlive, 900);
        });
    }

    window.AndroidKeepAlive = {
        openGuide: openKeepAliveGuide,
        checkNow: startupCheckAndKeepAlive
    };
})();
