# scripts/node-tools

部署链路仍在使用的 Node 脚本目录。这里不放临时调研脚本；能迁移到 Python 的普通工具优先放到 `scripts/tools/`。

| 脚本 | 用途 | 入口 |
| --- | --- | --- |
| `deploy-doctor.mjs` | 部署环境自检：env、CORS、媒体路径、服务状态、公开 URL 和 KTV 索引诊断。 | `pnpm deploy:doctor` / `bash deploy/source/ktv.sh doctor` / `bash deploy/docker/ktv.sh doctor` |
| `web-deploy-smoke.mjs` | 部署后 smoke：Web 入口、CORS、TV bootstrap/heartbeat、控制端 session 和推荐歌曲。 | `pnpm deploy:smoke` / `bash deploy/source/ktv.sh smoke` |

## 测试

```bash
node --test scripts/node-tools/deploy-doctor.test.mjs
node --test scripts/node-tools/web-deploy-smoke.test.mjs
```
