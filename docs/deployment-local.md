# 本地开发部署

本地开发用于在电脑上同时启动 API、后台、手机控制器和 Web TV 调试端。真实电视播放仍以 Android TV APK 为准。

## 前置条件

```text
Node.js
pnpm 10.x
PostgreSQL
ffmpeg / ffprobe
Android Platform Tools / adb
```

默认数据库：

```bash
export DATABASE_URL=postgres://ktv:ktv@127.0.0.1:5432/home_ktv
```

## 环境变量

```bash
export DATABASE_URL=postgres://ktv:ktv@127.0.0.1:5432/home_ktv
export MEDIA_ROOT="$(pwd)/home-ktv-media"
export PUBLIC_BASE_URL=http://<电脑局域网IP>:4000
export CONTROLLER_BASE_URL=http://<电脑局域网IP>:5176
export MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/mnt/nas/KTV歌曲
```

查看本机 Wi-Fi IP：

```bash
ipconfig getifaddr en0
```

## 一键启动

```bash
pnpm install
pnpm db:migrate
pnpm dev:local start
```

常用命令：

```bash
pnpm dev:local restart
pnpm dev:local status
pnpm dev:local tail api
pnpm dev:local tail admin
pnpm dev:local tail controller
pnpm dev:local tail tv-web
pnpm dev:local stop
```

## 默认端口

```text
API             4000
Web TV debug    5173
Admin           5174
Controller      5176
```

实际 URL 以 `pnpm dev:local start` 输出为准。

## Android TV 本地验证

```bash
cd clients/android-tv
./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

启动：

```bash
adb shell am start -W \
  -n com.liuyue.homektv/.MainActivity \
  --es apiBaseUrl http://<电脑局域网IP>:4000 \
  --es room living-room \
  --es deviceName "Living Room TV"
```

## 基线验证

每次重新编译并启动 Web TV / Controller / API 后，先运行一次 smoke check，再让人手工测试：

```bash
pnpm deploy:smoke -- \
  --api-base-url http://<电脑局域网IP>:4000 \
  --controller-base-url http://<电脑局域网IP>:5176 \
  --tv-web-base-url http://<电脑局域网IP>:5173 \
  --room living-room
```

它会检查 CORS、Web TV 页面、控制端页面、TV bootstrap/heartbeat、控制端快照里的 `tvPresence.online`，以及歌曲推荐是否非空。

1. `http://<电脑局域网IP>:4000/health` 返回 JSON。
2. 后台 `Room` 页面能看到 TV 在线。
3. Android TV 空闲页显示二维码。
4. 手机扫码进入控制器，显示电视在线。
5. 搜索真实歌曲并点歌，Android TV 开始播放。
6. 切歌、顶歌、删除队列、音量调整和原唱/伴唱切换不需要刷新页面即可反映。
