-- 手机端快进/快退:seek 命令写目标位置并递增序列号,TV 检测序列号变化后应用。
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS seek_seq integer NOT NULL DEFAULT 0 CHECK (seek_seq >= 0);
