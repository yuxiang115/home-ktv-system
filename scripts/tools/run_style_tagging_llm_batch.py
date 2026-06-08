#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


SOURCE = "llm-style-v1"
DEFAULT_BATCH_SIZE = 30
DEFAULT_CONFIDENCE = 0.72

KTV_STYLE_TAXONOMY = [
    {
        "id": "language-region",
        "name": "语种地区",
        "sortOrder": 10,
        "tags": ["粤语", "闽南语", "客家语", "英语", "日语", "韩语", "港台", "港乐", "台语"],
    },
    {
        "id": "core-genre",
        "name": "核心曲风",
        "sortOrder": 20,
        "tags": [
            "流行",
            "粤语流行",
            "摇滚",
            "流行摇滚",
            "另类摇滚",
            "独立摇滚",
            "民谣",
            "校园民谣",
            "民歌",
            "民族",
            "民族流行",
            "草原",
            "R&B",
            "灵魂乐",
            "说唱",
            "电子",
            "流行舞曲",
            "舞曲",
            "DJ",
            "迪斯科",
            "浩室",
            "放克",
            "爵士",
            "布鲁斯",
            "古典",
            "轻音乐",
            "器乐",
            "新世纪",
            "戏曲",
            "京剧",
            "黄梅戏",
            "越剧",
            "儿歌",
            "童谣",
            "宗教/佛乐",
        ],
    },
    {
        "id": "mood-theme",
        "name": "主题情绪",
        "sortOrder": 30,
        "tags": [
            "情歌",
            "甜蜜",
            "浪漫",
            "伤感",
            "失恋",
            "思念",
            "孤独",
            "治愈",
            "励志",
            "热血",
            "青春回忆",
            "怀旧",
            "亲情",
            "友情",
            "友情/兄弟",
            "爱国",
            "红歌/革命歌曲",
            "军旅",
            "思乡",
            "校园",
            "婚礼",
            "离别",
            "励志合唱",
        ],
    },
    {
        "id": "ktv-scene",
        "name": "KTV场景",
        "sortOrder": 40,
        "tags": [
            "KTV必点",
            "经典老歌",
            "冷门佳曲",
            "热门",
            "对唱",
            "合唱",
            "女生",
            "男声",
            "女声",
            "高音",
            "低音",
            "容易唱",
            "飙歌",
            "广场舞",
            "车载",
            "运动/节奏",
            "酒吧",
            "晚会",
            "春晚",
            "生日歌",
            "喜庆/节日",
            "婚礼歌曲",
            "影视金曲",
            "动漫/ACG",
        ],
    },
    {
        "id": "era-version",
        "name": "年代版本",
        "sortOrder": 50,
        "tags": [
            "50/60年代",
            "70/80年代",
            "80/90年代",
            "70后",
            "80后",
            "90后",
            "00后",
            "00年代",
            "10年代",
            "20年代",
            "现场/演唱会",
            "Live",
            "DJ版",
            "翻唱",
            "怀旧金曲",
            "网络歌曲",
        ],
    },
]

ALLOWED_TAGS = frozenset(tag for group in KTV_STYLE_TAXONOMY for tag in group["tags"])
TAG_GROUP_BY_TAG = {tag: group["name"] for group in KTV_STYLE_TAXONOMY for tag in group["tags"]}


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    load_env_file(args.env_file)

    if args.command == "status":
        status(args)
    elif args.command == "run":
        run(args)
    elif args.command == "import":
        import_results(args)
    elif args.command == "run-and-import":
        run(args)
        import_results(args)
    else:
        raise SystemExit(f"Unknown command: {args.command}")


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Run batched LLM style tagging outside the API container.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    for command in ("status", "run", "import", "run-and-import"):
        sub = subparsers.add_parser(command)
        add_common_args(sub)
        if command in ("run", "run-and-import", "status"):
            add_selection_args(sub)
        if command in ("run", "run-and-import"):
            add_llm_args(sub)
        if command in ("import", "run-and-import"):
            sub.add_argument("--apply", action="store_true", help="Write the JSONL results back to the database.")
            sub.add_argument("--dry-run", action="store_true", help="Validate and summarize without writing.")

    args = parser.parse_args(argv)
    if getattr(args, "dry_run", False) and getattr(args, "apply", False):
        parser.error("--dry-run and --apply cannot be used together")
    if args.command in ("import", "run-and-import") and not args.apply and not args.dry_run:
        args.dry_run = True
    return args


