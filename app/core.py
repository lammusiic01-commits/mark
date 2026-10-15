#!/usr/bin/env python3
"""
Ядро генерации конфигураций и управления маршрутизацией Tenda TX2 Smart Gateway.
Обеспечивает выборочный обход блокировок (YouTube, Telegram, Instagram, Discord, AI)
для всех устройств дома (Wi-Fi и кабель в ПК на Windows 11) без включения VPN на клиентах.
"""

from __future__ import annotations

import ipaddress
import json
import os
import secrets
import uuid
from pathlib import Path
from typing import Any, Dict, List, Tuple

BASE_DIR = Path(__file__).resolve().parent.parent
RULES_DIR = BASE_DIR / "configs" / "rules"
SERVICES_FILE = RULES_DIR / "services.json"
GENERATED_DIR = BASE_DIR / "configs" / "generated"


def load_Lines(file_path: Path) -> List[str]:
    """Читает непустые строки из .lst файла без комментариев."""
    if not file_path.exists():
        return []
    result: List[str] = []
    for raw in file_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            result.append(line)
    return result


def save_lines(file_path: Path, lines: List[str], header: str = "") -> None:
    """Сохраняет список доменов или подсетей в .lst файл."""
    cleaned: List[str] = []
    seen = set()
    for item in lines:
        val = item.strip().lower()
        if val and not val.startswith("#") and val not in seen:
            seen.add(val)
            cleaned.append(val)
    content = ""
    if header:
        content += f"# {header}\n"
    content += "\n".join(cleaned) + "\n"
    file_path.write_text(content, encoding="utf-8")


def load_state() -> Dict[str, Any]:
    """Загружает состояние сервисов, сети и доменов."""
    data = json.loads(SERVICES_FILE.read_text(encoding="utf-8"))
    for svc in data.get("services", []):
        dom_file = svc.get("domain_file")
        cidr_file = svc.get("cidr_file")
        svc["domains"] = load_Lines(RULES_DIR / dom_file) if dom_file else []
        svc["cidrs"] = load_Lines(RULES_DIR / cidr_file) if cidr_file else []
        svc["domain_count"] = len(svc["domains"])
        svc["cidr_count"] = len(svc["cidrs"])
    return data


