# Playlist Score Design

## Goal

Add a standalone Python tool that pulls songs from user playlists on Chinese mainstream music platforms, merges repeated songs by normalized title plus artist, and outputs a playlist-based score table.

This tool is separate from the existing chart-based tool. It will produce its own artifact set so a later merge script can combine chart scores and playlist scores.

## Scope

The first version supports two input modes.

### Keyword -> playlist search

- `netease`
- `kuwo`

Behavior:

- the user provides one or more keywords
- the tool searches playlists by keyword per supported platform
- it keeps the top N playlists per keyword
- it fetches songs from those playlists

### Direct playlist URL / ID input

- `netease`
- `qq`
- `kugou`
- `kuwo`

Behavior:

- the user provides playlist URLs, platform-prefixed ids, or plain ids with explicit platform
- the tool parses playlist identity
- it fetches songs from those playlists directly

## Non-Goals for v1

- playlist search for `qq`
- playlist search for `kugou`
- non-music platforms
- direct database writes
- automatic deletion decisions
- the final merge script between chart and playlist outputs

## Scoring Model

The playlist tool uses its own score output, independent from chart scores.

Default v1 rule:

- each song gets `+10` points for each distinct playlist it appears in

This stays configurable by CLI so later the user can change playlist scoring without changing chart scoring.

Deduplication rules:

- duplicate rows inside the same playlist count once
- the same playlist discovered twice counts once
- the same song across different playlists accumulates

## Architecture

The script stays self-contained under `scripts/tools/fetch_playlist_scores.py` and is split into five layers:

1. Input parsing
   - read keywords from CLI or file
   - read playlist URLs / IDs from CLI or file
2. Playlist discovery
   - keyword search on NetEase and Kuwo
   - direct playlist reference parsing for all supported direct platforms
3. Playlist song collection
   - fetch playlist detail and songs
4. Normalization and aggregation
   - normalize title and artist noise
   - merge repeated songs
5. Reporting
   - write source report, raw playlist rows, and aggregated CSV

## Source Strategy

### NetEase

- service: deployed `NeteaseCloudMusicApiBackup`
- keyword search: `/cloudsearch?type=1000`
- playlist songs: `/playlist/track/all?id=<playlist_id>`
- fallback detail: `/playlist/detail?id=<playlist_id>`

Reason:

- already deployed on `lxc-dev`
- playlist search and playlist detail have already been verified

### Kuwo

- keyword search: `https://bd.kuwo.cn/api/www/search/searchPlayListBykeyWord`
- playlist songs: `https://bd.kuwo.cn/api/www/playlist/playListInfo`
- auth/signing: generate `reqId` and `Secret` using the existing JS logic from the researched `musicapi` repo

Reason:

- verified workable with generated `Secret` and `reqId`
- supports both keyword search and direct playlist fetch in v1

### QQ

- direct playlist only
- playlist songs: `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?...&disstid=<id>`

Reason:

- stable direct playlist detail path already known
- keyword playlist search was not validated and stays out of scope

### Kugou

- direct playlist only
- playlist songs: `http://gatewayretry.kugou.com/v2/get_other_list_file?...&specialid=<id>`
- request signing: reuse the MD5 rule already validated in the researched repo

Reason:

- direct playlist fetch path is known
- keyword playlist search remains unstable and stays out of scope

## Input Model

The tool will support:

- `--keywords`
- `--keywords-file`
- `--playlist-urls`
- `--playlist-urls-file`
- `--search-limit-per-keyword`
- `--per-source-points`
- `--netease-base-url`

Keyword search and direct playlist fetch can run in the same execution.

## Normalization

Use the same normalization strategy as the chart tool for compatibility:

- lowercase latin text
- normalize full-width and half-width text
- strip common title noise such as `Live`, `DJ版`, `Remix`, `伴奏`, `纯音乐`
- split artist strings on common separators
- sort normalized artist tokens

Song identity:

- `normalized_title + normalized_artist_set`

## Output

Default output directory:

`runtime/playlist-scores/run-<timestamp>/`

Files:

- `source-report.json`
- `playlist-rows.json`
- `aggregated-songs.csv`

`aggregated-songs.csv` columns:

- `score`
- `appearances`
- `title`
- `artist_name`
- `platforms`
- `playlists`
- `normalized_key`

The shape intentionally mirrors the chart tool so a later merge script can combine them with minimal translation.

## Error Handling

- one platform failure does not stop the run
- one playlist failure does not stop the run
- source failures are recorded in `source-report.json`
- unsupported or unparsable playlist URLs are reported and skipped
- duplicate playlist references are collapsed before fetch

## Testing

Focused unit coverage for:

- CLI defaults
- keyword file and playlist file parsing
- playlist URL / ID parsing for NetEase, QQ, Kugou, Kuwo
- aggregation and dedupe rules
- NetEase keyword search and playlist track parsing
- Kuwo keyword search and playlist track parsing
- QQ direct playlist parsing
- Kugou direct playlist parsing

## Open Follow-Up

The user already expects a second phase for playlist search weighting. When that rule is finalized, keep it in this script as CLI-configurable scoring, then merge with chart output using a separate script.
