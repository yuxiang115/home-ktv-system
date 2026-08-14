-- Online supplement tasks: queue for "search online (YouTube/Bilibili) -> produce
-- a spec-named NAS MV -> index into ktv_songs" pipeline. The produced file is a
-- normal ktv_songs row (sourceType is always "nas" on the playback path); this
-- table only tracks the asynchronous production workflow. See docs for the design.
--
-- Status model:
--   status        overall task state shown to clients (discovered/processing/ready/failed)
--   stage         current pipeline step (download/rename/vocal_remove/mix/lyrics/index)
--   stage_status  per-stage state driving the worker scheduler. "pending" means the
--                 worker can claim it (rename & vocal_remove are batched), "running"
--                 means a worker owns it via worker_id + worker_lease_until.
CREATE TABLE IF NOT EXISTS online_supplement_tasks (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_candidate_id text NOT NULL,
  source_url text NOT NULL,
  title text NOT NULL,
  artist_name text NOT NULL DEFAULT '',
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  workflow_id text NOT NULL DEFAULT 'youtube-enhanced' CHECK (workflow_id IN ('youtube-basic', 'youtube-enhanced')),
  status text NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'processing', 'ready', 'failed')),
  stage text NOT NULL DEFAULT 'download' CHECK (stage IN ('download', 'rename', 'vocal_remove', 'mix', 'lyrics', 'index')),
  stage_status text NOT NULL DEFAULT 'pending' CHECK (stage_status IN ('pending', 'running', 'done', 'failed')),
  stage_progress_percent integer NOT NULL DEFAULT 0 CHECK (stage_progress_percent >= 0 AND stage_progress_percent <= 100),
  stage_message text NOT NULL DEFAULT '',
  failure_reason text,
  failure_stage text,
  llm_renamed_title text,
  final_file_path text,
  lyric_file text,
  ready_song_id text REFERENCES ktv_songs(id) ON DELETE SET NULL,
  worker_id text,
  worker_lease_until timestamptz,
  requested_by text,
  download_at timestamptz,
  ready_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(room_id, provider, provider_candidate_id)
);

CREATE INDEX IF NOT EXISTS online_supplement_tasks_room_status_updated_idx
  ON online_supplement_tasks(room_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS online_supplement_tasks_stage_claim_idx
  ON online_supplement_tasks(stage, stage_status, updated_at ASC)
  WHERE status IN ('discovered', 'processing');

CREATE INDEX IF NOT EXISTS online_supplement_tasks_ready_song_idx
  ON online_supplement_tasks(ready_song_id)
  WHERE ready_song_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS online_supplement_tasks_lease_idx
  ON online_supplement_tasks(worker_lease_until)
  WHERE stage_status = 'running';
