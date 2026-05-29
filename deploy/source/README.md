# 源码部署入口

源码部署是当前私有测试服务器的推荐部署方式，适合服务器直接拉取 Git 仓库后运行 Node.js/Vite 进程，调试 UI 和 API 时不需要反复构建镜像。

它不负责启动 PostgreSQL，也不启动 Android TV。PostgreSQL 只需要通过 `deploy/source/.env` 里的 `DATABASE_URL` 可访问；电视端需要单独安装 `clients/android-tv` 生成的 APK。

第一次部署：

```bash
bash deploy/source/ktv.sh setup
vim deploy/source/.env
bash deploy/source/ktv.sh deploy
```

`setup` 只创建 `.env` 和运行目录。`deploy` 会拉取最新代码、安装依赖、构建、迁移、重启服务，并自动执行 doctor 和公开入口 smoke。

常用命令：

```bash
bash deploy/source/ktv.sh deploy
bash deploy/source/ktv.sh start
bash deploy/source/ktv.sh restart
bash deploy/source/ktv.sh status
bash deploy/source/ktv.sh doctor
bash deploy/source/ktv.sh smoke
bash deploy/source/ktv.sh logs
bash deploy/source/ktv.sh stop
```

完整配置、运行端口、日志目录和 NAS 路径映射见 [../../docs/deployment-source.md](../../docs/deployment-source.md)。
