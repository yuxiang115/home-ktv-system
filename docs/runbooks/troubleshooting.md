# 故障排查 Runbook

## 先跑自检

服务器上优先执行：

```bash
cd /opt/home-ktv-system
bash deploy/source/ktv.sh status
bash deploy/source/ktv.sh doctor
```

`doctor` 会同时输出 API、Admin、Controller、Web TV、NAS 路径和 KTV 索引诊断的原始指标。索引诊断中的 `active`、`missing`、`songs`、`latest` 只用于排查事实，不替代人工判断。

Docker Compose 备用部署：

```bash
bash deploy/docker/ktv.sh doctor
```

## TV 显示离线

检查顺序：

1. API 是否健康：`curl https://ktv-api.shaolongfei.com/health`
2. Admin Room 页面是否能看到 TV 在线。
3. TV 端是否使用正确 API 地址，不要用 `localhost`。
4. 查看 API 日志：`bash deploy/source/ktv.sh logs api`
5. 如果是 Web TV，确认 URL 中有 `apiBaseUrl=https://ktv-api.shaolongfei.com`。

## 手机控制器显示电视离线

检查顺序：

1. 手机打开的 Controller URL 是否来自 TV 二维码。
2. Controller 域名是否能访问 API 域名。
3. `CORS_ALLOWED_ORIGINS` 是否包含 Controller 和 Web TV 域名。
4. 重新刷新 TV 页面的二维码后再扫码。

## 搜索有结果但点歌失败

检查顺序：

1. Admin Songs 诊断中查看真实索引是否有结果。
2. 执行 `bash deploy/source/ktv.sh doctor` 看 NAS 路径是否可读。
3. 访问 API 日志，查找 `KTV_INDEX_FILE_UNREADABLE` 或媒体路径映射错误。
4. 检查 `MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/mnt/nas/KTV歌曲`。

## 队列为空但手机显示已点

检查顺序：

1. 刷新 Admin Room 页面，确认当前 sessionVersion 和队列。
2. 查看 API 日志里对应点歌请求是否返回 200。
3. 确认 TV 是否仍在线，断线时服务端可能只记录命令但 TV 未拉到快照。
4. 重启 TV 端，观察是否恢复当前房间快照。

## Web TV 首次点歌不自动播放

这是浏览器自动播放限制。Web TV 第一次播放有声音的视频时，需要点击一次电视页面授权。Android TV 不受这个限制。

## Android TV 原唱/伴唱切换失败

检查顺序：

1. 当前歌曲是否真的有两条可选音轨。
2. 屏幕左下角是否显示音轨数量和当前音轨。
3. API 里的 `selectedTrackRef` 是否存在。
4. 如果第二条音轨仍有人声，优先按资源缺陷处理，不按播放器 bug 处理。

## Web TV 能播但 Android TV 不能播

真实电视端以 Android TV + libVLC 为准。先记录 Android 日志里的当前 URL、assetId 和异常，再用同一 URL 在样本播放页或 VLC 桌面版验证。
