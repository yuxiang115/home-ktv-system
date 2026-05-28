# lxc-dev 部署 Runbook

## 服务器

```text
lxc-dev      192.168.5.102  HomeKTV Docker Compose
lxc-network  192.168.5.103  Caddy + Homepage
```

代码目录：

```bash
/opt/home-ktv-system
```

## NAS 挂载

真实歌曲文件在 NAS，`lxc-dev` 通过 PVE bind mount 只读访问：

```bash
pct set 102 -mp0 /hdd-pool/nas,mp=/mnt/nas,ro=1
```

在 `lxc-dev` 内验证：

```bash
ls /mnt/nas/KTV歌曲
test -r /mnt/nas/KTV歌曲
```

## 环境变量

`/opt/home-ktv-system/deploy/docker/.env` 至少应包含：

```bash
PUBLIC_BASE_URL=https://ktv-api.shaolongfei.com
ADMIN_BASE_URL=https://ktv-admin.shaolongfei.com
CONTROLLER_BASE_URL=https://ktv-controller.shaolongfei.com
TV_WEB_BASE_URL=https://ktv-tv.shaolongfei.com
CORS_ALLOWED_ORIGINS=https://ktv-admin.shaolongfei.com,https://ktv-controller.shaolongfei.com,https://ktv-tv.shaolongfei.com
KTV_NAS_HOST_PATH=/mnt/nas/KTV歌曲
DOCKER_MEDIA_PATH_MAPPINGS=/mnt/nas/KTV歌曲=/nas/KTV歌曲
TV_ROOM_SLUG=living-room
```

## 部署

`lxc-dev` 只从 Git 更新代码。本地有未推送提交时，先在本机完成验证、提交并推送：

```bash
git status --short --branch
git push origin main
```

然后在服务器拉取并重启：

```bash
cd /opt/home-ktv-system
git pull --ff-only
bash deploy/docker/ktv.sh restart
bash deploy/docker/ktv.sh status
bash deploy/docker/ktv.sh doctor
```

不要用本机 `pnpm dev:local` 或本地 Web 预览替代服务器验证；本地环境通常没有 `lxc-dev` 的 PostgreSQL、NAS bind mount 和公网 Caddy 链路。

## 真实曲库检查

`doctor` 应输出 KTV 索引诊断，重点看：

```text
active > 0
songs > 0
latest = completed
coverage 接近 100%
```

首页推荐依赖 `/rooms/living-room/songs/discovery`。如果 `doctor` 显示 KTV 索引有数据，但 discovery 返回空，优先检查 API 是否已把 discovery 路由接到 KTV 索引：

```bash
curl -sS 'https://ktv-api.shaolongfei.com/rooms/living-room/songs/discovery?seed=server-check&limit=30' \
  | jq '{count: (.recommended | length), recommended: [.recommended[0:5][] | {title, artistName}]}'
```

`count` 必须大于 0，才算真实曲库首页可测。

## 部署后 Smoke

每次重新编译部署 API、Controller 或 Web TV 后，都要在通知测试前跑公开入口 smoke：

```bash
pnpm deploy:smoke -- \
  --api-base-url https://ktv-api.shaolongfei.com \
  --controller-base-url https://ktv-controller.shaolongfei.com \
  --tv-web-base-url https://ktv-tv.shaolongfei.com \
  --room living-room
```

这个 smoke 会覆盖 CORS、Web TV bootstrap/heartbeat、控制端看到 TV 在线，以及推荐列表非空。

## 公网入口

```text
API:        https://ktv-api.shaolongfei.com/health
Admin:      https://ktv-admin.shaolongfei.com/
Controller: 通过 Web TV 二维码或 Admin 的 pairing.controllerUrl 进入，URL 必须带 token
Web TV:     https://ktv-tv.shaolongfei.com/?apiBaseUrl=https://ktv-api.shaolongfei.com&roomSlug=living-room&deviceName=Web%20TV
```

没有历史 cookie 时，裸 `https://ktv-controller.shaolongfei.com/controller?room=living-room` 不能创建控制会话，只能用于前端静态资源可达性检查。手动生成一次可用控制端 URL：

```bash
curl -sS -X POST 'https://ktv-api.shaolongfei.com/admin/rooms/living-room/pairing-token/refresh' \
  | jq -r '.pairing.controllerUrl'
```

## Caddy 和 Homepage

Caddy 配置在 `lxc-network:/etc/caddy/Caddyfile`。修改前先备份：

```bash
ts=$(date +%Y%m%d-%H%M%S)
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$ts
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
```

Homepage 配置在：

```bash
/opt/homepage/config/services.yaml
```

修改前同样先备份。
