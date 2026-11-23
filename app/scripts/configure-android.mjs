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
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
            keyAlias System.getenv("ANDROID_KEY_ALIAS") ?: ""
            keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: ""
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
  '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />'
];
for (const perm of requiredPerms) {
  const nameMatch = /android:name="([^"]+)"/.exec(perm);
  if (nameMatch && !manifest.includes(nameMatch[1])) {
    manifest = manifest.replace('</manifest>', `    ${perm}\n</manifest>`);
  }
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
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.InputStream;
import java.security.MessageDigest;
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
            strings = { Manifest.permission.READ_EXTERNAL_STORAGE }
        ),
        @Permission(
            alias = "photos13",
            strings = { Manifest.permission.READ_MEDIA_IMAGES }
        )
    }
)
public class AlbumSyncPlugin extends Plugin {

    private String activeAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "photos13" : "photos";
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState(activeAlias()) == PermissionState.GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        String alias = activeAlias();
        if (getPermissionState(alias) == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias(alias, call, "permCallback");
    }

    @PermissionCallback
    private void permCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState(activeAlias()) == PermissionState.GRANTED);
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
    public void listAlbums(PluginCall call) {
        if (getPermissionState(activeAlias()) != PermissionState.GRANTED) {
            call.reject("未授予相册权限");
            return;
        }
        getBridge().execute(() -> {
            Map<String, Integer> counts = new HashMap<>();
            String[] proj = { MediaStore.Images.Media.BUCKET_DISPLAY_NAME };
            try (Cursor c = getContext().getContentResolver().query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, proj, null, null, null)) {
                if (c != null) {
                    int idx = c.getColumnIndex(MediaStore.Images.Media.BUCKET_DISPLAY_NAME);
                    while (c.moveToNext()) {
                        String b = idx >= 0 ? c.getString(idx) : null;
                        if (b == null || b.trim().isEmpty()) b = "Other";
                        counts.put(b, (counts.containsKey(b) ? counts.get(b) : 0) + 1);
                    }
                }
            } catch (Exception e) {
                call.reject("扫描相册目录失败: " + e.getMessage());
                return;
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
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void listPhotos(PluginCall call) {
        if (getPermissionState(activeAlias()) != PermissionState.GRANTED) {
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
            JSObject ret = new JSObject();
            ret.put("photos", items);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void getPhotoSha256(PluginCall call) {
        long id = call.getLong("id", -1L);
        if (id < 0) {
            call.reject("无效的照片 ID");
            return;
        }
        getBridge().execute(() -> {
            Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
            ContentResolver cr = getContext().getContentResolver();
            try (InputStream is = cr.openInputStream(uri)) {
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
        long offset = call.getLong("offset", 0L);
        int length = Math.max(1, Math.min(2 * 1024 * 1024, call.getInt("length", 1024 * 1024)));
        if (id < 0) {
            call.reject("无效的照片 ID");
            return;
        }
        getBridge().execute(() -> {
            Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
            ContentResolver cr = getContext().getContentResolver();
            try (InputStream is = cr.openInputStream(uri)) {
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
}
`;
  fs.writeFileSync(path.join(javaPkgDir, 'AlbumSyncPlugin.java'), pluginJava, 'utf8');

  const mainActPath = path.join(javaPkgDir, 'MainActivity.java');
  if (fs.existsSync(mainActPath)) {
    let mainAct = fs.readFileSync(mainActPath, 'utf8');
    if (!mainAct.includes('AlbumSyncPlugin')) {
      if (!mainAct.includes('import android.os.Bundle;')) {
        mainAct = mainAct.replace(
          'import com.getcapacitor.BridgeActivity;',
          'import android.os.Bundle;\nimport com.getcapacitor.BridgeActivity;'
        );
      }
      if (!mainAct.includes('public void onCreate(')) {
        mainAct = mainAct.replace(
          /public class MainActivity extends BridgeActivity\s*\{/,
          `public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        registerPlugin(AlbumSyncPlugin.class);\n        super.onCreate(savedInstanceState);\n    }`
        );
      } else {
        mainAct = mainAct.replace(
          'super.onCreate(savedInstanceState);',
          'registerPlugin(AlbumSyncPlugin.class);\n        super.onCreate(savedInstanceState);'
        );
      }
      fs.writeFileSync(mainActPath, mainAct, 'utf8');
    }
  }
}

console.log(`[configure-android] Configured Android project: v${versionName} (${versionCode})`);
