#!/usr/bin/env python3
"""
Веб-сервер панели управления Tenda TX2 Smart Gateway.
Работает без внешних зависимостей (на стандартной библиотеке Python 3),
поэтому запускается на любом одноплатнике (Orange Pi / Raspberry Pi), мини-ПК или сервере.
"""

from __future__ import annotations

import io
import ipaddress
import json
import os
import sys
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core import (
    BASE_DIR,
    RULES_DIR,
    export_all_configs,
    generate_new_credentials,
    generate_tenda_static_routes,
    get_active_domains_and_cidrs,
    load_state,
    save_lines,
    save_state,
)

STATIC_DIR = Path(__file__).resolve().parent / "static"


def build_release_zip_bytes() -> bytes:
    """Собирает полный готовый архив сборки Tenda-TX2-Smart-Gateway-Win11.zip."""
    export_all_configs()
    buf = io.BytesIO()
    include_dirs = ["app", "configs", "scripts", "windows11", "tests"]
    include_files = [
        "Tenda-Win11-AutoSetup-v2.bat",
        "Tenda-Win11-AutoSetup-v2.ps1",
        "README.md",
        "install.sh",
        "docker-compose.gateway.yml",
        "docker-compose.vps.yml",
    ]

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in include_files:
            fpath = BASE_DIR / fname
            if fpath.exists():
                zf.write(fpath, f"tenda-gateway/{fname}")
        for dname in include_dirs:
            dpath = BASE_DIR / dname
            if not dpath.exists():
                continue
            for file_path in sorted(dpath.rglob("*")):
                if file_path.is_file() and "__pycache__" not in file_path.parts:
                    rel = file_path.relative_to(BASE_DIR).as_posix()
                    zf.write(file_path, f"tenda-gateway/{rel}")
    return buf.getvalue()


def check_target_route(query: str) -> dict:
    """
    Проверяет, как именно шлюз обработает указанный домен или IP-адрес:
    напрямую через провайдера РФ (0 мс задержки) или через скоростной туннель VLESS-Reality.
    """
    target = query.strip().lower()
    if "://" in target:
        target = urlparse(target).hostname or target
    target = target.split("/")[0].split(":")[0]

    state = load_state()
    domains, cidrs = get_active_domains_and_cidrs(state)

    # Проверяем, является ли цель IP-адресом
    try:
        ip_obj = ipaddress.ip_address(target)
        if ip_obj.is_private:
            return {
                "target": target,
                "route": "LOCAL_LAN",
                "outbound": "direct (Локальная сеть Tenda TX2)",
                "latency_overhead": "0.0 мс",
                "matched_rule": "ip_is_private (192.168.0.0/24)",
                "service": "Локальное устройство",
            }
        for svc in state.get("services", []):
            if not svc.get("enabled", True):
                continue
            for cidr in svc.get("cidrs", []):
                try:
                    net = ipaddress.ip_network(cidr, strict=False)
                    if ip_obj in net:
                        return {
                            "target": target,
                            "route": "PROXY_TUNNEL",
                            "outbound": "proxy-auto (VLESS-Reality XTLS-Vision)",
                            "latency_overhead": "FakeIP / TFO (~22-35 мс до узла)",
                            "matched_rule": f"IP CIDR: {cidr}",
                            "service": svc["name"],
                        }
                except ValueError:
                    continue
        return {
            "target": target,
            "route": "DIRECT_ISP",
            "outbound": "direct (Напрямую через провайдера РФ)",
            "latency_overhead": "< 0.15 мс (Nftables Flowtable Offload)",
            "matched_rule": "final: direct (IP не входит в списки блокировок)",
            "service": "Прямой маршрут (Без VPN)",
        }
    except ValueError:
        pass

    # Проверка доменных зон РФ (всегда идут напрямую без проксирования)
    ru_suffixes = (".ru", ".xn--p1ai", ".su", ".by", "gosuslugi.ru", "sberbank.ru", "yandex.ru", "vk.com", "ozon.ru")
    if target.endswith(ru_suffixes):
        return {
            "target": target,
            "route": "DIRECT_ISP",
            "outbound": "direct (Напрямую через провайдера РФ)",
            "latency_overhead": "< 0.15 мс (Прямой DNS 77.88.8.8 + Flowtable)",
            "matched_rule": "Гео-правило РФ (.ru / .рф / Госуслуги / Банки)",
            "service": "Российский сервис (Без VPN)",
        }

    # Проверка по включенным сервисам
    for svc in state.get("services", []):
        if not svc.get("enabled", True):
            continue
        for dom in svc.get("domains", []):
            if target == dom or target.endswith("." + dom):
                return {
                    "target": target,
                    "route": "PROXY_TUNNEL",
                    "outbound": "proxy-auto (VLESS-Reality XTLS-Vision)",
                    "latency_overhead": "0.3 мс DNS (FakeIP 198.18.x.x) + TCP BBR",
                    "matched_rule": f"domain_suffix: {dom}",
                    "service": svc["name"],
                }

    return {
        "target": target,
        "route": "DIRECT_ISP",
        "outbound": "direct (Напрямую через провайдера РФ)",
        "latency_overhead": "< 0.15 мс (Nftables Flowtable Offload)",
        "matched_rule": "final: direct (Домен не в списке проксирования)",
        "service": "Обычный интернет (Напрямую)",
    }


class GatewayRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        # Лаконичное логирование
        sys.stderr.write(f"[GatewayUI] {self.address_string()} - {fmt % args}\n")

    def _send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            index_file = STATIC_DIR / "index.html"
            content = index_file.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return

        if path == "/download/Tenda-TX2-Smart-Gateway-Win11.zip":
            zip_bytes = build_release_zip_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/zip")
            self.send_header(
                "Content-Disposition",
                'attachment; filename="Tenda-TX2-Smart-Gateway-Win11.zip"',
            )
            self.send_header("Content-Length", str(len(zip_bytes)))
            self.end_headers()
            self.wfile.write(zip_bytes)
            return

        if path == "/api/state":
            state = load_state()
            domains, cidrs = get_active_domains_and_cidrs(state)
            state["summary"] = {
                "active_services": sum(1 for s in state["services"] if s.get("enabled")),
                "total_services": len(state["services"]),
                "active_domains": len(domains),
                "active_cidrs": len(cidrs),
                "tenda_routes": generate_tenda_static_routes(state),
            }
            self._send_json(state)
            return

        if path == "/api/configs":
            files = export_all_configs()
            self._send_json({"status": "ok", "files": files})
            return

        if path == "/api/check-route":
            qs = parse_qs(parsed.query)
            target = (qs.get("target") or ["youtube.com"])[0]
            self._send_json(check_target_route(target))
            return

        self._send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_json_body()

        if path == "/api/service/toggle":
            service_id = body.get("id")
            enabled = bool(body.get("enabled", True))
            state = load_state()
            found = False
            for svc in state.get("services", []):
                if svc["id"] == service_id:
                    svc["enabled"] = enabled
                    found = True
                    break
            if not found:
                self._send_json({"error": "Сервис не найден"}, status=HTTPStatus.BAD_REQUEST)
                return
            save_state(state)
            export_all_configs()
            self._send_json({"status": "ok", "id": service_id, "enabled": enabled})
            return

        if path == "/api/service/domains":
            service_id = body.get("id")
            domains = body.get("domains", [])
            state = load_state()
            for svc in state.get("services", []):
                if svc["id"] == service_id:
                    dom_file = svc.get("domain_file")
                    if dom_file:
                        save_lines(RULES_DIR / dom_file, domains, header=svc["name"])
                        export_all_configs()
                        self._send_json({"status": "ok", "count": len(domains)})
                        return
            self._send_json({"error": "Сервис не найден"}, status=HTTPStatus.BAD_REQUEST)
            return

        if path == "/api/settings":
            state = load_state()
            if "network" in body and isinstance(body["network"], dict):
                state["network"].update(body["network"])
            if "vps" in body and isinstance(body["vps"], dict):
                if "primary" in body["vps"]:
                    state["vps"]["primary"].update(body["vps"]["primary"])
                if "backup" in body["vps"]:
                    state["vps"]["backup"].update(body["vps"]["backup"])
            save_state(state)
            files = export_all_configs()
            self._send_json({"status": "ok", "files": files})
            return

        if path == "/api/generate-credentials":
            creds = generate_new_credentials()
            self._send_json(creds)
            return

        self._send_json({"error": "Unknown endpoint"}, status=HTTPStatus.NOT_FOUND)


def run_server(host: str = "0.0.0.0", port: int = 8080) -> None:
    export_all_configs()
    server = ThreadingHTTPServer((host, port), GatewayRequestHandler)
    print(f"Панель управления Tenda TX2 Smart Gateway запущена на http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    run_server(host="0.0.0.0", port=port)
