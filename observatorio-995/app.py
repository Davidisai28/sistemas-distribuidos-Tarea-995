#!/usr/bin/env python3
"""Observatorio 995 — monitor de solo lectura para la tarea de Sistemas Distribuidos.
Sin dependencias externas. Solo ejecuta comandos Docker de consulta.
"""
import argparse
import collections
import datetime as dt
import json
import logging
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = "distributed-three-tier"
API_BASE = "http://127.0.0.1"
REFRESH_SECONDS = 4
LOGGER = logging.getLogger("observatorio995")

TIERS = {
    "presentation": {
        "label": "Presentación",
        "services": ["presentation-entry", "presentation-lb-master", "presentation-lb-backup",
                     "presentation-keepalived-master", "presentation-keepalived-backup", "web1", "web2", "web3"],
    },
    "application": {
        "label": "Aplicación",
        "services": ["application-lb-master", "application-lb-backup", "application-keepalived-master",
                     "application-keepalived-backup", "app1", "app2", "app3"],
    },
    "data": {
        "label": "Datos",
        "services": ["galera-proxy", "galera-proxy-backup", "galera-keepalived-master",
                     "galera-keepalived-backup", "galera1", "galera2", "galera3",
                     "mongodb", "mongodb2", "mongodb-arbiter", "redis", "redis-replica",
                     "redis-sentinel-1", "redis-sentinel-2", "redis-sentinel-3"],
    },
    "support": {"label": "Apoyo", "services": ["nagios", "catalog-init"]},
}
EXPECTED_SERVICES = {x for group in TIERS.values() for x in group["services"]}


def run_readonly(*argv, timeout=6):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        if p.returncode != 0:
            return None
        return p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return None


def docker_snapshot():
    output = run_readonly("docker", "ps", "-a", "--filter",
                          f"label=com.docker.compose.project={PROJECT}",
                          "--format", "{{.Names}}", timeout=5)
    if output is None:
        return None
    names = [name for name in output.splitlines() if name.strip()]
    if not names:
        return {}
    details = run_readonly("docker", "inspect", *names, timeout=8)
    if details is None:
        return None
    try:
        items = json.loads(details)
    except json.JSONDecodeError:
        return None
    result = {}
    for item in items:
        labels = (item.get("Config") or {}).get("Labels") or {}
        service = labels.get("com.docker.compose.service")
        if not service:
            continue
        state = item.get("State") or {}
        health = (state.get("Health") or {}).get("Status")
        result[service] = {
            "name": item.get("Name", "").lstrip("/"),
            "state": state.get("Status", "unknown"),
            "health": health,
            "exit_code": state.get("ExitCode"),
            "started_at": state.get("StartedAt"),
        }
    return result


def redis_query(host, port, *parts, timeout=1.4):
    data = b"*" + str(len(parts)).encode() + b"\r\n"
    for part in parts:
        arg = str(part).encode()
        data += b"$" + str(len(arg)).encode() + b"\r\n" + arg + b"\r\n"
    try:
        with socket.create_connection((host, port), timeout=timeout) as conn:
            conn.settimeout(timeout)
            conn.sendall(data)
            file = conn.makefile("rb")
            return parse_resp(file)
    except (OSError, ValueError, EOFError):
        return None


def parse_resp(file):
    header = file.readline()
    if not header:
        raise EOFError()
    t, rest = header[:1], header[1:].strip()
    if t == b"+":
        return rest.decode(errors="replace")
    if t == b"-":
        raise ValueError(rest.decode(errors="replace"))
    if t == b":":
        return int(rest)
    if t == b"$":
        n = int(rest)
        return None if n < 0 else file.read(n + 2)[:-2].decode(errors="replace")
    if t == b"*":
        n = int(rest)
        return None if n < 0 else [parse_resp(file) for _ in range(n)]
    raise ValueError("RESP inválido")


