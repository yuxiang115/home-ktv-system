# HomeKTV Android TV

`HomeKTV` 是 HomeKTV 的正式 TV 播放端。它是 Android TV 项目，使用 Kotlin 和 libVLC 播放真实 KTV MV。

## 职责

- 向后端注册 TV 播放器并保持心跳。
- 空闲时展示二维码，供手机扫码进入控制器。
- 播放当前队列歌曲，支持 HTTP Range 媒体流。
- 切换原唱/伴唱音轨。
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
HomeKTV/app/src/main/java/com/liuyue/homektv/
HomeKTV/app/src/main/res/
HomeKTV/app/src/test/
```

## 构建

从项目根目录运行：

```bash
cd HomeKTV
./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon
```

APK 输出：

```text
HomeKTV/app/build/outputs/apk/debug/app-debug.apk
```

## 安装到电视

电视需要开启开发者模式和 ADB 调试。

```bash
adb connect <TV_IP>:5555
adb install -r HomeKTV/app/build/outputs/apk/debug/app-debug.apk
```

启动并指定后端：

```bash
adb shell am start -W \
  -n com.liuyue.homektv/.MainActivity \
  --es apiBaseUrl http://192.168.5.64:4000 \
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

## 相关文档

- [部署说明](../docs/deployment.md)
- [Android TV libVLC 调研](../docs/plans/2026-05-21-android-tv-libvlc-spike.md)
- [Android TV 真机客户端设计](../docs/plans/2026-05-21-android-tv-real-client-design.md)
