(function () {
    'use strict';

    var GUARD_KEY = '__milkBackGuard';
    var lastHomeBackAt = 0;
    var guardPushed = false;
    var ignoringPop = false;

    function isNativeApp() {
        try {
            return !!(window.Capacitor
                && typeof window.Capacitor.isNativePlatform === 'function'
                && window.Capacitor.isNativePlatform());
        } catch (e) {
            return false;
        }
    }

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        if (el.classList && el.classList.contains('hidden')) return false;
        try {
            var cs = window.getComputedStyle(el);
            if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        } catch (e) {
            if (el.style && el.style.display === 'none') return false;
        }
        return true;
    }

    function getZIndex(el) {
        try {
            var z = parseInt(window.getComputedStyle(el).zIndex, 10);
            return isNaN(z) ? 0 : z;
        } catch (e) {
            return 0;
        }
    }

    function closeModalElement(el) {
        if (!el) return false;
        // 优先走二级页面自带的「返回上级」按钮（如外观/聊天/高级设置 -> 设置）
        var backBtn = el.querySelector('[id^="back-"], .modal-back-btn');
        if (backBtn && isVisible(backBtn)) {
            backBtn.click();
            return true;
        }
        if (typeof window.hideModal === 'function' && el.classList.contains('modal')) {
            window.hideModal(el);
            return true;
        }
        var closeBtn = el.querySelector('[id^="close-"], [id^="cancel-"], .modal-close, .close-btn');
        if (closeBtn && isVisible(closeBtn)) {
            closeBtn.click();
            return true;
        }
        el.style.display = 'none';
        return true;
    }

    function closeTopLayer() {
        // 1. 原生保活引导弹窗
        var aka = document.getElementById('aka-overlay');
        if (aka && isVisible(aka)) {
            aka.remove();
            return true;
        }

        // 2. 动态全屏浮层（图片预览、导出弹窗、云备份弹窗等）
        var bodyChildren = document.body ? Array.prototype.slice.call(document.body.children) : [];
        var dynamicFixed = [];
        for (var i = 0; i < bodyChildren.length; i++) {
            var child = bodyChildren[i];
            if (!child || child.nodeType !== 1) continue;
            if (child.id === 'tour-overlay' || child.id === 'pwa-install-banner') continue;
            if (child.classList && (child.classList.contains('modal') || child.classList.contains('notification') || child.classList.contains('toast'))) continue;
            try {
                var cs = window.getComputedStyle(child);
                var z = parseInt(cs.zIndex, 10) || 0;
                if (cs.position === 'fixed' && z >= 9000 && isVisible(child)) {
                    // 跳过纯提示 toast（通常高度很小且无交互按钮）
                    if (!child.querySelector('button, a, input, select, textarea, img')) continue;
                    dynamicFixed.push({ el: child, z: z, order: i });
                }
            } catch (e) {}
        }
        if (dynamicFixed.length > 0) {
            dynamicFixed.sort(function (a, b) { return (b.z - a.z) || (b.order - a.order); });
            var topDyn = dynamicFixed[0].el;
            var dynClose = topDyn.querySelector('[data-close], .close-btn, .modal-close');
            if (dynClose) {
                dynClose.click();
            } else {
                topDyn.remove();
            }
            return true;
        }

        // 3. 标准 .modal 弹窗（按 z-index 与 DOM 顺序从上往下关闭）
        var modals = Array.prototype.slice.call(document.querySelectorAll('.modal'));
        var openModals = [];
        for (var j = 0; j < modals.length; j++) {
            if (isVisible(modals[j])) {
                openModals.push({ el: modals[j], z: getZIndex(modals[j]), order: j });
            }
        }
        if (openModals.length > 0) {
            openModals.sort(function (a, b) { return (b.z - a.z) || (b.order - a.order); });
            return closeModalElement(openModals[0].el);
        }

        // 4. 其它独立浮层
        var specialIds = ['ti-settings-modal', 'mood-selector-overlay', 'coin-toss-overlay', 'daily-greeting-modal', 'lenormand-modal', 'dg-editor-modal', 'pwa-install-banner'];
        for (var k = 0; k < specialIds.length; k++) {
            var sp = document.getElementById(specialIds[k]);
            if (sp && isVisible(sp)) {
                if (sp.id === 'daily-greeting-modal') {
                    var dgClose = sp.querySelector('#dg-close-btn, .dg-close-btn, button');
                    if (dgClose) dgClose.click();
                    else sp.classList.add('hidden');
                    return true;
                }
                if (sp.id === 'pwa-install-banner') {
                    var pwaClose = sp.querySelector('#pwa-banner-dismiss, button');
                    if (pwaClose) pwaClose.click();
                    else sp.remove();
                    return true;
                }
                if (sp.classList.contains('active')) {
                    sp.classList.remove('active');
                }
                var spClose = sp.querySelector('[id^="close-"], [id^="cancel-"], .close-btn, .modal-close');
                if (spClose) spClose.click();
                else sp.style.display = 'none';
                return true;
            }
        }

        return false;
    }

    function hasAnyOpenLayer() {
        if (document.getElementById('aka-overlay')) return true;
        var modals = document.querySelectorAll('.modal');
        for (var i = 0; i < modals.length; i++) {
            if (isVisible(modals[i])) return true;
        }
        var specialIds = ['ti-settings-modal', 'mood-selector-overlay', 'coin-toss-overlay', 'daily-greeting-modal', 'lenormand-modal', 'dg-editor-modal'];
        for (var j = 0; j < specialIds.length; j++) {
            var sp = document.getElementById(specialIds[j]);
            if (sp && isVisible(sp)) return true;
        }
        return false;
    }

    function ensureHistoryGuard() {
        if (isNativeApp()) return;
        try {
            if (history.state && history.state[GUARD_KEY]) {
                guardPushed = true;
                return;
            }
            history.pushState({ __milkBackGuard: true, ts: Date.now() }, '');
            guardPushed = true;
        } catch (e) {}
    }

    function showExitToast() {
        if (typeof window.showNotification === 'function') {
            window.showNotification('再按一次返回退出', 'info', 1800);
        }
    }

    function handleBackAction() {
        if (closeTopLayer()) {
            lastHomeBackAt = 0;
            return true; // 已消费返回事件
        }
        var now = Date.now();
        if (now - lastHomeBackAt < 2000) {
            lastHomeBackAt = 0;
            return false; // 放行退出
        }
        lastHomeBackAt = now;
        showExitToast();
        return true;
    }

    // 原生 APK：接管 Capacitor App.backButton
    function setupNativeBack() {
        if (!isNativeApp()) return;
        try {
            var appPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
            if (!appPlugin || typeof appPlugin.addListener !== 'function') return;
            appPlugin.addListener('backButton', function () {
                var handled = handleBackAction();
                if (!handled && typeof appPlugin.exitApp === 'function') {
                    appPlugin.exitApp();
                }
            });
        } catch (e) {}
    }

    // 网页 / PWA：通过 History API 哨兵状态拦截系统/手势返回
    function setupWebBack() {
        if (isNativeApp()) return;

        // 首次加载及用户交互时补齐哨兵历史栈
        ensureHistoryGuard();
        document.addEventListener('click', function () {
            if (!guardPushed || !(history.state && history.state[GUARD_KEY])) {
                ensureHistoryGuard();
            }
        }, { passive: true });

        // 包装 showModal：每次打开弹窗都确保有可退出的历史栈
        if (typeof window.showModal === 'function') {
            var origShowModal = window.showModal;
            window.showModal = function () {
                ensureHistoryGuard();
                return origShowModal.apply(this, arguments);
            };
        }

        window.addEventListener('popstate', function () {
            if (ignoringPop) return;
            guardPushed = false;
            var handled = handleBackAction();
            if (handled) {
                ensureHistoryGuard();
            } else {
                // 二次确认退出：放行再退一步
                ignoringPop = true;
                try { history.back(); } catch (e) {}
                setTimeout(function () { ignoringPop = false; }, 300);
            }
        });
    }

    function init() {
        setupNativeBack();
        setupWebBack();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.MilkBackNav = {
        closeTopLayer: closeTopLayer,
        hasAnyOpenLayer: hasAnyOpenLayer,
        ensureHistoryGuard: ensureHistoryGuard
    };
})();
