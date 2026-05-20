# Phase 18: KTV Index Read Model and Diagnostics - UI Spec

**Created:** 2026-05-20
**Status:** Ready for planning

## Product Surfaces

Phase 18 affects two UI surfaces:

- Admin Songs workspace: operator diagnostics for the real KTV index.
- Mobile controller search: user-visible KTV indexed search results inside the existing song search panel.

No new top-level Admin tab, no new Mobile route, and no TV UI changes are part of this phase.

## Admin Songs Diagnostics

### Placement

Add a KTV index diagnostics section inside `SongCatalogView`, near the formal catalog list/detail layout. It should feel like a library operations tool, not a separate dashboard.

### Layout

- Use a full-width diagnostics band above or beside the existing catalog workbench, depending on available space.
- Keep the existing formal songs list and detail editor visible and usable.
- Use compact metric groups and tables; do not nest cards inside cards.
- Provide one explicit refresh button with a refresh icon when an icon library exists. If no icon library exists in Admin, use the existing button styling without adding a new icon package.

### Required Raw Metrics

Show these labels in Chinese by default, with English dictionary entries preserved:

- `索引表`
- `最近索引`
- `来源根目录`
- `活动文件`
- `缺失文件`
- `歌曲数`
- `歌手数`
- `解析策略`
- `低置信度`
- `NAS 抽样读取`
- `未映射`
- `搜索预览`

Do not show a synthesized health label such as `健康`, `异常`, `阻塞`, `healthy`, `degraded`, `ok`, or `warning`.

### Search Preview

Admin search preview should accept a keyword and display indexed song groups with version rows. Admin may show:

- indexed song id;
- indexed asset id;
- title;
- artist;
- category;
- extension;
- parse confidence;
- file path;
- missing state;
- sample-read result when available.

The preview is diagnostic. It must not approve, queue, sync, or mutate catalog data in Phase 18.

### Empty And Error States

- If `ktv_*` tables are missing, show table availability rows and an explanatory raw metric line; do not collapse to a generic error page.
- If no indexed search result matches, show `未找到 KTV 索引结果`.
- If NAS sampling times out, is unreadable, missing, or unmapped for some rows, show per-sample status and counts rather than a single failure banner.

## Mobile Search Indexed Results

### Placement

Extend the existing Mobile search panel. Keep formal catalog results first, online补歌 second or after indexed results according to existing layout density. Indexed results must be visually distinct from formal local results.

### Result Grouping

Render indexed results grouped by song:

- Group title: song title and primary artist.
- Meta row: source label `KTV索引`, category, version count.
- Version rows: extension, category/version label, size if available, source label.

Mobile must not display absolute `file_path`.

### Queue Action State

Until Phase 19 implements queue-time sync:

- Indexed version buttons are disabled.
- Disabled label is exactly `需同步入库后可点歌`.
- The UI still preserves `indexedSongId` and `indexedAssetId` in the response-driven component state for Phase 19, but it does not send them to queue commands yet.

### Responsive Behavior

- Search result rows must keep stable spacing on narrow phones.
- Buttons must not resize result rows dramatically.
- Long titles and artist names wrap within the row.
- Source/category chips wrap instead of overflowing.

## Accessibility

- Search preview inputs have labels.
- Refresh/sample actions are buttons, not clickable divs.
- Disabled indexed queue buttons keep readable text.
- Tables include headers for raw metrics and sample rows.

## Verification Hooks

Plans should include frontend tests or source assertions for:

- Admin renders `KTV 索引诊断`, `NAS 抽样读取`, and `搜索预览` inside Songs.
- Admin diagnostics copy does not contain synthesized health labels.
- Mobile renders `KTV索引` and `需同步入库后可点歌`.
- Mobile output does not render `/mnt/nas` or `file_path`.
