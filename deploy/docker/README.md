# Docker Compose 部署入口

Docker Compose 保留为稳定发布和备用路径。当前私有测试服务器的高频调试优先使用 [源码部署入口](../source/README.md)。

需要完整容器化部署时：

```bash
bash deploy/docker/ktv.sh setup
vim deploy/docker/.env
bash deploy/docker/ktv.sh start
bash deploy/docker/ktv.sh doctor
```

常用命令：

```bash
bash deploy/docker/ktv.sh restart
bash deploy/docker/ktv.sh status
bash deploy/docker/ktv.sh logs
bash deploy/docker/ktv.sh stop
```

真实曲库维护命令：

```bash
bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2
bash deploy/docker/ktv.sh cover-status
bash deploy/docker/ktv.sh fetch-covers -- --limit 300
bash deploy/docker/ktv.sh cover-coverage -- --limit 100
docker compose -f deploy/docker/compose.yml --env-file deploy/docker/.env exec -T api \
  python3 /app/scripts/tools/run_style_tagging_llm_batch.py run --max-existing-tags 1 --batch-size 30 --output /data/home-ktv-media/tagging/llm-style-tags.jsonl
docker compose -f deploy/docker/compose.yml --env-file deploy/docker/.env exec -T api \
  python3 /app/scripts/tools/run_style_tagging_llm_batch.py import --output /data/home-ktv-media/tagging/llm-style-tags.jsonl --dry-run
docker compose -f deploy/docker/compose.yml --env-file deploy/docker/.env exec -T api \
  python3 /app/scripts/tools/run_style_tagging_llm_batch.py import --output /data/home-ktv-media/tagging/llm-style-tags.jsonl --apply
```

风格标签现在只走 `scripts/tools/run_style_tagging_llm_batch.py`，不再保留旧的 Docker 独立任务入口或 JSONL wrapper。run 阶段只追加 JSONL 和 state 文件，全部完成后才统一 import 写库；整批失败时不写入数据库，由外层脚本等待后重试。

完整配置、NAS 路径映射、公网入口和验证步骤见 [../../docs/deployment-docker.md](../../docs/deployment-docker.md)。歌曲封面拉取流程见 [../../docs/runbooks/song-cover-fetching.md](../../docs/runbooks/song-cover-fetching.md)。从旧曲库桥接结构升级到 NAS/online 曲库模型时，先按 [../../docs/runbooks/nas-online-catalog-migration.md](../../docs/runbooks/nas-online-catalog-migration.md) 做备份、迁移和回滚准备。
