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
  '<uses-permission android:name="android.permission.WAKE_LOCK" />'
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
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;

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
        requestPermission(call);
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

    @PluginMethod
    public void getSystemStatus(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences sp = ctx.getSharedPreferences("milk_keepalive", Context.MODE_PRIVATE);
        JSObject ret = new JSObject();
        ret.put("media", hasMediaAccess());
        ret.put("notification", hasNotificationAccess());
        ret.put("batteryUnrestricted", isIgnoringBatteryOptimizations());
        ret.put("keepAliveService", sp.getBoolean("enabled", true));
        ret.put("manufacturer", Build.MANUFACTURER != null ? Build.MANUFACTURER : "");
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
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

        JSObject ret = new JSObject();
        ret.put("wifi", isWifi);
        ret.put("networkType", netType);
        ret.put("charging", charging);
        ret.put("batteryLevel", batteryLevel);
        call.resolve(ret);
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
        long sinceSec = call.getLong("sinceMs", 0L) / 1000L;
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
            String sel = sinceSec > 0 ? (MediaStore.Images.Media.DATE_MODIFIED + " >= ?") : null;
            String[] selArgs = sinceSec > 0 ? new String[]{ String.valueOf(sinceSec) } : null;
            String order = MediaStore.Images.Media.DATE_MODIFIED + " ASC, " + MediaStore.Images.Media._ID + " ASC";

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

                    while (c.moveToNext() && items.length() < limit) {
                        String bkt = bktIdx >= 0 ? c.getString(bktIdx) : null;
                        if (bkt == null || bkt.trim().isEmpty()) bkt = "Other";
                        if (!bucketSet.isEmpty() && !bucketSet.contains(bkt)) continue;

                        long size = sizeIdx >= 0 ? c.getLong(sizeIdx) : 0L;
                        if (size <= 0) continue;

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

    private InputStream openPhotoStream(long id, String filePath) throws Exception {
        if (filePath != null && !filePath.isEmpty()) {
            return new FileInputStream(new File(filePath));
        }
        Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
        return getContext().getContentResolver().openInputStream(uri);
    }

    @PluginMethod
    public void getPhotoSha256(PluginCall call) {
        long id = call.getLong("id", -1L);
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
        long id = call.getLong("id", -1L);
        String filePath = call.getString("path", "");
        long offset = call.getLong("offset", 0L);
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
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.database.ContentObserver;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.MediaStore;

public class KeepAliveService extends Service {
    private static final String CHANNEL_ID = "milk_keepalive_channel";
    private static final int NOTIF_ID = 10017;
    private Handler observerHandler;
    private ContentObserver mediaObserver;
    private Runnable pendingNotifyTask;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        registerMediaObserver();
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
            if (observerHandler != null && pendingNotifyTask != null) {
                observerHandler.removeCallbacks(pendingNotifyTask);
            }
            if (mediaObserver != null) {
                getContentResolver().unregisterContentObserver(mediaObserver);
            }
        } catch (Exception ignored) {}
        super.onDestroy();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
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
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    "后台保活服务",
                    NotificationManager.IMPORTANCE_LOW
            );
            ch.setDescription("保持传讯在任务栏存活，防止被系统清理");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
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
