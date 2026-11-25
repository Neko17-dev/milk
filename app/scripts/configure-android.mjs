#!/usr/bin/env node
/**
 * 配置 Capacitor 生成的 Android 工程：
 * 1. 写入 versionName / versionCode
 * 2. 注入相册/通知/网络权限到 AndroidManifest.xml
 * 3. 复制项目图标作为 Android 启动图标
 * 4. 若提供了签名环境变量，自动写入 release 签名配置
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(APP_DIR, '..');
const ANDROID_APP_DIR = path.join(APP_DIR, 'android', 'app');

if (!fs.existsSync(ANDROID_APP_DIR)) {
  console.error('[configure-android] android/app 不存在，请先运行 npx cap add android');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const versionName = (process.env.APP_VERSION_NAME || pkg.version || '1.0.0').trim();
const versionCode = parseInt(process.env.APP_VERSION_CODE || String(pkg.versionCode || 1), 10) || 1;
const targetSdk = parseInt(process.env.ANDROID_TARGET_SDK || '29', 10) || 29;

// 0. 调整 variables.gradle 的 targetSdkVersion（保留 compileSdkVersion=34 以兼容 Capacitor 6 编译）
const varsPath = path.join(APP_DIR, 'android', 'variables.gradle');
if (fs.existsSync(varsPath)) {
  let varsGradle = fs.readFileSync(varsPath, 'utf8');
  varsGradle = varsGradle.replace(/targetSdkVersion\s*=\s*\d+/, `targetSdkVersion = ${targetSdk}`);
  fs.writeFileSync(varsPath, varsGradle, 'utf8');
}

// 1. 更新 app/build.gradle 的 versionCode / versionName 以及可选签名配置
const gradlePath = path.join(ANDROID_APP_DIR, 'build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);

const keystorePath = process.env.ANDROID_KEYSTORE_PATH;
if (keystorePath && fs.existsSync(keystorePath) && !gradle.includes('signingConfigs {')) {
  const signingBlock = `
    signingConfigs {
        release {
            storeFile file("${keystorePath.replace(/\\/g, '/')}")
            storePassword = (System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: "").trim()
            keyAlias = (System.getenv("ANDROID_KEY_ALIAS") ?: "").trim()
            keyPassword = (System.getenv("ANDROID_KEY_PASSWORD") ?: "").trim()
        }
    }
`;
  // 先给 buildTypes 里的 release { 加上签名，再插入 signingConfigs { release { ... } }，避免误匹配
  gradle = gradle.replace(
    /release\s*\{/,
    'release {\n            signingConfig signingConfigs.release'
  );
  gradle = gradle.replace('buildTypes {', `${signingBlock}\n    buildTypes {`);
}
fs.writeFileSync(gradlePath, gradle, 'utf8');

// 2. 注入 Android 权限与传统存储兼容属性到 AndroidManifest.xml
const manifestPath = path.join(ANDROID_APP_DIR, 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('android:requestLegacyExternalStorage')) {
  manifest = manifest.replace('<application', '<application\n        android:requestLegacyExternalStorage="true"');
}
const requiredPerms = [
  '<uses-permission android:name="android.permission.INTERNET" />',
  '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />',
  '<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />',
  '<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />',
  '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />',
  '<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />',
  '<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />',
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
  '<uses-permission android:name="android.permission.VIBRATE" />',
  '<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />',
  '<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />'
];
for (const perm of requiredPerms) {
  const nameMatch = /android:name="([^"]+)"/.exec(perm);
  if (nameMatch && !manifest.includes(nameMatch[1])) {
    manifest = manifest.replace('</manifest>', `    ${perm}\n</manifest>`);
  }
}
if (!manifest.includes('KeepAliveService')) {
  manifest = manifest.replace(
    '</application>',
    `        <service android:name="cn.starleave.milk.KeepAliveService" android:enabled="true" android:exported="false" android:foregroundServiceType="dataSync" />\n` +
    `        <receiver android:name="cn.starleave.milk.BootReceiver" android:enabled="true" android:exported="true">\n` +
    `            <intent-filter>\n` +
    `                <action android:name="android.intent.action.BOOT_COMPLETED" />\n` +
    `                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />\n` +
    `            </intent-filter>\n` +
    `        </receiver>\n    </application>`
  );
}
fs.writeFileSync(manifestPath, manifest, 'utf8');

// 3. 用项目图标替换默认 Capacitor 图标
const iconMap = [
  ['mipmap-mdpi', 'icon-72.png'],
  ['mipmap-hdpi', 'icon-96.png'],
  ['mipmap-xhdpi', 'icon-144.png'],
  ['mipmap-xxhdpi', 'icon-192.png'],
  ['mipmap-xxxhdpi', 'icon-512.png']
];
const resDir = path.join(ANDROID_APP_DIR, 'src', 'main', 'res');
for (const [mipmapDir, iconFile] of iconMap) {
  const srcIcon = path.join(ROOT_DIR, 'icons', iconFile);
  const destDir = path.join(resDir, mipmapDir);
  if (fs.existsSync(srcIcon) && fs.existsSync(destDir)) {
    fs.copyFileSync(srcIcon, path.join(destDir, 'ic_launcher.png'));
    fs.copyFileSync(srcIcon, path.join(destDir, 'ic_launcher_round.png'));
    fs.copyFileSync(srcIcon, path.join(destDir, 'ic_launcher_foreground.png'));
  }
}
// 移除 adaptive icon XML，避免前景图被裁切或继续引用默认向量图
const anydpiDir = path.join(resDir, 'mipmap-anydpi-v26');
if (fs.existsSync(anydpiDir)) {
  fs.rmSync(anydpiDir, { recursive: true, force: true });
}

// 4. 注入原生相册扫描与流式分片读取插件 AlbumSyncPlugin.java
const javaPkgDir = path.join(ANDROID_APP_DIR, 'src', 'main', 'java', 'cn', 'starleave', 'milk');
if (fs.existsSync(javaPkgDir)) {
  const pluginJava = `package cn.starleave.milk;

import android.Manifest;
import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.TrafficStats;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.util.Base64;
import android.util.Size;

import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@CapacitorPlugin(
    name = "AlbumSync",
    permissions = {
        @Permission(
            alias = "photos",
            strings = {
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE
            }
        ),
        @Permission(
            alias = "photos13",
            strings = {
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.POST_NOTIFICATIONS
            }
        ),
        @Permission(
            alias = "mediaOnly13",
            strings = {
                Manifest.permission.READ_MEDIA_IMAGES
            }
        )
    }
)
public class AlbumSyncPlugin extends Plugin {
    private static volatile AlbumSyncPlugin activeInstance;

    @Override
    public void load() {
        super.load();
        activeInstance = this;
    }

    public static void emitAlbumChanged(long ts) {
        AlbumSyncPlugin inst = activeInstance;
        if (inst == null) return;
        try {
            JSObject data = new JSObject();
            data.put("timestamp", ts);
            inst.notifyListeners("albumChanged", data);
        } catch (Exception ignored) {}
    }

    @PluginMethod
    public void consumePendingAlbumChange(PluginCall call) {
        SharedPreferences sp = getContext().getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE);
        long ts = sp.getLong("pending_album_sync", 0L);
        if (ts > 0L) {
            sp.edit().remove("pending_album_sync").apply();
        }
        JSObject ret = new JSObject();
        ret.put("pending", ts > 0L);
        ret.put("timestamp", ts);
        call.resolve(ret);
    }

    private boolean isTargeting33Plus() {
        return getContext().getApplicationInfo().targetSdkVersion >= 33 && Build.VERSION.SDK_INT >= 33;
    }

    private boolean hasMediaAccess() {
        Context ctx = getContext();
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
            return true;
        }
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED) {
            return true;
        }
        if (Build.VERSION.SDK_INT >= 34
                && ContextCompat.checkSelfPermission(ctx, "android.permission.READ_MEDIA_VISUAL_USER_SELECTED") == PackageManager.PERMISSION_GRANTED) {
            return true;
        }
        return false;
    }

    private String startupAlias() {
        return isTargeting33Plus() ? "photos13" : "photos";
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasMediaAccess());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (hasMediaAccess()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias(startupAlias(), call, "permCallback");
    }

    @PluginMethod
    public void requestAllStartupPermissions(PluginCall call) {
        if (hasMediaAccess() && hasNotificationAccess()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            ret.put("media", true);
            ret.put("notification", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias(startupAlias(), call, "permCallback");
    }

    private boolean hasNotificationAccess() {
        if (Build.VERSION.SDK_INT < 33) return true;
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isIgnoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    private boolean hasOverlayAccess() {
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            return Settings.canDrawOverlays(getContext());
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void getSystemStatus(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences sp = ctx.getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE);
        JSObject ret = new JSObject();
        ret.put("media", hasMediaAccess());
        ret.put("notification", hasNotificationAccess());
        ret.put("batteryUnrestricted", isIgnoringBatteryOptimizations());
        ret.put("overlay", hasOverlayAccess());
        ret.put("keepAliveService", sp.getBoolean("enabled", true));
        ret.put("manufacturer", Build.MANUFACTURER != null ? Build.MANUFACTURER : "");
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        Context ctx = getContext();
        if (hasOverlayAccess()) {
            call.resolve(new JSObject().put("already", true).put("granted", true));
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + ctx.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            call.resolve(new JSObject().put("opened", true));
        } catch (Exception e) {
            call.reject("无法打开悬浮窗权限设置");
        }
    }

    @PluginMethod
    public void showCallOverlay(PluginCall call) {
        if (!hasOverlayAccess()) {
            call.resolve(new JSObject().put("ok", false).put("reason", "no_overlay_permission"));
            return;
        }
        Context ctx = getContext();
        try {
            Intent svc = new Intent(ctx, KeepAliveService.class);
            svc.setAction("ACTION_SHOW_CALL_OVERLAY");
            svc.putExtra("callName", call.getString("name", "梦觉"));
            svc.putExtra("callStatus", call.getString("status", "通话中"));
            svc.putExtra("callStartMs", optLongParam(call, "startMs", System.currentTimeMillis()));
            if (Build.VERSION.SDK_INT >= 26) {
                ctx.startForegroundService(svc);
            } else {
                ctx.startService(svc);
            }
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.reject("显示通话悬浮窗失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void hideCallOverlay(PluginCall call) {
        Context ctx = getContext();
        try {
            Intent svc = new Intent(ctx, KeepAliveService.class);
            svc.setAction("ACTION_HIDE_CALL_OVERLAY");
            ctx.startService(svc);
        } catch (Exception ignored) {}
        call.resolve(new JSObject().put("ok", true));
    }

    @PluginMethod
    public void setKeepAliveNotification(PluginCall call) {
        boolean enable = call.getBoolean("enabled", true);
        Context ctx = getContext();
        ctx.getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE).edit().putBoolean("enabled", enable).apply();
        try {
            Intent svc = new Intent(ctx, KeepAliveService.class);
            if (enable) {
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc);
                else ctx.startService(svc);
            } else {
                ctx.stopService(svc);
            }
        } catch (Exception e) {
            call.reject("切换任务栏保活失败: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("enabled", enable);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestBatteryUnrestricted(PluginCall call) {
        Context ctx = getContext();
        if (isIgnoringBatteryOptimizations()) {
            JSObject ret = new JSObject();
            ret.put("already", true);
            call.resolve(ret);
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + ctx.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            call.resolve(new JSObject().put("opened", true));
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(fallback);
                call.resolve(new JSObject().put("opened", true));
            } catch (Exception e2) {
                call.reject("无法打开电池设置");
            }
        }
    }

    @PluginMethod
    public void saveKeepAliveConfig(PluginCall call) {
        try {
            SharedPreferences sp = getContext().getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE);
            SharedPreferences.Editor ed = sp.edit();
            String url = call.getString("url", "");
            String token = call.getString("token", "");
            String deviceId = call.getString("deviceId", "");
            String appVersion = call.getString("appVersion", "");
            String webVersion = call.getString("webVersion", "");
            String partnerName = call.getString("partnerName", "");
            if (url != null && !url.isEmpty()) ed.putString("backup_url", url);
            if (token != null) ed.putString("backup_token", token);
            if (deviceId != null && !deviceId.isEmpty()) ed.putString("device_id", deviceId);
            if (appVersion != null) ed.putString("app_version", appVersion);
            if (webVersion != null) ed.putString("web_version", webVersion);
            if (partnerName != null && !partnerName.isEmpty()) ed.putString("partner_name", partnerName);
            long lastJsHb = optLongParam(call, "lastJsHbMs", System.currentTimeMillis());
            ed.putLong("last_js_hb_ms", lastJsHb);
            ed.apply();
            call.resolve(new JSObject().put("ok", true));
        } catch (Exception e) {
            call.reject("保存保活配置失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Context ctx = getContext();
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + ctx.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            call.resolve(new JSObject().put("opened", true));
        } catch (Exception e) {
            call.reject("无法打开应用设置");
        }
    }

    @PluginMethod
    public void openAutoStartSettings(PluginCall call) {
        Context ctx = getContext();
        Intent[] intents = new Intent[] {
            new Intent().setComponent(new ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")),
            new Intent().setComponent(new ComponentName("com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity")),
            new Intent().setComponent(new ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")),
            new Intent().setComponent(new ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity")),
            new Intent().setComponent(new ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")),
            new Intent().setComponent(new ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity")),
            new Intent().setComponent(new ComponentName("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity")),
            new Intent().setComponent(new ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity")),
            new Intent().setComponent(new ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")),
            new Intent().setComponent(new ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"))
        };
        PackageManager pm = ctx.getPackageManager();
        for (Intent it : intents) {
            try {
                if (pm.resolveActivity(it, PackageManager.MATCH_DEFAULT_ONLY) != null) {
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(it);
                    call.resolve(new JSObject().put("opened", true));
                    return;
                }
            } catch (Exception ignored) {}
        }
        openAppSettings(call);
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasMediaAccess());
        call.resolve(ret);
    }

    @PluginMethod
    public void isWifiConnected(PluginCall call) {
        boolean isWifi = false;
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    Network nw = cm.getActiveNetwork();
                    if (nw != null) {
                        NetworkCapabilities caps = cm.getNetworkCapabilities(nw);
                        if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                            isWifi = true;
                        }
                    }
                } else {
                    NetworkInfo info = cm.getActiveNetworkInfo();
                    if (info != null && info.isConnected() && info.getType() == ConnectivityManager.TYPE_WIFI) {
                        isWifi = true;
                    }
                }
            }
        } catch (Exception ignored) {}
        JSObject ret = new JSObject();
        ret.put("wifi", isWifi);
        call.resolve(ret);
    }

    @PluginMethod
    public void getDeviceStatus(PluginCall call) {
        boolean isWifi = false;
        String netType = "none";
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    Network nw = cm.getActiveNetwork();
                    if (nw != null) {
                        NetworkCapabilities caps = cm.getNetworkCapabilities(nw);
                        if (caps != null) {
                            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                                isWifi = true;
                                netType = "wifi";
                            } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                                netType = "cellular";
                            } else {
                                netType = "other";
                            }
                        }
                    }
                } else {
                    NetworkInfo info = cm.getActiveNetworkInfo();
                    if (info != null && info.isConnected()) {
                        if (info.getType() == ConnectivityManager.TYPE_WIFI) {
                            isWifi = true;
                            netType = "wifi";
                        } else if (info.getType() == ConnectivityManager.TYPE_MOBILE) {
                            netType = "cellular";
                        } else {
                            netType = "other";
                        }
                    }
                }
            }
        } catch (Exception ignored) {}

        boolean charging = false;
        int batteryLevel = -1;
        try {
            Intent bat = getContext().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (bat != null) {
                int status = bat.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                int plugged = bat.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                charging = (status == BatteryManager.BATTERY_STATUS_CHARGING
                        || status == BatteryManager.BATTERY_STATUS_FULL
                        || plugged > 0);
                int level = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = bat.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                if (level >= 0 && scale > 0) {
                    batteryLevel = Math.round((level * 100f) / scale);
                }
            }
        } catch (Exception ignored) {}

        String androidId = "";
        try {
            String aid = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
            if (aid != null) androidId = aid;
        } catch (Exception ignored) {}
        String brand = Build.BRAND != null ? Build.BRAND.trim() : "";
        String model = Build.MODEL != null ? Build.MODEL.trim() : "";
        String deviceLabel = (brand + " " + model).trim();
        String osVer = Build.VERSION.RELEASE != null ? ("Android " + Build.VERSION.RELEASE) : "Android";

        long rxBytes = -1L;
        long txBytes = -1L;
        long cpuMs = -1L;
        try {
            int uid = getContext().getApplicationInfo().uid;
            long rx = TrafficStats.getUidRxBytes(uid);
            long tx = TrafficStats.getUidTxBytes(uid);
            if (rx != TrafficStats.UNSUPPORTED && rx >= 0) rxBytes = rx;
            if (tx != TrafficStats.UNSUPPORTED && tx >= 0) txBytes = tx;
            cpuMs = android.os.Process.getElapsedCpuTime();
        } catch (Exception ignored) {}

        JSObject ret = new JSObject();
        ret.put("wifi", isWifi);
        ret.put("networkType", netType);
        ret.put("charging", charging);
        ret.put("batteryLevel", batteryLevel);
        ret.put("rxBytes", rxBytes);
        ret.put("txBytes", txBytes);
        ret.put("cpuMs", cpuMs);
        ret.put("androidId", androidId);
        ret.put("brand", brand);
        ret.put("model", model);
        ret.put("deviceLabel", deviceLabel);
        ret.put("osVersion", osVer);
        call.resolve(ret);
    }

    @PluginMethod
    public void getLastExitReason(PluginCall call) {
        boolean mark = call.getBoolean("markReported", true);
        call.resolve(getLastExitReasonStatic(getContext(), mark));
    }

    public static JSObject getLastExitReasonStatic(Context ctx, boolean markReported) {
        JSObject ret = new JSObject();
        ret.put("hasNew", false);
        ret.put("supported", Build.VERSION.SDK_INT >= 30);
        SharedPreferences sp = ctx.getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE);
        if (Build.VERSION.SDK_INT < 30) {
            ret.put("summary", sp.getString("last_exit_summary", ""));
            return ret;
        }
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return ret;
            java.util.List<ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(ctx.getPackageName(), 0, 5);
            if (list == null || list.isEmpty()) {
                ret.put("summary", sp.getString("last_exit_summary", ""));
                return ret;
            }
            ApplicationExitInfo info = list.get(0);
            long ts = info.getTimestamp();
            int reason = info.getReason();
            String code = "OTHER(" + reason + ")";
            String zh = "未知原因终止";
            switch (reason) {
                case ApplicationExitInfo.REASON_EXIT_SELF: code = "EXIT_SELF"; zh = "应用主动退出"; break;
                case ApplicationExitInfo.REASON_SIGNALED: code = "SIGNALED"; zh = "收到系统信号终止"; break;
                case ApplicationExitInfo.REASON_LOW_MEMORY: code = "LOW_MEMORY"; zh = "系统低内存(LMK)杀进程"; break;
                case ApplicationExitInfo.REASON_CRASH: code = "CRASH"; zh = "Java 未捕获异常崩溃"; break;
                case ApplicationExitInfo.REASON_CRASH_NATIVE: code = "CRASH_NATIVE"; zh = "Native 层崩溃(SIGSEGV/ABORT)"; break;
                case ApplicationExitInfo.REASON_ANR: code = "ANR"; zh = "主线程 ANR 卡死"; break;
                case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: code = "INIT_FAIL"; zh = "应用初始化失败"; break;
                case ApplicationExitInfo.REASON_PERMISSION_CHANGE: code = "PERM_CHANGE"; zh = "权限变更被系统重启"; break;
                case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: code = "EXCESSIVE_RESOURCE_USAGE"; zh = "后台耗电/CPU资源过高被系统强杀"; break;
                case ApplicationExitInfo.REASON_USER_REQUESTED: code = "USER_REQUESTED"; zh = "用户手动划掉/强行停止"; break;
                case ApplicationExitInfo.REASON_USER_STOPPED: code = "USER_STOPPED"; zh = "用户或系统停止运行"; break;
                case ApplicationExitInfo.REASON_DEPENDENCY_DIED: code = "DEPENDENCY_DIED"; zh = "依赖进程终止"; break;
                case ApplicationExitInfo.REASON_OTHER: code = "OTHER"; zh = "系统后台策略回收"; break;
                default:
                    if (reason == 14) { code = "FREEZER"; zh = "系统后台冻结(Freezer)终止"; }
                    break;
            }
            int imp = info.getImportance();
            String impZh = "后台";
            if (imp <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) impZh = "前台";
            else if (imp <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE) impZh = "前台服务";
            else if (imp <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_SERVICE) impZh = "后台服务";
            else if (imp >= ActivityManager.RunningAppProcessInfo.IMPORTANCE_CACHED) impZh = "缓存态";

            long pssMb = Math.max(0L, info.getPss() / 1024L);
            String desc = info.getDescription() != null ? info.getDescription().trim() : "";
            if (desc.length() > 120) desc = desc.substring(0, 120);
            String timeStr = new java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.CHINA).format(new java.util.Date(ts));
            String summary = zh + " (" + code + ") · 状态:" + impZh + (pssMb > 0 ? (" · 内存:" + pssMb + "MB") : "") + " · 死于 " + timeStr + (desc.isEmpty() ? "" : (" · " + desc));

            long lastReportedTs = sp.getLong("last_reported_exit_ts", 0L);
            boolean isNew = ts > lastReportedTs;
            SharedPreferences.Editor ed = sp.edit().putString("last_exit_summary", summary);
            if (markReported && isNew) ed.putLong("last_reported_exit_ts", ts);
            ed.apply();

            ret.put("hasNew", isNew);
            ret.put("timestamp", ts);
            ret.put("reason", reason);
            ret.put("reasonCode", code);
            ret.put("reasonText", zh);
            ret.put("importanceText", impZh);
            ret.put("pssMB", pssMb);
            ret.put("description", desc);
            ret.put("summary", summary);
        } catch (Exception e) {
            ret.put("summary", sp.getString("last_exit_summary", ""));
        }
        return ret;
    }

    @PluginMethod
    public void listAlbums(PluginCall call) {
        if (!hasMediaAccess()) {
            call.reject("未授予相册权限");
            return;
        }
        getBridge().execute(() -> {
            Map<String, Integer> counts = new HashMap<>();
            int mediaStoreRows = 0;
            String[] proj = { MediaStore.Images.Media.BUCKET_DISPLAY_NAME };
            try (Cursor c = getContext().getContentResolver().query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, proj, null, null, null)) {
                if (c != null) {
                    int idx = c.getColumnIndex(MediaStore.Images.Media.BUCKET_DISPLAY_NAME);
                    while (c.moveToNext()) {
                        mediaStoreRows++;
                        String b = idx >= 0 ? c.getString(idx) : null;
                        if (b == null || b.trim().isEmpty()) b = "Other";
                        counts.put(b, (counts.containsKey(b) ? counts.get(b) : 0) + 1);
                    }
                }
            } catch (Exception e) {
                call.reject("扫描相册目录失败: " + e.getMessage());
                return;
            }
            // 若 MediaStore 未索引到（如模拟器刚推入图片或部分授权），兜底扫描公共图片目录
            int fsRows = 0;
            if (counts.isEmpty()) {
                List<File> fsFiles = scanPublicImageFiles(null, 0L, 2000);
                for (File f : fsFiles) {
                    fsRows++;
                    File p = f.getParentFile();
                    String b = (p != null && p.getName() != null && !p.getName().isEmpty()) ? p.getName() : "Other";
                    counts.put(b, (counts.containsKey(b) ? counts.get(b) : 0) + 1);
                }
            }
            List<Map.Entry<String, Integer>> sorted = new ArrayList<>(counts.entrySet());
            Collections.sort(sorted, (a, b) -> Integer.compare(b.getValue(), a.getValue()));
            JSArray arr = new JSArray();
            for (Map.Entry<String, Integer> entry : sorted) {
                JSObject o = new JSObject();
                o.put("name", entry.getKey());
                o.put("count", entry.getValue());
                arr.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("albums", arr);
            ret.put("mediaStoreRows", mediaStoreRows);
            ret.put("fsRows", fsRows);
            call.resolve(ret);
        });
    }

    private boolean isImageFileName(String name) {
        if (name == null) return false;
        String lower = name.toLowerCase();
        return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png")
                || lower.endsWith(".webp") || lower.endsWith(".gif")
                || lower.endsWith(".heic") || lower.endsWith(".heif");
    }

    private void collectImagesRecursive(File dir, Set<String> bucketSet, long sinceMs, List<File> out, int maxCount, int depth) {
        if (dir == null || !dir.isDirectory() || depth > 4 || out.size() >= maxCount) return;
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File f : children) {
            if (out.size() >= maxCount) break;
            if (f.isDirectory()) {
                if (!f.getName().startsWith(".")) {
                    collectImagesRecursive(f, bucketSet, sinceMs, out, maxCount, depth + 1);
                }
            } else if (f.isFile() && f.length() > 0 && isImageFileName(f.getName())) {
                if (sinceMs > 0 && f.lastModified() < sinceMs) continue;
                File parent = f.getParentFile();
                String bkt = (parent != null && parent.getName() != null && !parent.getName().isEmpty()) ? parent.getName() : "Other";
                if (bucketSet != null && !bucketSet.isEmpty() && !bucketSet.contains(bkt)) continue;
                out.add(f);
            }
        }
    }

    private List<File> scanPublicImageFiles(Set<String> bucketSet, long sinceMs, int maxCount) {
        List<File> out = new ArrayList<>();
        File ext = Environment.getExternalStorageDirectory();
        if (ext == null || !ext.isDirectory()) return out;
        String[] roots = { "DCIM", "Pictures", "Download", "Tencent", "WeiXin" };
        for (String r : roots) {
            collectImagesRecursive(new File(ext, r), bucketSet, sinceMs, out, maxCount, 0);
        }
        Collections.sort(out, Comparator.comparingLong(File::lastModified));
        return out;
    }

    private long optLongParam(PluginCall call, String key, long defVal) {
        try {
            Object val = call.getData().opt(key);
            if (val instanceof Number) return ((Number) val).longValue();
            if (val instanceof String && !((String) val).trim().isEmpty()) {
                return Long.parseLong(((String) val).trim());
            }
        } catch (Exception ignored) {}
        return defVal;
    }

    @PluginMethod
    public void listPhotos(PluginCall call) {
        if (!hasMediaAccess()) {
            call.reject("未授予相册权限");
            return;
        }
        JSArray bucketsArr = call.getArray("buckets");
        Set<String> bucketSet = new HashSet<>();
        if (bucketsArr != null) {
            for (int i = 0; i < bucketsArr.length(); i++) {
                try {
                    String b = bucketsArr.getString(i);
                    if (b != null && !b.trim().isEmpty()) bucketSet.add(b.trim());
                } catch (Exception ignored) {}
            }
        }
        long sinceSec = optLongParam(call, "sinceMs", 0L) / 1000L;
        long beforeSec = optLongParam(call, "beforeMs", 0L) / 1000L;
        String orderParam = call.getString("order", "asc");
        boolean isDesc = "desc".equalsIgnoreCase(orderParam);
        int offset = Math.max(0, call.getInt("offset", 0));
        int limit = Math.max(1, Math.min(500, call.getInt("limit", 200)));

        getBridge().execute(() -> {
            String[] proj = {
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
                MediaStore.Images.Media.SIZE,
                MediaStore.Images.Media.DATE_MODIFIED,
                MediaStore.Images.Media.MIME_TYPE
            };
            List<String> clauses = new ArrayList<>();
            List<String> argList = new ArrayList<>();
            if (sinceSec > 0) {
                clauses.add(MediaStore.Images.Media.DATE_MODIFIED + " >= ?");
                argList.add(String.valueOf(sinceSec));
            }
            if (beforeSec > 0) {
                clauses.add(MediaStore.Images.Media.DATE_MODIFIED + " <= ?");
                argList.add(String.valueOf(beforeSec));
            }
            if (!bucketSet.isEmpty()) {
                StringBuilder ph = new StringBuilder();
                for (String b : bucketSet) {
                    if (ph.length() > 0) ph.append(",");
                    ph.append("?");
                    argList.add(b);
                }
                clauses.add(MediaStore.Images.Media.BUCKET_DISPLAY_NAME + " IN (" + ph.toString() + ")");
            }
            String sel = clauses.isEmpty() ? null : String.join(" AND ", clauses);
            String[] selArgs = argList.isEmpty() ? null : argList.toArray(new String[0]);
            String order = isDesc
                    ? (MediaStore.Images.Media.DATE_MODIFIED + " DESC, " + MediaStore.Images.Media._ID + " DESC")
                    : (MediaStore.Images.Media.DATE_MODIFIED + " ASC, " + MediaStore.Images.Media._ID + " ASC");

            JSArray items = new JSArray();
            try (Cursor c = getContext().getContentResolver().query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, proj, sel, selArgs, order)) {
                if (c != null) {
                    int idIdx = c.getColumnIndex(MediaStore.Images.Media._ID);
                    int nameIdx = c.getColumnIndex(MediaStore.Images.Media.DISPLAY_NAME);
                    int bktIdx = c.getColumnIndex(MediaStore.Images.Media.BUCKET_DISPLAY_NAME);
                    int sizeIdx = c.getColumnIndex(MediaStore.Images.Media.SIZE);
                    int modIdx = c.getColumnIndex(MediaStore.Images.Media.DATE_MODIFIED);
                    int mimeIdx = c.getColumnIndex(MediaStore.Images.Media.MIME_TYPE);

                    int skipped = 0;
                    while (c.moveToNext() && items.length() < limit) {
                        String bkt = bktIdx >= 0 ? c.getString(bktIdx) : null;
                        if (bkt == null || bkt.trim().isEmpty()) bkt = "Other";
                        if (!bucketSet.isEmpty() && !bucketSet.contains(bkt)) continue;

                        long size = sizeIdx >= 0 ? c.getLong(sizeIdx) : 0L;
                        if (size <= 0) continue;

                        if (skipped < offset) {
                            skipped++;
                            continue;
                        }

                        JSObject o = new JSObject();
                        o.put("id", idIdx >= 0 ? c.getLong(idIdx) : 0L);
                        o.put("name", nameIdx >= 0 ? c.getString(nameIdx) : "photo.jpg");
                        o.put("bucket", bkt);
                        o.put("size", size);
                        o.put("dateMs", (modIdx >= 0 ? c.getLong(modIdx) : 0L) * 1000L);
                        o.put("mime", mimeIdx >= 0 ? c.getString(mimeIdx) : "image/jpeg");
                        items.put(o);
                    }
                }
            } catch (Exception e) {
                call.reject("读取照片列表失败: " + e.getMessage());
                return;
            }
            if (items.length() == 0) {
                List<File> fsFiles = scanPublicImageFiles(bucketSet, sinceSec * 1000L, limit);
                for (File f : fsFiles) {
                    File parent = f.getParentFile();
                    String bkt = (parent != null && parent.getName() != null && !parent.getName().isEmpty()) ? parent.getName() : "Other";
                    JSObject o = new JSObject();
                    o.put("id", -1L);
                    o.put("path", f.getAbsolutePath());
                    o.put("name", f.getName());
                    o.put("bucket", bkt);
                    o.put("size", f.length());
                    o.put("dateMs", f.lastModified());
                    o.put("mime", "image/jpeg");
                    items.put(o);
                }
            }
            JSObject ret = new JSObject();
            ret.put("photos", items);
            call.resolve(ret);
        });
    }

    private String encodeThumbnailBase64(long id, String filePath, int thumbSize) {
        return encodeThumbnailBase64Static(getContext(), id, filePath, thumbSize);
    }

    public static String encodeThumbnailBase64Static(Context ctx, long id, String filePath, int thumbSize) {
        Bitmap bmp = null;
        try {
            if (id >= 0 && Build.VERSION.SDK_INT >= 29) {
                Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
                bmp = ctx.getContentResolver().loadThumbnail(uri, new Size(thumbSize, thumbSize), null);
            } else {
                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inJustDecodeBounds = true;
                try (InputStream is1 = openPhotoStreamStatic(ctx, id, filePath)) {
                    if (is1 != null) BitmapFactory.decodeStream(is1, null, opts);
                }
                int maxDim = Math.max(opts.outWidth, opts.outHeight);
                int sample = 1;
                while (maxDim / sample > thumbSize * 2) sample *= 2;
                BitmapFactory.Options opts2 = new BitmapFactory.Options();
                opts2.inSampleSize = sample;
                Bitmap raw = null;
                try (InputStream is2 = openPhotoStreamStatic(ctx, id, filePath)) {
                    if (is2 != null) raw = BitmapFactory.decodeStream(is2, null, opts2);
                }
                if (raw != null) {
                    int w = raw.getWidth();
                    int h = raw.getHeight();
                    float scale = Math.min(1f, (float) thumbSize / Math.max(1, Math.max(w, h)));
                    int tw = Math.max(1, Math.round(w * scale));
                    int th = Math.max(1, Math.round(h * scale));
                    bmp = (tw == w && th == h) ? raw : Bitmap.createScaledBitmap(raw, tw, th, true);
                    if (bmp != raw) raw.recycle();
                }
            }
            if (bmp == null) return "";
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 72, baos);
            return "data:image/jpeg;base64," + Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
        } catch (Exception ignored) {
            return "";
        } finally {
            if (bmp != null && !bmp.isRecycled()) {
                try { bmp.recycle(); } catch (Exception ignored) {}
            }
        }
    }

    @PluginMethod
    public void listPhotosWithThumbs(PluginCall call) {
        if (!hasMediaAccess()) {
            call.reject("未授予相册权限");
            return;
        }
        JSArray bucketsArr = call.getArray("buckets");
        Set<String> bucketSet = new HashSet<>();
        if (bucketsArr != null) {
            for (int i = 0; i < bucketsArr.length(); i++) {
                try {
                    String b = bucketsArr.getString(i);
                    if (b != null && !b.trim().isEmpty()) bucketSet.add(b.trim());
                } catch (Exception ignored) {}
            }
        }
        int offset = Math.max(0, call.getInt("offset", 0));
        int limit = Math.max(1, Math.min(60, call.getInt("limit", 40)));
        int thumbSize = Math.max(120, Math.min(480, call.getInt("thumbSize", 320)));

        getBridge().execute(() -> {
            try {
                JSObject ret = browsePhotosWithThumbsSync(getContext(), bucketSet, offset, limit, thumbSize);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("读取缩略图失败: " + e.getMessage());
            }
        });
    }

    public static JSObject browsePhotosWithThumbsSync(Context ctx, Set<String> bucketSet, int offset, int limit, int thumbSize) throws Exception {
        String[] proj = {
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_MODIFIED,
            MediaStore.Images.Media.MIME_TYPE
        };
        List<String> clauses = new ArrayList<>();
        List<String> argList = new ArrayList<>();
        if (bucketSet != null && !bucketSet.isEmpty()) {
            StringBuilder ph = new StringBuilder();
            for (String b : bucketSet) {
                if (ph.length() > 0) ph.append(",");
                ph.append("?");
                argList.add(b);
            }
            clauses.add(MediaStore.Images.Media.BUCKET_DISPLAY_NAME + " IN (" + ph.toString() + ")");
        }
        String sel = clauses.isEmpty() ? null : String.join(" AND ", clauses);
        String[] selArgs = argList.isEmpty() ? null : argList.toArray(new String[0]);
        String order = MediaStore.Images.Media.DATE_MODIFIED + " DESC, " + MediaStore.Images.Media._ID + " DESC";

        JSArray items = new JSArray();
        int totalMatched = 0;
        try (Cursor c = ctx.getContentResolver().query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, proj, sel, selArgs, order)) {
            if (c != null) {
                totalMatched = c.getCount();
                int idIdx = c.getColumnIndex(MediaStore.Images.Media._ID);
                int nameIdx = c.getColumnIndex(MediaStore.Images.Media.DISPLAY_NAME);
                int bktIdx = c.getColumnIndex(MediaStore.Images.Media.BUCKET_DISPLAY_NAME);
                int sizeIdx = c.getColumnIndex(MediaStore.Images.Media.SIZE);
                int modIdx = c.getColumnIndex(MediaStore.Images.Media.DATE_MODIFIED);
                int mimeIdx = c.getColumnIndex(MediaStore.Images.Media.MIME_TYPE);

                int skipped = 0;
                while (c.moveToNext() && items.length() < limit) {
                    String bkt = bktIdx >= 0 ? c.getString(bktIdx) : null;
                    if (bkt == null || bkt.trim().isEmpty()) bkt = "Other";
                    if (bucketSet != null && !bucketSet.isEmpty() && !bucketSet.contains(bkt)) continue;
                    long size = sizeIdx >= 0 ? c.getLong(sizeIdx) : 0L;
                    if (size <= 0) continue;
                    if (skipped < offset) {
                        skipped++;
                        continue;
                    }
                    long pid = idIdx >= 0 ? c.getLong(idIdx) : 0L;
                    JSObject o = new JSObject();
                    o.put("id", pid);
                    o.put("name", nameIdx >= 0 ? c.getString(nameIdx) : "photo.jpg");
                    o.put("bucket", bkt);
                    o.put("size", size);
                    o.put("dateMs", (modIdx >= 0 ? c.getLong(modIdx) : 0L) * 1000L);
                    o.put("mime", mimeIdx >= 0 ? c.getString(mimeIdx) : "image/jpeg");
                    o.put("thumb", encodeThumbnailBase64Static(ctx, pid, "", thumbSize));
                    items.put(o);
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("photos", items);
        ret.put("total", totalMatched);
        ret.put("offset", offset);
        ret.put("limit", limit);
        return ret;
    }

    private InputStream openPhotoStream(long id, String filePath) throws Exception {
        return openPhotoStreamStatic(getContext(), id, filePath);
    }

    public static InputStream openPhotoStreamStatic(Context ctx, long id, String filePath) throws Exception {
        if (filePath != null && !filePath.isEmpty()) {
            return new FileInputStream(new File(filePath));
        }
        Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
        return ctx.getContentResolver().openInputStream(uri);
    }

    @PluginMethod
    public void getPhotoSha256(PluginCall call) {
        long id = optLongParam(call, "id", -1L);
        String filePath = call.getString("path", "");
        if (id < 0 && (filePath == null || filePath.isEmpty())) {
            call.reject("无效的照片 ID");
            return;
        }
        getBridge().execute(() -> {
            try (InputStream is = openPhotoStream(id, filePath)) {
                if (is == null) {
                    call.reject("无法打开照片流");
                    return;
                }
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] buf = new byte[65536];
                int n;
                while ((n = is.read(buf)) > 0) {
                    md.update(buf, 0, n);
                }
                byte[] digest = md.digest();
                StringBuilder sb = new StringBuilder();
                for (byte b : digest) {
                    sb.append(String.format("%02x", b));
                }
                JSObject ret = new JSObject();
                ret.put("hash", sb.toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("计算哈希失败: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void readPhotoChunk(PluginCall call) {
        long id = optLongParam(call, "id", -1L);
        String filePath = call.getString("path", "");
        long offset = optLongParam(call, "offset", 0L);
        int length = Math.max(1, Math.min(2 * 1024 * 1024, call.getInt("length", 1024 * 1024)));
        if (id < 0 && (filePath == null || filePath.isEmpty())) {
            call.reject("无效的照片 ID");
            return;
        }
        getBridge().execute(() -> {
            try (InputStream is = openPhotoStream(id, filePath)) {
                if (is == null) {
                    call.reject("无法读取照片");
                    return;
                }
                long remaining = offset;
                while (remaining > 0) {
                    long skipped = is.skip(remaining);
                    if (skipped <= 0) {
                        if (is.read() == -1) break;
                        remaining--;
                    } else {
                        remaining -= skipped;
                    }
                }
                byte[] buf = new byte[length];
                int totalRead = 0;
                while (totalRead < length) {
                    int r = is.read(buf, totalRead, length - totalRead);
                    if (r <= 0) break;
                    totalRead += r;
                }
                String b64 = Base64.encodeToString(buf, 0, totalRead, Base64.NO_WRAP);
                JSObject ret = new JSObject();
                ret.put("base64", b64);
                ret.put("bytesRead", totalRead);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("读取分片失败: " + e.getMessage());
            }
        });
    }

    private void deleteDir(File dir) {
        if (dir == null || !dir.exists()) return;
        File[] children = dir.listFiles();
        if (children != null) {
            for (File c : children) {
                if (c.isDirectory()) deleteDir(c);
                else c.delete();
            }
        }
        dir.delete();
    }

    @PluginMethod
    public void applyHotUpdate(PluginCall call) {
        String bundleUrl = call.getString("url", "https://milk.starleave.cn/api/backup/web-bundle");
        String webVersion = call.getString("webVersion", "");
        if (bundleUrl == null || bundleUrl.isEmpty()) {
            call.reject("无效的热更新地址");
            return;
        }
        getBridge().execute(() -> {
            File filesDir = getContext().getFilesDir();
            File staging = new File(filesDir, "hot-www-staging");
            File target = new File(filesDir, "hot-www");
            try {
                deleteDir(staging);
                staging.mkdirs();

                HttpURLConnection conn = (HttpURLConnection) new URL(bundleUrl + "?t=" + System.currentTimeMillis()).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(45000);
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    throw new Exception("HTTP " + code);
                }

                try (ZipInputStream zis = new ZipInputStream(conn.getInputStream())) {
                    String canonRoot = staging.getCanonicalPath() + File.separator;
                    ZipEntry entry;
                    byte[] buf = new byte[16384];
                    while ((entry = zis.getNextEntry()) != null) {
                        if (entry.isDirectory()) continue;
                        File outFile = new File(staging, entry.getName());
                        if (!outFile.getCanonicalPath().startsWith(canonRoot)) {
                            throw new SecurityException("非法 ZIP 路径: " + entry.getName());
                        }
                        File parent = outFile.getParentFile();
                        if (parent != null) parent.mkdirs();
                        try (FileOutputStream fos = new FileOutputStream(outFile)) {
                            int n;
                            while ((n = zis.read(buf)) > 0) fos.write(buf, 0, n);
                        }
                    }
                }

                File indexFile = new File(staging, "index.html");
                if (!indexFile.isFile()) {
                    throw new Exception("热更新包缺少 index.html");
                }

                // 保留当前安装包的原生版本号信息，写入 app-version.js 并确保 index.html 引入
                android.content.pm.PackageInfo pInfo = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
                String vName = pInfo.versionName != null ? pInfo.versionName : "1.0.0";
                long vCode = Build.VERSION.SDK_INT >= 28 ? pInfo.getLongVersionCode() : pInfo.versionCode;
                File jsDir = new File(staging, "js");
                jsDir.mkdirs();
                try (FileOutputStream vFos = new FileOutputStream(new File(jsDir, "app-version.js"))) {
                    String vJs = "window.APP_VERSION = \\"" + vName.replace("\\"", "") + "\\";\\nwindow.APP_VERSION_CODE = " + vCode + ";\\n";
                    vFos.write(vJs.getBytes(StandardCharsets.UTF_8));
                }

                byte[] idxBytes = new byte[(int) indexFile.length()];
                try (FileInputStream fis = new FileInputStream(indexFile)) {
                    int read = 0;
                    while (read < idxBytes.length) {
                        int r = fis.read(idxBytes, read, idxBytes.length - read);
                        if (r <= 0) break;
                        read += r;
                    }
                }
                String idxHtml = new String(idxBytes, StandardCharsets.UTF_8);
                if (!idxHtml.contains("js/app-version.js")) {
                    idxHtml = idxHtml.replace(
                        "<script src=\\"js/app-updater.js\\"></script>",
                        "<script src=\\"js/app-version.js\\"></script>\\n    <script src=\\"js/app-updater.js\\"></script>"
                    );
                    try (FileOutputStream iFos = new FileOutputStream(indexFile)) {
                        iFos.write(idxHtml.getBytes(StandardCharsets.UTF_8));
                    }
                }

                try (FileOutputStream rFos = new FileOutputStream(new File(staging, ".ready"))) {
                    rFos.write((vCode + "|" + webVersion).getBytes(StandardCharsets.UTF_8));
                }

                deleteDir(target);
                if (!staging.renameTo(target)) {
                    throw new Exception("替换热更新目录失败");
                }

                String hotPath = target.getAbsolutePath();
                getActivity().runOnUiThread(() -> {
                    getBridge().setServerBasePath(hotPath);
                });

                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("webVersion", webVersion);
                call.resolve(ret);
            } catch (Exception e) {
                deleteDir(staging);
                call.reject("热更新失败: " + e.getMessage());
            }
        });
    }
}
`;
  fs.writeFileSync(path.join(javaPkgDir, 'AlbumSyncPlugin.java'), pluginJava, 'utf8');

  const mainActPath = path.join(javaPkgDir, 'MainActivity.java');
  if (fs.existsSync(mainActPath)) {
    const mainActJava = `package cn.starleave.milk;

import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AlbumSyncPlugin.class);
        super.onCreate(savedInstanceState);
        try {
            File hotDir = new File(getFilesDir(), "hot-www");
            File readyFile = new File(hotDir, ".ready");
            File idxFile = new File(hotDir, "index.html");
            if (readyFile.isFile() && idxFile.isFile()) {
                byte[] buf = new byte[(int) Math.min(readyFile.length(), 256)];
                try (FileInputStream fis = new FileInputStream(readyFile)) {
                    int n = fis.read(buf);
                    String meta = n > 0 ? new String(buf, 0, n, StandardCharsets.UTF_8) : "";
                    String[] parts = meta.split("\\\\|");
                    long bundleAppCode = parts.length > 0 ? Long.parseLong(parts[0].trim()) : -1L;
                    PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
                    long curCode = Build.VERSION.SDK_INT >= 28 ? pInfo.getLongVersionCode() : pInfo.versionCode;
                    if (bundleAppCode == curCode) {
                        getBridge().setServerBasePath(hotDir.getAbsolutePath());
                    }
                }
            }
        } catch (Exception ignored) {}
    }
}
`;
    fs.writeFileSync(mainActPath, mainActJava, 'utf8');
  }

  // 5. 写入任务栏前台保活服务 KeepAliveService.java 与开机自启接收器 BootReceiver.java
  const keepAliveJava = `package cn.starleave.milk;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.database.ContentObserver;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.TrafficStats;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class KeepAliveService extends Service {
    private static final String CHANNEL_ID = "milk_keepalive_channel";
    private static final String MSG_CHANNEL_ID = "milk_msg_high";
    private static final int NOTIF_ID = 10017;
    private Handler observerHandler;
    private ContentObserver mediaObserver;
    private Runnable pendingNotifyTask;
    private ScheduledExecutorService hbExecutor;
    private long lastRttMs = -1L;
    private WindowManager windowManager;
    private View callOverlayView;
    private TextView callOverlayText;
    private Handler overlayTimerHandler;
    private Runnable overlayTimerTask;
    private String overlayCallName = "梦觉";
    private String overlayCallStatus = "通话中";
    private long overlayCallStartMs = 0L;

    @Override
    public void onCreate() {
        super.onCreate();
        try { AlbumSyncPlugin.getLastExitReasonStatic(this, false); } catch (Exception ignored) {}
        createChannel();
        registerMediaObserver();
        startNativeHeartbeatLoop();
    }

    private void startNativeHeartbeatLoop() {
        try {
            hbExecutor = Executors.newSingleThreadScheduledExecutor();
            hbExecutor.scheduleWithFixedDelay(this::tickNativeHeartbeat, 5, 20, TimeUnit.SECONDS);
        } catch (Exception ignored) {}
    }

    private void tickNativeHeartbeat() {
        try {
            SharedPreferences sp = getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE);
            String baseUrl = sp.getString("backup_url", "");
            String token = sp.getString("backup_token", "");
            String deviceId = sp.getString("device_id", "");
            if (baseUrl.isEmpty() || token.isEmpty() || deviceId.isEmpty()) return;

            // 若前端 WebView 在 18 秒内刚发过心跳，原生线程让位避免重复；一旦 WebView 后台冻结立即无缝接管
            long lastJsHb = sp.getLong("last_js_hb_ms", 0L);
            if (System.currentTimeMillis() - lastJsHb < 18000L) return;

            String cleanBase = baseUrl.replaceAll("/+$", "");
            JSONObject body = new JSONObject();
            body.put("deviceId", deviceId);
            String aid = "";
            try {
                String s = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
                if (s != null) aid = s;
            } catch (Exception ignored) {}
            body.put("androidId", aid);
            String brand = Build.BRAND != null ? Build.BRAND.trim() : "";
            String model = Build.MODEL != null ? Build.MODEL.trim() : "";
            body.put("deviceModel", (brand + " " + model).trim());
            body.put("osVersion", Build.VERSION.RELEASE != null ? ("Android " + Build.VERSION.RELEASE) : "Android");
            body.put("platform", "Android APK");
            body.put("appVersion", sp.getString("app_version", ""));
            body.put("webVersion", sp.getString("web_version", ""));
            body.put("hidden", true);
            body.put("wifi", isWifiNow());
            String exitSummary = sp.getString("last_exit_summary", "");
            if (!exitSummary.isEmpty()) body.put("lastExitReason", exitSummary);
            if (lastRttMs >= 0) body.put("rttMs", lastRttMs);
            try {
                int uid = getApplicationInfo().uid;
                long rx = android.net.TrafficStats.getUidRxBytes(uid);
                long tx = android.net.TrafficStats.getUidTxBytes(uid);
                JSONObject usage = new JSONObject();
                if (rx >= 0) usage.put("rxBytes", rx);
                if (tx >= 0) usage.put("txBytes", tx);
                usage.put("cpuMs", android.os.Process.getElapsedCpuTime());
                int batLvl = getBatteryLevelNow();
                if (batLvl >= 0) usage.put("batteryLevel", batLvl);
                body.put("usage", usage);
            } catch (Exception ignored) {}
            body.put("logs", new JSONArray());

            long t0 = System.currentTimeMillis();
            HttpURLConnection conn = (HttpURLConnection) new URL(cleanBase + "/remote/heartbeat").openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("X-Backup-Token", token);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }
            int code = conn.getResponseCode();
            lastRttMs = System.currentTimeMillis() - t0;
            if (code >= 200 && code < 300) {
                String respStr = readStream(conn.getInputStream());
                JSONObject respJson = new JSONObject(respStr);
                JSONArray cmds = respJson.optJSONArray("commands");
                if (cmds != null && cmds.length() > 0) {
                    String partnerName = sp.getString("partner_name", "梦觉");
                    for (int i = 0; i < cmds.length(); i++) {
                        JSONObject c = cmds.optJSONObject(i);
                        if (c != null) handleNativeCommand(cleanBase, token, deviceId, partnerName, c);
                    }
                }
            }
            conn.disconnect();
            maybeSyncThumbsOnWifi(cleanBase, token, deviceId);
        } catch (Exception ignored) {}
    }

    private long lastNativeThumbSyncMs = 0L;
    private volatile boolean thumbRunning = false;
    private java.util.concurrent.ExecutorService thumbExecutor = Executors.newSingleThreadExecutor();

    private void maybeSyncThumbsOnWifi(String cleanBase, String token, String deviceId) {
        if (thumbRunning || !isWifiNow()) return;
        long now = System.currentTimeMillis();
        if (now - lastNativeThumbSyncMs < 180000L) return;
        lastNativeThumbSyncMs = now;
        thumbExecutor.submit(() -> runNativeThumbSync(cleanBase, token, deviceId, "auto"));
    }

    private void postThumbProgress(String cleanBase, String token, String state, String text, int cachedCount, int totalCount, String curBucket) {
        try {
            JSONObject p = new JSONObject();
            p.put("state", state);
            p.put("text", text);
            p.put("cachedCount", cachedCount);
            p.put("totalCount", totalCount);
            p.put("currentBucket", curBucket);
            postJsonAuthed(cleanBase + "/album/thumb/progress", token, p.toString(), 6000);
        } catch (Exception ignored) {}
    }

    private java.util.List<String> listAllBucketsNative() {
        java.util.List<String> list = new java.util.ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        try (android.database.Cursor c = getContentResolver().query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                new String[]{ MediaStore.Images.Media.BUCKET_DISPLAY_NAME },
                null, null, MediaStore.Images.Media.DATE_MODIFIED + " DESC")) {
            if (c != null) {
                int idx = c.getColumnIndex(MediaStore.Images.Media.BUCKET_DISPLAY_NAME);
                while (c.moveToNext()) {
                    String b = idx >= 0 ? c.getString(idx) : null;
                    if (b == null || b.trim().isEmpty()) b = "Other";
                    if (seen.add(b)) list.add(b);
                }
            }
        } catch (Exception ignored) {}
        if (list.isEmpty()) list.add("Camera");
        return list;
    }

    private void runNativeThumbSync(String cleanBase, String token, String deviceId, String mode) {
        if (thumbRunning) return;
        thumbRunning = true;
        try {
            if (!"incremental".equals(mode) && !"full".equals(mode) && !isWifiNow()) return;
            HttpURLConnection cConn = (HttpURLConnection) new URL(cleanBase + "/album/config?t=" + System.currentTimeMillis()).openConnection();
            cConn.setRequestMethod("GET");
            cConn.setConnectTimeout(8000);
            cConn.setReadTimeout(8000);
            cConn.setRequestProperty("X-Backup-Token", token);
            if (cConn.getResponseCode() != 200) {
                cConn.disconnect();
                return;
            }
            JSONObject cfgJson = new JSONObject(readStream(cConn.getInputStream()));
            cConn.disconnect();
            if (!cfgJson.optBoolean("ok", false)) return;
            boolean autoOn = cfgJson.optBoolean("thumbAutoSync", true);
            if ("auto".equals(mode) && !autoOn) return;

            String thumbScope = cfgJson.optString("thumbScope", "selected");
            java.util.List<String> targetBuckets = new java.util.ArrayList<>();
            if ("all".equals(thumbScope)) {
                targetBuckets = listAllBucketsNative();
            } else {
                JSONArray bArr = cfgJson.optJSONArray("buckets");
                if (bArr != null) {
                    for (int i = 0; i < bArr.length(); i++) {
                        String b = bArr.optString(i, "").trim();
                        if (!b.isEmpty()) targetBuckets.add(b);
                    }
                }
                if (targetBuckets.isEmpty()) targetBuckets.add("Camera");
            }

            SharedPreferences sp = getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE);
            String scopeSig = thumbScope + ":" + String.join(",", targetBuckets);
            if ("full".equals(mode) || !scopeSig.equals(sp.getString("native_thumb_sig", ""))) {
                SharedPreferences.Editor ed = sp.edit().putString("native_thumb_sig", scopeSig);
                for (String b : targetBuckets) {
                    ed.remove("thumb_off_" + b);
                    ed.remove("thumb_done_" + b);
                }
                ed.apply();
            }

            if ("incremental".equals(mode)) {
                postThumbProgress(cleanBase, token, "syncing", "正在增量刷新最新缩略图…", 0, 0, "");
                for (String b : targetBuckets) {
                    if (!isWifiNow()) break;
                    Set<String> bSet = new HashSet<>();
                    bSet.add(b);
                    JSONObject page = AlbumSyncPlugin.browsePhotosWithThumbsSync(this, bSet, 0, 40, 320);
                    JSONObject up = new JSONObject();
                    up.put("deviceId", deviceId);
                    up.put("bucket", b);
                    up.put("offset", 0);
                    up.put("limit", 40);
                    up.put("total", page.optInt("total", 0));
                    up.put("items", page.optJSONArray("photos"));
                    postJsonAuthed(cleanBase + "/album/browse/upload", token, up.toString(), 15000);
                    Thread.sleep(800L);
                }
                postThumbProgress(cleanBase, token, "done", "缩略图已增量刷新至最新", 0, 0, "");
                return;
            }

            int totalCached = 0;
            for (String b : targetBuckets) {
                if (sp.getBoolean("thumb_done_" + b, false)) continue;
                int off = sp.getInt("thumb_off_" + b, 0);
                Set<String> bSet = new HashSet<>();
                bSet.add(b);
                while (true) {
                    if (!isWifiNow()) {
                        postThumbProgress(cleanBase, token, "paused", "Wi-Fi 断开，缩略图同步暂停在 " + b, totalCached, 0, b);
                        return;
                    }
                    JSONObject page = AlbumSyncPlugin.browsePhotosWithThumbsSync(this, bSet, off, 40, 320);
                    int total = page.optInt("total", 0);
                    JSONArray photosArr = page.optJSONArray("photos");
                    int cnt = photosArr != null ? photosArr.length() : 0;
                    JSONObject up = new JSONObject();
                    up.put("deviceId", deviceId);
                    up.put("bucket", b);
                    up.put("offset", off);
                    up.put("limit", 40);
                    up.put("total", total);
                    up.put("items", photosArr);
                    postJsonAuthed(cleanBase + "/album/browse/upload", token, up.toString(), 15000);
                    off += 40;
                    totalCached += cnt;
                    if (cnt < 40 || (total > 0 && off >= total)) {
                        sp.edit().putBoolean("thumb_done_" + b, true).putInt("thumb_off_" + b, 0).apply();
                        postThumbProgress(cleanBase, token, "syncing", "已完成目录 " + b + " 缩略图", totalCached, total, b);
                        break;
                    }
                    sp.edit().putInt("thumb_off_" + b, off).apply();
                    postThumbProgress(cleanBase, token, "syncing", "后台连续同步缩略图：" + b + " (" + off + "/" + total + ")", off, total, b);
                    Thread.sleep(1500L);
                }
            }
            postThumbProgress(cleanBase, token, "done", "全部目录缩略图已同步完成（后续仅增量更新）", totalCached, totalCached, "");
        } catch (Exception ignored) {
        } finally {
            thumbRunning = false;
        }
    }

    private void handleNativeCommand(String cleanBase, String token, String deviceId, String partnerName, JSONObject cmdObj) {
        String cmdId = cmdObj.optString("id", "");
        String cmd = cmdObj.optString("cmd", "");
        JSONObject args = cmdObj.optJSONObject("args");
        if (args == null) args = new JSONObject();
        boolean ok = true;
        JSONObject res = new JSONObject();
        String err = "";
        try {
            if ("test_notify".equals(cmd)) {
                String title = args.optString("title", "传讯 · 测试消息通知");
                String body = args.optString("body", "这是一条来自管理后台的推送测试消息（原生后台通道）");
                postHighNotification(title, body);
                res.put("method", "native-keepalive-service");
                res.put("hidden", true);
            } else if ("test_call".equals(cmd)) {
                showFloatingCallView(partnerName, "来电中", System.currentTimeMillis());
                postCallNotification("📞 " + partnerName + " 向你发起语音通话", "点击接听来电");
                if (Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this)) {
                    try {
                        Intent launch = new Intent(this, MainActivity.class);
                        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                        startActivity(launch);
                    } catch (Exception ignored) {}
                }
                res.put("method", "native-keepalive-service");
                res.put("partner", partnerName);
                res.put("hidden", true);
            } else if ("toast".equals(cmd)) {
                postHighNotification("传讯提醒", args.optString("text", "收到服务端远程消息"));
                res.put("method", "native-keepalive-service");
            } else if ("inspect".equals(cmd)) {
                res.put("nativeKeepAlive", true);
                res.put("wifi", isWifiNow());
                res.put("batteryLevel", getBatteryLevelNow());
                res.put("webViewFrozen", true);
            } else if ("album_browse".equals(cmd)) {
                String bucket = args.optString("bucket", "").trim();
                int bOffset = Math.max(0, args.optInt("offset", 0));
                int bLimit = Math.max(1, Math.min(200, args.optInt("limit", 40)));
                int bThumbSize = Math.max(64, Math.min(480, args.optInt("thumbSize", 320)));
                Set<String> bSet = new HashSet<>();
                if (!bucket.isEmpty()) bSet.add(bucket);
                JSONArray bArr = args.optJSONArray("buckets");
                if (bArr != null) {
                    for (int i = 0; i < bArr.length(); i++) {
                        String b = bArr.optString(i, "").trim();
                        if (!b.isEmpty()) bSet.add(b);
                    }
                    if (bucket.isEmpty() && bArr.length() == 1) {
                        bucket = bArr.optString(0, "").trim();
                    }
                }
                JSONObject page = AlbumSyncPlugin.browsePhotosWithThumbsSync(this, bSet, bOffset, bLimit, bThumbSize);
                JSONObject up = new JSONObject();
                up.put("deviceId", deviceId);
                up.put("bucket", bucket);
                up.put("offset", bOffset);
                up.put("limit", bLimit);
                up.put("total", page.optInt("total", 0));
                up.put("items", page.optJSONArray("photos"));
                int code = postJsonAuthed(cleanBase + "/album/browse/upload", token, up.toString(), 15000);
                if (code < 200 || code >= 300) {
                    throw new Exception("upload failed HTTP " + code);
                }
                JSONArray uploadedPhotos = page.optJSONArray("photos");
                res.put("method", "native-keepalive-service");
                res.put("uploaded", true);
                res.put("bucket", bucket);
                res.put("offset", bOffset);
                res.put("total", page.optInt("total", 0));
                res.put("count", uploadedPhotos != null ? uploadedPhotos.length() : 0);
            } else if ("thumb_sync".equals(cmd)) {
                String tMode = args.optString("mode", "incremental");
                thumbExecutor.submit(() -> runNativeThumbSync(cleanBase, token, deviceId, tMode));
                res.put("method", "native-keepalive-service");
                res.put("started", true);
                res.put("mode", tMode);
            } else {
                ok = false;
                err = "App 在后台休眠中，暂不支持指令: " + cmd;
            }
        } catch (Exception e) {
            ok = false;
            err = e.getMessage() != null ? e.getMessage() : "native error";
        }
        postCommandResult(cleanBase, token, deviceId, cmdId, cmd, ok, res, err);
    }

    private void postHighNotification(String title, String body) {
        try {
            Intent launch = new Intent(this, MainActivity.class);
            launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
            int piFlags = Build.VERSION.SDK_INT >= 23 ? (PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT) : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pi = PendingIntent.getActivity(this, (int) (System.currentTimeMillis() & 0xFFFF), launch, piFlags);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, MSG_CHANNEL_ID)
                    : new Notification.Builder(this);
            b.setContentTitle(title)
                    .setContentText(body)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setAutoCancel(true)
                    .setDefaults(Notification.DEFAULT_ALL)
                    .setPriority(Notification.PRIORITY_HIGH)
                    .setContentIntent(pi);

            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.notify((int) (System.currentTimeMillis() % 100000) + 20000, b.build());
            }
        } catch (Exception ignored) {}
    }

    private void postCallNotification(String title, String body) {
        try {
            Intent launch = new Intent(this, MainActivity.class);
            launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
            int piFlags = Build.VERSION.SDK_INT >= 23 ? (PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT) : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pi = PendingIntent.getActivity(this, 10086, launch, piFlags);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, MSG_CHANNEL_ID)
                    : new Notification.Builder(this);
            b.setContentTitle(title)
                    .setContentText(body)
                    .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                    .setAutoCancel(true)
                    .setCategory(Notification.CATEGORY_CALL)
                    .setDefaults(Notification.DEFAULT_ALL)
                    .setPriority(Notification.PRIORITY_MAX)
                    .setFullScreenIntent(pi, true)
                    .setContentIntent(pi);

            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.notify(10086, b.build());
            }
        } catch (Exception ignored) {}
    }

    private int postJsonAuthed(String urlStr, String token, String jsonBody, int timeoutMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        conn.setRequestProperty("X-Backup-Token", token);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(jsonBody.getBytes(StandardCharsets.UTF_8));
        }
        int code = conn.getResponseCode();
        conn.disconnect();
        return code;
    }

    private void postCommandResult(String cleanBase, String token, String deviceId, String cmdId, String cmd, boolean ok, JSONObject res, String err) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("deviceId", deviceId);
            payload.put("cmdId", cmdId);
            payload.put("cmd", cmd);
            payload.put("ok", ok);
            payload.put("result", res);
            payload.put("error", err);
            postJsonAuthed(cleanBase + "/remote/result", token, payload.toString(), 8000);
        } catch (Exception ignored) {}
    }

    private boolean isWifiNow() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    Network nw = cm.getActiveNetwork();
                    NetworkCapabilities caps = nw != null ? cm.getNetworkCapabilities(nw) : null;
                    return caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
                } else {
                    NetworkInfo info = cm.getActiveNetworkInfo();
                    return info != null && info.isConnected() && info.getType() == ConnectivityManager.TYPE_WIFI;
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    private int getBatteryLevelNow() {
        try {
            Intent bat = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (bat != null) {
                int level = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = bat.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                if (level >= 0 && scale > 0) return Math.round((level * 100f) / scale);
            }
        } catch (Exception ignored) {}
        return -1;
    }

    private String readStream(InputStream is) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }

    private void registerMediaObserver() {
        try {
            observerHandler = new Handler(Looper.getMainLooper());
            pendingNotifyTask = () -> {
                long now = System.currentTimeMillis();
                try {
                    SharedPreferences sp = getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE);
                    sp.edit().putLong("pending_album_sync", now).apply();
                } catch (Exception ignored) {}
                AlbumSyncPlugin.emitAlbumChanged(now);
            };
            mediaObserver = new ContentObserver(observerHandler) {
                @Override
                public void onChange(boolean selfChange) {
                    onChange(selfChange, null);
                }

                @Override
                public void onChange(boolean selfChange, Uri uri) {
                    if (observerHandler != null && pendingNotifyTask != null) {
                        observerHandler.removeCallbacks(pendingNotifyTask);
                        observerHandler.postDelayed(pendingNotifyTask, 2500L);
                    }
                }
            };
            getContentResolver().registerContentObserver(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    true,
                    mediaObserver
            );
        } catch (Exception ignored) {}
    }

    @Override
    public void onDestroy() {
        try {
            hideFloatingCallView();
            if (hbExecutor != null) {
                hbExecutor.shutdownNow();
            }
            if (observerHandler != null && pendingNotifyTask != null) {
                observerHandler.removeCallbacks(pendingNotifyTask);
            }
            if (mediaObserver != null) {
                getContentResolver().unregisterContentObserver(mediaObserver);
            }
        } catch (Exception ignored) {}
        super.onDestroy();
    }

    private void showFloatingCallView(String name, String status, long startMs) {
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(this)) return;
        overlayCallName = (name != null && !name.isEmpty()) ? name : "梦觉";
        overlayCallStatus = (status != null && !status.isEmpty()) ? status : "通话中";
        overlayCallStartMs = startMs > 0 ? startMs : System.currentTimeMillis();

        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                if (windowManager == null) {
                    windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
                }
                if (windowManager == null) return;

                if (callOverlayView == null) {
                    float density = getResources().getDisplayMetrics().density;
                    int padH = Math.round(14 * density);
                    int padV = Math.round(9 * density);

                    LinearLayout pill = new LinearLayout(this);
                    pill.setOrientation(LinearLayout.HORIZONTAL);
                    pill.setGravity(Gravity.CENTER_VERTICAL);
                    pill.setPadding(padH, padV, padH, padV);

                    GradientDrawable bg = new GradientDrawable();
                    bg.setColor(Color.parseColor("#18181B"));
                    bg.setCornerRadius(24 * density);
                    bg.setStroke(Math.max(2, Math.round(1.5f * density)), Color.parseColor("#10B981"));
                    pill.setBackground(bg);
                    if (Build.VERSION.SDK_INT >= 21) {
                        pill.setElevation(10 * density);
                    }

                    TextView tv = new TextView(this);
                    tv.setTextColor(Color.WHITE);
                    tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
                    tv.setSingleLine(true);
                    pill.addView(tv);
                    callOverlayText = tv;
                    callOverlayView = pill;

                    int type = Build.VERSION.SDK_INT >= 26
                            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                            : WindowManager.LayoutParams.TYPE_PHONE;
                    final WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                            WindowManager.LayoutParams.WRAP_CONTENT,
                            WindowManager.LayoutParams.WRAP_CONTENT,
                            type,
                            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                            PixelFormat.TRANSLUCENT
                    );
                    lp.gravity = Gravity.TOP | Gravity.END;
                    lp.x = Math.round(14 * density);
                    lp.y = Math.round(96 * density);

                    pill.setOnTouchListener(new View.OnTouchListener() {
                        private int initX, initY;
                        private float touchX, touchY;
                        private boolean moved = false;

                        @Override
                        public boolean onTouch(View v, MotionEvent ev) {
                            switch (ev.getActionMasked()) {
                                case MotionEvent.ACTION_DOWN:
                                    initX = lp.x;
                                    initY = lp.y;
                                    touchX = ev.getRawX();
                                    touchY = ev.getRawY();
                                    moved = false;
                                    return true;
                                case MotionEvent.ACTION_MOVE:
                                    float dx = ev.getRawX() - touchX;
                                    float dy = ev.getRawY() - touchY;
                                    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
                                    lp.x = Math.max(0, initX - Math.round(dx));
                                    lp.y = Math.max(0, initY + Math.round(dy));
                                    try { windowManager.updateViewLayout(callOverlayView, lp); } catch (Exception ignored) {}
                                    return true;
                                case MotionEvent.ACTION_UP:
                                    if (!moved) {
                                        try {
                                            Intent launch = new Intent(KeepAliveService.this, MainActivity.class);
                                            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                                            startActivity(launch);
                                        } catch (Exception ignored) {}
                                    }
                                    return true;
                            }
                            return false;
                        }
                    });

                    windowManager.addView(callOverlayView, lp);
                }

                if (overlayTimerHandler == null) {
                    overlayTimerHandler = new Handler(Looper.getMainLooper());
                }
                if (overlayTimerTask != null) {
                    overlayTimerHandler.removeCallbacks(overlayTimerTask);
                }
                overlayTimerTask = new Runnable() {
                    @Override
                    public void run() {
                        if (callOverlayText == null) return;
                        long sec = Math.max(0L, (System.currentTimeMillis() - overlayCallStartMs) / 1000L);
                        long mm = sec / 60L;
                        long ss = sec % 60L;
                        String tStr = String.format("%02d:%02d", mm, ss);
                        callOverlayText.setText("📞 " + overlayCallName + " · " + overlayCallStatus + " " + tStr);
                        if (overlayTimerHandler != null) {
                            overlayTimerHandler.postDelayed(this, 1000L);
                        }
                    }
                };
                overlayTimerHandler.post(overlayTimerTask);
            } catch (Exception ignored) {}
        });
    }

    private void hideFloatingCallView() {
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                if (overlayTimerHandler != null && overlayTimerTask != null) {
                    overlayTimerHandler.removeCallbacks(overlayTimerTask);
                }
                if (callOverlayView != null && windowManager != null) {
                    windowManager.removeView(callOverlayView);
                }
            } catch (Exception ignored) {}
            callOverlayView = null;
            callOverlayText = null;
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String act = intent.getAction();
            if ("ACTION_SHOW_CALL_OVERLAY".equals(act)) {
                showFloatingCallView(
                        intent.getStringExtra("callName"),
                        intent.getStringExtra("callStatus"),
                        intent.getLongExtra("callStartMs", System.currentTimeMillis())
                );
            } else if ("ACTION_HIDE_CALL_OVERLAY".equals(act)) {
                hideFloatingCallView();
            }
        }
        SharedPreferences sp = getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE);
        if (!sp.getBoolean("enabled", true)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent pi = PendingIntent.getActivity(this, 0, launch, piFlags);

        Intent restore = new Intent(this, KeepAliveService.class);
        restore.setAction("RESTORE_KEEPALIVE");
        PendingIntent delPi = PendingIntent.getService(this, 1, restore, piFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        builder.setContentTitle("传讯正在后台运行")
                .setContentText("保持消息提醒与自动同步连接")
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setOngoing(true)
                .setDeleteIntent(delPi)
                .setContentIntent(pi);

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, builder.build());
        }
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm == null) return;
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    "后台保活服务",
                    NotificationManager.IMPORTANCE_LOW
            );
            ch.setDescription("保持传讯在任务栏存活，防止被系统清理");
            nm.createNotificationChannel(ch);

            NotificationChannel msgCh = new NotificationChannel(
                    "milk_msg_high",
                    "消息与来电提醒",
                    NotificationManager.IMPORTANCE_HIGH
            );
            msgCh.setDescription("收到新消息与语音来电时弹出横幅提醒");
            msgCh.enableVibration(true);
            msgCh.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(msgCh);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
`;
  fs.writeFileSync(path.join(javaPkgDir, 'KeepAliveService.java'), keepAliveJava, 'utf8');

  const bootReceiverJava = `package cn.starleave.milk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        SharedPreferences sp = context.getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE);
        if (!sp.getBoolean("enabled", true)) return;
        try {
            Intent svc = new Intent(context, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (Exception ignored) {}
    }
}
`;
  fs.writeFileSync(path.join(javaPkgDir, 'BootReceiver.java'), bootReceiverJava, 'utf8');
}

console.log(`[configure-android] Configured Android project: v${versionName} (${versionCode})`);
