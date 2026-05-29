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
bash deploy/docker/ktv.sh tag-styles -- --limit 300 --dry-run
bash deploy/docker/ktv.sh tag-styles-export -- --out /data/home-ktv-media/tagging/full/songs.jsonl
bash deploy/docker/ktv.sh tag-styles-jsonl -- --input /data/home-ktv-media/tagging/full/songs.jsonl --output /data/home-ktv-media/tagging/full/results.jsonl --source netease --concurrency 5
bash deploy/docker/ktv.sh tag-styles-job resume
bash deploy/docker/ktv.sh tag-styles-job status
bash deploy/docker/ktv.sh tag-styles-job logs
bash deploy/docker/ktv.sh tag-styles-job stats
bash deploy/docker/ktv.sh tag-styles-import -- --input /data/home-ktv-media/tagging/full/results.jsonl --dry-run
node scripts/tools/run-style-tagging-llm-batch.mjs --llm-max-existing-tags 0
bash deploy/docker/ktv.sh cover-coverage -- --limit 100
bash deploy/docker/ktv.sh fetch-covers -- --limit 300
```

`tag-styles-jsonl` 仍可用于短任务；全量长任务建议使用 `tag-styles-job`，它会启动独立 Docker 容器并把运行状态写到 `/opt/home-ktv-jobs/style-tagging`，主服务 `restart` 不会杀掉该任务。
`run-style-tagging-llm-batch.mjs` 用于 LLM 兜底补标签，一次请求处理一批歌曲；整批失败时不写入单曲失败状态，由外层脚本等待后重试。

完整配置、NAS 路径映射、公网入口和验证步骤见 [../../docs/deployment-docker.md](../../docs/deployment-docker.md)。歌曲封面拉取流程见 [../../docs/runbooks/song-cover-fetching.md](../../docs/runbooks/song-cover-fetching.md)。从旧曲库桥接结构升级到 NAS/online 曲库模型时，先按 [../../docs/runbooks/nas-online-catalog-migration.md](../../docs/runbooks/nas-online-catalog-migration.md) 做备份、迁移和回滚准备。