def redis_snapshot():
    servers = {"redis": "172.29.95.10", "redis-replica": "172.29.95.11"}
    sentinel_hosts = {"redis-sentinel-1": "172.29.95.21",
                      "redis-sentinel-2": "172.29.95.22", "redis-sentinel-3": "172.29.95.23"}
    info = {"master": None, "reported_by": 0, "roles": {}, "sentinels": {}}
    votes = []
    for name, ip in sentinel_hosts.items():
        reply = redis_query(ip, 26379, "SENTINEL", "get-master-addr-by-name", "mymaster")
        candidate = reply[0] if isinstance(reply, list) and len(reply) == 2 else None
        info["sentinels"][name] = candidate
        if candidate:
            votes.append(candidate)
    if votes:
        name, count = collections.Counter(votes).most_common(1)[0]
        if count >= 2:
            info["master"] = name
            info["reported_by"] = count
    for name, ip in servers.items():
        raw = redis_query(ip, 6379, "INFO", "replication")
        role = re.search(r"^role:(master|slave)\s*$", raw, re.M).group(1) if isinstance(raw, str) and re.search(r"^role:(master|slave)\s*$", raw, re.M) else None
        raw = raw or ""
        link = re.search(r"^master_link_status:(up|down)\s*$", raw, re.M)
        info["roles"][name] = {"role": role, "link": link.group(1) if link else None}
    return info


def mongo_snapshot(containers):
    result = {}
    for svc in ("mongodb", "mongodb2"):
        container = containers.get(svc)
        if not container or container["state"] != "running":
            result[svc] = None
            continue
        out = run_readonly("docker", "exec", container["name"], "mongosh", "--quiet",
                           "--eval", "db.hello().isWritablePrimary", timeout=4)
        if out is not None:
            lines = [x.strip().lower() for x in out.splitlines()]
            result[svc] = "primary" if "true" in lines else ("secondary" if "false" in lines else None)
        else:
            result[svc] = None
    return result


def http_probe(url, trace=False):
    begun = time.monotonic()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Observatorio995/1.0"})
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            body = resp.read(4096)
            result = {"http": resp.status, "latency_ms": round((time.monotonic() - begun) * 1000, 1),
                      "ok": 200 <= resp.status < 400}
            if trace:
                result["trace"] = resp.headers.get("X-Request-Trace", "")
            else:
                try:
                    parsed = json.loads(body)
                    result["status"] = parsed.get("status")
                    result["redis"] = parsed.get("redis")
                except (ValueError, AttributeError):
                    pass
            return result
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return {"http": None, "ok": False, "latency_ms": round((time.monotonic() - begun) * 1000, 1),
                "error": type(e).__name__}


