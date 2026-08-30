-- Karaoke char-level timing (Qwen3-ForcedAligner output path) + align stage.
-- karaoke_lyrics_file points at the JSON produced by aligning vocals.wav with
-- the LRC; the TV client prefers it over the plain .lrc for per-char highlight.
ALTER TABLE ktv_songs
  ADD COLUMN IF NOT EXISTS karaoke_lyrics_file text;

-- supplement pipeline gains an 'align' stage (after vocal_remove, before mix)
ALTER TABLE online_supplement_tasks
  DROP CONSTRAINT IF EXISTS online_supplement_tasks_stage_check;

ALTER TABLE online_supplement_tasks
  ADD CONSTRAINT online_supplement_tasks_stage_check
  CHECK (stage IN ('download', 'rename', 'vocal_remove', 'align', 'mix', 'lyrics', 'index'));
