# 部署说明

本文档说明 HomeKTV 的本地部署方式。当前推荐使用电脑作为后端服务端，Android TV、手机控制器和后台通过局域网访问电脑。

## 前置条件

```text
Node.js
pnpm 10.x
PostgreSQL
Android Platform Tools / adb
Android Studio 或真实 Android TV
ffmpeg / ffprobe
```

PostgreSQL 当前默认连接：

```bash
DATABASE_URL=postgres://ktv:ktv@127.0.0.1:5432/home_ktv
```

## 本地环境变量

建议在当前 shell 中设置：

```bash
export DATABASE_URL=postgres://ktv:ktv@127.0.0.1:5432/home_ktv
export MEDIA_ROOT=/Users/shaolongfei/OtherProjects/home-ktv-system/home-ktv-media
export PUBLIC_BASE_URL=http://192.168.5.64:4000
export CONTROLLER_BASE_URL=http://192.168.5.64:5176
export MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/mnt/nas/KTV歌曲
```

`PUBLIC_BASE_URL` 和 `CONTROLLER_BASE_URL` 必须使用手机和 TV 都能访问的局域网 IP。不要在二维码或 TV 配置里使用 `localhost`。

如果本机 IP 变化，可以通过以下命令查看：

```bash
ipconfig getifaddr en0
```

## 数据库迁移

```bash
pnpm db:migrate
```

如果迁移失败，先确认 PostgreSQL 容器或本地服务已经启动，并且 `DATABASE_URL` 指向正确数据库。

## 一键本地部署

启动全部 Web/后端服务：

```bash
pnpm dev:local start
```

重启：

```bash
pnpm dev:local restart
```

查看状态：

```bash
pnpm dev:local status
```

停止：

```bash
pnpm dev:local stop
```

查看日志：

```bash
pnpm dev:local tail api
pnpm dev:local tail admin
pnpm dev:local tail mobile-controller
pnpm dev:local tail tv-player
```

日志目录：

```text
logs/dev/
```

## 默认访问地址

实际地址以 `pnpm dev:local start` 输出为准。常见地址：

```text
API health:        http://192.168.5.64:4000/health
Admin:             http://192.168.5.64:5174/
Mobile controller: http://192.168.5.64:5176/controller?room=living-room
Web TV debug:      http://192.168.5.64:5173/
```

## Android TV 部署

构建 APK：

```bash
cd HomeKTV
./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon
cd ..
```

安装到真实电视：

```bash
adb connect <TV_IP>:5555
adb install -r HomeKTV/app/build/outputs/apk/debug/app-debug.apk
```

启动 TV 端：

```bash
adb shell am start -W \
  -n com.liuyue.homektv/.MainActivity \
  --es apiBaseUrl http://192.168.5.64:4000 \
  --es room living-room \
  --es deviceName "Living Room TV"
```

如果电视使用 Android 无线调试配对：

```bash
adb pair <TV_IP>:<PAIR_PORT>
adb connect <TV_IP>:<CONNECT_PORT>
```

## 真实曲库与 NAS

数据库中的真实 KTV 索引通常保存 NAS 原始路径，例如：

```text
/mnt/nas/KTV歌曲/...
```

后端必须能读取这些路径，或者通过 `MEDIA_PATH_MAPPINGS` 映射到当前机器实际挂载路径。

生成的 web-compatible 文件默认写入：

```text
home-ktv-media/generated/ktv-index/
```

这些生成文件是运行时产物，不提交到 git。

## 验证清单

1. `http://192.168.5.64:4000/health` 返回 JSON。
2. 后台 `Room` 页面能看到 TV 在线。
3. TV 空闲页显示二维码。
4. 手机扫码进入控制器。
5. 手机搜索歌曲并点歌。
6. TV 开始播放。
7. 切歌可用。
8. 原唱/伴唱切换后，TV 左下角模式和音轨编号变化。

## 常见问题

### 手机或 TV 访问不到 API

确认电脑、手机、电视在同一个局域网，并且 `PUBLIC_BASE_URL` 是电脑局域网 IP。

### TV 在线但手机显示电视离线

检查控制器请求的 API 地址是否仍是 `localhost`。二维码应该来自 `CONTROLLER_BASE_URL`，并指向局域网 IP。

### 媒体返回 404 或不可读

检查 `assets.file_path` 或 `ktv_song_assets.file_path` 指向的文件是否存在。NAS 路径不可读时，需要挂载 NAS 或配置 `MEDIA_PATH_MAPPINGS`。

### 播放有声音问题

优先在真实电视上验证。Android 模拟器的音频输出可能有杂音，不适合作为最终音质判断。

### 热门歌曲榜单失败

查看 [packages/hot-songs/README.md](../packages/hot-songs/README.md)，重点检查 `source-report.json`、代理和 Cookie。