class Collector:
    def __init__(self):
        self.lock = threading.Lock()
        self.data = {"ready": False}
        self.events = collections.deque(maxlen=60)
        self.history = collections.deque(maxlen=60)
        self.last_status = {}
        self.last_redis_master = None
        self.last_mongo = {}
        self.redis_cache = {}
        self.mongo_cache = {}
        self.role_at = 0
        self.catalog_sequence = 0
        self.down_since = {}
        self.last_recovery = None

    def log_event(self, title, detail, level="info"):
        self.events.appendleft({"at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                                "title": title, "detail": detail, "level": level})

    def tick(self):
        now = time.monotonic()
        containers = docker_snapshot()
        if containers is None:
            with self.lock:
                previous = dict(self.data)
                previous.update({"docker_ok": False, "timestamp": dt.datetime.now().astimezone().isoformat(timespec="seconds")})
                self.data = previous
            return
        api = http_probe(API_BASE + "/api/health")
        catalog = http_probe(API_BASE + "/api/products/cheapest", trace=True)
        self.catalog_sequence += 1
        if now - self.role_at > 16 or not self.redis_cache:
            self.redis_cache = redis_snapshot()
            self.mongo_cache = mongo_snapshot(containers)
            self.role_at = now
        roles = self.redis_cache
        mongo = self.mongo_cache
        # Registrar sólo transiciones observadas, evitando falsos fallos al arrancar el observatorio.
        statuses = {name: (item["state"], item["health"]) for name, item in containers.items()
                    if name in EXPECTED_SERVICES and name != "catalog-init"}
        for service, state in statuses.items():
            old = self.last_status.get(service)
            if old is not None and old != state:
                if old[0] == "running" and state[0] != "running":
                    self.down_since[service] = now
                if old[0] != "running" and state[0] == "running" and service in self.down_since:
                    elapsed = round(now - self.down_since.pop(service), 1)
                    self.last_recovery = {"service": service, "observed_seconds": elapsed}
                    self.log_event("Recuperación observada: " + service,
                                   f"Contenedor disponible nuevamente · {elapsed} s entre detecciones (estimación)", "success")
                else:
                    self.log_event("Cambio de estado: " + service, f"{old[0]} → {state[0]}",
                                   "warning" if state[0] != "running" else "success")
        if self.last_status and not statuses:
            self.log_event("Sin contenedores del proyecto", "Docker no informa servicios del proyecto", "warning")
        self.last_status = statuses
        primary = roles.get("master")
        if self.last_redis_master is not None and primary is not None and primary != self.last_redis_master:
            self.log_event("Cambio de primario Redis", f"{self.last_redis_master} → {primary}", "warning")
        if primary:
            self.last_redis_master = primary
        for svc, role in mongo.items():
            prior = self.last_mongo.get(svc)
            if prior and role and prior != role:
                self.log_event("Cambio de rol MongoDB", f"{svc}: {prior} → {role}", "warning")
        self.last_mongo = dict(mongo)
        self.history.append({"time": dt.datetime.now().strftime("%H:%M:%S"),
                             "latency": catalog.get("latency_ms") if catalog.get("ok") else None,
                             "ok": bool(catalog.get("ok"))})
        required_running = sum(containers.get(n, {}).get("state") == "running" for n in EXPECTED_SERVICES if n != "catalog-init")
        payload = {"ready": True, "docker_ok": True,
                   "timestamp": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                   "project": PROJECT, "tiers": TIERS,
                   "containers": containers, "required_running": required_running,
                   "required_total": len(EXPECTED_SERVICES) - 1,
                   "api": api, "catalog": catalog, "redis": roles, "mongo": mongo,
                   "request_sequence": self.catalog_sequence,
                   "last_recovery": self.last_recovery,
                   "events": list(self.events), "history": list(self.history),
                   "notes": ["Redes y flechas: arquitectura lógica, no tráfico TCP inspeccionado.",
                             "Estado verde de Galera: proceso Docker, no certifica wsrep Synced.",
                             "Rol Redis: consultas INFO + acuerdo de al menos 2 Sentinel.",
                             "Rol MongoDB: respuesta hello; si falla, estado desconocido.",
                             "HTTP: sondeos ligeros reales; no equivalen a una prueba de carga.",
                             "Tiempo de recuperación: intervalo entre observaciones del sondeo; no es la duración exacta del corte.",
                             "Animación: reconstrucción del encabezado X-Request-Trace; no inspección de paquetes."]}
        with self.lock:
            self.data = payload

    def loop(self):
        self.log_event("Observatorio iniciado", "Monitoreo de solo lectura activo", "success")
        while True:
            try:
                self.tick()
            except Exception:
                LOGGER.exception("Error de muestreo")
            time.sleep(REFRESH_SECONDS)


COLLECTOR = Collector()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/state":
            with COLLECTOR.lock:
                content = json.dumps(COLLECTOR.data, ensure_ascii=False).encode()
            return self.send_data(200, content, "application/json; charset=utf-8")
        paths = {"/": "index.html", "/index.html": "index.html",
                 "/static/app.js": "static/app.js", "/static/style.css": "static/style.css",
                 "/static/premium.css": "static/premium.css"}
        asset = paths.get(path)
        if asset is None:
            return self.send_data(404, b"No encontrado", "text/plain")
        file = ROOT / asset
        type_ = "text/html; charset=utf-8" if asset.endswith("html") else (
            "application/javascript; charset=utf-8" if asset.endswith("js") else "text/css; charset=utf-8")
        try:
            return self.send_data(200, file.read_bytes(), type_)
        except OSError:
            return self.send_data(404, b"Archivo no encontrado", "text/plain")

    def send_data(self, code, body, mime):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_, *args):
        LOGGER.info("%s — %s", self.client_address[0], format_ % args)


def main():
    parser = argparse.ArgumentParser(description="Observatorio 995, panel local de solo lectura")
    parser.add_argument("--port", type=int, default=7810)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    threading.Thread(target=COLLECTOR.loop, daemon=True, name="collector").start()
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    LOGGER.info("Observatorio listo: http://127.0.0.1:%d", args.port)
    try:
        httpd.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        LOGGER.info("Monitor detenido")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
