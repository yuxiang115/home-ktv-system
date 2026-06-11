# scripts/tools

项目级工具脚本目录。原则是：能合并就合并，能用 Python 就不用 Node，临时输出写到 `runtime/` 或 `logs/`，不要放进这个目录。

## 入口总览

### Python 工具

| 脚本 | 用途 | 常用入口 |
| --- | --- | --- |
| `repo_hygiene_check.py` | 提交前仓库卫生检查。 | `pnpm repo:hygiene` |
| `visual_check.py` | Controller/Admin/Web TV 的 Chrome 截图检查。 | `pnpm ui:visual-check` / `pnpm tv:visual-check` |
| `fetch_song_covers.py` | 查询、下载并缓存歌曲封面。 | `pnpm covers:songs` / `python3 scripts/tools/fetch_song_covers.py probe ...` |
| `generate_cover_thumbnails.py` | 生成本地封面缩略图。 | `pnpm covers:thumbnails` |
| `run_style_tagging_llm_batch.py` | 离线批量补风格标签并导入数据库。 | `pnpm ktv:tags:llm-batch:py -- ...` |
| `fetch_hot_song_candidates.py` | 聚合热歌候选。 | `python3 scripts/tools/fetch_hot_song_candidates.py collect` |
| `fetch_chart_scores.py` | 抓取榜单积分。 | `python3 scripts/tools/fetch_chart_scores.py collect` |
| `fetch_playlist_scores.py` | 抓取歌单积分。 | `python3 scripts/tools/fetch_playlist_scores.py collect` |
| `merge_music_scores.py` | 合并热歌、榜单、歌单积分。 | `python3 scripts/tools/merge_music_scores.py merge ...` |
| `delete_uncovered_songs.py` | 根据 CSV 规划或执行删歌。 | `python3 scripts/tools/delete_uncovered_songs.py plan ...` |
| `android_app_icon_pipeline.py` | 生成 Android TV 图标资源。 | `python3 scripts/tools/android_app_icon_pipeline.py --candidate 1` |
| `prepare_readme_assets.py` | 生成 README 横幅和压缩截图。 | `python3 scripts/tools/prepare_readme_assets.py` |

### Node 工具

部署校验仍是 Node 脚本，统一放到 `scripts/node-tools/`；用途和测试见 `scripts/node-tools/README.md`。

| 脚本 | 用途 | 常用入口 |
| --- | --- | --- |
| `deploy-doctor.mjs` | 部署环境自检。 | `pnpm deploy:doctor` |
| `web-deploy-smoke.mjs` | 部署后 smoke。 | `pnpm deploy:smoke` |

## 测试

```bash
python3 scripts/tools/repo_hygiene_check_test.py
python3 scripts/tools/visual_check_test.py
python3 scripts/tools/fetch_song_covers_test.py
python3 scripts/tools/generate_cover_thumbnails_test.py
python3 scripts/tools/fetch_hot_song_candidates_test.py
python3 scripts/tools/fetch_chart_scores_test.py
python3 scripts/tools/fetch_playlist_scores_test.py
python3 scripts/tools/merge_music_scores_test.py
python3 scripts/tools/delete_uncovered_songs_test.py
python3 scripts/tools/run_style_tagging_llm_batch_test.py
python3 scripts/tools/android_app_icon_pipeline_test.py
node --test scripts/node-tools/deploy-doctor.test.mjs
node --test scripts/node-tools/web-deploy-smoke.test.mjs
```

## 当前整理状态

- 已合并：`ui-visual-check.mjs`、`tv-visual-check.mjs` -> `visual_check.py`
- 已迁移：`repo-hygiene-check.mjs` -> `repo_hygiene_check.py`
- 已收拢：部署 Node 脚本 -> `scripts/node-tools/`
