# 默认音量 50 设计

## 背景

房间音量控制已经存在，但系统默认值是 100。真实使用中 100 作为初始音量过大，用户希望默认音量为 50，并且仍然可以继续调小或调大。

## 设计

把房间音量默认值统一为 50，范围保持 0-100。后端快照、控制端 fallback、Android TV 快照解析和数据库新会话默认值使用同一个产品默认值。Web TV 收到房间快照后要把 `volumePercent` 应用到 `<video>.volume`，避免开发测试时只更新状态、不改变实际声音。

## 数据流

1. API 从 `playback_sessions.volume_percent` 读取音量；无会话或旧数据缺失时返回 50。
2. 控制端 slider 展示快照音量；无快照时 fallback 为 50。
3. 控制端发送 `set-volume`，后端仍校验 `0-100` 并广播快照。
4. Web TV 每次同步播放前应用 `snapshot.volumePercent / 100`。
5. Android TV 每次收到快照时应用 `snapshot.volumePercent` 到 libVLC。

## 迁移

新增数据库迁移把 `playback_sessions.volume_percent` 默认值改为 50，并将当前仍为 100 的会话重置为 50。已经被用户主动调成其他值的会话不改动。

## 验证

- API 测试覆盖空会话快照默认 50、会话映射默认 50、现有 `set-volume` 仍可调到 65。
- 控制端测试覆盖无音量字段时显示 50，并保持可调。
- Web TV 测试覆盖快照音量会应用到 active/standby video。
- Android 单元测试覆盖缺失 `volumePercent` 时默认 50。
