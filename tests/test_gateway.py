#!/usr/bin/env python3
"""Автотесты для проверки логики маршрутизации и генерации конфигов Tenda TX2 Smart Gateway."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core import (
    export_all_configs,
    generate_dnsmasq_tenda_config,
    generate_singbox_gateway_config,
    generate_singbox_windows11_config,
    generate_tenda_static_routes,
    get_active_domains_and_cidrs,
    load_state,
)
from app.server import check_target_route


class TestTendaSmartGateway(unittest.TestCase):
    def test_state_and_active_rules(self):
        state = load_state()
        self.assertEqual(state["network"]["tenda_router_ip"], "192.168.0.1")
        domains, cidrs = get_active_domains_and_cidrs(state)
        self.assertIn("youtube.com", domains)
        self.assertIn("googlevideo.com", domains)
        self.assertIn("instagram.com", domains)
        self.assertIn("t.me", domains)
        self.assertIn("discord.media", domains)
        self.assertIn("chatgpt.com", domains)
        self.assertIn("149.154.160.0/20", cidrs)

    def test_selective_routing_simulator(self):
        # Проксируемые сервисы должны идти через туннель VLESS-Reality
        for target in [
            "youtube.com",
            "rr1---sn-gvnuxaxjvh.googlevideo.com",
            "instagram.com",
            "scontent.cdninstagram.com",
            "t.me",
            "149.154.167.99",  # Telegram DC2 IP
            "91.108.56.120",   # Telegram DC5 IP
            "discord.media",
            "chatgpt.com",
        ]:
            res = check_target_route(target)
            self.assertEqual(
                res["route"],
                "PROXY_TUNNEL",
                f"Ожидался маршрут PROXY_TUNNEL для {target}, получено: {res}",
            )

        # Российские сервисы и банки должны идти строго напрямую (0 мс задержки)
        for direct_target in [
            "sberbank.ru",
            "gosuslugi.ru",
            "yandex.ru",
            "vk.com",
            "ozon.ru",
            "77.88.8.8",
        ]:
            res = check_target_route(direct_target)
            self.assertEqual(
                res["route"],
                "DIRECT_ISP",
                f"Ожидался прямой маршрут DIRECT_ISP для {direct_target}, получено: {res}",
            )

        # Локальная сеть роутера Tenda TX2
        lan_res = check_target_route("192.168.0.1")
        self.assertEqual(lan_res["route"], "LOCAL_LAN")

    def test_singbox_gateway_config_structure(self):
        cfg = generate_singbox_gateway_config()
        self.assertIn("dns", cfg)
        self.assertTrue(cfg["dns"]["fakeip"]["enabled"])
        self.assertEqual(cfg["dns"]["fakeip"]["inet4_range"], "198.18.0.0/15")
        inbounds = {i["tag"]: i for i in cfg["inbounds"]}
        self.assertIn("tun-in", inbounds)
        outbounds = {o["tag"]: o for o in cfg["outbounds"]}
        self.assertIn("proxy-auto", outbounds)
        self.assertIn("vless-primary", outbounds)
        self.assertEqual(outbounds["vless-primary"]["flow"], "xtls-rprx-vision")

    def test_tenda_static_routes_netmask_format(self):
        routes = generate_tenda_static_routes()
        self.assertGreaterEqual(len(routes), 9)
        fakeip_route = routes[0]
        self.assertEqual(fakeip_route["network"], "198.18.0.0")
        self.assertEqual(fakeip_route["netmask"], "255.254.0.0")
        tg_main = next(r for r in routes if r["network"] == "149.154.160.0")
        self.assertEqual(tg_main["netmask"], "255.255.240.0")

    def test_windows11_config_structure(self):
        cfg = generate_singbox_windows11_config()
        inbounds = {i["tag"]: i for i in cfg["inbounds"]}
        self.assertIn("tun-in", inbounds)
        self.assertEqual(inbounds["tun-in"]["interface_name"], "SingBoxTun")
        self.assertIn("192.168.0.0/16", inbounds["tun-in"]["inet4_route_exclude_address"])
        self.assertIn("dns-lan-53", inbounds)
        self.assertEqual(inbounds["dns-lan-53"]["listen_port"], 53)

    def test_export_all_configs(self):
        files = export_all_configs()
        self.assertIn("singbox_windows11.json", files)
        self.assertIn("singbox_gateway.json", files)
        self.assertIn("dnsmasq_tenda.conf", files)
        self.assertIn("nftables_gateway.conf", files)
        # Проверяем валидность JSON
        json.loads(files["singbox_windows11.json"])
        json.loads(files["singbox_gateway.json"])
        json.loads(files["singbox_vps.json"])


if __name__ == "__main__":
    unittest.main()
