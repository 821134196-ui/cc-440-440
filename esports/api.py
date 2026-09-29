"""HTTP API: 基于标准库 http.server 的轻量路由 + 静态文件服务。"""
from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .errors import BizError
from .services import ArenaService

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".js": "application/javascript; charset=utf-8",
                 ".svg": "image/svg+xml", ".png": "image/png"}


def _int(x):
    return int(x)


# (method, 路径正则, handler(service, body, query, **路径参数))
ROUTES = [
    ("GET", r"/api/state",
     lambda s, b, q: s.get_state()),
    ("GET", r"/api/seats",
     lambda s, b, q: s.list_seats()),
    ("GET", r"/api/kits",
     lambda s, b, q: s.list_kits()),
    ("GET", r"/api/peripherals",
     lambda s, b, q: s.list_peripherals()),
    ("GET", r"/api/customers",
     lambda s, b, q: s.list_customers()),
    ("GET", r"/api/accounts",
     lambda s, b, q: s.list_accounts()),
    ("GET", r"/api/events",
     lambda s, b, q: s.list_events()),
    ("GET", r"/api/orders",
     lambda s, b, q: s.list_orders(status=q.get("status", [None])[0], recent=True)),
    ("POST", r"/api/orders",
     lambda s, b, q: s.create_order(
         _int(b["customer_id"]), _int(b["seat_id"]), _int(b["kit_id"]),
         [_int(a) for a in b.get("account_ids", [])], b["start_at"], b["end_at"])),
    ("GET", r"/api/orders/(\d+)",
     lambda s, b, q, id: s.get_order(_int(id))),
    ("POST", r"/api/orders/(\d+)/start",
     lambda s, b, q, id: s.start_order(_int(id))),
    ("POST", r"/api/orders/(\d+)/end",
     lambda s, b, q, id: s.end_order(_int(id), b.get("returns"))),
    ("POST", r"/api/orders/(\d+)/cancel",
     lambda s, b, q, id: s.cancel_order(_int(id))),
    ("POST", r"/api/orders/(\d+)/settle",
     lambda s, b, q, id: s.settle_order(_int(id))),
    ("GET", r"/api/grants",
     lambda s, b, q: s.list_grants()),
    ("POST", r"/api/grants/check",
     lambda s, b, q: s.check_grant(_int(b["account_id"]), b.get("at"))),
    ("GET", r"/api/faults",
     lambda s, b, q: s.list_faults()),
    ("POST", r"/api/faults",
     lambda s, b, q: s.report_fault(_int(b["seat_id"]), b.get("order_id"),
                                    b.get("type", "hardware"), b.get("description", ""))),
    ("POST", r"/api/faults/(\d+)/resolve",
     lambda s, b, q, id: s.resolve_fault(_int(id))),
    ("GET", r"/api/inspections",
     lambda s, b, q: s.list_inspections()),
    ("POST", r"/api/inspections",
     lambda s, b, q: s.create_inspection(
         _int(b["seat_id"]), b.get("order_id"), b.get("type", "routine"),
         b.get("findings", ""), _int(b.get("damage_cents", 0)), b.get("created_by", "前台"))),
    ("POST", r"/api/inspections/(\d+)/close",
     lambda s, b, q, id: s.close_inspection(
         _int(id), b.get("findings"),
         b.get("damage_cents") if b.get("damage_cents") is not None else None)),
    ("GET", r"/api/settlements",
     lambda s, b, q: s.list_settlements()),
    ("POST", r"/api/settlements/(\d+)/confirm",
     lambda s, b, q, id: s.confirm_settlement(_int(id))),
    ("POST", r"/api/settlements/(\d+)/adjust",
     lambda s, b, q, id: s.adjust_settlement(
         _int(id), _int(b["amount_cents"]), b.get("reason", ""))),
    ("POST", r"/api/settlements/(\d+)/refund",
     lambda s, b, q, id: s.refund_settlement(_int(id), b.get("idempotency_key", ""))),
]
COMPILED = [(m, re.compile("^" + p + "$"), h) for m, p, h in ROUTES]


def make_handler(service: ArenaService):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):  # 保持控制台干净
            pass

        # ---------- 响应 ----------
        def _send_json(self, obj, status=200):
            payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _send_file(self, path: Path):
            data = path.read_bytes()
            ctype = CONTENT_TYPES.get(path.suffix, "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        # ---------- 分发 ----------
        def _handle(self, method: str):
            parsed = urlparse(self.path)
            path = parsed.path
            if method == "GET":
                if path == "/":
                    return self._send_file(STATIC_DIR / "index.html")
                if path.startswith("/static/"):
                    target = (STATIC_DIR / path[len("/static/"):]).resolve()
                    if target.is_file() and STATIC_DIR in target.parents:
                        return self._send_file(target)
                    return self._send_json({"error": {"code": "not_found",
                                                      "message": "文件不存在"}}, 404)
            body = {}
            if method == "POST":
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    body = json.loads(raw or b"{}")
                except json.JSONDecodeError:
                    return self._send_json({"error": {"code": "bad_json",
                                                      "message": "请求体不是合法 JSON"}}, 400)
            query = parse_qs(parsed.query)
            for m, rx, handler in COMPILED:
                if m != method:
                    continue
                match = rx.match(path)
                if not match:
                    continue
                try:
                    result = handler(service, body, query, *match.groups())
                    self._send_json(result if result is not None else {"ok": True})
                except BizError as e:
                    self._send_json({"error": {"code": e.code, "message": e.message}},
                                    e.status)
                except (KeyError, ValueError, TypeError) as e:
                    self._send_json({"error": {"code": "bad_request",
                                               "message": f"参数错误: {e}"}}, 400)
                except Exception as e:  # noqa: BLE001
                    self._send_json({"error": {"code": "internal", "message": str(e)}}, 500)
                return
            self._send_json({"error": {"code": "not_found", "message": "接口不存在"}}, 404)

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

    return Handler


def serve(service: ArenaService, port: int = 8000, host: str = "0.0.0.0"):
    server = ThreadingHTTPServer((host, port), make_handler(service))
    server.daemon_threads = True
    print(f"电竞馆包机管理台已启动:  http://localhost:{port}")
    print("演示数据: 包机/故障/结账样例已生成; Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
