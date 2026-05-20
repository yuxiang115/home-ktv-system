---
status: testing
phase: 19-search-and-queue-time-catalog-sync
source:
  - .planning/phases/19-search-and-queue-time-catalog-sync/19-01-SUMMARY.md
  - .planning/phases/19-search-and-queue-time-catalog-sync/19-02-SUMMARY.md
  - .planning/phases/19-search-and-queue-time-catalog-sync/19-03-SUMMARY.md
  - .planning/phases/19-search-and-queue-time-catalog-sync/19-04-SUMMARY.md
started: 2026-05-20T13:30:29Z
updated: 2026-05-20T14:22:30Z
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

number: 2
name: Mobile Indexed Search Can Queue
expected: |
  我已修复搜索时出现的 `42703`，以及点歌时出现的 `KTV_INDEX_FILE_UNREADABLE` / `KTV_INDEX_SYNC_FAILED`。请刷新 Mobile controller 页面后重新测试真实索引点歌：

  1. 在搜索框输入 `稻香`
  2. 查看 `KTV 索引结果`
  3. 找到可点的版本行，点击 `点歌`

  应该看到：版本行显示 `点歌`；点击后按钮短暂显示 `正在加入...`；随后队列中出现这首歌；选中的索引版本状态变成 `已点`；页面不需要刷新。
awaiting: user response

## Tests

### 1. Cold Start Smoke Test
expected: 我完成本地迁移和服务重启后，API health 正常返回；Admin、Mobile、TV 页面都能打开中文界面；Admin 的房间状态能看到 TV 在线；打开带 token 的 Mobile controller 后，Admin 的在线控制端数量变为 1 或更高，Mobile 右上角显示电视在线；页面没有 Failed to fetch 或明显启动错误。
result: pass
note: "Retested after fixing local dev script to print token-bearing Mobile controller URL."

### 2. Mobile Indexed Search Can Queue
expected: 在 Mobile controller 搜索 `稻香`，`KTV 索引结果` 中的版本行显示 `点歌`；点击后按钮短暂显示 `正在加入...`，随后队列中出现这首歌，选中的索引版本状态变为 `已点`。
result: [pending]
note: "Previously failed with 42703; fixed KTV indexed search SQL to use ms.category. Then failed with KTV_INDEX_FILE_UNREADABLE because indexed /mnt/nas paths were not mapped to the macOS /Volumes/nas mount; fixed MEDIA_PATH_MAPPINGS and verified indexed add-queue-entry accepts 稻香, then cleaned the room back to idle."

### 3. Queued Indexed Result Remains Visible And Path-Safe
expected: 同一搜索结果刷新后仍保留在 `KTV 索引结果` 区域，已点过的版本显示 `已点`；Mobile 页面不显示 `/mnt/nas`、原始 `file_path` 或其他 NAS 绝对路径。
result: [pending]

### 4. Duplicate Confirmation For Indexed Song
expected: 再次点击同一首已点索引歌曲的 `已点` 按钮，会先出现重复点歌确认；确认后才会再次加入队列，不会静默重复点歌。
result: [pending]

### 5. Admin Songs Shows KTV Source Identity
expected: 打开 Admin 的 Songs 页面搜索刚才点过的歌，歌曲资产详情中显示 `KTV 同步来源`，包含 `ktv_songs.id`、`ktv_song_assets.id`、源文件路径和解析置信度等操作员可见信息。
result: [pending]

### 6. Queue Operations Work For Synced Indexed Song
expected: 对刚才从 KTV 索引点入队列的歌曲执行置顶、删除、撤销、切歌等队列操作时，操作能成功；Mobile、Admin、TV 的队列/当前播放状态随之更新，不需要刷新网页。
result: [pending]

### 7. Realtime Search Queue State Refresh
expected: 当你在 Mobile 或 Admin 改变队列后，Mobile 搜索结果里的索引版本状态会自动同步为 `点歌` 或 `已点`，不需要手动刷新页面才能看到变化。
result: [pending]

### 8. Indexed Failure State Stays Understandable
expected: 如果某个索引版本已经失效或文件不可读，Mobile 仍保留该候选但禁用点歌按钮，并显示 `索引已失效` 或 `文件不可读`；不会消失成空白，也不会泄露 NAS 路径。
result: [pending]

## Summary

passed: 1
issues: 0
pending: 7
skipped: 0
blocked: 0

## Gaps

[none yet]
