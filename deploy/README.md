# 部署入口

服务器部署入口集中在 `deploy/`：

```text
deploy/
├── docker/   # Docker Compose 部署
├── source/   # 源码部署
└── env/      # 环境变量模板
```

Docker Compose：

```bash
bash deploy/docker/ktv.sh setup
bash deploy/docker/ktv.sh start
```

源码部署：

```bash
bash deploy/source/ktv.sh setup
bash deploy/source/ktv.sh start
```

完整说明见：

- [Docker 部署](../docs/deployment-docker.md)
- [源码部署](../docs/deployment-source.md)
