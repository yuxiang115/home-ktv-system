# 源码部署

源码部署适合服务器直接拉取 Git 仓库后运行 Node.js 进程。它不启动 Android TV，电视端需要单独安装 `clients/android-tv` 生成的 APK。

## 第一次部署

```bash
bash deploy/source/ktv.sh setup
vim deploy/source/.env
bash deploy/source/ktv.sh build
bash deploy/source/ktv.sh restart
```

`setup` 会安装依赖、构建 API/Admin/Controller，并执行数据库迁移。`deploy/source/.env` 从 `deploy/env/server.env.example` 生成。修改 `PUBLIC_BASE_URL` 后需要重新 `build`，因为 Admin/Controller 会在构建时写入 API 地址。

## 常用命令

```bash
bash deploy/source/ktv.sh start
bash deploy/source/ktv.sh restart
bash deploy/source/ktv.sh status
bash deploy/source/ktv.sh logs
bash deploy/source/ktv.sh logs api
bash deploy/source/ktv.sh stop
```

## 运行内容

源码部署只运行服务器侧服务：

```text
api         4000  后端 API、媒体网关、房间状态和队列
admin       5174  后台管理界面
controller  5176  手机扫码控制器
```

日志和 PID 默认写入：

```text
runtime/logs/
runtime/pids/
```

## 关键配置

`PUBLIC_BASE_URL` 和 `CONTROLLER_BASE_URL` 必须是手机和 Android TV 能访问的服务器局域网或域名地址。

真实 NAS 曲库需要确保后端进程能读到数据库索引中的文件路径。路径不一致时用 `MEDIA_PATH_MAPPINGS` 映射，例如：

```bash
MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/mnt/nas/KTV歌曲
```
