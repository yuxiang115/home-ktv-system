# Docker 部署

服务器拉取代码后：

```bash
bash deploy/docker/ktv.sh setup
vim deploy/docker/.env
bash deploy/docker/ktv.sh start
```

常用命令：

```bash
bash deploy/docker/ktv.sh restart
bash deploy/docker/ktv.sh status
bash deploy/docker/ktv.sh doctor
bash deploy/docker/ktv.sh logs
bash deploy/docker/ktv.sh logs api
bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2
bash deploy/docker/ktv.sh tag-styles -- --limit 300 --dry-run
bash deploy/docker/ktv.sh stop
```

`doctor` 会对刚重启后常见的 502/503/504 等公网反代临时状态做短重试，避免 `restart && doctor` 因 API 刚恢复时序产生误报。500 等后端错误仍会直接标记失败。

`deploy/docker/.env` 从 `deploy/env/server.env.example` 生成。`PUBLIC_BASE_URL` 和 `CONTROLLER_BASE_URL` 必须是手机、Web TV 和 Android TV 可访问的服务器地址。
公网分域名部署时也应设置 `ADMIN_BASE_URL` 和 `TV_WEB_BASE_URL`，这样自检脚本能准确验证 CORS 与入口地址。

当前产品边界：

- Admin 不加登录鉴权，公网暴露范围由部署网络、Caddy 和域名策略控制。
- 媒体流不做 token 或签名 URL 访问控制。
- Android TV APK 不通过服务端自动更新，采用本地打包后覆盖安装。

真实 NAS 曲库需要重点检查：

```bash
KTV_NAS_HOST_PATH=/mnt/nas/KTV歌曲
DOCKER_MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/nas/KTV歌曲
```

真实曲库音轨元数据探测先跑小样本：

```bash
bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2
```

确认耗时和失败率可接受后，再全量高并发回填：

```bash
bash deploy/docker/ktv.sh probe-index -- --concurrency 8 --retry-failed
```

探测只保存 `mediaInfoSummary`、`mediaInfoProvenance` 和失败摘要，不保存完整 ffprobe raw JSON。探测失败不会影响搜索、点歌或播放。

真实曲库风格标签先跑网易云 API 小样本：

```bash
bash deploy/docker/ktv.sh tag-styles -- --limit 300 --dry-run
bash deploy/docker/ktv.sh tag-styles -- --limit 300 --apply
```

`tag-styles` 默认只处理缺失 `netease-playlist-v1` 标签的歌曲；如需重跑全部样本，加 `--all`。

网易云样本后，如果存在空标签或只有 1 个标签的歌曲，可以启用大模型兜底：

```bash
bash deploy/docker/ktv.sh tag-styles -- \
  --source llm \
  --llm-base-url http://192.168.5.103:8317 \
  --llm-api-key "$LLM_API_KEY" \
  --llm-model "$LLM_MODEL" \
  --limit 100 \
  --apply
```

`--source llm` 默认只处理已经有 `netease-playlist-v1` 状态、且当前聚合标签数 `<= 1` 的歌曲，并写入独立来源 `llm-style-v1`。如需调整阈值，使用 `--max-existing-tags <n>`；如需改成其它主来源，使用 `--fallback-from-source <source>`。

全量曲库标签长任务使用：

```bash
nohup pnpm ktv:tags:full >> logs/tagging/full-library.log 2>&1 &
```

这个脚本先分批跑网易云主标签，直到没有未处理歌曲；然后再用 LLM 每批 30 首补低覆盖歌曲。

容器内 API 会使用 `DOCKER_DATABASE_URL` 连接 Compose 内的 PostgreSQL。源码部署才使用 `DATABASE_URL`。

当前 Compose 会启动：

```text
api         4000
admin       5174
controller  5176
tv-web      5173
postgres    5432
```

lxc-dev 测试环境的公网入口：

```text
https://ktv-api.shaolongfei.com/health
https://ktv-admin.shaolongfei.com/
控制器需通过 Web TV 二维码或 pairing.controllerUrl 进入，不能用不带 token 的裸地址完成首次配对
https://ktv-tv.shaolongfei.com/?apiBaseUrl=https://ktv-api.shaolongfei.com&roomSlug=living-room&deviceName=Web%20TV
```

完整更新流程以 `docs/runbooks/deploy-lxc-dev.md` 为准。部署后必须跑公开入口 smoke，并确认真实曲库 discovery 非空后再交给手机端/TV 端测试。
