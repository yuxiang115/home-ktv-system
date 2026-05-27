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
  stop        Stop services
  config      Render docker compose config
  help        Show this help
USAGE
}

compose() {
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
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
service="${2:-}"

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
