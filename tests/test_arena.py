"""业务规则测试: 时段竞争、权限到期、设备唯一、停机补偿、退款幂等等。

运行: python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from esports.db import Database, init_db
from esports.errors import BizError
from esports.seed import seed_base
from esports.services import ArenaService, LATE_GRACE_MIN
from esports.timeutil import ManualClock, to_iso

T0 = datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc)  # 测试基准时刻


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="esports-test-")
        self.db = Database(os.path.join(self.tmp, "test.db"))
        init_db(self.db)
        seed_base(self.db)
        self.clock = ManualClock(T0)
        self.svc = ArenaService(self.db, self.clock)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- 定位演示数据 ----
    def seat(self, code):
        return self.db.one("SELECT id FROM seats WHERE code=?", (code,))["id"]

    def kit(self, name):
        return self.db.one("SELECT id FROM kits WHERE name=?", (name,))["id"]

    def cust(self, name="张伟"):
        return self.db.one("SELECT id FROM customers WHERE name=?", (name,))["id"]

    def acct(self, login="LOL-王者一号"):
        return self.db.one("SELECT id FROM game_accounts WHERE login_name=?", (login,))["id"]

    def peri(self, serial):
        return self.db.one("SELECT id FROM peripherals WHERE serial=?", (serial,))["id"]

    @staticmethod
    def iso(dt):
        return to_iso(dt)

    def make_order(self, seat="A01", kit="标准套装", start=T0, hours=2, accounts=None):
        return self.svc.create_order(
            self.cust(), self.seat(seat), self.kit(kit),
            accounts if accounts is not None else [self.acct()],
            self.iso(start), self.iso(start + timedelta(hours=hours)))

    def assertBiz(self, code, fn, *args, **kwargs):
        with self.assertRaises(BizError) as ctx:
            fn(*args, **kwargs)
        self.assertEqual(ctx.exception.code, code)
        return ctx.exception


class TestSlotContention(Base):
    """时段竞争: 同一机位同一时段只允许一个订单。"""

    def test_overlapping_slot_rejected(self):
        self.make_order(seat="A01", start=T0, hours=2)  # 10:00-12:00
        # 完全重叠 / 部分重叠 / 包含, 全部拒绝
        for s, h in [(T0, 2), (T0 + timedelta(hours=1), 2),
                     (T0 - timedelta(hours=1), 2), (T0 + timedelta(minutes=30), 1)]:
            self.assertBiz("slot_conflict", self.make_order, seat="A01", start=s, hours=h)

    def test_adjacent_slot_allowed(self):
        self.make_order(seat="A01", start=T0, hours=2)
        nxt = self.make_order(seat="A01", start=T0 + timedelta(hours=2), hours=1)
        self.assertEqual(nxt["status"], "reserved")

    def test_same_slot_different_seat_allowed(self):
        self.make_order(seat="A01", start=T0, hours=2)
        other = self.make_order(seat="A02", kit="电竞套装", start=T0, hours=2)
        self.assertEqual(other["status"], "reserved")

    def test_cancelled_order_frees_slot(self):
        o = self.make_order(seat="A01", start=T0, hours=2)
        self.svc.cancel_order(o["id"])
        again = self.make_order(seat="A01", start=T0, hours=2)
        self.assertEqual(again["status"], "reserved")


class TestDeviceUniqueness(Base):
    """设备唯一: 同一外设不能被两个订单同时占用。"""

    def test_same_kit_overlapping_rejected(self):
        self.make_order(seat="A01", kit="标准套装", start=T0, hours=2)
        self.assertBiz("peripheral_conflict", self.make_order,
                       seat="A02", kit="标准套装", start=T0 + timedelta(hours=1), hours=2)

    def test_same_kit_sequential_allowed(self):
        self.make_order(seat="A01", kit="标准套装", start=T0, hours=2)
        ok = self.make_order(seat="A02", kit="标准套装",
                             start=T0 + timedelta(hours=2), hours=1)
        self.assertEqual(ok["status"], "reserved")

    def test_loan_released_after_return(self):
        o1 = self.make_order(seat="A01", kit="标准套装", start=T0, hours=2)
        self.svc.start_order(o1["id"])
        self.clock.set(T0 + timedelta(hours=2))
        self.svc.end_order(o1["id"])  # 全部完好归还
        o2 = self.make_order(seat="A02", kit="标准套装",
                             start=T0 + timedelta(hours=2), hours=1)
        self.svc.start_order(o2["id"])  # 外设已释放, 可再次出借
        loans = self.db.query("SELECT * FROM loan_records WHERE checked_in_at IS NULL")
        self.assertEqual(len(loans), 3)  # 只有 o2 的三件在借

    def test_active_loan_unique_index(self):
        """数据库兜底: 同一外设不允许两条未归还记录。"""
        o = self.make_order(seat="A01", kit="标准套装", start=T0, hours=2)
        self.svc.start_order(o["id"])
        pid = self.peri("KB-1001")
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db.immediate() as conn:
                conn.execute(
                    """INSERT INTO loan_records(order_id, peripheral_id, checked_out_at)
                       VALUES (?,?,?)""", (o["id"], pid, self.clock.now_iso()))


class TestConcurrentStart(Base):
    """两名前台同时开机同一订单: 只允许一次成功。"""

    def test_double_start_single_success(self):
        o = self.make_order(seat="A01", start=T0, hours=2)
        results, errors = [], []

        def worker():
            try:
                self.svc.start_order(o["id"])
                results.append("ok")
            except BizError as e:
                errors.append(e.code)

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(results), 1, "只允许一次开机成功")
        self.assertEqual(errors, ["state_conflict"])
        order = self.svc.get_order(o["id"])
        self.assertEqual(order["status"], "active")
        self.assertEqual(len(order["loans"]), 3)  # 外设只出库一次


class TestGrantExpiry(Base):
    """权限到期: 账号授权只在包机有效时段内开放。"""

    def test_grant_window(self):
        aid = self.acct()
        o = self.make_order(seat="A01", start=T0, hours=2, accounts=[aid])
        # 未开机: 授权 pending, 不放行
        self.assertFalse(self.svc.check_grant(aid)["valid"])
        # 开机后, 时段内放行
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(hours=1))
        self.assertTrue(self.svc.check_grant(aid)["valid"])
        # 超过包机结束时间: 过期, 不放行
        self.clock.set(T0 + timedelta(hours=2, minutes=1))
        self.assertFalse(self.svc.check_grant(aid)["valid"])
        grants = [g for g in self.svc.list_grants() if g["account_id"] == aid]
        self.assertEqual(grants[0]["status"], "expired")

    def test_grant_revoked_on_early_end(self):
        aid = self.acct()
        o = self.make_order(seat="A01", start=T0, hours=2, accounts=[aid])
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(hours=1))
        self.svc.end_order(o["id"])  # 提前结束 → 授权立即回收
        self.assertFalse(self.svc.check_grant(aid)["valid"])

    def test_grant_revoked_on_cancel(self):
        aid = self.acct()
        o = self.make_order(seat="A01", start=T0, hours=2, accounts=[aid])
        self.svc.cancel_order(o["id"])
        self.assertFalse(self.svc.check_grant(aid)["valid"])


class TestDowntimeCompensation(Base):
    """停机补偿: 故障导致的停机时间从结算快照中扣除。"""

    def test_downtime_deducted(self):
        o = self.make_order(seat="A01", start=T0, hours=2)  # 竞技区 800 分/小时
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(minutes=30))
        f = self.svc.report_fault(self.seat("A01"), o["id"], "network", "网络中断")
        self.clock.set(T0 + timedelta(minutes=50))
        self.svc.resolve_fault(f["id"])  # 停机 20 分钟
        self.clock.set(T0 + timedelta(hours=2))
        self.svc.end_order(o["id"])
        st = self.svc.settle_order(o["id"])

        self.assertEqual(st["downtime_minutes"], 20)
        self.assertEqual(st["billable_minutes"], 100)  # 120 - 20
        rate = 800 / 60
        self.assertEqual(st["gross_cents"], int(100 * rate + 0.5))
        self.assertEqual(st["downtime_credit_cents"], int(20 * rate + 0.5))

    def test_unresolved_fault_counts_until_end(self):
        o = self.make_order(seat="A01", start=T0, hours=2)
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(hours=1))
        self.svc.report_fault(self.seat("A01"), o["id"], "hardware", "主机死机")
        self.clock.set(T0 + timedelta(hours=2))
        self.svc.end_order(o["id"])  # 故障未解决 → 计到订单结束(60 分钟)
        st = self.svc.settle_order(o["id"])
        self.assertEqual(st["downtime_minutes"], 60)
        self.assertEqual(st["billable_minutes"], 60)

    def test_downtime_never_exceeds_usage(self):
        o = self.make_order(seat="A01", start=T0, hours=2)
        self.svc.start_order(o["id"])
        self.svc.report_fault(self.seat("A01"), o["id"], "network", "断网")  # 10:00 起
        self.clock.set(T0 + timedelta(hours=3))  # 故障横跨到订单结束后
        self.svc.end_order(o["id"])
        st = self.svc.settle_order(o["id"])
        self.assertEqual(st["downtime_minutes"], 180)  #  capped 到实际使用时长
        self.assertEqual(st["billable_minutes"], 0)
        self.assertEqual(st["gross_cents"], 0)


class TestDepositAndInspection(Base):
    """押金扣款必须关联检查记录; 损坏/缺失自动生成结账检查工单。"""

    def test_damage_creates_inspection_and_deduction(self):
        o = self.make_order(seat="A01", kit="标准套装", start=T0, hours=2)
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(hours=2))
        self.svc.end_order(o["id"], returns=[
            {"peripheral_id": self.peri("MS-2001"), "condition": "damaged",
             "appearance": "左键失灵"},
        ])
        # 自动生成结账检查工单, 定损 = 鼠标押金 6000 * 40%
        insp = self.db.one("SELECT * FROM inspection_tickets WHERE order_id=?", (o["id"],))
        self.assertIsNotNone(insp)
        self.assertEqual(insp["type"], "checkout")
        self.assertEqual(insp["damage_cents"], 2400)

        st = self.svc.settle_order(o["id"])
        self.assertEqual(st["damage_cents"], 2400)
        # 押金扣款关联了巡检工单
        self.assertEqual(len(st["deductions"]), 1)
        self.assertEqual(st["deductions"][0]["inspection_code"], insp["code"])
        # 应退押金 = 押金 - 赔偿
        self.assertEqual(st["refund_cents"], st["deposit_cents"] - 2400)
        # 损坏外设进入维修, 不再可借
        p = self.db.one("SELECT status FROM peripherals WHERE serial='MS-2001'")
        self.assertEqual(p["status"], "maintenance")

    def test_missing_charged_full_deposit(self):
        o = self.make_order(seat="A01", kit="标准套装", start=T0, hours=2)
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(hours=2))
        self.svc.end_order(o["id"], returns=[
            {"peripheral_id": self.peri("HS-3001"), "condition": "missing",
             "appearance": "未归还"},
        ])
        insp = self.db.one("SELECT * FROM inspection_tickets WHERE order_id=?", (o["id"],))
        self.assertEqual(insp["damage_cents"], 12000)  # 耳机押金全额

    def test_deduction_requires_inspection_fk(self):
        """结算扣款与巡检工单之间是外键强约束。"""
        o = self.make_order(seat="A01", start=T0, hours=2)
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(hours=2))
        self.svc.end_order(o["id"])
        st = self.svc.settle_order(o["id"])
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db.immediate() as conn:
                conn.execute(
                    """INSERT INTO settlement_deductions(settlement_id, inspection_id,
                                                         amount_cents, reason)
                       VALUES (?,?,?,?)""", (st["id"], 99999, 100, "无巡检单的非法扣款"))


class TestRefundIdempotency(Base):
    """退款幂等: 同一幂等键只退一次; 同一结算单只允许一笔退款。"""

    def _settled(self):
        o = self.make_order(seat="A01", start=T0, hours=2)
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(hours=2))
        self.svc.end_order(o["id"])
        st = self.svc.settle_order(o["id"])
        self.svc.confirm_settlement(st["id"])
        return st

    def test_same_key_replays(self):
        st = self._settled()
        r1 = self.svc.refund_settlement(st["id"], "key-1")
        r2 = self.svc.refund_settlement(st["id"], "key-1")
        self.assertFalse(r1["replayed"])
        self.assertTrue(r2["replayed"])
        self.assertEqual(r1["id"], r2["id"])
        n = self.db.one("SELECT COUNT(*) c FROM refunds WHERE settlement_id=?", (st["id"],))
        self.assertEqual(n["c"], 1)
        self.assertEqual(len(self.svc.payment.refunds), 1, "支付适配器只执行一次退款")

    def test_different_key_rejected(self):
        st = self._settled()
        self.svc.refund_settlement(st["id"], "key-1")
        self.assertBiz("already_refunded", self.svc.refund_settlement, st["id"], "key-2")

    def test_refund_requires_confirm(self):
        o = self.make_order(seat="A01", start=T0, hours=2)
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(hours=2))
        self.svc.end_order(o["id"])
        st = self.svc.settle_order(o["id"])
        self.assertBiz("state_conflict", self.svc.refund_settlement, st["id"], "key-1")


class TestFlowEdges(Base):
    """迟到、提前结束、异常扣费冲正。"""

    def test_late_arrival_auto_cancel(self):
        o = self.make_order(seat="A01", start=T0, hours=2)
        self.clock.set(T0 + timedelta(minutes=LATE_GRACE_MIN + 1))
        self.assertBiz("late_cancelled", self.svc.start_order, o["id"])
        self.assertEqual(self.svc.get_order(o["id"])["status"], "cancelled")

    def test_too_early_start_rejected(self):
        o = self.make_order(seat="A01", start=T0 + timedelta(hours=2), hours=2)
        self.assertBiz("too_early", self.svc.start_order, o["id"])

    def test_early_end_bills_actual_usage(self):
        o = self.make_order(seat="A01", start=T0, hours=2)
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(minutes=45))  # 提前 75 分钟结束
        self.svc.end_order(o["id"])
        st = self.svc.settle_order(o["id"])
        self.assertEqual(st["billable_minutes"], 45)
        self.assertEqual(st["gross_cents"], int(45 * (800 / 60) + 0.5))

    def test_abnormal_charge_adjustment(self):
        o = self.make_order(seat="A01", start=T0, hours=2)
        self.svc.start_order(o["id"])
        self.clock.set(T0 + timedelta(hours=2))
        self.svc.end_order(o["id"])
        st = self.svc.settle_order(o["id"])
        before = st["due_cents"]
        st2 = self.svc.adjust_settlement(st["id"], -1000, "重复计时, 冲正 10 元")
        self.assertEqual(st2["due_cents"], before - 1000)
        self.assertEqual(st2["adjustment_cents"], -1000)
        self.svc.confirm_settlement(st["id"])
        # 确认后不允许再调整
        self.assertBiz("state_conflict", self.svc.adjust_settlement, st["id"], -100, "x")


if __name__ == "__main__":
    unittest.main()
