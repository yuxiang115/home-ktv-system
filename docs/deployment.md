# 部署说明

HomeKTV 支持三种运行方式：

```text
本地开发      pnpm dev:local start
Docker 部署   bash deploy/docker/ktv.sh start
源码部署      bash deploy/source/ktv.sh start
```

服务器部署只包含后端 API、后台 Admin、手机 Controller 和 PostgreSQL。Android TV 是正式 TV 客户端，需要单独构建 APK 并安装到电视。

## 文档入口

- [本地开发部署](deployment-local.md)
- [Docker Compose 部署](deployment-docker.md)
- [源码部署](deployment-source.md)
- [项目结构](project-structure.md)
- [Android TV](../clients/android-tv/README.md)

## 推荐路径

本地开发使用：

```bash
pnpm install
pnpm db:migrate
pnpm dev:local start
```

服务器优先使用 Docker Compose：

```bash
bash deploy/docker/ktv.sh setup
bash deploy/docker/ktv.sh start
bash deploy/docker/ktv.sh status
```

如果服务器已经有 Node.js、pnpm 和 PostgreSQL，也可以使用源码部署：

```bash
bash deploy/source/ktv.sh setup
bash deploy/source/ktv.sh start
bash deploy/source/ktv.sh status
```

## 核心配置

`PUBLIC_BASE_URL` 和 `CONTROLLER_BASE_URL` 必须是手机与 Android TV 都能访问的局域网 IP 或域名，不能使用 `localhost`。

真实 NAS 曲库需要确保后端能读取数据库中的文件路径。路径不一致时，通过 `MEDIA_PATH_MAPPINGS` 或 `DOCKER_MEDIA_PATH_MAPPINGS` 映射。

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

Android TV 启动时传入：

```bash
adb shell am start -W \
  -n com.liuyue.homektv/.MainActivity \
  --es apiBaseUrl http://<server-ip>:4000 \
  --es room living-room \
  --es deviceName "Living Room TV"
```
