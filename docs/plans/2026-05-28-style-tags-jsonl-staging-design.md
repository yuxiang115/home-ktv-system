# Style Tags JSONL Staging Design

## Goal

Allow long-running KTV style tagging to continue while PostgreSQL is being rebuilt or the catalog schema is changing. Tagging results should first be written to durable JSONL files and imported into the database only after the new schema is stable.

## Architecture

The flow has three explicit steps:

1. Export a song snapshot from the current database to `songs.jsonl`.
2. Run the tagger against `songs.jsonl` and append results to `results.jsonl`.
3. Import `results.jsonl` into PostgreSQL after the database rebuild is complete.

The tagging step does not require PostgreSQL. It only needs the JSONL input, the provider API, and an output file. This removes the current failure mode where a Postgres restart interrupts a multi-hour NetEase run and leaves a `running` database record behind.

## File Contract

Input rows contain stable matching data:

```json
{"schemaVersion":1,"songKey":"...","sourceSongId":"...","title":"稻香","artistName":"周杰伦","normalizedTitle":"稻香","normalizedArtistName":"周杰伦","assetPaths":["/mnt/nas/KTV歌曲/..."]}
```

Result rows contain the complete provider output needed for replay:

```json
{"schemaVersion":1,"source":"netease-playlist-v1","songKey":"...","song":{"title":"稻香","artistName":"周杰伦"},"status":"tagged","tags":[{"tag":"华语","confidence":0.8,"evidence":["..."]}],"evidence":{},"processedAt":"2026-05-28T00:00:00.000Z","elapsedMs":1234}
```

`songKey` is derived from normalized title, normalized artist, and a stable asset path hash when available. It is used for resume and import matching, but import still validates against current database rows.

## Runtime Behavior

- `export` requires PostgreSQL and writes the current active song list.
- `run-jsonl` does not require PostgreSQL.
- `run-jsonl` appends one result per processed song and skips existing results by default.
- `import-jsonl` supports dry-run and apply mode.
- Import matches by existing source song id first, then by normalized title plus normalized artist.
- Tagged rows replace unlocked tags for the same source. Empty rows record empty status. Failed rows record failed status without deleting old tags.

## Commands

```bash
pnpm ktv:tags:export -- --out runtime/media/tagging/full/songs.jsonl
pnpm ktv:tags:jsonl -- --input runtime/media/tagging/full/songs.jsonl --output runtime/media/tagging/full/results.jsonl --source netease
pnpm ktv:tags:import -- --input runtime/media/tagging/full/results.jsonl --dry-run
pnpm ktv:tags:import -- --input runtime/media/tagging/full/results.jsonl --apply
```

Docker uses the mounted media directory so files survive container rebuilds:

```bash
bash deploy/docker/ktv.sh tag-styles-export -- --out /data/home-ktv-media/tagging/full/songs.jsonl
bash deploy/docker/ktv.sh tag-styles-jsonl -- --input /data/home-ktv-media/tagging/full/songs.jsonl --output /data/home-ktv-media/tagging/full/results.jsonl --source netease
bash deploy/docker/ktv.sh tag-styles-import -- --input /data/home-ktv-media/tagging/full/results.jsonl --apply
```

## Verification

- Unit tests cover JSONL parse/write, resume behavior, and import matching.
- CLI tests cover option parsing for export/run/import commands.
- API typecheck verifies the scripts compile.
