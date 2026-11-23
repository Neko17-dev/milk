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
  gradle = gradle.replace('buildTypes {', `${signingBlock}\n    buildTypes {`);
  gradle = gradle.replace(
    /release\s*\{/,
    'release {\n            signingConfig signingConfigs.release'
  );
}
fs.writeFileSync(gradlePath, gradle, 'utf8');

// 2. 注入 Android 权限到 AndroidManifest.xml
const manifestPath = path.join(ANDROID_APP_DIR, 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
const requiredPerms = [
  '<uses-permission android:name="android.permission.INTERNET" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  '<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />',
  '<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />'
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

console.log(`[configure-android] Configured Android project: v${versionName} (${versionCode})`);
