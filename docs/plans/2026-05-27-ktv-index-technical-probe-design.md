# 真实曲库音轨元数据探测设计

## 背景

真实曲库已经通过 `ktv_*` 索引接入，当前线上有效资源约 `34385` 首。控制端已经能根据搜索结果里的 `audioTrackCount` 显示“单音轨歌曲源”，但线上 `ktv_song_assets.technical_metadata` 尚未回填音轨信息，因此该标签和后续 Admin 音轨统计还不能在真实曲库中发挥作用。

## 已确认决策

- 不保存完整 raw ffprobe JSON，只保存必要摘要、来源和失败信息。
- 先在服务器上探测 300 首，确认耗时和失败率，再全量高并发回填。
- 探测失败不影响点歌；失败只表示技术元数据未知或当前文件探测异常。

## 目标

1. 为 `ktv_song_assets` 回填 `mediaInfoSummary.audioTracks` 等必要技术摘要。
2. 让控制端的“单音轨歌曲源”标签在真实曲库中可见。
3. 让 Admin/doctor 能看到原始探测覆盖率和音轨分布。
4. 探测过程可中断、可续跑、可限制样本量和并发。

## 推荐方案

新增一个独立的 KTV 索引技术探测流程，不改变现有自动入库和点歌链路。

探测流程读取 `ktv_song_assets` 中 `missing_at is null` 的资源，通过 `MEDIA_PATH_MAPPINGS` 把索引路径映射到当前运行环境可读路径，调用现有 `probeMediaFile()` 获取 ffprobe 摘要。成功后写入：

- `technical_status = 'probed'`
- `technical_metadata.mediaInfoSummary`
- `technical_metadata.mediaInfoProvenance`
- `technical_metadata.probedAt`

失败后写入：

- `technical_status = 'failed'`
- `technical_metadata.probeError.code`
- `technical_metadata.probeError.message`
- `technical_metadata.probeError.failedAt`

不保存完整 raw ffprobe JSON，避免数据库膨胀。

## 执行策略

第一阶段在 `lxc-dev` 跑样本：

```bash
bash deploy/docker/ktv.sh probe-index -- --limit 300 --concurrency 2
```

样本通过后再全量高并发跑：

```bash
bash deploy/docker/ktv.sh probe-index -- --concurrency 8 --retry-failed
```

全量并发默认保持可配置。`8` 是初始建议值：比样本快很多，但不会默认把 NAS 和 API 容器打满。若服务器 I/O 和 CPU 余量充足，可以提高到 `12` 或 `16`。

## 数据流

1. CLI 从数据库读取待探测资源。
2. 对每个资源执行路径映射和文件可读性检查。
3. 调用 `ffprobe` 生成 `MediaInfoSummary` 和 `MediaInfoProvenance`。
4. 批量更新 `ktv_song_assets.technical_status` 和 `technical_metadata`。
5. CLI 输出成功、失败、单音轨、双音轨、多音轨、耗时和吞吐。
6. 搜索 API 继续读取 `technical_metadata.mediaInfoSummary.audioTracks.length`，无需改变点歌行为。

## 错误处理

- 文件不可读、路径映射失败、ffprobe 超时、ffprobe 非零退出都记为 `failed`。
- failed 资源仍然可以搜索和点歌。
- 默认不重复探测 `probed` 资源；传入 `--retry-failed` 时重试 failed 资源。
- 传入 `--asset-id` 时只探测指定资源，便于排查。
- 传入 `--dry-run` 时只列出将探测的数量和样本，不写数据库。

## 诊断指标

`/admin/ktv-index/diagnostics` 增加原始指标：

- `technicalStatusCounts`
- `audioTrackDistribution`
- `probePendingCount`
- `probeFailedCount`
- `probeCoveragePercent`

`deploy doctor` 展示这些指标，但不做复杂好坏判断。

## 非目标

- 不做人工审核门槛。
- 不做转码。
- 不保存完整 ffprobe 原始 JSON。
- 不因为探测失败禁止点歌。
- 不在本轮识别“哪条音轨一定是原唱/伴奏”，只回填音轨数量和基础技术摘要。

## 验证

- 单元测试覆盖待探测资源选择、路径映射、成功写入、失败写入、dry-run、retry-failed。
- CLI 测试覆盖参数解析和汇总输出。
- repository/diagnostics 测试覆盖音轨分布和技术状态统计。
- `lxc-dev` 先跑 300 首样本并记录耗时/失败率。
- 样本通过后全量回填，再用搜索 UI 验证单音轨标签可见。