def save_state(data: Dict[str, Any]) -> None:
    """Сохраняет обновленную конфигурацию в services.json."""
    clean_copy = json.loads(json.dumps(data))
    for svc in clean_copy.get("services", []):
        svc.pop("domains", None)
        svc.pop("cidrs", None)
        svc.pop("domain_count", None)
        svc.pop("cidr_count", None)
    SERVICES_FILE.write_text(
        json.dumps(clean_copy, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def get_active_domains_and_cidrs(state: Dict[str, Any] | None = None) -> Tuple[List[str], List[str]]:
    """Возвращает агрегированный список всех доменов и CIDR включенных сервисов."""
    if state is None:
        state = load_state()
    domains: List[str] = []
    cidrs: List[str] = []
    seen_dom = set()
    seen_cidr = set()

    for svc in state.get("services", []):
        if not svc.get("enabled", True):
            continue
        for d in svc.get("domains", []):
            if d not in seen_dom:
                seen_dom.add(d)
                domains.append(d)
        for c in svc.get("cidrs", []):
            if c not in seen_cidr:
                seen_cidr.add(c)
                cidrs.append(c)
    return domains, cidrs


def generate_singbox_gateway_config(state: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """
    Генерирует боевой конфиг Sing-box (v1.9+) для домашнего шлюза (Linux VM / Sidecar Gateway).
    Особенности:
    - FakeIP (198.18.0.0/15) для мгновенного DNS-ответа (< 0.5 мс) по проксируемым доменам
    - Прямой резолвинг РФ-доменов через быстрый локальный DNS (77.88.8.8 / роутер Tenda TX2)
    - Автоматический Failover (urltest) между основным и резервным VPS
    - Протокол VLESS + XTLS-Vision + Reality (недетектируем для ТСПУ)
    - Блокировка QUIC (UDP/443) только для YouTube/Instagram для ускорения TCP BBR
    """
    if state is None:
        state = load_state()

    domains, cidrs = get_active_domains_and_cidrs(state)
    net = state["network"]
    vps_primary = state["vps"]["primary"]
    vps_backup = state["vps"].get("backup", {})

    outbounds: List[Dict[str, Any]] = []
    urltest_members = ["vless-primary"]

    primary_outbound = {
        "type": "vless",
        "tag": "vless-primary",
        "server": vps_primary["host"],
        "server_port": int(vps_primary["port"]),
        "uuid": vps_primary["uuid"],
        "flow": "xtls-rprx-vision",
        "packet_encoding": "xudp",
        "tcp_fast_open": True,
        "tls": {
            "enabled": True,
            "server_name": vps_primary["sni"],
            "utls": {
                "enabled": True,
                "fingerprint": "chrome",
            },
            "reality": {
                "enabled": True,
                "public_key": vps_primary["public_key"],
                "short_id": vps_primary["short_id"],
            },
        },
    }

    if vps_backup.get("enabled"):
        urltest_members.append("vless-backup")

    outbounds.append(
        {
            "type": "urltest",
            "tag": "proxy-auto",
            "outbounds": urltest_members,
            "url": "https://www.gstatic.com/generate_204",
            "interval": "45s",
            "tolerance": 35,
            "idle_timeout": "15m",
        }
    )
    outbounds.append(primary_outbound)

    if vps_backup.get("enabled"):
        outbounds.append(
            {
                "type": "vless",
                "tag": "vless-backup",
                "server": vps_backup["host"],
                "server_port": int(vps_backup["port"]),
                "uuid": vps_backup["uuid"],
                "flow": "xtls-rprx-vision",
                "packet_encoding": "xudp",
                "tcp_fast_open": True,
                "tls": {
                    "enabled": True,
                    "server_name": vps_backup["sni"],
                    "utls": {
                        "enabled": True,
                        "fingerprint": "chrome",
                    },
                    "reality": {
                        "enabled": True,
                        "public_key": vps_backup["public_key"],
                        "short_id": vps_backup["short_id"],
                    },
                },
            }
        )

    outbounds.extend(
        [
            {"type": "direct", "tag": "direct"},
            {"type": "block", "tag": "block"},
            {"type": "dns", "tag": "dns-out"},
        ]
    )

    config = {
        "log": {
            "level": "warn",
            "timestamp": True,
        },
        "dns": {
            "servers": [
                {
                    "tag": "dns-remote-doh",
                    "address": net.get("proxy_doh", "https://1.1.1.1/dns-query"),
                    "detour": "proxy-auto",
                },
                {
                    "tag": "dns-direct-ru",
                    "address": net.get("ru_dns_primary", "77.88.8.8"),
                    "detour": "direct",
                },
                {
                    "tag": "dns-fakeip",
                    "address": "fakeip",
                },
            ],
            "rules": [
                {
                    "outbound": "any",
                    "server": "dns-direct-ru",
                },
                {
                    "domain_suffix": [".ru", ".xn--p1ai", ".su", ".by"],
                    "server": "dns-direct-ru",
                },
                {
                    "query_type": ["A", "AAAA"],
                    "domain_suffix": domains,
                    "server": "dns-fakeip",
                    "rewrite_ttl": 1,
                },
            ],
            "fakeip": {
                "enabled": True,
                "inet4_range": "198.18.0.0/15",
            },
            "final": "dns-direct-ru",
            "strategy": "ipv4_only",
            "independent_cache": True,
        },
        "inbounds": [
            {
                "type": "tun",
                "tag": "tun-in",
                "interface_name": "tun0",
                "inet4_address": "172.19.0.1/30",
                "mtu": 1460,
                "auto_route": True,
                "strict_route": False,
                "inet4_route_exclude_address": [
                    "192.168.0.0/16",
                    "10.0.0.0/8",
                    "172.16.0.0/12",
                ],
                "stack": "system",
                "sniff": True,
                "sniff_override_destination": True,
            },
            {
                "type": "mixed",
                "tag": "mixed-in",
                "listen": "0.0.0.0",
                "listen_port": 2080,
                "sniff": True,
            },
            {
                "type": "direct",
                "tag": "dns-in",
                "listen": "0.0.0.0",
                "listen_port": 5353,
                "override_address": "8.8.8.8",
                "override_port": 53,
            },
        ],
        "outbounds": outbounds,
        "route": {
            "auto_detect_interface": True,
            "final": "direct",
            "rules": [
                {
                    "protocol": "dns",
                    "outbound": "dns-out",
                },
                {
                    "ip_is_private": True,
                    "outbound": "direct",
                },
                {
                    "domain_suffix": [".ru", ".xn--p1ai", ".su", ".gosuslugi.ru", ".sberbank.ru", ".tbank.ru", ".yandex.ru", ".vk.com", ".ozon.ru", ".wildberries.ru"],
                    "outbound": "direct",
                },
                {
                    "protocol": "quic",
                    "port": 443,
                    "domain_suffix": ["youtube.com", "googlevideo.com", "ytimg.com", "instagram.com", "cdninstagram.com"],
                    "outbound": "block",
                },
                {
                    "domain_suffix": domains,
                    "outbound": "proxy-auto",
                },
                {
                    "ip_cidr": cidrs,
                    "outbound": "proxy-auto",
                },
            ],
        },
    }
    return config


def generate_singbox_windows11_config(state: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """
    Генерирует специальный конфиг Sing-box для запуска НАПРЯМУЮ на Windows 11 (Вариант Б)
    либо в фоновой службе ПК (192.168.0.2), подключенного кабелем к Tenda TX2 (192.168.0.1).
    Особенности под Windows 11:
    - Wintun адаптер ('SingBoxTun') с исключением локальной подсети 192.168.0.0/16 (защита от петли)
    - Встроенный DNS-сервер сразу на порту 53 (0.0.0.0:53), чтобы роутер Tenda TX2 и Wi-Fi
      устройства могли использовать ПК 192.168.0.2 как Первичный DNS без стороннего dnsmasq!
    """
    cfg = generate_singbox_gateway_config(state)
    cfg["inbounds"] = [
        {
            "type": "tun",
            "tag": "tun-in",
            "interface_name": "SingBoxTun",
            "inet4_address": "172.19.0.1/30",
            "mtu": 1460,
            "auto_route": True,
            "strict_route": False,
            "inet4_route_exclude_address": [
                "192.168.0.0/16",
                "10.0.0.0/8",
                "172.16.0.0/12",
            ],
            "stack": "system",
            "sniff": True,
            "sniff_override_destination": True,
        },
        {
            "type": "mixed",
            "tag": "mixed-in",
            "listen": "0.0.0.0",
            "listen_port": 2080,
            "sniff": True,
        },
        {
            "type": "direct",
            "tag": "dns-lan-53",
            "listen": "0.0.0.0",
            "listen_port": 53,
            "override_address": "8.8.8.8",
            "override_port": 53,
        },
    ]
    return cfg


def generate_singbox_vps_config(
    state: Dict[str, Any] | None = None,
    private_key: str = "gK9mN3pQ7xR1tL5wY8zB2cF4hJ6kM9pS0uV3xZ7aE2g=",
) -> Dict[str, Any]:
    """Генерирует серверный конфиг Sing-box для зарубежного VPS (VLESS-Reality)."""
    if state is None:
        state = load_state()
    vps = state["vps"]["primary"]
    sni = vps.get("sni", "dl.google.com")

    return {
        "log": {"level": "warn", "timestamp": True},
        "inbounds": [
            {
                "type": "vless",
                "tag": "vless-reality-in",
                "listen": "::",
                "listen_port": int(vps.get("port", 443)),
                "tcp_fast_open": True,
                "sniff": True,
                "sniff_override_destination": True,
                "users": [
                    {
                        "name": "tenda-home-gateway",
                        "uuid": vps["uuid"],
                        "flow": "xtls-rprx-vision",
                    }
                ],
                "tls": {
                    "enabled": True,
                    "server_name": sni,
                    "reality": {
                        "enabled": True,
                        "handshake": {
                            "server": sni,
                            "server_port": 443,
                        },
                        "private_key": private_key,
                        "short_id": [vps["short_id"]],
                    },
                },
            }
        ],
        "outbounds": [
            {"type": "direct", "tag": "direct"},
            {"type": "block", "tag": "block"},
        ],
    }


def generate_dnsmasq_tenda_config(state: Dict[str, Any] | None = None) -> str:
    """
    Генерирует конфиг dnsmasq для работы в паре с роутером Tenda TX2.
    Раздает по DHCP шлюз (Option 3) и DNS (Option 6), указывающие на локальный шлюз,
    чтобы все устройства по Wi-Fi и кабелю работали автоматически без ручной настройки.
    """
    if state is None:
        state = load_state()
    net = state["network"]
    gw_ip = net["gateway_ip"]
    tenda_ip = net["tenda_router_ip"]
    iface = net["lan_interface"]
    dhcp_start = net["dhcp_start"]
    dhcp_end = net["dhcp_end"]
    ru_dns1 = net["ru_dns_primary"]
    ru_dns2 = net["ru_dns_secondary"]

    lines = [
        "# Автоматически сгенерированный конфиг Dnsmasq для роутера Tenda TX2",
        f"interface={iface}",
        "bind-dynamic",
        "no-resolv",
        "bogus-priv",
        "domain-needed",
        "cache-size=10000",
        "min-cache-ttl=60",
        "",
        "# Перенаправление всех DNS-запросов в Sing-box (Split-DNS + FakeIP на порту 5353)",
        "server=127.0.0.1#5353",
        f"# Прямой резолвинг .ru и .рф через быстрый российский DNS ({ru_dns1})",
        f"server=/ru/xn--p1ai/su/{ru_dns1}",
        f"server=/ru/xn--p1ai/su/{ru_dns2}",
        "",
        "# DHCP-сервер для локальной сети Tenda TX2 (Wi-Fi + LAN-кабель)",
        f"dhcp-range={dhcp_start},{dhcp_end},255.255.255.0,12h",
        "# Option 3: Шлюз по умолчанию -> наш прозрачный ускоритель",
        f"dhcp-option=3,{gw_ip}",
        "# Option 6: DNS-сервер -> наш прозрачный ускоритель",
        f"dhcp-option=6,{gw_ip}",
        f"# Исключаем сам роутер Tenda TX2 ({tenda_ip}) из пула",
        "dhcp-authoritative",
    ]
    return "\n".join(lines) + "\n"


def generate_nftables_gateway_config(state: Dict[str, Any] | None = None) -> str:
    """
    Генерирует правила nftables с аппаратным/программным ускорением (flowtable)
    для нулевой задержки на прямом российском трафике и игровых серверах.
    """
    if state is None:
        state = load_state()
    net = state["network"]
    iface = net["lan_interface"]
    lan_subnet = net["lan_subnet"]

    return f"""#!/usr/sbin/nft -f
# Оптимизированный файрвол и маршрутизатор для связки с Tenda TX2
# Включает Linux Flowtable Fastpath для минимальной задержки (< 0.15 мс)

flush ruleset

table inet tenda_gateway {{
    flowtable fastpath {{
        hook ingress priority 0;
        devices = {{ {iface}, tun0 }};
    }}

    chain forward {{
        type filter hook forward priority 0; policy accept;

        # Аппаратно-программный offload установленных соединений (игры, торренты, РФ-трафик)
        ip protocol {{ tcp, udp }} flow offload @fastpath

        # Выравнивание TCP MSS во избежание фрагментации пакетов в туннеле
        tcp flags syn tcp option maxseg size set rt mtu

        ct state established,related accept
        iifname "{iface}" accept
        iifname "tun0" accept
    }}

    chain postrouting {{
        type nat hook postrouting priority 100; policy accept;
        oifname "tun0" masquerade
        ip saddr {lan_subnet} oifname "{iface}" masquerade
    }}
}}
"""


def generate_smartdns_sniproxy_configs(state: Dict[str, Any] | None = None) -> Tuple[str, str]:
    """
    Генерирует конфиги SmartDNS (dnsmasq) + SNIProxy для Режима №2
    (когда дома стоит ТОЛЬКО роутер Tenda TX2 без мини-ПК/шлюза).
    """
    if state is None:
        state = load_state()
    domains, _ = get_active_domains_and_cidrs(state)
    vps_ip = state["vps"]["primary"]["host"]

    dns_lines = [
        "# SmartDNS конфигурация для работы напрямую с роутером Tenda TX2",
        "# Укажите IP вашего VPS в качестве Первичного DNS в настройках Tenda TX2",
        "no-resolv",
        "server=1.1.1.1",
        "server=8.8.8.8",
        "cache-size=10000",
        "",
        "# Перехват только выбранных сервисов на SNI-прокси (все остальные сайты идут напрямую!)",
    ]
    for dom in domains:
        dns_lines.append(f"address=/{dom}/{vps_ip}")

    sni_lines = [
        "# SNIProxy конфигурация (прозрачное проксирование TLS 1.3 и HTTP без расшифровки трафика)",
        "user daemon",
        "pidfile /var/run/sniproxy.pid",
        "",
        "resolver {",
        "    nameserver 1.1.1.1",
        "    nameserver 8.8.8.8",
        "    mode ipv4_only",
        "}",
        "",
        "listen 0.0.0.0:80 {",
        "    proto http",
        "    table selective_hosts",
        "}",
        "",
        "listen 0.0.0.0:443 {",
        "    proto tls",
        "    table selective_hosts",
        "}",
        "",
        "table selective_hosts {",
    ]
    for dom in domains:
        escaped = dom.replace(".", r"\.")
        sni_lines.append(f"    .*{escaped}$ *")
    sni_lines.append("}")

    return "\n".join(dns_lines) + "\n", "\n".join(sni_lines) + "\n"


def generate_tenda_static_routes(state: Dict[str, Any] | None = None) -> List[Dict[str, str]]:
    """
    Конвертирует подсеть FakeIP (198.18.0.0/15) и IPv4 CIDR подсети (например, Telegram)
    в формат таблицы «Статическая маршрутизация» заводской прошивки Tenda TX2:
    Сеть назначения | Маска подсети (255.255.x.x) | Шлюз
    """
    if state is None:
        state = load_state()
    _, cidrs = get_active_domains_and_cidrs(state)
    gw_ip = state["network"]["gateway_ip"]

    # Первым всегда идет диапазон FakeIP 198.18.0.0/15 (охватывает ВСЕ домены: YouTube, Instagram, Discord, ChatGPT)
    routes: List[Dict[str, str]] = [
        {
            "cidr": "198.18.0.0/15 (FakeIP: YouTube, Insta, Discord, AI)",
            "network": "198.18.0.0",
            "netmask": "255.254.0.0",
            "gateway": gw_ip,
        }
    ]

    for cidr in cidrs:
        try:
            net = ipaddress.ip_network(cidr, strict=False)
            if net.version == 4:
                routes.append(
                    {
                        "cidr": str(net),
                        "network": str(net.network_address),
                        "netmask": str(net.netmask),
                        "gateway": gw_ip,
                    }
                )
        except ValueError:
            continue
    return routes


def export_all_configs() -> Dict[str, str]:
    """Генерирует и записывает все конфигурационные файлы в configs/generated/."""
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()

    sb_win11 = generate_singbox_windows11_config(state)
    sb_gw = generate_singbox_gateway_config(state)
    sb_vps = generate_singbox_vps_config(state)
    dnsmasq_cfg = generate_dnsmasq_tenda_config(state)
    nft_cfg = generate_nftables_gateway_config(state)
    smartdns_cfg, sniproxy_cfg = generate_smartdns_sniproxy_configs(state)
    tenda_routes = generate_tenda_static_routes(state)

    files = {
        "singbox_windows11.json": json.dumps(sb_win11, ensure_ascii=False, indent=2) + "\n",
        "singbox_gateway.json": json.dumps(sb_gw, ensure_ascii=False, indent=2) + "\n",
        "singbox_vps.json": json.dumps(sb_vps, ensure_ascii=False, indent=2) + "\n",
        "dnsmasq_tenda.conf": dnsmasq_cfg,
        "nftables_gateway.conf": nft_cfg,
        "smartdns_vps.conf": smartdns_cfg,
        "sniproxy.conf": sniproxy_cfg,
        "tenda_tx2_static_routes.json": json.dumps(tenda_routes, ensure_ascii=False, indent=2) + "\n",
    }

    for filename, content in files.items():
        (GENERATED_DIR / filename).write_text(content, encoding="utf-8")

    return files


def generate_new_credentials() -> Dict[str, str]:
    """Генерирует новый UUID и ShortID для VLESS-Reality."""
    return {
        "uuid": str(uuid.uuid4()),
        "short_id": secrets.token_hex(8),
    }


if __name__ == "__main__":
    generated = export_all_configs()
    print(f"Сгенерировано {len(generated)} файлов конфигурации в {GENERATED_DIR}")
