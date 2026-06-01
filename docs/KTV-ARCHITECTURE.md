# 当前架构

这份文档描述当前 HomeKTV 的有效架构。历史探索和阶段计划不再放在当前文档主路径中，需要追溯时使用 Git 记录。

## 产品边界

- 系统面向家庭 KTV 场景，核心能力是搜索真实曲库、手机点歌、TV 播放和后台诊断。
- Admin 暂不做登录鉴权，访问边界交给部署网络、Caddy 和域名暴露范围。
- 公网媒体流暂不做 token 或签名 URL。
- Android TV 是正式 TV 播放端，使用 libVLC 直接播放真实 MKV/MPG/MPEG MV。
- Web TV 保留为开发调试端，不作为真实播放兼容性的最终判断。
- 真实曲库全自动入库。只要索引资源存在且未标记缺失，就可以搜索和点歌；Admin 只负责查看、诊断和管理，不做人工作为可用性的前置审核。

## 系统组成

```text
apps/api              后端 API、房间状态、队列、媒体网关、真实曲库接入
apps/admin            后台管理界面
apps/controller       手机扫码控制器
apps/tv-web           Web TV 调试端
clients/android-tv    Android TV 正式播放端
packages/*            共享领域模型、协议、会话引擎、热门歌曲工具
deploy/*              Docker Compose 和源码部署入口
scripts/*             本地开发、检查和运维工具
```

## 核心运行链路

1. TV 端通过 `/player/bootstrap` 注册到房间，并持续发送心跳。
2. TV 空闲页展示二维码，二维码指向控制器并携带房间配对信息。
3. 手机控制器通过配对会话进入房间，读取 snapshot 和实时状态。
4. 用户搜索歌曲时，后端优先查询真实 KTV 索引读模型。
5. 点歌命令进入房间队列，后端生成当前播放目标和媒体 URL。
6. TV 端拉取播放目标，通过后端媒体网关播放文件。
7. TV 上报播放、结束、失败和音轨切换结果；控制器和 Admin 通过 snapshot 或实时通道刷新。

## 曲库模型

真实曲库索引与旧演示目录分离。当前 NAS 曲库已经压缩为最小运行模型：

- `ktv_songs`: NAS 可播放文件表。一行就是一个可点播文件，同时保存歌名、歌手数组、风格数组、文件路径、技术探测、封面地址、缺失标记和长期点歌计数。
- `candidate_tasks`: 线上候选发现和拉取工作流。当前没有独立线上曲库表，ready 结果直接保存在任务表中。

`ktv_songs.category` 已不再作为长期分类字段。歌手分类读取 `ktv_songs.artist_names`，风格分类读取 `ktv_songs.style_tags`。一首歌有多个歌手或多个风格时，直接以数组保存。

完整字段和关系以 [database-schema.md](database-schema.md) 为准。

## 媒体和播放

- 单文件 MV 就是一首歌的一个版本。
- 原唱/伴唱来自同一个媒体文件内的不同音轨。
- 当前同一时间只播放一条音轨，手机控制器使用一个房间级音量。
- 单音轨歌曲仍可点歌播放，控制器显示“单音轨歌曲源”作为能力提示。
- 技术探测用于补充音轨数、编码和时长等诊断信息，不阻塞搜索、点歌和播放。

## 部署模型

服务器侧包含 API、Admin、Controller、Web TV 和 PostgreSQL。正式 TV 客户端是单独安装到电视的 Android APK。

当前私有测试服务器推荐使用源码部署：

```bash
bash deploy/source/ktv.sh setup
bash deploy/source/ktv.sh deploy
bash deploy/source/ktv.sh doctor
```

Docker Compose 保留为稳定发布和备用路径：

```bash
bash deploy/docker/ktv.sh setup
bash deploy/docker/ktv.sh start
bash deploy/docker/ktv.sh doctor
```

部署细节以 [deployment.md](deployment.md) 和 [runbooks/deploy-lxc-dev.md](runbooks/deploy-lxc-dev.md) 为准。

## 文档分层

- `README.md`: 项目入口和常用命令。
- `docs/README.md`: 文档入口。
- `docs/project-structure.md`: 当前目录结构。
- `docs/deployment*.md`: 部署说明。
- `docs/database-schema.md`: 当前数据库结构。
- `docs/KTV-FULL-INDEX.md`: 真实曲库索引和维护说明。
- `.planning/`: GSD 过程档案，不作为部署或排障入口。

## 暂不处理

- Admin 登录鉴权。
- 媒体流签名访问控制。
- Android APK 自动更新。
- 服务端转码作为默认播放路径。
- 把 Admin 做成重型 CMS 或人工审核工作台。
