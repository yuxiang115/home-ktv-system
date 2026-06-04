# Music Chart Score Design

## Goal

Add a standalone Python tool that pulls songs from all charts on Chinese mainstream music platforms, merges the same song by normalized title plus artist, and gives each chart appearance `+10` points.

## Scope

The first version covers:

- NetEase Cloud Music via `NeteaseCloudMusicApiBackup`
- QQ Music
- Kugou
- Kuwo
- Migu Music

The tool only needs song title and artist. It does not write to the HomeKTV database.

## Architecture

The tool is a single Python script under `scripts/tools/` with four layers:

1. Source discovery
   - Discover all chart ids and names per platform.
2. Chart collection
   - Fetch all songs for each chart.
3. Normalization and aggregation
   - Normalize noisy title and artist variants.
   - Deduplicate within one chart.
   - Merge across charts and add `+10` points per chart hit.
4. Reporting
   - Write raw chart rows, source health, and final aggregated CSV.

## Source Strategy

### NetEase

- Primary source: deployed `NeteaseCloudMusicApiBackup`
- Discovery: `/toplist`
- Chart songs: `/playlist/track/all?id=<playlist_id>&limit=<n>`

Reason: the user already deploys this locally and it is more stable than scraping NetEase HTML.

### QQ Music

- Discovery: parse `window.__INITIAL_DATA__` from `https://y.qq.com/n/ryqq_v2/toplist/4`
- Chart songs: `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?...`

Reason: the toplist page contains all `topId` values and the detail API returns structured JSON.

### Kugou

- Discovery: parse chart links from `https://www.kugou.com/yy/html/rank.html`
- Chart songs: parse each chart page `https://www.kugou.com/yy/rank/home/<page>-<rank_id>.html?from=rank`
- Pagination: increment page number until a page returns zero songs

Reason: the official PC rank pages are public and stable enough for HTML extraction.

### Kuwo

- Discovery: parse chart cards from `https://www.kuwo.cn/newh5/bang/index`
- Chart songs: parse `https://www.kuwo.cn/newh5/bang/content?bid=<bid>`

Reason: the mobile pages return complete chart song lists in HTML.

### Migu

- Discovery: call `https://app.c.nf.migu.cn/pc/bmw/rank/rank-index/v1.0`
- Chart songs: call `https://app.c.nf.migu.cn/pc/bmw/rank/rank-info/v1.0`
- Headers: send the small required H5 headers used by Migu web requests

Reason: this avoids scraping the SPA shell from `music.migu.cn`.

## Normalization

Song identity is:

- normalized title
- normalized artist set

Normalization rules in v1:

- lowercase latin text
- unify full-width and half-width punctuation
- trim repeated whitespace and separators
- strip common suffix noise such as `live`, `dj版`, `伴奏`, `remix`, `cover`, `完整版`
- remove bracketed variant notes when they look like version noise
- split artist strings on common separators such as `/` `&` `、` `,`
- sort normalized artist tokens for stable matching

If a chart row has no usable artist, it falls back to title-only identity and is marked with a warning in raw output.

## Output

Default output directory:

`runtime/chart-scores/run-<timestamp>/`

Files:

- `source-report.json`: per chart fetch result and row counts
- `chart-rows.json`: flattened raw chart rows
- `aggregated-songs.csv`: final merged score table

`aggregated-songs.csv` columns:

- `score`
- `appearances`
- `title`
- `artist_name`
- `platforms`
- `charts`
- `normalized_key`

## Error Handling

- A single chart failure does not stop the whole run.
- Source failures are recorded in `source-report.json`.
- NetEase charts fail fast with a clear message if the configured local API is unreachable.
- Kugou pagination stops when a page returns zero parsed rows.

## Testing

Focused unit coverage for:

- CLI defaults
- normalization and merge rules
- per-chart dedupe and `+10` scoring
- platform-specific parsers using small inline fixtures
- Migu header builder

## Initial Non-Goals

- direct database writes
- long-term scheduling
- automatic low-score deletion
- fuzzy artist alias dictionaries beyond basic normalization
