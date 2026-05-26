# HomeKTV Admin

`apps/admin` 是 HomeKTV 的后台管理界面。它面向系统维护者，用于管理房间、曲库、导入结果、在线补歌、诊断和播放状态。

## 职责

- 查看 TV、控制器和房间在线状态。
- 管理曲库歌曲、资产、导入候选和真实 KTV 索引同步结果。
- 查看队列、当前播放、在线补歌任务和诊断信息。
- 作为本地调试和运维控制台。

## 技术栈

```text
Vite
React
TypeScript
CSS
```

## 环境变量

```bash
VITE_API_BASE_URL=http://192.168.5.64:4000
```

本地一键部署脚本会自动注入该变量。

## 常用命令

从项目根目录运行：

```bash
pnpm -F @home-ktv/admin dev
pnpm -F @home-ktv/admin test
pnpm -F @home-ktv/admin typecheck
```

推荐本地启动方式：

```bash
pnpm dev:local start
```

默认访问地址：

```text
http://192.168.5.64:5174/
```

实际 IP 以 `pnpm dev:local start` 输出为准。

## 与后端关系

Admin 不直接访问数据库，只通过 `apps/api` 提供的 HTTP API 工作。后台和 API 一起组成“后端与后台”产品域。
