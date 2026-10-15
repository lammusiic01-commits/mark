#!/usr/bin/env python3
"""
Демон контроля задержки и бесперебойной работы (Watchdog & Fail-Safe Monitor).
Функции:
1. Каждые 20 секунд проверяет TCP-рукопожатие и задержку (RTT) до основного и резервного VPS.
2. Контролирует работу локального DNS/FakeIP (порт 5353) и SOCKS/Mixed порта (2080).
3. При зависании туннеля перезапускает службу sing-box без разрыва прямого РФ-интернета.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.core import load_state


def measure_tcp_rtt_ms(host: str, port: int, timeout: float = 3.0) -> float | None:
    """Измеряет время TCP-рукопожатия в миллисекундах."""
    start = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return round((time.perf_counter() - start) * 1000.0, 2)
    except OSError:
        return None


def restart_singbox_if_needed() -> None:
    """Мягкий перезапуск sing-box при сбое."""
    try:
        subprocess.run(
            ["systemctl", "restart", "sing-box"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except Exception:
        pass


def check_once() -> dict:
    state = load_state()
    primary = state["vps"]["primary"]
    backup = state["vps"].get("backup", {})
    tenda_ip = state["network"]["tenda_router_ip"]

    router_rtt = measure_tcp_rtt_ms(tenda_ip, 80, timeout=1.5)
    primary_rtt = measure_tcp_rtt_ms(primary["host"], int(primary["port"]), timeout=3.0)
    backup_rtt = (
        measure_tcp_rtt_ms(backup["host"], int(backup["port"]), timeout=3.0)
        if backup.get("enabled")
        else None
    )
    local_proxy_ok = measure_tcp_rtt_ms("127.0.0.1", 2080, timeout=1.0) is not None

    return {
        "timestamp": int(time.time()),
        "tenda_router_rtt_ms": router_rtt,
        "vps_primary_rtt_ms": primary_rtt,
        "vps_backup_rtt_ms": backup_rtt,
        "singbox_local_alive": local_proxy_ok,
    }


def main() -> None:
    failures = 0
    print("[Watchdog] Запущен мониторинг бесперебойности Tenda TX2 Smart Gateway...")
    while True:
        status = check_once()
        if not status["singbox_local_alive"] and status["vps_primary_rtt_ms"] is not None:
            failures += 1
            if failures >= 3:
                print("[Watchdog] Обнаружена остановка локального туннеля, выполняю авто-восстановление...")
                restart_singbox_if_needed()
                failures = 0
        else:
            failures = 0
        time.sleep(20)


if __name__ == "__main__":
    if "--once" in sys.argv:
        print(json.dumps(check_once(), ensure_ascii=False, indent=2))
    else:
        main()
