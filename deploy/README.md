# 部署入口

`deploy/` 只保留可执行部署入口和环境变量模板。完整说明集中在 `docs/`，避免部署规则分散维护。

```text
deploy/
├── source/   # 源码部署脚本，当前私有测试服务器优先使用
├── docker/   # Docker Compose 部署脚本，稳定发布和备用路径
└── env/      # 环境变量模板
```

常用入口：

```bash
bash deploy/source/ktv.sh setup
bash deploy/source/ktv.sh deploy
bash deploy/source/ktv.sh doctor

bash deploy/docker/ktv.sh setup
bash deploy/docker/ktv.sh start
bash deploy/docker/ktv.sh doctor
```

文档：

- [部署总览](../docs/deployment.md)
- [Docker Compose 部署](../docs/deployment-docker.md)
- [源码部署](../docs/deployment-source.md)
- [lxc-dev Runbook](../docs/runbooks/deploy-lxc-dev.md)
