# 源码部署入口

源码部署适合服务器直接拉取 Git 仓库后运行 Node.js 进程。它不启动 Android TV，电视端需要单独安装 `clients/android-tv` 生成的 APK。

第一次部署：

```bash
bash deploy/source/ktv.sh setup
vim deploy/source/.env
bash deploy/source/ktv.sh build
bash deploy/source/ktv.sh restart
```

常用命令：

```bash
bash deploy/source/ktv.sh start
bash deploy/source/ktv.sh restart
bash deploy/source/ktv.sh status
bash deploy/source/ktv.sh doctor
bash deploy/source/ktv.sh logs
bash deploy/source/ktv.sh stop
```

完整配置、运行端口、日志目录和 NAS 路径映射见 [../../docs/deployment-source.md](../../docs/deployment-source.md)。
