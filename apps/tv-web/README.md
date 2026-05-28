# HomeKTV Web TV Player

`apps/tv-web` 是 Web 版 TV 播放端，当前主要用于浏览器调试和历史兼容。正式电视播放以 [Android TV](../../clients/android-tv/README.md) 为准。

## 职责

- 在浏览器中模拟 TV 播放端。
- 验证房间 snapshot、二维码配对和基础播放链路。
- 辅助 UI/视觉检查。

## 技术栈

```text
Vite
React
TypeScript
HTML5 media
```

## 环境变量

```bash
VITE_API_BASE_URL=http://<LAN_IP>:4000
```

## 常用命令

从项目根目录运行：

```bash
pnpm -F @home-ktv/tv-web dev
pnpm -F @home-ktv/tv-web typecheck
```

推荐统一启动：

```bash
pnpm dev:local start
```

默认访问地址：

```text
http://<LAN_IP>:5173/?apiBaseUrl=http://<LAN_IP>:4000&roomSlug=living-room&deviceName=Living%20Room%20TV
```

## 与 Android TV 的区别

Web TV 端依赖浏览器媒体能力，真实 KTV MV 的 mkv/mpg、复杂音轨和电视播放体验不以它为准。Android TV 端使用 libVLC，是真实播放验证的主路径。
