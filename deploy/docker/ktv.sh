#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${KTV_ENV_FILE:-${SCRIPT_DIR}/.env}"
EXAMPLE_ENV="${ROOT_DIR}/deploy/env/server.env.example"
COMPOSE_FILE="${SCRIPT_DIR}/compose.yml"

usage() {
  cat <<'USAGE'
Usage: bash deploy/docker/ktv.sh <command> [service]

Commands:
  setup       Create .env and runtime directories
  pull        git pull --ff-only
  build       Build Docker images
  start       Start services
  restart     Restart services
  status      Show service status
  logs [svc]  Follow logs for all services or one service
  doctor      Run deployment self-checks
  probe-index Probe indexed KTV media technical metadata inside the API container
  tag-styles  Tag indexed KTV songs with style tags inside the API container
  tag-styles-export Export active indexed songs to JSONL inside the API container
  tag-styles-jsonl  Tag exported songs from JSONL without database dependency
  tag-styles-job    Manage an independent JSONL style tagging job container
  tag-styles-import Import staged JSONL style tag results into PostgreSQL
  fetch-covers Batch fetch song cover metadata inside the API container
  cover-coverage Test cover lookup coverage without writing database rows
  stop        Stop services
  config      Render docker compose config
  help        Show this help
USAGE
}

compose() {
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

compose_exec_env_args() {
  local name
  for name in "$@"; do
    if [[ -n "${!name:-}" ]]; then
      printf '%s\n' "-e"
      printf '%s\n' "${name}"
    fi
  done
}

ensure_env() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "Missing ${ENV_FILE}. Run setup first." >&2
    exit 1
  fi
}

setup() {
  mkdir -p "${SCRIPT_DIR}" "${ROOT_DIR}/runtime/media" "${ROOT_DIR}/runtime/nas/KTV歌曲"
  if [[ ! -f "${ENV_FILE}" ]]; then
    cp "${EXAMPLE_ENV}" "${ENV_FILE}"
    echo "Created ${ENV_FILE}"
    echo "Edit it before starting services."
  else
    echo "${ENV_FILE} already exists"
  fi
}

command="${1:-help}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "${command}" in
  setup)
    setup
    ;;
  pull)
    git -C "${ROOT_DIR}" pull --ff-only
    ;;
  build)
    ensure_env
    compose build
    ;;
  start)
    ensure_env
    compose up -d --build
    ;;
  restart)
    ensure_env
    compose up -d --build --force-recreate
    ;;
  status)
    ensure_env
    compose ps
    ;;
  logs)
    ensure_env
    service="${1:-}"
    if [[ -n "${service}" ]]; then
      compose logs -f "${service}"
    else
      compose logs -f
    fi
    ;;
  doctor)
    ensure_env
    node "${ROOT_DIR}/scripts/tools/deploy-doctor.mjs" \
      --mode docker \
      --env-file "${ENV_FILE}" \
      --service-status-cmd "docker compose --env-file '${ENV_FILE}' -f '${COMPOSE_FILE}' ps"
    ;;
  probe-index)
    ensure_env
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    compose exec -T api pnpm -F @home-ktv/api probe:ktv-index -- "$@"
    ;;
  tag-styles)
    ensure_env
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    mapfile -t exec_env_args < <(compose_exec_env_args \
      LLM_API_BASE_URL \
      LLM_API_KEY \
      LLM_MODEL \
      LLM_MAX_TOKENS \
      LLM_TIMEOUT_MS \
      KTV_LLM_BASE_URL \
      KTV_LLM_API_KEY \
      KTV_LLM_MODEL \
      KTV_LLM_MAX_TOKENS \
      KTV_LLM_TIMEOUT_MS)
    compose exec -T "${exec_env_args[@]}" api pnpm -F @home-ktv/api tag:ktv-styles -- "$@"
    ;;
  tag-styles-export)
    ensure_env
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    compose exec -T api pnpm -F @home-ktv/api tag:ktv-styles:export -- "$@"
    ;;
  tag-styles-jsonl)
    ensure_env
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    compose exec -T api pnpm -F @home-ktv/api tag:ktv-styles:jsonl -- "$@"
    ;;
  tag-styles-job)
    ensure_env
    node "${ROOT_DIR}/scripts/tools/style-tagging-job.mjs" "$@"
    ;;
  tag-styles-import)
    ensure_env
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    compose exec -T api pnpm -F @home-ktv/api tag:ktv-styles:import -- "$@"
    ;;
  fetch-covers)
    ensure_env
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    compose exec -T api pnpm -F @home-ktv/api covers:songs -- "$@"
    ;;
  cover-coverage)
    ensure_env
    if [[ "${1:-}" == "--" ]]; then
      shift
    fi
    compose exec -T api pnpm -F @home-ktv/api covers:coverage -- "$@"
    ;;
  stop)
    ensure_env
    compose down
    ;;
  config)
    ensure_env
    compose config
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
