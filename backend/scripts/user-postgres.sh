#!/usr/bin/env bash

set -Eeuo pipefail

ACTION="${1:-status}"
PG_ROOT="${PG_ROOT:-/Library/PostgreSQL/18}"
PG_BIN="$PG_ROOT/bin"
BASE_DIR="${PIDGE_POSTGRES_HOME:-$HOME/Library/Application Support/Pidge/Postgres18}"
DATA_DIR="$BASE_DIR/data"
SOCKET_DIR="$BASE_DIR/socket"
LOG_FILE="$BASE_DIR/postgres.log"
PORT="${PIDGE_POSTGRES_PORT:-55432}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$BACKEND_DIR/.env"

require_binary() {
  if [[ ! -x "$1" ]]; then
    echo "Required PostgreSQL binary is unavailable: $1" >&2
    exit 1
  fi
}

require_cluster() {
  if [[ ! -f "$DATA_DIR/PG_VERSION" ]]; then
    echo "Pidge's user-owned database has not been initialized." >&2
    echo "Run: npm run db:bootstrap" >&2
    exit 1
  fi
}

is_running() {
  "$PG_BIN/pg_ctl" status -D "$DATA_DIR" >/dev/null 2>&1
}

start_cluster() {
  require_cluster
  mkdir -p "$SOCKET_DIR"
  chmod 700 "$BASE_DIR" "$DATA_DIR" "$SOCKET_DIR"
  if is_running; then
    echo "Pidge PostgreSQL is already running on port $PORT."
    return
  fi
  "$PG_BIN/pg_ctl" start -D "$DATA_DIR" -l "$LOG_FILE"
  "$PG_BIN/pg_isready" -h "$SOCKET_DIR" -p "$PORT" -U pidge_admin
}

bootstrap_cluster() {
  if [[ -f "$DATA_DIR/PG_VERSION" ]]; then
    if [[ ! -f "$ENV_FILE" ]]; then
      echo "$DATA_DIR exists, but $ENV_FILE is missing." >&2
      echo "Restore the matching environment file instead of rotating credentials implicitly." >&2
      exit 1
    fi
    start_cluster
    npm --prefix "$BACKEND_DIR" run migrate
    return
  fi

  if [[ -f "$ENV_FILE" ]]; then
    echo "$ENV_FILE already exists without a matching user-owned database." >&2
    echo "Move it aside before bootstrapping a new cluster." >&2
    exit 1
  fi

  require_binary "$PG_BIN/initdb"
  require_binary "$PG_BIN/createdb"
  if ! command -v openssl >/dev/null 2>&1; then
    echo "Required command is unavailable: openssl" >&2
    exit 1
  fi
  mkdir -p "$DATA_DIR" "$SOCKET_DIR"
  chmod 700 "$BASE_DIR" "$DATA_DIR" "$SOCKET_DIR"

  local password_file admin_password app_password
  password_file="$(mktemp /tmp/pidge-initdb.XXXXXX)"
  admin_password="$(openssl rand -hex 32)"
  app_password="$(openssl rand -hex 32)"
  trap 'if [[ -n "${password_file:-}" ]]; then unlink "$password_file" 2>/dev/null || true; fi' EXIT
  printf '%s\n' "$admin_password" >"$password_file"
  chmod 600 "$password_file"

  "$PG_BIN/initdb" -D "$DATA_DIR" \
    --username=pidge_admin \
    --pwfile="$password_file" \
    --auth-local=trust \
    --auth-host=scram-sha-256 \
    --encoding=UTF8 \
    --locale=C
  unlink "$password_file"
  password_file=""
  trap - EXIT

  cat >>"$DATA_DIR/postgresql.conf" <<EOF

# Pidge user-owned development cluster
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$SOCKET_DIR'
EOF

  start_cluster

  PGHOST="$SOCKET_DIR" PGPORT="$PORT" "$PG_BIN/psql" \
    -U pidge_admin -d postgres --set=ON_ERROR_STOP=1 \
    --set=app_password="$app_password" <<'SQL'
SELECT format('CREATE ROLE pidge_app WITH LOGIN PASSWORD %L', :'app_password') \gexec
SQL
  PGHOST="$SOCKET_DIR" PGPORT="$PORT" "$PG_BIN/createdb" \
    -U pidge_admin -O pidge_app pidge_parking
  PGHOST="$SOCKET_DIR" PGPORT="$PORT" "$PG_BIN/psql" \
    -U pidge_admin -d pidge_parking --set=ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER DATABASE pidge_parking OWNER TO pidge_app;
SQL

  cat >"$ENV_FILE" <<EOF
DATABASE_URL=postgresql://pidge_app:${app_password}@127.0.0.1:${PORT}/pidge_parking
PORT=8080
TIMEZONE=America/New_York
VIEWPORT_MAX_SEGMENTS=6000

# Add a newly issued Socrata app token for higher ingestion rate limits.
NYC_APP_TOKEN=
NYC_BASE_URL=https://data.cityofnewyork.us/resource
NYC_METER_DATASET_ID=e7yp-wx55
NYC_SIGNS_DATASET_ID=nfid-uabd
NYC_GEOMETRY_DATASET_ID=6yyb-pb25
NYC_HYDRANT_DATASET_ID=5bgh-vtsn
NYC_GARAGE_DATASET_ID=ptfx-m7u5
GEOSEARCH_BASE_URL=https://geosearch.planninglabs.nyc/v2
NYC_PAGE_LIMIT=5000
NYC_GEOMETRY_PAGE_LIMIT=50000
NYC_MAX_PAGES=0
EOF
  chmod 600 "$ENV_FILE"
  npm --prefix "$BACKEND_DIR" run migrate
  echo "Pidge PostgreSQL is ready. Run 'npm --prefix backend run ingest:all' to load NYC data."
}

require_binary "$PG_BIN/pg_ctl"
require_binary "$PG_BIN/pg_isready"
require_binary "$PG_BIN/psql"

case "$ACTION" in
  bootstrap)
    bootstrap_cluster
    ;;
  start)
    start_cluster
    ;;
  stop)
    require_cluster
    if is_running; then
      "$PG_BIN/pg_ctl" stop -D "$DATA_DIR" -m fast
    else
      echo "Pidge PostgreSQL is already stopped."
    fi
    ;;
  status)
    require_cluster
    "$PG_BIN/pg_ctl" status -D "$DATA_DIR"
    ;;
  *)
    echo "Usage: $0 {bootstrap|start|stop|status}" >&2
    exit 2
    ;;
esac
