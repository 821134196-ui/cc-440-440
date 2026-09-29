"""演示数据: 基础档案 + 一套覆盖包机/故障/结账全流程的样例。

seed_demo 复用 ArenaService 的真实业务路径(配合 ManualClock 回放时间),
因此样例数据与手工操作产生的数据完全一致。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .db import Database
from .services import ArenaService
from .timeutil import ManualClock, to_iso

ZONES = [("竞技区", 800), ("开黑区", 600), ("VIP区", 1500)]  # 元/小时(分)

PERIPHERALS = [
    # serial, type, model, deposit_cents, status
    ("KB-1001", "keyboard", "机械键盘 K870", 8000, "available"),
    ("KB-1002", "keyboard", "机械键盘 K870", 8000, "available"),
    ("KB-1003", "keyboard", "光轴键盘 Pro X", 12000, "available"),
    ("KB-1004", "keyboard", "机械键盘 K870", 8000, "available"),
    ("KB-1005", "keyboard", "机械键盘 K870(备)", 8000, "available"),
    ("MS-2001", "mouse", "电竞鼠标 G502", 6000, "available"),
    ("MS-2002", "mouse", "电竞鼠标 G502", 6000, "available"),
    ("MS-2003", "mouse", "无线鼠标 GPW2", 12000, "available"),
    ("MS-2004", "mouse", "电竞鼠标 G502", 6000, "available"),
    ("MS-2005", "mouse", "电竞鼠标 G502(备)", 6000, "available"),
    ("HS-3001", "headset", "头戴耳机 H7", 12000, "available"),
    ("HS-3002", "headset", "头戴耳机 H7", 12000, "available"),
    ("HS-3003", "headset", "降噪耳机 Alpha", 16000, "available"),
    ("HS-3004", "headset", "头戴耳机 H7", 12000, "available"),
    ("HS-3005", "headset", "头戴耳机 H7", 12000, "maintenance"),
]

KITS = [
    ("标准套装", ["KB-1001", "MS-2001", "HS-3001"]),
    ("电竞套装", ["KB-1002", "MS-2002", "HS-3002"]),
    ("职业套装", ["KB-1003", "MS-2003", "HS-3003"]),
    ("备用套装", ["KB-1004", "MS-2004", "HS-3004"]),
]

CUSTOMERS = [
    ("张伟", "13800000001"),
    ("李娜", "13800000002"),
    ("王强", "13800000003"),
    ("赵敏", "13800000004"),
]

ACCOUNTS = [
    ("英雄联盟", "LOL-王者一号"),
    ("英雄联盟", "LOL-峡谷先锋"),
    ("CS2", "CS2-枪神"),
    ("CS2", "CS2-爆头王"),
    ("永劫无间", "NARAKA-一刀"),
    ("无畏契约", "VAL-霓虹"),
]


def seed_base(db: Database) -> None:
    """基础档案: 机位/外设/套装/顾客/游戏账号(幂等)。"""
    if db.one("SELECT value FROM meta WHERE key='base_seeded'"):
        return
    with db.immediate() as conn:
        for row_idx, (zone, price) in enumerate(ZONES):
            prefix = {"竞技区": "A", "开黑区": "B", "VIP区": "C"}[zone]
            for col in range(4):
                conn.execute(
                    """INSERT INTO seats(code, zone, grid_row, grid_col, specs,
                                         hourly_price_cents, status)
                       VALUES (?,?,?,?,?,?, 'idle')""",
                    (f"{prefix}0{col + 1}", zone, row_idx, col,
                     "i7 / RTX4070 / 32G / 240Hz", price))
        for serial, ptype, model, dep, status in PERIPHERALS:
            conn.execute(
                """INSERT INTO peripherals(serial, type, model, appearance,
                                           deposit_cents, status)
                   VALUES (?,?,?,?,?,?)""",
                (serial, ptype, model, "外观完好, 无划痕", dep, status))
        for name, serials in KITS:
            dep = sum(d for s, _, _, d, _ in PERIPHERALS if s in serials)
            cur = conn.execute("INSERT INTO kits(name, deposit_cents) VALUES (?,?)",
                               (name, dep))
            for s in serials:
                pid = conn.execute("SELECT id FROM peripherals WHERE serial=?",
                                   (s,)).fetchone()["id"]
                conn.execute("INSERT INTO kit_items(kit_id, peripheral_id) VALUES (?,?)",
                             (cur.lastrowid, pid))
        for name, phone in CUSTOMERS:
            conn.execute("INSERT INTO customers(name, phone) VALUES (?,?)", (name, phone))
        for game, login in ACCOUNTS:
            conn.execute(
                "INSERT INTO game_accounts(game, login_name, login_secret) VALUES (?,?,?)",
                (game, login, "demo1234"))
        conn.execute("INSERT INTO meta(key, value) VALUES ('base_seeded', '1')")


def _id(db: Database, table: str, where: str, arg) -> int:
    return db.one(f"SELECT id FROM {table} WHERE {where}=?", (arg,))["id"]


def seed_demo(db: Database, svc: ArenaService) -> None:
    """生成包机、故障、结账样例(幂等)。时间锚定真实当前时刻。"""
    if db.one("SELECT value FROM meta WHERE key='demo_seeded'"):
        return
    real_clock = svc.clock
    now = datetime.now(timezone.utc).replace(microsecond=0, second=0)
    clock = ManualClock(now - timedelta(hours=2, minutes=10))
    svc.clock = clock
    try:
        seat = lambda code: _id(db, "seats", "code", code)
        kit = lambda name: _id(db, "kits", "name", name)
        cust = lambda name: _id(db, "customers", "name", name)
        acct = lambda login: _id(db, "game_accounts", "login_name", login)

        # —— 订单D: 已结账并退款的完整历史样例 ——
        d = svc.create_order(cust("赵敏"), seat("A04"), kit("备用套装"),
                             [acct("VAL-霓虹")], to_iso(now - timedelta(hours=2)),
                             to_iso(now - timedelta(hours=1, minutes=5)))
        clock.set(now - timedelta(hours=2))
        svc.start_order(d["id"])

        # —— 订单A: 进行中, 含一段已解决的网络故障(停机补偿样例) ——
        clock.set(now - timedelta(minutes=85))
        a = svc.create_order(cust("张伟"), seat("B02"), kit("电竞套装"),
                             [acct("LOL-王者一号"), acct("CS2-枪神")],
                             to_iso(now - timedelta(minutes=80)),
                             to_iso(now + timedelta(minutes=40)))
        clock.set(now - timedelta(minutes=80))
        svc.start_order(a["id"])

        # —— 订单D 结账退款 ——
        clock.set(now - timedelta(hours=1, minutes=5))
        svc.end_order(d["id"])
        st = svc.settle_order(d["id"])
        svc.confirm_settlement(st["id"])
        svc.refund_settlement(st["id"], "demo-refund-D")

        # —— 订单C: 已结束待结算, 归还时鼠标损坏(押金扣款样例) ——
        c = svc.create_order(cust("王强"), seat("A02"), kit("标准套装"),
                             [acct("LOL-峡谷先锋")], to_iso(now - timedelta(hours=1)),
                             to_iso(now - timedelta(minutes=10)))
        clock.set(now - timedelta(hours=1))
        svc.start_order(c["id"])

        # —— 订单A 的网络故障: 停机 12 分钟 ——
        clock.set(now - timedelta(minutes=50))
        f = svc.report_fault(seat("B02"), a["id"], "network", "上联交换机抖动, 对局中断")
        clock.set(now - timedelta(minutes=38))
        svc.resolve_fault(f["id"])

        # —— 订单C 结束, 鼠标损坏 ——
        clock.set(now - timedelta(minutes=10))
        mouse_id = _id(db, "peripherals", "serial", "MS-2001")
        svc.end_order(c["id"], returns=[
            {"peripheral_id": mouse_id, "condition": "damaged",
             "appearance": "左键微动失灵, 外壳有裂痕"},
        ])

        # —— 订单B: 未来预约(日历与授权未开始样例) ——
        svc.create_order(cust("李娜"), seat("C01"), kit("职业套装"),
                         [acct("NARAKA-一刀")], to_iso(now + timedelta(hours=1)),
                         to_iso(now + timedelta(hours=3)))

        # —— 巡检样例: 一单已关闭, 一单待处理; A03 置为维护 ——
        t1 = svc.create_inspection(seat("A01"), None, "routine",
                                   "键盘缝隙积灰, 已清理", 0, "前台-小王")
        svc.close_inspection(t1["id"])
        svc.create_inspection(seat("A03"), None, "routine",
                              "耳机罩老化, 建议更换; 机位暂停使用", 0, "前台-小李")
        with db.immediate() as conn:
            conn.execute("UPDATE seats SET status='maintenance' WHERE code='A03'")
            conn.execute("INSERT INTO events(ts, kind, message) VALUES (?,?,?)",
                         (to_iso(now), "inspection", "机位 A03 转入维护状态"))

        clock.set(now)
    finally:
        svc.clock = real_clock
    with db.immediate() as conn:
        conn.execute("INSERT INTO meta(key, value) VALUES ('demo_seeded', '1')")
