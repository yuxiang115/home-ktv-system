# HomeKTV Android TV

`clients/android-tv` 是 HomeKTV 的正式 TV 播放端。它是 Android TV 项目，使用 Kotlin 和 libVLC 播放真实 KTV MV。

Web TV 端保留为调试客户端；真实电视播放、真实 MV 解码和原唱/伴唱音轨切换以本项目为准。浏览器 autoplay 或浏览器音轨支持限制不作为 Android TV 产品体验的判断依据。

## 职责

- 向后端注册 TV 播放器并保持心跳。
- 空闲时展示二维码，供手机扫码进入控制器。
- 播放当前队列歌曲，支持 HTTP Range 媒体流。
- 切换原唱/伴唱音轨。
- 应用手机控制器下发的房间音量。
- 上报播放状态、失败、结束和切换结果。

## 技术栈

```text
Kotlin
Android TV
libVLC
Gradle
```

## 关键目录

```text
clients/android-tv/app/src/main/java/com/liuyue/homektv/
clients/android-tv/app/src/main/res/
clients/android-tv/app/src/test/
```

## 构建

从项目根目录运行：

```bash
cd clients/android-tv
./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon
```

APK 输出：

```text
clients/android-tv/app/build/outputs/apk/debug/app-debug.apk
```

## 安装到电视

电视需要开启开发者模式和 ADB 调试。

当前发布策略是手动打包 APK 后覆盖安装，不做应用内自动更新。

```bash
adb connect <TV_IP>:5555
adb install -r clients/android-tv/app/build/outputs/apk/debug/app-debug.apk
```

启动并指定后端：

```bash
adb shell am start -W \
  -n com.liuyue.homektv/.MainActivity \
  --es apiBaseUrl http://<LAN_IP>:4000 \
  --es room living-room \
  --es deviceName "Living Room TV"
```

`apiBaseUrl` 必须是电视能访问的电脑局域网地址。

## 播放规则

真实单文件 MV 使用双音轨模型：

```text
original     原唱
instrumental 伴唱/伴奏
```

后端给 TV 下发 `selectedTrackRef`，Android 端会按音轨顺序优先匹配 libVLC 的运行时音轨。左下角会显示当前模式和音轨编号。

当前播放同一时间只启用一条音轨。手机控制器上的音量是房间级单音量，会应用到当前正在播放的音轨。

## 基线验证

完整步骤见 [部署说明](../../docs/deployment.md) 的“真实 Android TV 基线验证”。每次修改 Android TV 播放、后端播放状态、手机控制器或部署脚本后，至少回归：

- 空闲页二维码。
- 手机扫码进入控制器。
- 搜索真实歌曲并点歌。
- Android TV 播放真实 MV。
- 切歌、顶歌、删除。
- 双音轨歌曲的原唱/伴唱切换。
- 房间音量控制。
- 手机控制器关闭后重新进入。

## 相关文档

- [部署说明](../../docs/deployment.md)
- [Android TV libVLC 调研](../../docs/plans/2026-05-21-android-tv-libvlc-spike.md)
- [Android TV 真机客户端设计](../../docs/plans/2026-05-21-android-tv-real-client-design.md)
