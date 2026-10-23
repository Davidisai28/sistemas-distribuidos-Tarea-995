#!/bin/sh
set -eu

HOST="${3:?Falta direccion del nodo}"
PORT="${4:?Falta puerto del nodo}"

: "${DB_USER:?Falta DB_USER}"
: "${DB_PASSWORD:?Falta DB_PASSWORD}"

STATUS=$(
  MYSQL_PWD="$DB_PASSWORD" mariadb \
    --protocol=tcp \
    --host="$HOST" \
    --port="$PORT" \
    --user="$DB_USER" \
    --connect-timeout=2 \
    --batch \
    --skip-column-names \
    -e "SHOW GLOBAL STATUS WHERE Variable_name IN ('wsrep_local_state_comment','wsrep_cluster_status','wsrep_ready')" \
    2>/dev/null
) || exit 1

printf '%s\n' "$STATUS" | awk '
  $1 == "wsrep_local_state_comment" && $2 == "Synced"  { synced = 1 }
  $1 == "wsrep_cluster_status"     && $2 == "Primary" { primary = 1 }
  $1 == "wsrep_ready"              && $2 == "ON"      { ready = 1 }
  END {
    if (synced && primary && ready) exit 0
    exit 1
  }
'
