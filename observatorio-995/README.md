# Observatorio 995 — v0.3

Panel de **solo lectura** para la Tarea #995 de Sistemas Distribuidos. Presenta un resumen de la arquitectura de tres capas, el estado de contenedores, la disponibilidad de la API, roles detectables de bases de datos, la última traza HTTP y eventos de recuperación observados.

## Novedades de v0.3

- Diseño **premium sobrio**: superficies color grafito, tipografía del sistema, alto contraste y una acentuación azul tenue. Sin degradados pronunciados.
- **Modo claro/oscuro** mediante el icono del encabezado (preferencia guardada localmente cuando el navegador lo permite).
- **Conexiones animadas directamente sobre la topología** a partir de `X-Request-Trace`, con partículas y líneas que siguen cada tramo de la **última** solicitud observada.
- Botón «Pausar conexiones» independiente del botón «Pausar animación» del recorrido horizontal.
- Botón «Resaltar ruta»: atenúa *suavemente* los nodos no utilizados en la última solicitud, pero los mantiene visibles. Verde sigue significando activo.
- Los destinos genéricos `redis` y `mongodb` se muestran como **destinos lógicos**, nunca como prueba de qué réplica o nodo físico atendió la operación.
- Se mantienen los indicadores, roles (cuando se pueden consultar), gráfica de latencia y línea de tiempo de la versión 0.2.

## Instalación separada y reversible

**No reemplazar la versión 0.2 antes de probar esta versión**. Descomprima en una nueva carpeta, por ejemplo `/home/david/observatorio-995-v03/observatorio-995`. No coloque la carpeta encima del proyecto de Docker Compose.

Desde Ubuntu:

```bash
python3 -m zipfile -t ~/Observatorio_995_v0.3.zip
mkdir -p ~/observatorio-995-v03
python3 -m zipfile -e ~/Observatorio_995_v0.3.zip ~/observatorio-995-v03
python3 -m py_compile ~/observatorio-995-v03/observatorio-995/app.py
cd ~/observatorio-995-v03/observatorio-995
python3 app.py --port 7812
```

Desde una **nueva** PowerShell de Windows:

```powershell
ssh -N -L 17812:127.0.0.1:7812 david@192.168.56.101
```

Abrir `http://localhost:17812` en el navegador. La PowerShell con el túnel y la sesión Ubuntu que ejecuta Python deben permanecer abiertas. Pulse `Ctrl+C` en la sesión Ubuntu para detener únicamente el Observatorio.

Si el puerto está ocupado, consultar `ss -ltn | grep ':7812'`; no eliminar ni reiniciar contenedores del sistema principal.

## Cómo se recopilan los datos

- **Docker**: `docker ps` / `docker inspect` de consulta, para estados del proyecto `distributed-three-tier`.
- **API**: GET `/api/health` y GET `/api/products/cheapest` (sondeos periódicos), con código HTTP, latencia y encabezado `X-Request-Trace`.
- **Redis**: Sentinel + `INFO replication`, solo lecturas; roles actualizados periódicamente.
- **MongoDB**: `db.hello().isWritablePrimary` en contenedores con `mongosh`, cuando responden.
- **Eventos**: transiciones vistas por el muestreador. Un apagado y reencendido entre dos sondeos puede no quedar registrado.

El monitor utiliza un sondeo de aproximadamente cuatro segundos. Esto **no** es captura TCP, seguimiento de cada petición de los usuarios, ni herramienta de análisis de tráfico de paquetes. La animación se reconstruye a partir de **una ruta lógica reportada por la aplicación** y se reproduce con fines explicativos, sin afirmar que cada partícula sea un paquete real.

**Importante:** el encabezado `X-Request-Trace` puede indicar un backend físico (`galera1`) o un destino genérico (`redis`, `mongodb`). En los casos genéricos, la línea se dirige al encabezado *destino lógico* del grupo correspondiente. No presupone cuál réplica atendió la consulta.

Las líneas discretas entre capas muestran arquitectura lógica. Estar *en ejecución* no certifica por sí solo la salud integral de Galera, la posesión de una VIP de Keepalived ni que HAProxy seleccione efectivamente un backend. Esas verificaciones deben hacerse con evidencias complementarias.

## Seguridad

- El HTTP del Observatorio escucha únicamente en `127.0.0.1` de la VM; usar SSH para visualizarlo desde Windows.
- Este código no implementa acciones de parar, iniciar, borrar o reiniciar contenedores.
- Consultar Docker no convierte en inofensivos sus permisos: quien acceda a Docker puede tener control elevado sobre el host. **No exponer el puerto del Observatorio a Internet ni compartir acceso Docker con usuarios no autorizados**.
- No publicar en GitHub capturas con contraseñas, variables de entorno o tokens.

## Uso sugerido durante una exposición

1. Mostrar la vista de tres capas con **Mostrar todos**.
2. Mostrar un `X-Request-Trace` real y explicar la animación, que corresponde a *una solicitud observada*.
3. Mantener el panel visible y hacer un fallo controlado de `app2` desde una terminal separada.
4. Mostrar la caída del contador, la permanencia de `HTTP 200` en los sondeos y luego la recuperación de `app2`.
5. Medir disponibilidad bajo carga por separado, con resultados ApacheBench, Siege o JMeter, sin confundir sondeos con una prueba de estrés.

Este documento es provisional hasta validar v0.3 dentro de la VM y reunir las pruebas de concepto formales.
