# Merge Music Scores Design

## Goal

Add a standalone Python tool that merges three existing music score outputs into one deduplicated song table:

- hot-song candidates
- full chart scores
- playlist scores

The merged result is only required to guarantee:

- `title`
- `artist_name`
- `score`

## Scope

The first version reads existing CSV outputs from:

- `scripts/fetch_hot_song_candidates.py`
- `scripts/fetch_chart_scores.py`
- `scripts/fetch_playlist_scores.py`

It does not fetch any network data. It only reads local files and writes a merged CSV.

## Input Model

The tool accepts up to three inputs:

- `--hot-input`
- `--chart-input`
- `--playlist-input`

Each input may be either:

- a direct CSV file path
- a run output directory

Directory resolution rules:

- hot-song directory -> `ranked-songs.csv`
- chart directory -> `aggregated-songs.csv`
- playlist directory -> `aggregated-songs.csv`

At least one input is required.

## Merge Rule

Use the same normalization strategy as the existing Python score scripts:

- normalize full-width and half-width text
- lowercase latin text
- strip common title noise such as `Live`, `DJ版`, `Remix`, `伴奏`, `纯音乐`
- normalize artist separators and order

Song identity:

- `normalized_title + normalized_artist_set`

Scoring rule:

- `score = hot_score + chart_score + playlist_score`

This version does not add any extra weighting.

## Output

Default output directory:

`runtime/merged-music-scores/run-<timestamp>/`

Files:

- `merged-songs.csv`
- `merge-report.json`

`merged-songs.csv` columns:

- `title`
- `artist_name`
- `score`
- `hot_score`
- `chart_score`
- `playlist_score`
- `normalized_key`

## Error Handling

- if an input path is missing or invalid, fail fast
- if an input CSV is empty, treat it as zero rows
- if duplicate rows inside one source normalize to the same song, accumulate that source score before cross-source merge

## Testing

Focused coverage:

- CLI defaults
- directory-to-CSV resolution
- normalization identity
- three-source merge behavior
- duplicate collapse inside a single source
- end-to-end local merge output writing
