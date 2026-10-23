# Alta disponibilidad de Redis con Sentinel

## 1. Objetivo

Se configuró Redis Sentinel para evitar que el sistema dependa de un único servidor de caché. Esta solución permite supervisar el servidor principal y promover automáticamente una réplica cuando se detecta una falla.

Redis se utiliza como una caché temporal para mejorar el tiempo de respuesta de algunas consultas. Los datos originales del catálogo se mantienen en MariaDB Galera, mientras que las reseñas se almacenan en MongoDB.

## 2. Arquitectura implementada

La solución cuenta con dos servidores Redis: uno funciona como principal y el otro como réplica. Sus funciones pueden cambiar cuando ocurre un failover.

También se configuraron tres instancias de Redis Sentinel, con un quórum de dos, encargadas de supervisar al servidor principal y participar en su recuperación ante fallos.

Las tres API consultan a Sentinel para identificar el servidor principal. Además, se creó una red interna llamada `redis-ha`, con direcciones IP estables, sin eliminar la conexión a la red `database`.

## 3. Direcciones de la red Redis HA

| Servicio | Dirección IP |
|---|---|
| redis | 172.29.95.10 |
| redis-replica | 172.29.95.11 |
| redis-sentinel-1 | 172.29.95.21 |
| redis-sentinel-2 | 172.29.95.22 |
| redis-sentinel-3 | 172.29.95.23 |

## 4. Archivos de configuración

La configuración de Redis HA se encuentra distribuida en los archivos de Docker Compose y en la carpeta `redis-sentinel/`.

El archivo `docker-compose.redis-ha.yml` define la red interna, las direcciones IP estables y las dependencias de arranque. Por su parte, `start-redis.sh` consulta a Sentinel para identificar el servidor principal antes de iniciar Redis.

Las configuraciones de los tres Sentinel permiten supervisar el servicio y conservar la información del primario elegido después de un failover.

## 5. Prueba de failover

Se realizó una prueba controlada deteniendo el servidor Redis principal mediante `docker stop`.

Los tres Sentinel detectaron el cambio y reconocieron a `redis-replica` como nuevo primario, sin entrar en estado TILT. Posteriormente, el servidor original se reincorporó como réplica y recuperó la sincronización.

Durante la recuperación, la API presentó temporalmente el estado `degraded`. Después volvió a responder con `status: ok` y `redis: ok`, lo que confirmó la recuperación de la conexión con Redis.

Esta prueba se realizó antes de la última recreación de `redis` con su configuración de red definitiva. Las pruebas formales posteriores permitirán comprobar nuevamente su comportamiento.
