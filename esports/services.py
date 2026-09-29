"""领域服务: 包机、外设交接、账号授权、故障、巡检、结算。

关键规则:
- 同一机位同一时段只允许一个有效订单(reserved/active);
- 同一外设同一时段只服务一个订单(预订时校验 + 出借时唯一索引兜底);
- 账号授权只在 [valid_from, valid_to] 内有效, 结束/取消即回收;
- 故障停机时长从结算快照的计费时长中扣除;
- 押金扣款(赔偿)必须关联巡检工单(settlement_deductions);
- 退款按幂等键去重, 同一结算单只允许一笔退款;
- 开机采用 BEGIN IMMEDIATE + 状态校验, 并发下只有一人成功。
"""
from __future__ import annotations

from .adapters import NetworkAdapter, PaymentAdapter, PeripheralAdapter
from .db import Database
from .errors import BizError
from .timeutil import Clock, minutes_between, money, overlap_minutes, parse, to_iso

LATE_GRACE_MIN = 15    # 迟到宽限(分钟), 超时未开机自动取消
EARLY_START_MIN = 30   # 最早可提前开机(分钟)
MIN_DURATION_MIN = 30  # 最短包机时长(分钟)
DAMAGE_RATIO = 0.4     # 损坏定损 = 单件押金 * 40%; 缺失 = 100%

ACTIVE_STATUSES = ("reserved", "active")


def _d(row):
    return dict(row) if row is not None else None


