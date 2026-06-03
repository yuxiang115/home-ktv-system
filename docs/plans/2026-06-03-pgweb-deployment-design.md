# pgweb 部署设计

日期：2026-06-03

## 目标

为现有 HomeKTV 服务器环境增加一个网页数据库可视化入口，满足：

- 优先通过浏览器查看 PostgreSQL 数据库
- 复用当前数据库账号，不新增只读用户
- 接入现有 `lxc-network` 的 Caddy 和 Homepage
- 同步更新项目部署文档和服务器应用服务文档

## 当前环境

- `lxc-dev` (`192.168.5.102`)：HomeKTV 源码部署节点，当前已运行 API/Admin/Controller/Web TV
- `lxc-network` (`192.168.5.103`)：Caddy + Homepage
- 现有公网入口都由 `lxc-network:/etc/caddy/Caddyfile` 中的 `*.shaolongfei.com` 统一转发
- Homepage 服务清单位于 `lxc-network:/opt/homepage/config/services.yaml`
- HomeKTV 数据库连接串保存在 `lxc-dev:/opt/home-ktv-system/deploy/source/.env`

## 方案选型

### 方案 A：在 `lxc-dev` 部署 `pgweb` systemd 服务，Caddy 反代，Homepage 挂入口

做法：

- 在 `lxc-dev` 下载 `pgweb` 官方 Linux 二进制到 `/opt/pgweb/`
- 新建 `pgweb.service`
- 复用 `/opt/home-ktv-system/deploy/source/.env` 中的 `DATABASE_URL`
- 监听 `0.0.0.0:8082`
- 在 `lxc-network` 中新增 `pgweb.shaolongfei.com -> 192.168.5.102:8082`
- 在 Homepage 中新增入口

优点：

- 最轻量
- 不引入 Docker / Java / PHP
- 与现有 HomeKTV 部署解耦

缺点：

- 功能比重型数据库管理器少

### 方案 B：部署 Adminer

优点：

- 单文件，部署极快

缺点：

- 需要额外 PHP 运行环境
- 长期维护和安全边界不如 `pgweb` 干净

### 方案 C：部署 CloudBeaver

优点：

- 功能最全，团队级数据库工作台

缺点：

- 太重
- 明显超出当前“查看数据库”的需求

## 推荐方案

采用方案 A。

## 详细设计

### 服务端口

- `pgweb` 监听 `0.0.0.0:8082`
- 当前 `lxc-dev` 上 `8082` 未占用，适合新增轻量管理服务

### 二进制与目录

- 安装目录：`/opt/pgweb`
- 主程序：`/opt/pgweb/pgweb`
- 可选保留下载压缩包用于回溯版本，但不是必须

### systemd 服务

服务名：

- `pgweb.service`

配置原则：

- `After=network.target`
- `Restart=always`
- 复用 `EnvironmentFile=/opt/home-ktv-system/deploy/source/.env`
- 使用 `DATABASE_URL` 启动 `pgweb`

### 域名与反代

新增域名：

- `pgweb.shaolongfei.com`

在 `lxc-network:/etc/caddy/Caddyfile` 中追加：

- host match：`pgweb.shaolongfei.com`
- reverse proxy：`192.168.5.102:8082`

### Homepage

在 Homepage 中新增一个服务入口：

- 名称：`pgweb`
- 链接：`https://pgweb.shaolongfei.com`
- 描述：`PostgreSQL 网页数据库浏览器`
- 分组建议：`工具`

### 认证边界

用户已明确说明其内外网隔离，不需要额外增加公网防护层。本轮不追加 Basic Auth。

如果后续拓扑变化或该域名需要暴露到更开放网络，再补：

- Caddy Basic Auth
- IP 白名单

## 验证方式

- `lxc-dev`：`systemctl status pgweb`
- `lxc-dev`：`curl -I http://127.0.0.1:8082`
- `lxc-network`：`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
- 浏览器：`https://pgweb.shaolongfei.com`
- Homepage 页面能看到并打开 `pgweb`

## 文档更新

需要更新：

- `docs/runbooks/deploy-lxc-dev.md`
- `/Users/shaolongfei/Desktop/我的项目/服务器部署规划/06-应用服务.md`

## 不做的事

- 不把 `pgweb` 并入 HomeKTV 的 `deploy/source/ktv.sh`
- 不新增数据库只读账号
- 不引入 Docker Compose
