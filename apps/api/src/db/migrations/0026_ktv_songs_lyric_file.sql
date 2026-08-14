-- Records the path to a sidecar .lrc lyric file produced by the online supplement
-- pipeline. Lyrics are not rendered by the TV client yet (libVLC has no subtitle
-- code); this column only persists the produced file for future subtitle support.
ALTER TABLE ktv_songs
  ADD COLUMN IF NOT EXISTS lyric_file text;
