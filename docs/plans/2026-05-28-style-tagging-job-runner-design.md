# Style Tagging Job Runner Design

## Context

The full-library style tagging job currently runs through `docker compose exec api`.
That couples the long-running process to the `home-ktv-api-1` service container.
When the main deployment rebuilds or recreates the API service, Docker terminates
the `exec` process and the tagging job stops before writing its final summary.

The JSONL tagging flow already supports resume by skipping existing `songKey +
source` rows in the output file. The missing piece is a job lifecycle that is
independent from the main API service lifecycle.

## Design

Add a dedicated job runner command:

```bash
bash deploy/docker/ktv.sh tag-styles-job <command>
```

The runner starts an independent Docker container from the current
`home-ktv-api:latest` image instead of using `docker compose exec api`. The job
container joins the same Docker network as the main stack, mounts the same media
directory, and writes its state outside the repository:

```text
/opt/home-ktv-jobs/style-tagging/
  state.json
  logs/
```

Default runtime values:

- job root: `/opt/home-ktv-jobs/style-tagging`
- container: `home-ktv-style-tags-job`
- image: `home-ktv-api:latest`
- network: `home-ktv_default`
- input: `/data/home-ktv-media/tagging/full/songs.jsonl`
- output: existing output from `state.json`, or a timestamped JSONL file
- Netease API: `http://ktv-netease-api:3000`
- concurrency: `5`

## Commands

- `start`: start a new independent JSONL tagging container.
- `resume`: continue the last output file recorded in `state.json`.
- `status`: show the job container state and current state file.
- `logs`: tail the host-side job log file.
- `stop`: stop the job container.
- `stats`: summarize the current JSONL output file.
- `import-dry-run`: validate that the staged JSONL can match current database rows.
- `import`: apply the staged JSONL tags to PostgreSQL.

## Data Flow

`start` or `resume` writes `state.json`, then runs:

```text
docker run -d
  --name home-ktv-style-tags-job
  --network home-ktv_default
  -v <media-host-path>:/data/home-ktv-media
  -v /opt/home-ktv-jobs/style-tagging:/job
  home-ktv-api:latest
  sh -lc "pnpm -F @home-ktv/api tag:ktv-styles:jsonl ..."
```

Logs are redirected to `/job/logs/...` inside the container, which is the same
host directory under `/opt/home-ktv-jobs/style-tagging/logs`.

Main-service redeploys may replace `home-ktv-api-1`, but they do not recreate
or stop `home-ktv-style-tags-job`. The only operations that still affect the job
are explicit `docker stop`, deleting the Docker network, or stopping Docker.

## Error Handling

- Starting while the job container is running exits with a clear error.
- Starting after a previous stopped job removes that stopped container and starts
  a fresh one against the selected output file.
- `resume` requires an output file from `state.json` unless `--output` is given.
- `stats` reads the host-side result file through the media path mapping and
  reports total/tagged/empty/failed counts.

## Testing

Unit tests cover argument parsing, env-file parsing, Docker run argument
construction, path mapping, and JSONL result summarization. Server verification
will run the job on `lxc-dev`, confirm the independent container remains active,
and check that the JSONL line count grows.
