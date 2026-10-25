#!/bin/sh
# Chequeo HTTP para HAProxy presentación: no depende de API/Redis/Galera/web.
set -eu
PORT="${1:-80}"
case "$PORT" in 80) ;; *) exit 2 ;; esac
exec wget -q -T 2 -t 1 -O /dev/null "http://127.0.0.1:${PORT}/__haproxy_alive_995"
