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

```bash
cd /opt/home-ktv-system
git pull --ff-only
bash deploy/docker/ktv.sh restart
bash deploy/docker/ktv.sh status
bash deploy/docker/ktv.sh doctor
```

## 公网入口

```text
API:        https://ktv-api.shaolongfei.com/health
Admin:      https://ktv-admin.shaolongfei.com/
Controller: https://ktv-controller.shaolongfei.com/controller?room=living-room
Web TV:     https://ktv-tv.shaolongfei.com/?apiBaseUrl=https://ktv-api.shaolongfei.com&roomSlug=living-room&deviceName=Web%20TV
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