def add_common_args(parser):
    parser.add_argument("--env-file", default=os.environ.get("KTV_ENV_FILE", "deploy/docker/.env"))
    parser.add_argument("--database-url", default="")
    parser.add_argument("--postgres-container", default=os.environ.get("KTV_POSTGRES_CONTAINER", ""))
    parser.add_argument("--db-user", default=os.environ.get("PGUSER", "ktv"))
    parser.add_argument("--db-name", default=os.environ.get("PGDATABASE", "home_ktv"))
    parser.add_argument("--job-root", default=os.environ.get("KTV_STYLE_TAG_JOB_ROOT", "runtime/tagging/llm"))
    parser.add_argument("--output", default="")
    parser.add_argument("--state", default="")


def add_selection_args(parser):
    parser.add_argument("--batch-size", type=positive_int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--limit", type=non_negative_int, default=0, help="0 means all current candidates.")
    parser.add_argument("--max-existing-tags", type=non_negative_int, default=1)


def add_llm_args(parser):
    parser.add_argument("--llm-base-url", default="")
    parser.add_argument("--llm-api-key", default="")
    parser.add_argument("--llm-model", default="")
    parser.add_argument("--max-tags", type=positive_int, default=6)
    parser.add_argument("--max-tokens", type=positive_int, default=2048)
    parser.add_argument("--timeout-seconds", type=positive_int, default=180)
    parser.add_argument("--max-retries", type=positive_int, default=5)
    parser.add_argument("--sleep-ms", type=positive_int, default=60_000)
    parser.add_argument("--progress-every", type=positive_int, default=1)


def run(args):
    output = resolve_output_path(args)
    state_path = resolve_state_path(args, output)
    ensure_parent(output)
    ensure_parent(state_path)

    songs = select_candidate_songs(args)
    completed = read_completed_song_ids(output)
    pending = [song for song in songs if song["id"] not in completed]
    model = resolve_llm_model(args)
    write_state(
        state_path,
        {
            "status": "running",
            "output": str(output),
            "selected": len(songs),
            "completed": len(completed),
            "pending": len(pending),
            "maxExistingTags": args.max_existing_tags,
            "model": model,
            "updatedAt": now_iso(),
        },
    )

    print(f"selected={len(songs)} completed={len(completed)} pending={len(pending)} output={output}", flush=True)
    if not pending:
        write_state(
            state_path,
            {
                "status": "completed",
                "output": str(output),
                "selected": len(songs),
                "completed": len(completed),
                "pending": 0,
                "maxExistingTags": args.max_existing_tags,
                "model": model,
                "updatedAt": now_iso(),
            },
        )
        return

    for batch_index, batch in enumerate(chunks(pending, args.batch_size), start=1):
        results = complete_batch_with_retries(batch, args)
        append_result_rows(output, build_result_rows(batch, results, model))
        completed.update(song["id"] for song in batch)
        remaining = len(songs) - len(completed)
        if batch_index % args.progress_every == 0 or remaining == 0:
            print(
                f"batch={batch_index} wrote={len(batch)} completed={len(completed)}/{len(songs)} remaining={remaining}",
                flush=True,
            )
        write_state(
            state_path,
            {
                "status": "running" if remaining else "completed",
                "output": str(output),
                "selected": len(songs),
                "completed": len(completed),
                "pending": remaining,
                "maxExistingTags": args.max_existing_tags,
                "model": model,
                "updatedAt": now_iso(),
            },
        )


def status(args):
    output = resolve_output_path(args)
    state_path = resolve_state_path(args, output)
    pending_count = count_candidate_songs(args)
    rows = read_result_rows(output)
    summary = summarize_rows(rows)
    print(f"dbPending={pending_count} maxExistingTags={args.max_existing_tags}")
    print(f"output={output}")
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    if state_path.exists():
        print(f"state={state_path}")
        print(state_path.read_text(encoding="utf-8").strip())


def import_results(args):
    output = resolve_output_path(args)
    rows = read_result_rows(output)
    summary = summarize_rows(rows)
    if not rows:
        raise SystemExit(f"No JSONL result rows found: {output}")
    validate_unique_song_rows(rows)
    print(json.dumps({"input": str(output), **summary}, ensure_ascii=False, sort_keys=True), flush=True)
    if getattr(args, "dry_run", False):
        print("dryRun=true; database was not changed")
        return

    sql = build_import_sql(rows)
    run_psql_script(sql, args)
    print(f"imported={len(rows)} tagged={summary['tagged']} empty={summary['empty']} failed={summary['failed']}", flush=True)


def build_batch_prompt_songs_and_prompt(songs):
    prompt_songs = [
        {"id": str(index + 1), "title": song["title"], "artistName": song["primary_artist_name"]}
        for index, song in enumerate(songs)
    ]
    prompt = "\n".join(
        [
            "请为下面每首歌返回适合的 KTV 曲库标签。",
            "输入歌曲 JSON:",
            json.dumps(prompt_songs, ensure_ascii=False, separators=(",", ":")),
            "要求: results 数量必须等于输入歌曲数量；不要解释；不要输出 Markdown。",
        ]
    )
    return prompt_songs, prompt


def build_system_prompt():
    taxonomy = "\n".join(f"{group['name']}: {'、'.join(group['tags'])}" for group in KTV_STYLE_TAXONOMY)
    return "\n".join(
        [
            "你是家庭 KTV 曲库标签助手。",
            "只能从给定白名单中选择标签，不能创造新标签。",
            "根据歌名和歌手判断语种、曲风、情绪、KTV场景和年代版本。",
            "每首歌最多返回 6 个标签，优先选择对点歌筛选有用的标签。",
            "必须为输入中的每一个数字 id 返回且只返回一条结果，id 必须原样保留。",
            "不要返回 UUID、歌名或解释文字作为 id。",
            '只输出 JSON，格式为 {"results":[{"id":"1","tags":["标签1","标签2"]}]}。',
            "",
            taxonomy,
        ]
    )


def complete_batch_with_retries(batch, args):
    last_error = None
    for attempt in range(1, args.max_retries + 1):
        try:
            return complete_batch(batch, args)
        except Exception as error:
            last_error = error
            print(f"batch failed attempt={attempt}/{args.max_retries} error={error}", flush=True)
            if attempt < args.max_retries:
                time.sleep(args.sleep_ms / 1000)
    raise RuntimeError(f"batch failed after {args.max_retries} attempts: {last_error}")


def complete_batch(batch, args):
    prompt_songs, user_prompt = build_batch_prompt_songs_and_prompt(batch)
    content = call_llm(
        base_url=resolve_llm_base_url(args),
        api_key=resolve_llm_api_key(args),
        model=resolve_llm_model(args),
        system_prompt=build_system_prompt(),
        user_prompt=user_prompt,
        max_tokens=args.max_tokens,
        timeout_seconds=args.timeout_seconds,
    )
    return parse_batch_response(content, prompt_songs, args.max_tags)


def call_llm(base_url, api_key, model, system_prompt, user_prompt, max_tokens, timeout_seconds):
    if not base_url:
        raise RuntimeError("LLM base URL is required")
    if not api_key:
        raise RuntimeError("LLM API key is required")
    if not model:
        raise RuntimeError("LLM model is required")
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    request = urllib.request.Request(
        resolve_chat_completions_url(base_url),
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "authorization": f"Bearer {api_key}",
            "content-type": "application/json",
            "user-agent": "HomeKTVStyleTaggerPython/0.1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"LLM API HTTP {error.code}: {detail}") from error
    content = data.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("LLM API response did not include message content")
    return content


def parse_batch_response(content, prompt_songs, max_tags=6):
    parsed = json.loads(extract_json_object(content))
    raw_results = parsed.get("results")
    if not isinstance(raw_results, list):
        raise ValueError("LLM batch response must include results array")
    expected_ids = {song["id"] for song in prompt_songs}
    results = {}
    for raw_result in raw_results:
        if not isinstance(raw_result, dict):
            raise ValueError("LLM batch response result must be an object")
        result_id = str(raw_result.get("id", "")).strip()
        if result_id not in expected_ids:
            raise ValueError(f"unexpected result id {result_id or '<empty>'}")
        if result_id in results:
            raise ValueError(f"duplicate result id {result_id}")
        results[result_id] = normalize_tags(raw_result.get("tags", []), max_tags)
    for song in prompt_songs:
        if song["id"] not in results:
            raise ValueError(f"missing result id {song['id']}")
    return results


def normalize_tags(raw_tags, max_tags=6):
    if not isinstance(raw_tags, list):
        return []
    seen = set()
    tags = []
    for raw_tag in raw_tags:
        if not isinstance(raw_tag, str):
            continue
        tag = raw_tag.strip()
        if tag not in ALLOWED_TAGS or tag in seen:
            continue
        seen.add(tag)
        tags.append(tag)
        if len(tags) >= max_tags:
            break
    return tags


def extract_json_object(content):
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", content, flags=re.IGNORECASE)
    if fenced:
        return fenced.group(1).strip()
    start = content.find("{")
    end = content.rfind("}")
    if start >= 0 and end > start:
        return content[start : end + 1]
    return content.strip()


def build_result_rows(batch, results, model):
    rows = []
    for index, song in enumerate(batch):
        prompt_id = str(index + 1)
        tags = results[prompt_id]
        rows.append(
            {
                "songId": song["id"],
                "title": song["title"],
                "artistName": song["primary_artist_name"],
                "status": "tagged" if tags else "empty",
                "tags": tags,
                "source": SOURCE,
                "model": model,
                "confidence": DEFAULT_CONFIDENCE if tags else None,
                "evidence": ["llm-style-v1:batch-tag"] if tags else [],
                "createdAt": now_iso(),
            }
        )
    return rows


def select_candidate_songs(args):
    sql = candidate_sql(args.max_existing_tags, args.limit)
    return [json.loads(line) for line in run_psql_lines(sql, args)]


def count_candidate_songs(args):
    sql = f"SELECT count(*) FROM ({candidate_sql(args.max_existing_tags, args.limit)}) candidate_count"
    lines = run_psql_lines(sql, args)
    return int(lines[0]) if lines else 0


def candidate_sql(max_existing_tags, limit):
    limit_sql = "" if limit == 0 else f"LIMIT {int(limit)}"
    return f"""
WITH existing_tags AS (
  SELECT s.id AS song_id,
         cardinality(s.style_tags)::integer AS tag_count
  FROM ktv_songs s
)
SELECT json_build_object(
  'id', s.id,
  'title', s.title,
  'primary_artist_name', s.primary_artist_name,
  'tag_count', existing_tags.tag_count
)::text
FROM ktv_songs s
JOIN existing_tags ON existing_tags.song_id = s.id
WHERE s.missing_at IS NULL
  AND existing_tags.tag_count <= {int(max_existing_tags)}
ORDER BY existing_tags.tag_count ASC, s.updated_at DESC, s.id ASC
{limit_sql}
""".strip()


def run_psql_lines(sql, args):
    result = run_psql(["-At", "-c", sql], args, capture=True)
    return [line for line in result.stdout.splitlines() if line.strip()]


def run_psql_script(sql, args):
    run_psql(["-v", "ON_ERROR_STOP=1", "-f", "-"], args, capture=False, input_text=sql)


def run_psql(psql_args, args, capture, input_text=None):
    command = build_psql_command(args) + psql_args
    result = subprocess.run(
        command,
        input=input_text,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=False,
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(stderr or f"psql failed with code {result.returncode}")
    return result


def build_psql_command(args):
    container = args.postgres_container.strip() or detect_postgres_container()
    if container:
        return ["docker", "exec", "-i", container, "psql", "-U", args.db_user, "-d", args.db_name]
    if shutil.which("psql"):
        return ["psql", resolve_database_url(args)]
    raise RuntimeError("psql is not installed and no Postgres container was found; pass --postgres-container")


def detect_postgres_container():
    if shutil.which("docker") is None:
        return ""
    try:
        result = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return ""
    if result.returncode != 0:
        return ""
    names = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    preferred = ["home-ktv-postgres-1", "home-ktv-postgres"]
    for name in preferred:
        if name in names:
            return name
    for name in names:
        if "home-ktv" in name and "postgres" in name:
            return name
    return ""


def build_import_sql(rows):
    statements = ["BEGIN;"]
    for row in rows:
        statements.extend(song_import_sql(row))
    statements.append("COMMIT;")
    return "\n".join(statements)


def song_import_sql(row):
    song_id = row["songId"]
    status = row.get("status")
    tags = normalize_tags(row.get("tags", []))
    if status not in ("tagged", "empty", "failed"):
        raise ValueError(f"invalid row status for song {song_id}: {status}")
    if status == "tagged" and not tags:
        status = "empty"
    statements = []
    if status == "tagged":
        statements.append(
            f"""
UPDATE ktv_songs
SET style_tags = {sql_text_array(tags)},
    updated_at = now()
WHERE id = {sql_literal(song_id)};
""".strip()
        )
    return statements


def sql_literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def sql_text_array(values):
    return "ARRAY[" + ", ".join(sql_literal(value) for value in values) + "]::text[]"


def append_result_rows(output, rows):
    with output.open("a", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        file.flush()
        os.fsync(file.fileno())


def read_completed_song_ids(output):
    return {row["songId"] for row in read_result_rows(output) if "songId" in row}


def read_result_rows(output):
    if not output.exists():
        return []
    rows = []
    with output.open("r", encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid JSONL at {output}:{line_number}: {error}") from error
    return rows


def validate_unique_song_rows(rows):
    seen = set()
    for row in rows:
        song_id = row.get("songId")
        if not song_id:
            raise ValueError("result row missing songId")
        if song_id in seen:
            raise ValueError(f"duplicate songId in result file: {song_id}")
        seen.add(song_id)


def summarize_rows(rows):
    summary = {
        "total": 0,
        "tagged": 0,
        "empty": 0,
        "failed": 0,
        "tagsTotal": 0,
        "maxTags": 0,
    }
    for row in rows:
        status = row.get("status", "failed")
        if status not in ("tagged", "empty", "failed"):
            status = "failed"
        tags = normalize_tags(row.get("tags", []))
        summary["total"] += 1
        summary[status] += 1
        summary["tagsTotal"] += len(tags)
        summary["maxTags"] = max(summary["maxTags"], len(tags))
    summary["averageTags"] = round(summary["tagsTotal"] / summary["tagged"], 3) if summary["tagged"] else 0
    return summary


def resolve_output_path(args):
    if args.output:
        return Path(args.output)
    job_root = Path(args.job_root)
    command_name = "run" if args.command == "status" else args.command
    return job_root / f"{command_name}-llm-style-tags-{format_timestamp()}.jsonl"


def resolve_state_path(args, output):
    if args.state:
        return Path(args.state)
    return output.with_suffix(output.suffix + ".state.json")


def ensure_parent(path):
    path.parent.mkdir(parents=True, exist_ok=True)


def write_state(path, state):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def chunks(values, size):
    for index in range(0, len(values), size):
        yield values[index : index + size]


def resolve_llm_base_url(args):
    return args.llm_base_url or os.environ.get("KTV_LLM_BASE_URL") or os.environ.get("LLM_API_BASE_URL", "")


def resolve_llm_api_key(args):
    return args.llm_api_key or os.environ.get("KTV_LLM_API_KEY") or os.environ.get("LLM_API_KEY", "")


def resolve_llm_model(args):
    return args.llm_model or os.environ.get("KTV_LLM_MODEL") or os.environ.get("LLM_MODEL") or "gpt-5.5"


def resolve_database_url(args):
    return args.database_url or os.environ.get("DATABASE_URL") or "postgres://ktv:ktv@127.0.0.1:5432/home_ktv"


def resolve_chat_completions_url(raw_base_url):
    base_url = raw_base_url if re.match(r"^[a-z][a-z0-9+.-]*://", raw_base_url, re.IGNORECASE) else f"http://{raw_base_url}"
    parsed = urlparse(base_url)
    path = parsed.path.rstrip("/")
    if path.endswith("/chat/completions"):
        resolved_path = path
    elif path.endswith("/v1"):
        resolved_path = f"{path}/chat/completions"
    else:
        resolved_path = f"{path}/v1/chat/completions"
    return parsed._replace(path=resolved_path).geturl()


def load_env_file(path):
    if not path:
        return
    env_path = Path(path)
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = strip_quotes(value.strip())
        if key and key not in os.environ:
            os.environ[key] = value


def strip_quotes(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def positive_int(raw):
    value = int(raw)
    if value <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return value


def non_negative_int(raw):
    value = int(raw)
    if value < 0:
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    return value


def format_timestamp():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def find_tag_group(tag):
    tag_group = TAG_GROUP_BY_TAG.get(tag)
    if not tag_group:
        raise ValueError(f"unknown style tag group for tag: {tag}")
    return tag_group


if __name__ == "__main__":
    main()
