ALTER TABLE ktv_song_tagging_status
  DROP CONSTRAINT IF EXISTS ktv_song_tagging_status_pkey;

ALTER TABLE ktv_song_tagging_status
  ADD PRIMARY KEY (song_id, source);
