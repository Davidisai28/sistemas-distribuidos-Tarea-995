#!/bin/sh
set -eu

NODE_NAME="${1:?Falta el nombre del nodo}"

case "$NODE_NAME" in
  redis|redis-replica) ;;
  *) echo "Nodo no reconocido: $NODE_NAME"; exit 1 ;;
esac

MASTER_HOST=""
INTENTO=0
MAX_INTENTOS=12

while [ "$INTENTO" -lt "$MAX_INTENTOS" ] &&
      [ -z "$MASTER_HOST" ]; do

  for SENTINEL in \
    redis-sentinel-1 \
    redis-sentinel-2 \
    redis-sentinel-3
  do
    RESPUESTA=$(
      timeout 3 redis-cli -h "$SENTINEL" \
        -p 26379 --raw \
        SENTINEL get-master-addr-by-name mymaster \
        2>/dev/null
    ) || continue

    HOST=$(printf '%s\n' "$RESPUESTA" | sed -n '1p')
    PORT=$(printf '%s\n' "$RESPUESTA" | sed -n '2p')

    case "$HOST:$PORT" in
      redis:6379|redis-replica:6379)
        MASTER_HOST="$HOST"
        break
        ;;
    esac
  done

  if [ -z "$MASTER_HOST" ]; then
    INTENTO=$((INTENTO + 1))
    echo "Esperando Sentinel: intento $INTENTO"
    sleep 2
  fi
done

if [ -z "$MASTER_HOST" ]; then
  echo "ERROR: Sentinel no disponible."
  echo "No se asumira un primario sin confirmacion."
  exit 1
fi

echo "Nodo: $NODE_NAME"
echo "Primario identificado: $MASTER_HOST"

set -- redis-server \
  --save "" \
  --appendonly no \
  --replica-announce-ip "$NODE_NAME" \
  --replica-announce-port 6379

if [ "$NODE_NAME" != "$MASTER_HOST" ]; then
  echo "Iniciando como replica de $MASTER_HOST"
  set -- "$@" --replicaof "$MASTER_HOST" 6379
else
  echo "Iniciando como PRIMARY"
fi

exec "$@"
