CREATE TABLE ktv_song_style_tags_new (
  song_id text NOT NULL REFERENCES ktv_songs(id) ON DELETE CASCADE,
  tag_name text NOT NULL,
  tag_group text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ktv_song_style_tags_new (song_id, tag_name, tag_group, created_at, updated_at)
SELECT st.song_id,
       t.name AS tag_name,
       g.name AS tag_group,
       min(st.created_at) AS created_at,
       max(st.updated_at) AS updated_at
FROM ktv_song_style_tags st
JOIN ktv_style_tags t ON t.id = st.tag_id
JOIN ktv_style_groups g ON g.id = t.group_id
WHERE t.enabled = true
  AND g.enabled = true
GROUP BY st.song_id, t.name, g.name;

DROP TABLE IF EXISTS ktv_song_style_tags;

ALTER TABLE ktv_song_style_tags_new RENAME TO ktv_song_style_tags;

ALTER TABLE ktv_song_style_tags
  ADD CONSTRAINT ktv_song_style_tags_song_tag_group_uq UNIQUE(song_id, tag_name, tag_group);

CREATE INDEX IF NOT EXISTS ktv_song_style_tags_group_tag_idx
  ON ktv_song_style_tags(tag_group, tag_name, song_id);

CREATE INDEX IF NOT EXISTS ktv_song_style_tags_tag_idx
  ON ktv_song_style_tags(tag_name, song_id);

DROP TABLE IF EXISTS ktv_song_tagging_cache;
DROP TABLE IF EXISTS ktv_song_tagging_status;
DROP TABLE IF EXISTS ktv_song_tagging_runs;
DROP TABLE IF EXISTS ktv_style_tags;
DROP TABLE IF EXISTS ktv_style_groups;
