# Song Cover Cache Design

## Goal

Batch-fetch album cover metadata for the controller home recommendation list without slowing the discovery API.

## Architecture

- Store cover lookup results in `song_cover_cache`, keyed by `source_kind` and `source_song_id`.
- Keep external provider calls out of `GET /rooms/:roomSlug/songs/discovery`; that route only reads cached `coverImageUrl`.
- Use a separate batch command, `covers:songs`, with domestic providers ordered as Tencent, Kugou, NetEase, Kuwo.
- Match provider results by normalized title and artist, reject weak matches, and penalize live/DJ/remix variants.
- The controller renders cached images lazily and falls back to compact generated art when no cover is cached or an image fails.

## Operations

Docker deployments can run:

```bash
bash deploy/docker/ktv.sh fetch-covers -- --limit 300
```

The command only processes missing cache rows by default. Failed network/provider attempts can be retried with `--retry-failed`.

## Verification

- API tests cover discovery response cover injection and KTV-index source ids.
- Matcher tests cover exact matches, weak-match rejection, and original-version preference.
- Controller tests cover image rendering and fallback art.
