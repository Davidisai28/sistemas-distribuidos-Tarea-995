# Galera: enrutamiento y pools de conexiones

## 1. Arquitectura

El sistema utiliza tres nodos MariaDB Galera con
replicacion multiprimario.

Las aplicaciones app1, app2 y app3 acceden mediante
la IP virtual 172.31.0.240:3306, atendida por dos
instancias HAProxy con Keepalived.

El inicializador catalog-init tambien esta preparado
para utilizar la misma VIP.

## 2. Politica de lectura y escritura (ToDo 3.3)

- Lecturas: se envian a la VIP y HAProxy selecciona
  un nodo Galera saludable.
- Escrituras: utilizan el mismo endpoint y pueden
  dirigirse a cualquiera de los nodos elegibles.
- Balanceo: leastconn distribuye conexiones TCP,
  no instrucciones SQL individuales.
- Salud: el proxy comprueba Synced, Primary y
  wsrep_ready=ON antes de admitir un nodo.
- Fallos: las conexiones nuevas pueden dirigirse
  a otros nodos disponibles. Una consulta interrumpida
  puede requerir reintento desde la aplicacion.
- Conflictos: las escrituras concurrentes sobre los
  mismos datos pueden fallar por certificacion Galera.
  La aplicacion debe tratar esos errores apropiadamente.

Actualmente las consultas SQL de las API son de lectura.
La inicializacion del catalogo contiene operaciones
de escritura y se debe ejecutar de forma controlada,
sin inicializaciones concurrentes.

## 3. Consistencia

El valor observado de wsrep_sync_wait es 0.

No se aplica una espera causal adicional a cada lectura.
Para una lectura que deba observar una escritura previa,
se debe evaluar wsrep_sync_wait=1 en la misma sesion
SQL y restaurar la configuracion antes de devolver
la conexion al pool.

## 4. Pools de conexiones (ToDo 3.4)

Cada instancia API usa:

- DB_POOL_LIMIT: 10 conexiones maximas.
- DB_POOL_QUEUE_LIMIT: 50 solicitudes en espera.
- waitForConnections: true.

Capacidad teorica de las tres API:
3 x 10 = 30 conexiones simultaneas.

Para N replicas, el limite teorico es N x 10.
Este limite debe reevaluarse al escalar.

Durante la revision, cada nodo Galera tenia
max_connections=151.

Maximos historicos observados por nodo:
galera1=8, galera2=6, galera3=6.

Estos valores son mediciones del momento y no
sustituyen las pruebas de carga.

## 5. Validaciones realizadas

- Tres nodos Galera Synced y Primary, wsrep_ready=ON.
- Tres API conectadas a 172.31.0.240.
- Consultas HTTP de salud, productos y resenas: 200.
- catalog-init conectado por la VIP mediante SELECT 1.
- Inicializador original conservado en Exited (0).
- Pools desplegados en las tres API.

## 6. Validaciones pendientes

- Prueba de carga de las API y conexiones SQL.
- Documentar el comportamiento durante fallos de nodos
  como parte del plan formal de resiliencia.

## Prueba de escritura y replicacion mediante VIP

Fecha: 22 de octubre de 2026.

Se realizo una prueba controlada de escritura
utilizando la VIP 172.31.0.240:3306.

- HAProxy dirigio la conexion a galera2.
- Se creo una tabla exclusiva de prueba.
- La operacion INSERT se completo correctamente.
- Se verifico la lectura del registro desde
  galera1, galera2 y galera3.
- Para las lecturas de verificacion se utilizo
  SET SESSION wsrep_sync_wait = 1.
- Se ejecuto DROP TABLE sobre la tabla de prueba.
- Se confirmo que la tabla ya no existia en
  ninguno de los tres nodos.
- La API general continuo respondiendo HTTP 200.

Resultado: prueba de escritura y replicacion exitosa.

La prueba confirma el funcionamiento del
enrutamiento multiprimario mediante HAProxy.
No sustituye las pruebas de escritura durante
fallos ni las pruebas de carga.

## 7. Referencias

- MariaDB Galera Cluster:
  https://mariadb.com/docs/galera-cluster/
- Variables de Galera:
  https://mariadb.com/docs/galera-cluster/reference/galera-cluster-system-variables
- HAProxy TCP:
  https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/tcp/
