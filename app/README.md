# 传讯 Android App 构建与强制更新说明

本目录使用 **Capacitor** 将根目录的「传讯」网页封装为 Android 原生 APK，**无需重写前端代码**。

## 1. 一键云端编译 APK（推荐：GitHub Actions）

无需在本地安装 Android Studio：

1. 打开 GitHub 仓库 → **Actions** → 选择 **Build Android APK** → 点击 **Run workflow**；
2. 可填写版本号（如 `1.0.0`）和版本码（如 `1`，每次更新递增）；
3. 等待约 2～3 分钟，在运行结果的 **Artifacts** 里直接下载 `milk-v1.0.0.apk`；
4. 也可以直接推送 Tag（如 `git tag v1.0.1 && git push origin v1.0.1`），会自动构建并发布到 GitHub Releases。

*(可选：如需正式签名 Release APK，在 GitHub 仓库 Settings → Secrets 中配置 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`；未配置时默认产出可直接安装的签名调试包。)*

## 2. 发布强制更新 / 普通更新

将新 APK 放到服务器静态目录（例如 `/data/www/milk/download/milk-latest.apk`），然后修改根目录的 `version.json` 并 `git pull`：

```json
{
  "version": "1.0.1",
  "versionCode": 2,
  "minVersionCode": 2,
  "forceUpdate": true,
  "changelog": "1. 修复已知问题\n2. 优化备份同步速度",
  "downloadUrl": "https://milk.starleave.cn/download/milk-latest.apk"
}
```

- **强制更新**：把 `forceUpdate` 设为 `true`，或把 `minVersionCode` 提高到高于旧版的 `versionCode`——旧版 App 启动时会弹出**不可关闭的强制更新弹窗**，引导下载新 APK；
- **普通提醒更新**：`forceUpdate: false` 且 `minVersionCode <= 旧版 versionCode`，用户可点「稍后再说」或「立即更新」。
