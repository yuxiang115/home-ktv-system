# 部署说明

HomeKTV 支持三种运行方式：

```text
本地开发      pnpm dev:local start
源码部署      bash deploy/source/ktv.sh deploy
Docker 部署   bash deploy/docker/ktv.sh start
```

服务器部署包含后端 API、后台 Admin、手机 Controller、Web TV 调试端和 PostgreSQL。Android TV 是正式 TV 客户端，需要单独构建 APK 并安装到电视。

## 文档入口

- [本地开发部署](deployment-local.md)
- [Docker Compose 部署](deployment-docker.md)
- [源码部署](deployment-source.md)
- [lxc-dev 服务器 Runbook](runbooks/deploy-lxc-dev.md)
- [项目结构](project-structure.md)
- [Android TV](../clients/android-tv/README.md)

## 推荐路径

本地开发使用：

```bash
pnpm install
pnpm db:migrate
pnpm dev:local start
```

服务器优先使用源码部署：

```bash
bash deploy/source/ktv.sh setup
vim deploy/source/.env
bash deploy/source/ktv.sh deploy
bash deploy/source/ktv.sh status
```

当前私有测试服务器 `lxc-dev` 已有固定部署流程和公网入口，按 [lxc-dev 服务器 Runbook](runbooks/deploy-lxc-dev.md) 执行。不要用本地预览结果代替服务器部署验证。

Docker Compose 保留为稳定发布和备用路径。需要完整容器化运行 PostgreSQL、API 和前端静态站时使用：

```bash
bash deploy/docker/ktv.sh setup
bash deploy/docker/ktv.sh start
bash deploy/docker/ktv.sh status
bash deploy/docker/ktv.sh doctor
```

## 核心配置

`PUBLIC_BASE_URL`、`ADMIN_BASE_URL`、`CONTROLLER_BASE_URL` 和 `TV_WEB_BASE_URL` 必须是手机、Web TV 与 Android TV 都能访问的局域网 IP 或域名，不能使用 `localhost`。

真实 NAS 曲库需要确保后端能读取数据库中的文件路径。源码部署使用 `MEDIA_PATH_MAPPINGS`，Docker Compose 使用 `DOCKER_MEDIA_PATH_MAPPINGS`。

## 常见验证

```bash
curl http://<server-ip>:4000/health
```

后台：

```text
http://<server-ip>:5174/
```

手机控制器：

```text
http://<server-ip>:5176/controller?room=living-room
```

控制器首次进入需要从电视端二维码打开，或使用 Admin 返回的 `pairing.controllerUrl`。没有历史 cookie 时，裸控制器地址只适合验证静态页面是否可访问，不能完成配对。

Web TV：

```text
http://<server-ip>:5173/?apiBaseUrl=http://<server-ip>:4000&roomSlug=living-room&deviceName=Web%20TV
```

Android TV 启动时传入：

```bash
adb shell am start -W \
  -n com.liuyue.homektv/.MainActivity \
  --es apiBaseUrl http://<server-ip>:4000 \
  --es room living-room \
  --es deviceName "Living Room TV"
```
