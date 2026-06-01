# 发布检查清单

## 本地提交前

```bash
pnpm repo:hygiene
pnpm typecheck
pnpm test
pnpm build
```

如果本地已有历史调研文件，先按 [仓库卫生 Runbook](repo-hygiene.md) 判断归属；不要把不属于当前发布的文件混进提交。

如果只改了部署脚本或文档，可以至少运行：

```bash
node --test scripts/tools/deploy-doctor.test.mjs
node --test scripts/tools/repo-hygiene-check.test.mjs
pnpm deploy:doctor -- --mode docker --env-file deploy/env/server.env.example --skip-network
```

## 推送

提交信息使用中文，简短说明重点：

```bash
git add <files>
git commit -m "补充部署自检"
git push origin main
```

## 服务器更新

```bash
ssh lxc-dev
cd /opt/home-ktv-system
bash deploy/source/ktv.sh deploy
bash deploy/source/ktv.sh status
```

## 冒烟验证

```bash
curl -I https://ktv-api.shaolongfei.com/health
curl -I https://ktv-admin.shaolongfei.com/
curl -I 'https://ktv-controller.shaolongfei.com/controller?room=living-room'
curl -I 'https://ktv-tv.shaolongfei.com/?apiBaseUrl=https://ktv-api.shaolongfei.com&roomSlug=living-room&deviceName=Web%20TV'
bash deploy/source/ktv.sh smoke
```

人工验证：

1. Android TV 待机页显示二维码。
2. 手机扫码能进入控制器。
3. 搜索一首真实歌曲并点歌。
4. TV 进入播放状态。
5. 切歌、顶歌、音量、原唱/伴唱至少验证一项。
6. Admin Room 页面状态和队列能同步。

## Android TV 实机验证

```bash
cd clients/android-tv
./gradlew :app:testDebugUnitTest :app:assembleDebug --no-daemon
```

安装后使用真实电视验证：

1. 待机页二维码。
2. 播放画面比例。
3. 原唱/伴唱切换。
4. 音频是否干净。
5. 断线重连后状态恢复。