class ArenaService:
    def __init__(self, db: Database, clock: Clock = None,
                 net: NetworkAdapter = None,
                 peripheral: PeripheralAdapter = None,
                 payment: PaymentAdapter = None):
        self.db = db
        self.clock = clock or Clock()
        self.net = net or NetworkAdapter()
        self.peripheral = peripheral or PeripheralAdapter()
        self.payment = payment or PaymentAdapter()

    # ---------------------------------------------------------------- 工具
    def _event(self, conn, kind: str, message: str) -> None:
        conn.execute("INSERT INTO events(ts, kind, message) VALUES (?,?,?)",
                     (self.clock.now_iso(), kind, message))

    @staticmethod
    def _get(conn, sql, args, msg="记录不存在"):
        row = conn.execute(sql, args).fetchone()
        if row is None:
            raise BizError(404, "not_found", msg)
        return row

    @staticmethod
    def _next_code(conn, table: str, prefix: str) -> str:
        n = conn.execute(f"SELECT COUNT(*) c FROM {table}").fetchone()["c"] + 1
        return f"{prefix}{n:04d}"

    def _kit_items(self, conn, kit_id: int):
        return conn.execute(
            """SELECT p.* FROM kit_items ki JOIN peripherals p ON p.id = ki.peripheral_id
               WHERE ki.kit_id = ? ORDER BY p.type""", (kit_id,)).fetchall()

    # ---------------------------------------------------------------- 包机
    def create_order(self, customer_id: int, seat_id: int, kit_id: int,
                     account_ids, start_at: str, end_at: str) -> dict:
        start, end = parse(start_at), parse(end_at)
        now = self.clock.now()
        if (end - start).total_seconds() < MIN_DURATION_MIN * 60:
            raise BizError(400, "bad_duration", f"包机时长至少 {MIN_DURATION_MIN} 分钟")
        if (now - start).total_seconds() > 3600:
            raise BizError(400, "bad_start", "开始时间早于当前超过 1 小时, 请核对时间")
        start_iso, end_iso = to_iso(start), to_iso(end)

        with self.db.immediate() as conn:
            seat = self._get(conn, "SELECT * FROM seats WHERE id=?", (seat_id,), "机位不存在")
            if seat["status"] == "maintenance":
                raise BizError(409, "seat_maintenance", f"机位 {seat['code']} 维护中, 暂不可预订")
            self._get(conn, "SELECT * FROM customers WHERE id=?", (customer_id,), "顾客不存在")
            kit = self._get(conn, "SELECT * FROM kits WHERE id=?", (kit_id,), "外设套装不存在")

            # 机位时段互斥
            clash = conn.execute(
                """SELECT code FROM orders
                   WHERE seat_id=? AND status IN ('reserved','active')
                     AND NOT (end_at <= ? OR start_at >= ?)""",
                (seat_id, start_iso, end_iso)).fetchone()
            if clash:
                raise BizError(409, "slot_conflict",
                               f"机位 {seat['code']} 该时段已被订单 {clash['code']} 占用")

            # 外设时段互斥(同一外设不能被两个订单同时占用)
            items = self._kit_items(conn, kit_id)
            if not items:
                raise BizError(400, "empty_kit", "该套装内没有外设")
            for p in items:
                if p["status"] in ("maintenance", "missing"):
                    raise BizError(409, "peripheral_unavailable",
                                   f"外设 {p['serial']} 当前不可用({p['status']})")
                clash = conn.execute(
                    """SELECT o.code FROM orders o
                       JOIN kit_items ki ON ki.kit_id = o.kit_id
                       WHERE ki.peripheral_id=? AND o.status IN ('reserved','active')
                         AND NOT (o.end_at <= ? OR o.start_at >= ?)""",
                    (p["id"], start_iso, end_iso)).fetchone()
                if clash:
                    raise BizError(409, "peripheral_conflict",
                                   f"外设 {p['serial']} 在同时段已被订单 {clash['code']} 占用")

            code = self._next_code(conn, "orders", "BK")
            cur = conn.execute(
                """INSERT INTO orders(code, customer_id, seat_id, kit_id, start_at, end_at,
                                      status, deposit_cents, created_at)
                   VALUES (?,?,?,?,?,?, 'reserved', ?, ?)""",
                (code, customer_id, seat_id, kit_id, start_iso, end_iso,
                 kit["deposit_cents"], self.clock.now_iso()))
            oid = cur.lastrowid
            for aid in account_ids or []:
                acc = self._get(conn, "SELECT * FROM game_accounts WHERE id=?",
                                (aid,), f"游戏账号 {aid} 不存在")
                conn.execute(
                    """INSERT INTO account_grants(order_id, account_id, valid_from, valid_to, status)
                       VALUES (?,?,?,?, 'pending')""", (oid, aid, start_iso, end_iso))
            self._event(conn, "order",
                        f"包机订单 {code} 已创建: {seat['code']} {start_iso}~{end_iso}, "
                        f"押金 {money(kit['deposit_cents'])}")
        return self.get_order(oid)

    def start_order(self, order_id: int) -> dict:
        """开机: 并发下仅允许一次成功(BEGIN IMMEDIATE 串行化 + 状态校验)。

        迟到超时: 先在事务内提交"自动取消", 再向调用方抛出 late_cancelled。
        """
        late_cancelled = False
        with self.db.immediate() as conn:
            o = self._get(conn, "SELECT * FROM orders WHERE id=?", (order_id,), "订单不存在")
            if o["status"] != "reserved":
                raise BizError(409, "state_conflict",
                               f"订单 {o['code']} 当前状态为 {o['status']}, 不能重复开机")
            now = self.clock.now()
            start = parse(o["start_at"])
            if (now - start).total_seconds() > LATE_GRACE_MIN * 60:
                conn.execute("UPDATE orders SET status='cancelled' WHERE id=?", (order_id,))
                conn.execute("UPDATE account_grants SET status='revoked' WHERE order_id=?", (order_id,))
                self._event(conn, "order",
                            f"订单 {o['code']} 迟到超过 {LATE_GRACE_MIN} 分钟, 自动取消并回收授权")
                late_cancelled = True
            else:
                if (start - now).total_seconds() > EARLY_START_MIN * 60:
                    raise BizError(409, "too_early",
                                   f"距预约开始尚早, 最早可提前 {EARLY_START_MIN} 分钟开机")

                seat = self._get(conn, "SELECT * FROM seats WHERE id=?", (o["seat_id"],))
                now_iso = self.clock.now_iso()
                conn.execute("UPDATE orders SET status='active', started_at=? WHERE id=?",
                             (now_iso, order_id))
                conn.execute("UPDATE seats SET status='in_use' WHERE id=?", (o["seat_id"],))

                # 外设出库: 逐项记录编号与外观
                for p in self._kit_items(conn, o["kit_id"]):
                    busy = conn.execute(
                        "SELECT id FROM loan_records WHERE peripheral_id=? AND checked_in_at IS NULL",
                        (p["id"],)).fetchone()
                    if busy:
                        raise BizError(409, "peripheral_busy",
                                       f"外设 {p['serial']} 尚未归还, 无法出借")
                    receipt = self.peripheral.checkout(p["serial"])
                    conn.execute(
                        """INSERT INTO loan_records(order_id, peripheral_id, checked_out_at, appearance_out)
                           VALUES (?,?,?,?)""",
                        (order_id, p["id"], now_iso, p["appearance"]))
                    conn.execute("UPDATE peripherals SET status='lent' WHERE id=?", (p["id"],))
                    self._event(conn, "peripheral",
                                f"外设出库 {p['serial']}({p['model']}) → 订单 {o['code']}, "
                                f"外观:{p['appearance']}, 回执 {receipt['receipt']}")

                conn.execute("UPDATE account_grants SET status='active' "
                             "WHERE order_id=? AND status='pending'", (order_id,))
                receipt = self.net.power_on(seat["code"])
                self._event(conn, "network", f"机位 {seat['code']} 上电开机, 回执 {receipt['receipt']}")
                self._event(conn, "order", f"订单 {o['code']} 已开机, 账号授权在包机时段内生效")
        if late_cancelled:
            raise BizError(409, "late_cancelled",
                           f"迟到超过 {LATE_GRACE_MIN} 分钟, 订单已自动取消")
        return self.get_order(order_id)

    def end_order(self, order_id: int, returns=None) -> dict:
        """结束订单: 逐项归还外设, 损坏/缺失自动生成结账检查工单。"""
        returns = returns or []
        ret_map = {int(r["peripheral_id"]): r for r in returns}
        with self.db.immediate() as conn:
            o = self._get(conn, "SELECT * FROM orders WHERE id=?", (order_id,), "订单不存在")
            if o["status"] != "active":
                raise BizError(409, "state_conflict", "仅进行中的订单可以结束")
            now_iso = self.clock.now_iso()
            loans = conn.execute(
                """SELECT lr.*, p.serial, p.model, p.type, p.deposit_cents
                   FROM loan_records lr JOIN peripherals p ON p.id = lr.peripheral_id
                   WHERE lr.order_id=? AND lr.checked_in_at IS NULL
                   ORDER BY lr.id""", (order_id,)).fetchall()

            damaged, missing = [], []
            for loan in loans:
                entry = ret_map.get(loan["peripheral_id"], {})
                condition = entry.get("condition", "ok")
                appearance = (entry.get("appearance") or "与出借一致").strip() or "与出借一致"
                if condition not in ("ok", "damaged", "missing"):
                    raise BizError(400, "bad_condition", "归还状态必须是 ok / damaged / missing")
                receipt = self.peripheral.checkin(loan["serial"], condition)
                conn.execute(
                    """UPDATE loan_records SET checked_in_at=?, appearance_in=?, condition_in=?
                       WHERE id=?""", (now_iso, appearance, condition, loan["id"]))
                new_status = {"ok": "available", "damaged": "maintenance",
                              "missing": "missing"}[condition]
                conn.execute("UPDATE peripherals SET status=? WHERE id=?",
                             (new_status, loan["peripheral_id"]))
                self._event(conn, "peripheral",
                            f"外设归还 {loan['serial']} 状态={condition}, 回执 {receipt['receipt']}")
                if condition == "damaged":
                    damaged.append(loan)
                elif condition == "missing":
                    missing.append(loan)

            # 损坏/缺失 → 结账检查工单(押金扣款的依据)
            if damaged or missing:
                parts, total = [], 0
                for loan in damaged:
                    amt = round(loan["deposit_cents"] * DAMAGE_RATIO)
                    total += amt
                    parts.append(f"{loan['serial']} 损坏, 定损 {money(amt)}")
                for loan in missing:
                    amt = loan["deposit_cents"]
                    total += amt
                    parts.append(f"{loan['serial']} 缺失, 按押金全赔 {money(amt)}")
                code = self._next_code(conn, "inspection_tickets", "INSP")
                conn.execute(
                    """INSERT INTO inspection_tickets(code, seat_id, order_id, type, status,
                                                      findings, damage_cents, created_by, created_at)
                       VALUES (?,?,?, 'checkout', 'open', ?, ?, 'system', ?)""",
                    (code, o["seat_id"], order_id, "; ".join(parts), total, now_iso))
                self._event(conn, "inspection",
                            f"结账检查工单 {code} 已生成: {'; '.join(parts)}")

            conn.execute("UPDATE account_grants SET status='revoked' "
                         "WHERE order_id=? AND status='active'", (order_id,))
            seat = self._get(conn, "SELECT * FROM seats WHERE id=?", (o["seat_id"],))
            conn.execute("UPDATE seats SET status='idle' WHERE id=?", (o["seat_id"],))
            receipt = self.net.power_off(seat["code"])
            self._event(conn, "network", f"机位 {seat['code']} 关机断电, 回执 {receipt['receipt']}")
            conn.execute("UPDATE orders SET status='ended', ended_at=? WHERE id=?",
                         (now_iso, order_id))
            if self.clock.now() < parse(o["end_at"]):
                self._event(conn, "order", f"订单 {o['code']} 提前结束, 按实际使用时长计费")
            else:
                self._event(conn, "order", f"订单 {o['code']} 已结束")
        return self.get_order(order_id)

    def cancel_order(self, order_id: int) -> dict:
        with self.db.immediate() as conn:
            o = self._get(conn, "SELECT * FROM orders WHERE id=?", (order_id,), "订单不存在")
            if o["status"] != "reserved":
                raise BizError(409, "state_conflict", "仅待开机的订单可以取消")
            conn.execute("UPDATE orders SET status='cancelled' WHERE id=?", (order_id,))
            conn.execute("UPDATE account_grants SET status='revoked' WHERE order_id=?", (order_id,))
            self._event(conn, "order", f"订单 {o['code']} 已取消, 授权已回收")
        return self.get_order(order_id)

    # ---------------------------------------------------------------- 故障
    def report_fault(self, seat_id: int, order_id, type_: str, description: str) -> dict:
        if type_ not in ("network", "hardware", "peripheral"):
            raise BizError(400, "bad_type", "故障类型必须是 network / hardware / peripheral")
        with self.db.immediate() as conn:
            seat = self._get(conn, "SELECT * FROM seats WHERE id=?", (seat_id,), "机位不存在")
            code = self._next_code(conn, "fault_tickets", "FLT")
            cur = conn.execute(
                """INSERT INTO fault_tickets(code, order_id, seat_id, type, description,
                                             started_at, status)
                   VALUES (?,?,?,?,?,?, 'open')""",
                (code, order_id, seat_id, type_, description or "", self.clock.now_iso()))
            if type_ == "network":
                receipt = self.net.set_link(seat["code"], False)
                self._event(conn, "network",
                            f"机位 {seat['code']} 网络中断, 回执 {receipt['receipt']}")
            self._event(conn, "fault", f"故障工单 {code} 已创建: {description or type_}")
            fid = cur.lastrowid
        return self.get_fault(fid)

    def resolve_fault(self, fault_id: int) -> dict:
        with self.db.immediate() as conn:
            f = self._get(conn, "SELECT * FROM fault_tickets WHERE id=?", (fault_id,), "故障工单不存在")
            if f["status"] != "open":
                raise BizError(409, "state_conflict", "故障工单已处理")
            now_iso = self.clock.now_iso()
            mins = max(0, minutes_between(f["started_at"], now_iso))
            conn.execute(
                """UPDATE fault_tickets SET status='resolved', resolved_at=?, downtime_minutes=?
                   WHERE id=?""", (now_iso, mins, fault_id))
            seat = self._get(conn, "SELECT * FROM seats WHERE id=?", (f["seat_id"],))
            if f["type"] == "network":
                receipt = self.net.set_link(seat["code"], True)
                self._event(conn, "network",
                            f"机位 {seat['code']} 网络恢复, 回执 {receipt['receipt']}")
            self._event(conn, "fault", f"故障工单 {f['code']} 已解决, 停机 {mins} 分钟")
        return self.get_fault(fault_id)

    # ---------------------------------------------------------------- 巡检
    def create_inspection(self, seat_id: int, order_id, type_: str,
                          findings: str, damage_cents: int, created_by: str) -> dict:
        if type_ not in ("routine", "checkout"):
            raise BizError(400, "bad_type", "巡检类型必须是 routine / checkout")
        with self.db.immediate() as conn:
            self._get(conn, "SELECT * FROM seats WHERE id=?", (seat_id,), "机位不存在")
            code = self._next_code(conn, "inspection_tickets", "INSP")
            cur = conn.execute(
                """INSERT INTO inspection_tickets(code, seat_id, order_id, type, status,
                                                  findings, damage_cents, created_by, created_at)
                   VALUES (?,?,?,?, 'open', ?, ?, ?, ?)""",
                (code, seat_id, order_id, type_, findings or "", int(damage_cents or 0),
                 created_by or "前台", self.clock.now_iso()))
            self._event(conn, "inspection", f"巡检工单 {code} 已创建: {findings or '日常巡检'}")
            iid = cur.lastrowid
        return _d(self.db.one("SELECT * FROM inspection_tickets WHERE id=?", (iid,)))

    def close_inspection(self, inspection_id: int, findings=None, damage_cents=None) -> dict:
        with self.db.immediate() as conn:
            t = self._get(conn, "SELECT * FROM inspection_tickets WHERE id=?",
                          (inspection_id,), "巡检工单不存在")
            if t["status"] != "open":
                raise BizError(409, "state_conflict", "巡检工单已关闭")
            conn.execute(
                """UPDATE inspection_tickets SET status='closed', closed_at=?,
                       findings=?, damage_cents=? WHERE id=?""",
                (self.clock.now_iso(),
                 findings if findings is not None else t["findings"],
                 int(damage_cents) if damage_cents is not None else t["damage_cents"],
                 inspection_id))
            self._event(conn, "inspection", f"巡检工单 {t['code']} 已关闭")
        return _d(self.db.one("SELECT * FROM inspection_tickets WHERE id=?", (inspection_id,)))

    # ---------------------------------------------------------------- 结算
    def settle_order(self, order_id: int) -> dict:
        """生成结算快照: 故障停机时长从计费时长中扣除, 赔偿关联巡检工单。"""
        with self.db.immediate() as conn:
            o = self._get(conn, "SELECT * FROM orders WHERE id=?", (order_id,), "订单不存在")
            if o["status"] != "ended":
                raise BizError(409, "state_conflict", "订单尚未结束, 不能结算")
            if conn.execute("SELECT id FROM settlements WHERE order_id=?", (order_id,)).fetchone():
                raise BizError(409, "already_settled", "该订单已有结算快照")
            seat = self._get(conn, "SELECT * FROM seats WHERE id=?", (o["seat_id"],))

            usage = max(0, minutes_between(o["started_at"], o["ended_at"]))
            downtime = 0
            for f in conn.execute("SELECT * FROM fault_tickets WHERE order_id=?",
                                  (order_id,)).fetchall():
                f_end = f["resolved_at"] or o["ended_at"]  # 未解决的故障计到订单结束
                downtime += overlap_minutes(o["started_at"], o["ended_at"],
                                            f["started_at"], f_end)
            downtime = min(downtime, usage)
            billable = usage - downtime

            rate = seat["hourly_price_cents"] / 60.0
            gross = int(billable * rate + 0.5)
            credit = int(downtime * rate + 0.5)

            insps = conn.execute(
                """SELECT * FROM inspection_tickets
                   WHERE order_id=? AND damage_cents > 0 ORDER BY id""", (order_id,)).fetchall()
            damage = sum(i["damage_cents"] for i in insps)
            deposit = o["deposit_cents"]
            refund = max(0, deposit - damage)
            extra_due = max(0, damage - deposit)  # 赔偿超出押金部分并入应收
            due = gross + extra_due

            cur = conn.execute(
                """INSERT INTO settlements(order_id, billable_minutes, gross_cents,
                       downtime_minutes, downtime_credit_cents, damage_cents,
                       adjustment_cents, deposit_cents, refund_cents, due_cents,
                       status, created_at)
                   VALUES (?,?,?,?,?,?,0,?,?,?, 'pending', ?)""",
                (order_id, billable, gross, downtime, credit, damage,
                 deposit, refund, due, self.clock.now_iso()))
            sid = cur.lastrowid
            for i in insps:
                conn.execute(
                    """INSERT INTO settlement_deductions(settlement_id, inspection_id,
                                                         amount_cents, reason)
                       VALUES (?,?,?,?)""",
                    (sid, i["id"], i["damage_cents"], f"巡检单 {i['code']} 定损扣款"))
            self._event(
                conn, "settlement",
                f"订单 {o['code']} 结算快照: 计费 {billable} 分钟(停机 {downtime} 分钟已扣除), "
                f"赔偿 {money(damage)}, 应收 {money(due)}, 应退押金 {money(refund)}")
        return self.get_settlement(sid)

    def adjust_settlement(self, settlement_id: int, amount_cents: int, reason: str) -> dict:
        """异常扣费冲正: amount_cents 为负表示退还给顾客。"""
        with self.db.immediate() as conn:
            s = self._get(conn, "SELECT * FROM settlements WHERE id=?",
                          (settlement_id,), "结算单不存在")
            if s["status"] != "pending":
                raise BizError(409, "state_conflict", "仅待确认的结算可以调整")
            if s["due_cents"] + amount_cents < 0:
                raise BizError(400, "bad_adjustment", "调整后应收不能为负")
            conn.execute(
                """UPDATE settlements SET adjustment_cents = adjustment_cents + ?,
                       due_cents = due_cents + ? WHERE id=?""",
                (int(amount_cents), int(amount_cents), settlement_id))
            self._event(conn, "settlement",
                        f"结算 #{settlement_id} 调整 {money(amount_cents)}: {reason or '异常扣费冲正'}")
        return self.get_settlement(settlement_id)

    def confirm_settlement(self, settlement_id: int) -> dict:
        with self.db.immediate() as conn:
            s = self._get(conn, "SELECT * FROM settlements WHERE id=?",
                          (settlement_id,), "结算单不存在")
            if s["status"] != "pending":
                raise BizError(409, "state_conflict", "结算单已确认")
            receipt = self.payment.charge(f"charge-{settlement_id}", s["due_cents"],
                                          f"结算单 #{settlement_id} 收款")
            conn.execute("UPDATE settlements SET status='confirmed' WHERE id=?", (settlement_id,))
            conn.execute("UPDATE orders SET status='settled' WHERE id=?", (s["order_id"],))
            self._event(conn, "payment",
                        f"结算 #{settlement_id} 收款 {money(s['due_cents'])}, 回执 {receipt['receipt']}")
        return self.get_settlement(settlement_id)

    def refund_settlement(self, settlement_id: int, idempotency_key: str) -> dict:
        """退还押金: 幂等键去重; 同一结算单只允许一笔退款。"""
        key = (idempotency_key or "").strip()
        if not key:
            raise BizError(400, "bad_request", "缺少幂等键 idempotency_key")
        with self.db.immediate() as conn:
            s = self._get(conn, "SELECT * FROM settlements WHERE id=?",
                          (settlement_id,), "结算单不存在")
            existing = conn.execute("SELECT * FROM refunds WHERE settlement_id=?",
                                    (settlement_id,)).fetchone()
            if existing:
                if existing["idempotency_key"] == key:
                    out = dict(existing)
                    out["replayed"] = True   # 幂等重放: 返回原退款单, 不产生新扣款
                    return out
                raise BizError(409, "already_refunded",
                               f"该结算已退款(退款单 #{existing['id']}), 不能重复退款")
            if s["status"] != "confirmed":
                raise BizError(409, "state_conflict", "结算未确认收款, 不能退款")
            receipt = self.payment.refund(key, s["refund_cents"],
                                          f"结算单 #{settlement_id} 押金退还")
            cur = conn.execute(
                """INSERT INTO refunds(settlement_id, idempotency_key, amount_cents,
                                       status, created_at)
                   VALUES (?,?,?, 'succeeded', ?)""",
                (settlement_id, key, s["refund_cents"], self.clock.now_iso()))
            conn.execute("UPDATE settlements SET status='refunded' WHERE id=?", (settlement_id,))
            self._event(conn, "payment",
                        f"结算 #{settlement_id} 退还押金 {money(s['refund_cents'])}, "
                        f"回执 {receipt['receipt']}")
            rid = cur.lastrowid
        out = dict(self.db.one("SELECT * FROM refunds WHERE id=?", (rid,)))
        out["replayed"] = False
        return out

    # ---------------------------------------------------------------- 授权
    def sweep_grants(self) -> None:
        """惰性清理: 过期授权置为 expired, 已取消订单的授权回收。"""
        with self.db.immediate() as conn:
            now = self.clock.now_iso()
            conn.execute("UPDATE account_grants SET status='expired' "
                         "WHERE status='active' AND valid_to < ?", (now,))
            conn.execute("""UPDATE account_grants SET status='revoked'
                            WHERE status='pending' AND order_id IN
                              (SELECT id FROM orders WHERE status='cancelled')""")

    def check_grant(self, account_id: int, at_iso: str = None) -> dict:
        """权限闸门: 仅当授权 active 且当前时刻落在 [valid_from, valid_to] 内才放行。"""
        self.sweep_grants()
        at = at_iso or self.clock.now_iso()
        row = self.db.one(
            """SELECT g.*, o.code AS order_code FROM account_grants g
               JOIN orders o ON o.id = g.order_id
               WHERE g.account_id=? AND g.status='active'
                 AND g.valid_from <= ? AND g.valid_to >= ?
               ORDER BY g.id DESC""", (account_id, at, at))
        if row:
            return {"valid": True, "grant": dict(row)}
        return {"valid": False, "reason": "无有效授权或授权已过期"}

    # ---------------------------------------------------------------- 查询
    def get_order(self, order_id: int) -> dict:
        o = self.db.one(
            """SELECT o.*, s.code AS seat_code, s.zone AS seat_zone, c.name AS customer_name,
                      k.name AS kit_name
               FROM orders o
               JOIN seats s ON s.id = o.seat_id
               JOIN customers c ON c.id = o.customer_id
               JOIN kits k ON k.id = o.kit_id
               WHERE o.id=?""", (order_id,))
        if not o:
            raise BizError(404, "not_found", "订单不存在")
        out = dict(o)
        out["loans"] = [dict(r) for r in self.db.query(
            """SELECT lr.*, p.serial, p.model, p.type
               FROM loan_records lr JOIN peripherals p ON p.id = lr.peripheral_id
               WHERE lr.order_id=? ORDER BY lr.id""", (order_id,))]
        out["grants"] = [dict(r) for r in self.db.query(
            """SELECT g.*, a.game, a.login_name FROM account_grants g
               JOIN game_accounts a ON a.id = g.account_id
               WHERE g.order_id=? ORDER BY g.id""", (order_id,))]
        out["faults"] = [dict(r) for r in self.db.query(
            "SELECT * FROM fault_tickets WHERE order_id=? ORDER BY id", (order_id,))]
        st = self.db.one("SELECT id, status FROM settlements WHERE order_id=?", (order_id,))
        out["settlement"] = dict(st) if st else None
        return out

    def get_fault(self, fault_id: int) -> dict:
        row = self.db.one(
            """SELECT f.*, s.code AS seat_code FROM fault_tickets f
               JOIN seats s ON s.id = f.seat_id WHERE f.id=?""", (fault_id,))
        if not row:
            raise BizError(404, "not_found", "故障工单不存在")
        return dict(row)

    def get_settlement(self, settlement_id: int) -> dict:
        s = self.db.one(
            """SELECT st.*, o.code AS order_code, o.id AS order_id,
                      s2.code AS seat_code, c.name AS customer_name
               FROM settlements st
               JOIN orders o ON o.id = st.order_id
               JOIN seats s2 ON s2.id = o.seat_id
               JOIN customers c ON c.id = o.customer_id
               WHERE st.id=?""", (settlement_id,))
        if not s:
            raise BizError(404, "not_found", "结算单不存在")
        out = dict(s)
        out["deductions"] = [dict(r) for r in self.db.query(
            """SELECT d.*, i.code AS inspection_code FROM settlement_deductions d
               JOIN inspection_tickets i ON i.id = d.inspection_id
               WHERE d.settlement_id=? ORDER BY d.id""", (settlement_id,))]
        rf = self.db.one("SELECT * FROM refunds WHERE settlement_id=?", (settlement_id,))
        out["refund"] = dict(rf) if rf else None
        return out

    def get_state(self) -> list:
        """机位平面图聚合: 机位 + 进行中订单(剩余时间) + 下一单 + 网络状态。"""
        seats = self.db.query("SELECT * FROM seats ORDER BY grid_row, grid_col")
        now = self.clock.now()
        now_iso = to_iso(now)
        active = self.db.query(
            """SELECT o.*, c.name AS customer_name FROM orders o
               JOIN customers c ON c.id = o.customer_id WHERE o.status='active'""")
        upcoming = self.db.query(
            """SELECT o.*, c.name AS customer_name FROM orders o
               JOIN customers c ON c.id = o.customer_id
               WHERE o.status='reserved' AND o.end_at >= ? ORDER BY o.start_at""", (now_iso,))
        by_seat_active = {o["seat_id"]: o for o in active}
        by_seat_next = {}
        for o in upcoming:
            by_seat_next.setdefault(o["seat_id"], o)

        result = []
        for s in seats:
            item = dict(s)
            a = by_seat_active.get(s["id"])
            if a:
                total = max(1, (parse(a["end_at"]) - parse(a["started_at"])).total_seconds())
                remain = max(0, (parse(a["end_at"]) - now).total_seconds())
                item["active_order"] = {
                    "id": a["id"], "code": a["code"], "customer_name": a["customer_name"],
                    "end_at": a["end_at"], "remaining_sec": int(remain),
                    "progress": round(remain / total, 4),
                }
            n = by_seat_next.get(s["id"])
            if n:
                item["next_order"] = {
                    "id": n["id"], "code": n["code"], "customer_name": n["customer_name"],
                    "start_at": n["start_at"], "end_at": n["end_at"],
                }
            item["net"] = self.net.status(s["code"])
            result.append(item)
        return result

    def list_seats(self):
        return [dict(r) for r in self.db.query("SELECT * FROM seats ORDER BY grid_row, grid_col")]

    def list_kits(self):
        kits = [dict(r) for r in self.db.query("SELECT * FROM kits ORDER BY id")]
        for k in kits:
            k["items"] = [dict(r) for r in self.db.query(
                """SELECT p.* FROM kit_items ki JOIN peripherals p ON p.id = ki.peripheral_id
                   WHERE ki.kit_id=? ORDER BY p.type""", (k["id"],))]
        return kits

    def list_peripherals(self):
        return [dict(r) for r in self.db.query("SELECT * FROM peripherals ORDER BY serial")]

    def list_customers(self):
        return [dict(r) for r in self.db.query("SELECT * FROM customers ORDER BY id")]

    def list_accounts(self):
        return [dict(r) for r in self.db.query("SELECT * FROM game_accounts ORDER BY id")]

    def list_orders(self, status: str = None, recent: bool = False):
        sql = """SELECT o.*, s.code AS seat_code, c.name AS customer_name, k.name AS kit_name
                 FROM orders o
                 JOIN seats s ON s.id = o.seat_id
                 JOIN customers c ON c.id = o.customer_id
                 JOIN kits k ON k.id = o.kit_id"""
        args, where = [], []
        if status:
            where.append("o.status = ?")
            args.append(status)
        if recent:  # 日历视图: 前后两天的订单
            where.append("o.end_at >= datetime('now', '-2 days')")
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY o.start_at"
        return [dict(r) for r in self.db.query(sql, args)]

    def list_grants(self):
        self.sweep_grants()
        return [dict(r) for r in self.db.query(
            """SELECT g.*, a.game, a.login_name, o.code AS order_code, s.code AS seat_code
               FROM account_grants g
               JOIN game_accounts a ON a.id = g.account_id
               JOIN orders o ON o.id = g.order_id
               JOIN seats s ON s.id = o.seat_id
               ORDER BY g.valid_from DESC""")]

    def list_faults(self):
        return [dict(r) for r in self.db.query(
            """SELECT f.*, s.code AS seat_code, o.code AS order_code
               FROM fault_tickets f
               JOIN seats s ON s.id = f.seat_id
               LEFT JOIN orders o ON o.id = f.order_id
               ORDER BY f.status DESC, f.id DESC""")]

    def list_inspections(self):
        return [dict(r) for r in self.db.query(
            """SELECT i.*, s.code AS seat_code, o.code AS order_code
               FROM inspection_tickets i
               JOIN seats s ON s.id = i.seat_id
               LEFT JOIN orders o ON o.id = i.order_id
               ORDER BY i.status DESC, i.id DESC""")]

    def list_settlements(self):
        rows = self.db.query(
            """SELECT st.id FROM settlements st ORDER BY
                 CASE st.status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
                 st.id DESC""")
        return [self.get_settlement(r["id"]) for r in rows]

    def list_events(self, limit: int = 30):
        return [dict(r) for r in self.db.query(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))]
