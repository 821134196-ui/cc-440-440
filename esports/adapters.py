"""本地设备适配器与进程内结算适配器。

- NetworkAdapter:    模拟机位上电/断电与网络链路通断, 返回回执。
- PeripheralAdapter: 模拟外设柜扫码出库/归还回执。
- PaymentAdapter:    进程内模拟收款与退款, 按幂等键去重(重复调用返回同一回执)。
"""
from __future__ import annotations

import itertools


class NetworkAdapter:
    """机位供电与网络链路的本地模拟。"""

    def __init__(self):
        self._state = {}  # seat_code -> {"power": bool, "link": bool}
        self._seq = itertools.count(1)

    def _st(self, seat_code: str) -> dict:
        return self._state.setdefault(seat_code, {"power": False, "link": True})

    def power_on(self, seat_code: str) -> dict:
        st = self._st(seat_code)
        st["power"] = True
        return {"ok": True, "receipt": f"PWR-{next(self._seq):05d}",
                "seat": seat_code, "power": True}

    def power_off(self, seat_code: str) -> dict:
        st = self._st(seat_code)
        st["power"] = False
        return {"ok": True, "receipt": f"PWR-{next(self._seq):05d}",
                "seat": seat_code, "power": False}

    def set_link(self, seat_code: str, up: bool) -> dict:
        st = self._st(seat_code)
        st["link"] = up
        return {"ok": True, "receipt": f"LNK-{next(self._seq):05d}",
                "seat": seat_code, "link": up}

    def status(self, seat_code: str) -> dict:
        return dict(self._st(seat_code))


class PeripheralAdapter:
    """外设柜回执模拟: 出库/归还扫码。"""

    def __init__(self):
        self._seq = itertools.count(1)

    def checkout(self, serial: str) -> dict:
        return {"ok": True, "receipt": f"OUT-{next(self._seq):05d}", "serial": serial}

    def checkin(self, serial: str, condition: str) -> dict:
        return {"ok": True, "receipt": f"RTN-{next(self._seq):05d}",
                "serial": serial, "condition": condition}


class PaymentAdapter:
    """进程内结算适配器: 收款/退款均按幂等键去重。"""

    def __init__(self):
        self.charges = {}  # key -> receipt
        self.refunds = {}  # key -> receipt
        self._seq = itertools.count(1)

    def charge(self, key: str, amount_cents: int, label: str) -> dict:
        if key not in self.charges:
            self.charges[key] = {
                "ok": True, "receipt": f"PAY-{next(self._seq):05d}",
                "amount_cents": amount_cents, "label": label,
            }
        return self.charges[key]

    def refund(self, key: str, amount_cents: int, label: str) -> dict:
        if key not in self.refunds:
            self.refunds[key] = {
                "ok": True, "receipt": f"RFD-{next(self._seq):05d}",
                "amount_cents": amount_cents, "label": label,
            }
        return self.refunds[key]
