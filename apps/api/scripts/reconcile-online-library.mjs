#!/usr/bin/env node
// 对账 _online 曲库:文件存在但被标 missing 的行自愈(清 missing_at);
// 文件确实不存在的行标记 missing_at,让点播/列表链路把它当不可用,
// 避免"曲库有歌但播不了"。用 Node+pg 做(UTF-8 安全),不要在 PowerShell
// 里解析 docker exec 输出(中文路径会乱码,曾导致误标)。
import { access } from "node:fs/promises";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL?.trim() || "postgresql://ktv:ktv@127.0.0.1:5432/home_ktv";

const pool = new Pool({ connectionString: databaseUrl });
try {
  const { rows } = await pool.query(
    `SELECT id, file_path FROM ktv_songs
     WHERE file_path LIKE '%\\_online%' ESCAPE '\\'`
  );

  let healed = 0;
  let marked = 0;
  for (const row of rows) {
    const exists = await access(row.file_path).then(() => true, () => false);
    if (exists) {
      const result = await pool.query(
        `UPDATE ktv_songs SET missing_at = NULL, updated_at = now()
         WHERE id = $1 AND missing_at IS NOT NULL`,
        [row.id]
      );
      healed += result.rowCount ?? 0;
    } else {
      const result = await pool.query(
        `UPDATE ktv_songs SET missing_at = now(), updated_at = now()
         WHERE id = $1 AND missing_at IS NULL`,
        [row.id]
      );
      marked += result.rowCount ?? 0;
      console.log(`[reconcile] marked missing (file gone): ${row.file_path}`);
    }
  }
  console.log(`[reconcile] online library: ${rows.length} row(s), healed=${healed}, markedMissing=${marked}`);
} finally {
  await pool.end();
}
