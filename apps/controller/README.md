# HomeKTV Controller

`apps/controller` 是手机扫码后的点歌控制器。

## 职责

- 通过 TV 二维码进入指定房间。
- 搜索真实 KTV 曲库。
- 点歌、顶歌、切歌。
- 切换原唱/伴唱。
- 调整 TV 播放音量。
- 显示 TV 在线状态、当前播放和队列。
- 为只有一条音轨的真实曲库资源显示“单音轨歌曲源”标签。

## 技术栈

```text
Vite
React
TypeScript
CSS
```

## 环境变量

```bash
VITE_API_BASE_URL=http://<LAN_IP>:4000
```

本地一键部署脚本会自动注入该变量。

## 常用命令

从项目根目录运行：

```bash
pnpm -F @home-ktv/controller dev
pnpm -F @home-ktv/controller test
pnpm -F @home-ktv/controller typecheck
```

推荐本地启动：

```bash
pnpm dev:local start
```

默认访问地址：

```text
http://<LAN_IP>:5176/controller
```

实际二维码 URL 以后端快照返回的 `pairing.qrPayload` 为准。

## 注意事项

- 手机必须能访问电脑的局域网 IP。
- 如果 TV 页面显示在线但手机显示离线，优先检查 `PUBLIC_BASE_URL`、`CONTROLLER_BASE_URL` 和 API 日志。
- 控制器不直接访问媒体文件，只通过后端命令改变队列和播放目标。
- “单音轨歌曲源”只是资源能力提示，不阻止点歌播放。
