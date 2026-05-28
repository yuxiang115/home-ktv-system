# Docker Compose 部署入口

服务器拉取代码后：

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
bash deploy/docker/ktv.sh cover-coverage -- --limit 100
bash deploy/docker/ktv.sh fetch-covers -- --limit 300
```

完整配置、NAS 路径映射、公网入口和验证步骤见 [../../docs/deployment-docker.md](../../docs/deployment-docker.md)。歌曲封面拉取流程见 [../../docs/runbooks/song-cover-fetching.md](../../docs/runbooks/song-cover-fetching.md)。
