(function () {
    'use strict';

    var GUARD_KEY = '__milkBackGuard';
    var lastHomeBackAt = 0;
    var guardDepth = 0;
    var ignoringPop = false;
    var nativeListenerBound = false;
    var lastHiddenModal = null;
    var lastHiddenAt = 0;
    var isNavigatingBack = false;

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
        if (el._hideTimeout) return false;
        if (el.classList && el.classList.contains('hidden')) return false;
        try {
            var cs = window.getComputedStyle(el);
            if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
            if (el.classList && el.classList.contains('modal')) {
                var content = el.querySelector('.modal-content');
                if (content && content.style && content.style.opacity === '0') return false;
            }
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
        // 优先走二级页面自带的「返回上级」按钮（如外观/聊天/高级/数据设置 -> 设置）
        var backBtn = el.querySelector('[id^="back-"], .modal-back-btn');
        if (backBtn && isVisible(backBtn)) {
            isNavigatingBack = true;
            try { backBtn.click(); } finally { isNavigatingBack = false; }
            return true;
        }
        var parentModal = el._parentModal || null;
        el._parentModal = null;
        if (typeof window.hideModal === 'function' && el.classList.contains('modal')) {
            isNavigatingBack = true;
            try { window.hideModal(el); } finally { isNavigatingBack = false; }
        } else {
            var closeBtn = el.querySelector('[id^="close-"], [id^="cancel-"], .modal-close, .close-btn');
            if (closeBtn && isVisible(closeBtn)) {
                isNavigatingBack = true;
                try { closeBtn.click(); } finally { isNavigatingBack = false; }
            } else {
                el.style.display = 'none';
            }
        }
        if (parentModal && parentModal.isConnected && parentModal !== el && typeof window.showModal === 'function') {
            isNavigatingBack = true;
            try { window.showModal(parentModal); } finally { isNavigatingBack = false; }
        }
        return true;
    }

    function closeTopLayer() {
        // 1. 已知动态弹窗与数据管理抽屉（仅关闭，不移除永久 DOM 抽屉）
        var drawerIds = [
            { id: 'dm-drawer-full', cancel: '#dm-drawer-full-cancel' },
            { id: 'dm-drawer-chat', cancel: '#dm-drawer-chat-cancel' }
        ];
        for (var dIdx = 0; dIdx < drawerIds.length; dIdx++) {
            var dr = document.getElementById(drawerIds[dIdx].id);
            if (dr && dr.classList.contains('open')) {
                var dCancel = dr.querySelector(drawerIds[dIdx].cancel);
                if (dCancel) dCancel.click();
                else dr.classList.remove('open');
                document.body.style.overflow = '';
                return true;
            }
        }
        var cbOverlay = document.getElementById('cb-config-overlay');
        if (cbOverlay && isVisible(cbOverlay)) {
            var cbClose = cbOverlay.querySelector('#cb-close-btn');
            if (cbClose) cbClose.click();
            else cbOverlay.remove();
            return true;
        }
        var aka = document.getElementById('aka-overlay');
        if (aka && isVisible(aka)) {
            var akaClose = aka.querySelector('#aka-close-btn');
            if (akaClose) akaClose.click();
            else aka.remove();
            return true;
        }

        // 2. 其他动态全屏浮层（图片预览、导出弹窗等，跳过常驻通话、引导与抽屉遮罩）
        var bodyChildren = document.body ? Array.prototype.slice.call(document.body.children) : [];
        var dynamicFixed = [];
        for (var i = 0; i < bodyChildren.length; i++) {
            var child = bodyChildren[i];
            if (!child || child.nodeType !== 1) continue;
            if (child.id === 'tour-overlay'
                || child.id === 'pwa-install-banner'
                || child.id === 'call-incoming-overlay'
                || child.id === 'call-active-overlay'
                || child.id === 'ti-settings-modal'
                || child.id === 'dm-drawer-full'
                || child.id === 'dm-drawer-chat'
                || child.id === 'welcome-animation') continue;
            if (child.classList && (child.classList.contains('modal')
                || child.classList.contains('notification')
                || child.classList.contains('toast'))) continue;
            try {
                var cs = window.getComputedStyle(child);
                var z = parseInt(cs.zIndex, 10) || 0;
                if (cs.position === 'fixed' && z >= 1000 && isVisible(child)) {
                    if (!child.querySelector('button, a, input, select, textarea, img')) continue;
                    dynamicFixed.push({ el: child, z: z, order: i });
                }
            } catch (e) {}
        }
        if (dynamicFixed.length > 0) {
            dynamicFixed.sort(function (a, b) { return (b.z - a.z) || (b.order - a.order); });
            var topDyn = dynamicFixed[0].el;
            var dynClose = topDyn.querySelector('[data-close], .close-btn, .modal-close, [id^="close-"], [id^="cancel-"]');
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
                if (sp.classList.contains('active')) sp.classList.remove('active');
                if (sp.classList.contains('open')) sp.classList.remove('open');
                var spClose = sp.querySelector('[id^="close-"], [id^="cancel-"], .close-btn, .modal-close, .ti-close-btn');
                if (spClose) spClose.click();
                else sp.style.display = 'none';
                return true;
            }
        }

        return false;
    }

    function hasAnyOpenLayer() {
        if (document.getElementById('cb-config-overlay') || document.getElementById('aka-overlay')) return true;
        var df = document.getElementById('dm-drawer-full');
        var dc = document.getElementById('dm-drawer-chat');
        if ((df && df.classList.contains('open')) || (dc && dc.classList.contains('open'))) return true;
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

    function pushHistoryGuard(force) {
        if (isNativeApp()) return;
        try {
            if (!force && guardDepth >= 1 && !hasAnyOpenLayer()) return;
            guardDepth += 1;
            history.pushState({ __milkBackGuard: true, depth: guardDepth, ts: Date.now() }, '');
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
            return true;
        }
        var now = Date.now();
        if (now - lastHomeBackAt < 2000) {
            lastHomeBackAt = 0;
            return false;
        }
        lastHomeBackAt = now;
        showExitToast();
        return true;
    }

    // 原生 APK：接管 Capacitor App.backButton（幂等绑定）
    function setupNativeBack() {
        if (!isNativeApp() || nativeListenerBound) return;
        try {
            var appPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
            if (!appPlugin || typeof appPlugin.addListener !== 'function') return;
            nativeListenerBound = true;
            appPlugin.addListener('backButton', function () {
                var handled = handleBackAction();
                if (!handled && typeof appPlugin.exitApp === 'function') {
                    appPlugin.exitApp();
                }
            });
        } catch (e) {}
    }

    // 统一包装 showModal / hideModal（三端生效）：记录从高级/二级菜单进入三级菜单的父级关系
    function wrapModalHierarchy() {
        if (typeof window.hideModal === 'function' && !window.hideModal.__milkWrapped) {
            var origHideModal = window.hideModal;
            window.hideModal = function (el) {
                if (!isNavigatingBack && el && el.classList && el.classList.contains('modal')) {
                    lastHiddenModal = el;
                    lastHiddenAt = Date.now();
                }
                return origHideModal.apply(this, arguments);
            };
            window.hideModal.__milkWrapped = true;
        }
        if (typeof window.showModal === 'function' && !window.showModal.__milkWrapped) {
            var origShowModal = window.showModal;
            window.showModal = function (el) {
                if (!isNativeApp()) pushHistoryGuard(true);
                if (!isNavigatingBack && el && el.classList && el.classList.contains('modal')) {
                    if (el.id === 'settings-modal') {
                        el._parentModal = null;
                    } else if (lastHiddenModal && (Date.now() - lastHiddenAt) < 250 && lastHiddenModal !== el && lastHiddenModal._parentModal !== el) {
                        el._parentModal = lastHiddenModal;
                    }
                }
                return origShowModal.apply(this, arguments);
            };
            window.showModal.__milkWrapped = true;
        }
    }

    // 网页 / PWA：每次进入更深层级（有用户手势）都压入独立历史栈，连续返回不会直接退出
    function setupWebBack() {
        if (isNativeApp()) return;

        pushHistoryGuard(true);
        document.addEventListener('click', function () {
            if (guardDepth < 1 || hasAnyOpenLayer()) {
                pushHistoryGuard(true);
            }
        }, true);

        window.addEventListener('popstate', function () {
            if (ignoringPop) return;
            guardDepth = Math.max(0, guardDepth - 1);
            var handled = handleBackAction();
            if (handled) {
                // 仍在弹窗层级内或刚提示“再按一次退出”时，同步补回哨兵栈，防止连续返回直接退站
                if (hasAnyOpenLayer() || guardDepth === 0) {
                    pushHistoryGuard(true);
                }
            } else {
                ignoringPop = true;
                try { history.back(); } catch (e) {}
                setTimeout(function () { ignoringPop = false; }, 300);
            }
        });
    }

    function init() {
        wrapModalHierarchy();
        setupNativeBack();
        setupWebBack();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    window.addEventListener('load', setupNativeBack);

    window.MilkBackNav = {
        closeTopLayer: closeTopLayer,
        hasAnyOpenLayer: hasAnyOpenLayer,
        pushHistoryGuard: pushHistoryGuard
    };
})();
