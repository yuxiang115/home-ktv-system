# 服务器源码部署切换设计

最后更新：2026-05-29。

## 目标

把当前私有测试服务器的默认部署方式从 Docker Compose 切换为源码部署，减少高频 UI/API 调试时的镜像构建成本，并保留 Docker 作为数据库或稳定发布备用方案。

## 推荐方案

采用“源码应用 + 固定 PostgreSQL”的部署方式：

- API、Admin、Controller、Web TV 都在服务器源码目录中构建并以 Node/Vite preview 进程运行。
- PostgreSQL 继续使用服务器现有数据库服务；它可以是 Docker 中的 PostgreSQL，也可以是宿主机 PostgreSQL，只要 `DATABASE_URL` 对源码进程可达。
- NAS 路径按服务器真实路径直连，源码部署使用 `MEDIA_PATH_MAPPINGS`。
- 保留 `deploy/docker`，但文档中降级为稳定发布和灾备路径。

## 部署流

新增源码部署一键命令：

```bash
bash deploy/source/ktv.sh deploy
```

它按顺序执行：

1. `git pull --ff-only`
2. `pnpm install --frozen-lockfile`
3. `pnpm build`
4. `pnpm db:migrate`
5. 停止并重启源码进程
6. `deploy-doctor --mode source`
7. `web-deploy-smoke`

如果只想跑部署后公开入口检查，可单独执行：

```bash
bash deploy/source/ktv.sh smoke
```

## 数据库策略

源码部署不负责启动或重建 PostgreSQL。服务器上只需要保证 `.env` 的 `DATABASE_URL` 指向可用数据库。

如果当前数据库仍由旧 Docker Compose 提供，可以临时只保留 PostgreSQL 容器，停止旧 API/Admin/Controller/Web TV 容器，避免端口冲突。

## 风险

- 源码进程由 PID 文件管理，不如 systemd 完整。当前适合高频测试；后续稳定后可补 systemd service。
- `deploy` 会自动跑迁移。遇到高风险迁移前仍要确认备份。
- `smoke` 会注册一次临时 Web TV 和控制端 session，这是可接受的测试运行态。
