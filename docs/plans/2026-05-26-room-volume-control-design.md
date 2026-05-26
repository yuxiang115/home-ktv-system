# 房间单音量控制设计

## 背景

移动控制端当前只有原唱/伴唱切换，没有音量控制。真实 MV 是单文件双音轨，原唱和伴奏是二选一播放，不是两路声音混音，因此本次不做“原唱音量/伴奏音量”两套控制。

## 设计

新增一个房间级 `volumePercent`，取值 `0-100`，默认 `100`。控制端展示一个“音量”滑块；用户调整后通过控制命令写入后端，后端把新音量写入播放会话并广播房间快照。TV 端从房间快照读取 `volumePercent`，统一应用到当前 libVLC 播放器。

## 合同

- `RoomSnapshot` 和 `RoomControlSnapshot` 增加 `volumePercent: number`。
- 新增控制命令 `set-volume`，请求体包含 `volumePercent`。
- 后端校验音量必须是 `0-100` 的有限整数。
- DB 在 `playback_sessions` 增加 `volume_percent integer NOT NULL DEFAULT 100`。

## UI

移动端在“当前播放”面板增加单个音量控件：左侧标题“音量”，右侧显示当前百分比，中间为范围滑块。滑块使用乐观值展示，并用短防抖发送后端命令，避免拖动时产生过多请求。

## TV 行为

Android TV 在收到快照时立即应用音量；空闲时也记住最新音量，下一首开始播放前继续应用。原唱/伴唱切换不改变音量。

## 验证

- API 命令测试：`set-volume` 更新会话并返回带音量的快照。
- 移动端测试：滑块展示当前音量，拖动后发送 `set-volume`。
- Android 单元测试：快照解析出 `volumePercent`。
- 类型检查和相关测试通过。
