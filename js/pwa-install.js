(function () {
    'use strict';

    var DISMISS_KEY = 'pwaInstallDismissedAt';
    var COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 天内不重复打扰
    var deferredPrompt = window.__deferredPwaPrompt || null;
    var bannerEl = null;
    var currentMode = null;
    var showTimer = null;

    function isNativeApp() {
        try {
            return !!(window.Capacitor
                && typeof window.Capacitor.isNativePlatform === 'function'
                && window.Capacitor.isNativePlatform());
        } catch (e) {
            return false;
        }
    }

    function isStandalone() {
        return isNativeApp()
            || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
            || window.navigator.standalone === true
            || (document.referrer && document.referrer.indexOf('android-app://') === 0);
    }

    function hideSettingsInstallButton() {
        var btn = document.getElementById('install-pwa-settings-btn');
        if (btn) btn.style.display = 'none';
    }

    function isIOS() {
        var ua = navigator.userAgent || '';
        return /iphone|ipad|ipod/i.test(ua)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function isInCooldown() {
        try {
            var ts = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
            return ts > 0 && (Date.now() - ts) < COOLDOWN_MS;
        } catch (e) {
            return false;
        }
    }

    function markDismissed() {
        try {
            localStorage.setItem(DISMISS_KEY, String(Date.now()));
        } catch (e) {}
    }

    function injectStyles() {
        if (document.getElementById('pwa-install-style')) return;
        var style = document.createElement('style');
        style.id = 'pwa-install-style';
        style.textContent = [
            '#pwa-install-banner {',
            '  position: fixed;',
            '  left: 50%;',
            '  bottom: max(18px, env(safe-area-inset-bottom, 18px));',
            '  transform: translate(-50%, 24px);',
            '  opacity: 0;',
            '  z-index: 9500;',
            '  width: min(92vw, 400px);',
            '  background: var(--secondary-bg, #ffffff);',
            '  color: var(--text-primary, #1a1a1a);',
            '  border: 1px solid var(--border-color, #ebebeb);',
            '  border-radius: 16px;',
            '  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);',
            '  padding: 14px 16px;',
            '  display: flex;',
            '  align-items: center;',
            '  gap: 12px;',
            '  font-family: var(--font-family, sans-serif);',
            '  transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.28s ease;',
            '  pointer-events: auto;',
            '}',
            '#pwa-install-banner.pwa-visible {',
            '  transform: translate(-50%, 0);',
            '  opacity: 1;',
            '}',
            '.pwa-banner-icon {',
            '  width: 44px;',
            '  height: 44px;',
            '  border-radius: 11px;',
            '  object-fit: cover;',
            '  flex-shrink: 0;',
            '  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);',
            '}',
            '.pwa-banner-body {',
            '  flex: 1;',
            '  min-width: 0;',
            '}',
            '.pwa-banner-title {',
            '  font-size: 14px;',
            '  font-weight: 600;',
            '  line-height: 1.35;',
            '  color: var(--text-primary, #1a1a1a);',
            '}',
            '.pwa-banner-desc {',
            '  font-size: 12px;',
            '  line-height: 1.45;',
            '  margin-top: 2px;',
            '  color: var(--text-secondary, #7a7a7a);',
            '}',
            '.pwa-banner-actions {',
            '  display: flex;',
            '  align-items: center;',
            '  gap: 6px;',
            '  flex-shrink: 0;',
            '}',
            '.pwa-btn-install {',
            '  border: none;',
            '  border-radius: 999px;',
            '  padding: 7px 14px;',
            '  font-size: 12px;',
            '  font-weight: 600;',
            '  cursor: pointer;',
            '  background: var(--accent-color, #1a1a1a);',
            '  color: #ffffff;',
            '  white-space: nowrap;',
            '  transition: opacity 0.2s ease, transform 0.15s ease;',
            '}',
            '.pwa-btn-install:active {',
            '  transform: scale(0.95);',
            '}',
            '.pwa-btn-close {',
            '  border: none;',
            '  background: transparent;',
            '  color: var(--text-secondary, #7a7a7a);',
            '  width: 28px;',
            '  height: 28px;',
            '  border-radius: 50%;',
            '  font-size: 16px;',
            '  line-height: 1;',
            '  cursor: pointer;',
            '  display: flex;',
            '  align-items: center;',
            '  justify-content: center;',
            '}',
            '.pwa-btn-close:hover {',
            '  background: rgba(128, 128, 128, 0.12);',
            '}'
        ].join('\n');
        document.head.appendChild(style);
    }

    function hideBanner(recordDismiss) {
        if (recordDismiss) markDismissed();
        if (!bannerEl) return;
        bannerEl.classList.remove('pwa-visible');
        var el = bannerEl;
        bannerEl = null;
        currentMode = null;
        setTimeout(function () {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        }, 320);
    }

    function showBanner(mode) {
        if (isStandalone()) return;
        if (bannerEl) {
            // 如果已显示手动引导但原生安装事件刚刚到达，升级为一键安装
            if (mode === 'native' && currentMode !== 'native') {
                var descEl = bannerEl.querySelector('.pwa-banner-desc');
                var btnEl = bannerEl.querySelector('#pwa-install-action');
                if (descEl) descEl.textContent = '全屏畅聊、离线可用，数据存储更稳妥';
                if (btnEl) btnEl.textContent = '立即安装';
                currentMode = 'native';
            }
            return;
        }
        injectStyles();

        currentMode = mode;
        var isNative = mode === 'native';
        var isIosMode = mode === 'ios';
        var descText = isNative
            ? '全屏畅聊、离线可用，数据存储更稳妥'
            : isIosMode
                ? '点击底部「分享」图标，选择「添加到主屏幕」'
                : '点击浏览器菜单中的「安装应用 / 添加到主屏幕」';
        var btnText = isNative ? '立即安装' : '知道了';

        var el = document.createElement('div');
        el.id = 'pwa-install-banner';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', '安装传讯到桌面');

        el.innerHTML = ''
            + '<img class="pwa-banner-icon" src="icons/icon-192.png" alt="传讯" onerror="this.style.display=\'none\'">'
            + '<div class="pwa-banner-body">'
            +   '<div class="pwa-banner-title">安装「传讯」到桌面</div>'
            +   '<div class="pwa-banner-desc">' + descText + '</div>'
            + '</div>'
            + '<div class="pwa-banner-actions">'
            +   '<button type="button" class="pwa-btn-install" id="pwa-install-action">' + btnText + '</button>'
            +   '<button type="button" class="pwa-btn-close" id="pwa-install-close" aria-label="暂不安装">×</button>'
            + '</div>';

        document.body.appendChild(el);
        bannerEl = el;

        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                if (bannerEl) bannerEl.classList.add('pwa-visible');
            });
        });

        var closeBtn = el.querySelector('#pwa-install-close');
        var actionBtn = el.querySelector('#pwa-install-action');

        if (closeBtn) {
            closeBtn.addEventListener('click', function () {
                hideBanner(true);
            });
        }

        if (actionBtn) {
            actionBtn.addEventListener('click', function () {
                if (currentMode !== 'native' || !deferredPrompt) {
                    hideBanner(true);
                    return;
                }
                var promptEvent = deferredPrompt;
                deferredPrompt = null;
                window.__deferredPwaPrompt = null;
                promptEvent.prompt();
                if (promptEvent.userChoice && typeof promptEvent.userChoice.then === 'function') {
                    promptEvent.userChoice.then(function (choice) {
                        if (choice && choice.outcome === 'accepted') {
                            hideBanner(false);
                        } else {
                            hideBanner(true);
                        }
                    }).catch(function () {
                        hideBanner(true);
                    });
                } else {
                    hideBanner(false);
                }
            });
        }
    }

    function scheduleShow(mode, delayMs) {
        if (isStandalone() || isInCooldown()) return;
        if (showTimer) clearTimeout(showTimer);
        showTimer = setTimeout(function () {
            if (!isStandalone() && !isInCooldown()) {
                showBanner(deferredPrompt ? 'native' : mode);
            }
        }, typeof delayMs === 'number' ? delayMs : 3000);
    }

    if (isStandalone()) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', hideSettingsInstallButton);
        } else {
            hideSettingsInstallButton();
        }
        return;
    }

    // 若 <head> 已提前捕获到 beforeinstallprompt，立即安排弹出
    if (deferredPrompt) {
        scheduleShow('native', 2500);
    }

    // Android / 桌面端 Chrome、Edge 等原生安装事件
    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        deferredPrompt = e;
        window.__deferredPwaPrompt = e;
        if (bannerEl) {
            showBanner('native');
        } else {
            scheduleShow('native', 2500);
        }
    });

    window.addEventListener('appinstalled', function () {
        deferredPrompt = null;
        window.__deferredPwaPrompt = null;
        hideBanner(false);
        if (typeof showNotification === 'function') {
            showNotification('已安装到桌面，数据存储将更加稳定', 'success', 3500);
        }
    });

    // 页面加载后兜底：iOS 显示 Safari 引导；其他未触发原生事件的浏览器也显示菜单引导
    window.addEventListener('load', function () {
        if (isStandalone()) return;
        if (deferredPrompt) {
            scheduleShow('native', 2500);
        } else if (isIOS()) {
            scheduleShow('ios', 3000);
        } else {
            scheduleShow('manual', 4000);
        }
    });

    // 暴露手动触发入口（设置页按钮直接调用，无视 7 天冷却期）
    window.showPwaInstallPrompt = function (triggerNativeDirect) {
        if (isStandalone()) {
            if (typeof showNotification === 'function') {
                showNotification('当前已以桌面应用模式运行', 'info', 2500);
            }
            return;
        }
        var promptEvent = deferredPrompt || window.__deferredPwaPrompt;
        if (promptEvent) {
            if (triggerNativeDirect) {
                deferredPrompt = null;
                window.__deferredPwaPrompt = null;
                promptEvent.prompt();
                if (promptEvent.userChoice && typeof promptEvent.userChoice.then === 'function') {
                    promptEvent.userChoice.then(function (choice) {
                        if (choice && choice.outcome === 'accepted') {
                            hideBanner(false);
                        }
                    }).catch(function () {});
                }
                return;
            }
            deferredPrompt = promptEvent;
            showBanner('native');
        } else if (isIOS()) {
            showBanner('ios');
        } else {
            showBanner('manual');
        }
    };
})();
