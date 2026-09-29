"""SQLite 持久层: 机位、外设、订单、授权、巡检、故障与消费快照。

并发模型: 每个写操作在 BEGIN IMMEDIATE 事务内完成, SQLite 串行化写者,
因此"两名前台同时开机同一订单"只有一个事务能先把状态从 reserved 改成 active。
"""
from __future__ import annotations

import contextlib
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 机位(平面图固定网格位置)
CREATE TABLE IF NOT EXISTS seats (
  id                 INTEGER PRIMARY KEY,
  code               TEXT UNIQUE NOT NULL,      -- A01 / B02 / C03
  zone               TEXT NOT NULL,             -- 竞技区 / 开黑区 / VIP区
  grid_row           INTEGER NOT NULL,
  grid_col           INTEGER NOT NULL,
  specs              TEXT NOT NULL DEFAULT '',
  hourly_price_cents INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'idle'  -- idle / in_use / maintenance
);

-- 外设单品(键鼠耳机)
CREATE TABLE IF NOT EXISTS peripherals (
  id            INTEGER PRIMARY KEY,
  serial        TEXT UNIQUE NOT NULL,           -- KB-1001
  type          TEXT NOT NULL,                  -- keyboard / mouse / headset
  model         TEXT NOT NULL,
  appearance    TEXT NOT NULL DEFAULT '外观完好', -- 当前外观基线
  deposit_cents INTEGER NOT NULL,               -- 单件押金参考价值
  status        TEXT NOT NULL DEFAULT 'available' -- available / lent / maintenance / missing
);

-- 外设套装(固定组合)
CREATE TABLE IF NOT EXISTS kits (
  id            INTEGER PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  deposit_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kit_items (
  kit_id        INTEGER NOT NULL REFERENCES kits(id),
  peripheral_id INTEGER NOT NULL REFERENCES peripherals(id),
  PRIMARY KEY (kit_id, peripheral_id)
);

CREATE TABLE IF NOT EXISTS customers (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  phone TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_accounts (
  id           INTEGER PRIMARY KEY,
  game         TEXT NOT NULL,
  login_name   TEXT UNIQUE NOT NULL,
  login_secret TEXT NOT NULL          -- 演示数据
);

-- 包机订单: 锁定机位 + 时段 + 外设套装
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  seat_id       INTEGER NOT NULL REFERENCES seats(id),
  kit_id        INTEGER NOT NULL REFERENCES kits(id),
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'reserved',
    -- reserved -> active -> ended -> settled; reserved -> cancelled
  started_at    TEXT,
  ended_at      TEXT,
  deposit_cents INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_seat ON orders(seat_id, status);

-- 账号授权: 只在包机有效时段内开放
CREATE TABLE IF NOT EXISTS account_grants (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  account_id INTEGER NOT NULL REFERENCES game_accounts(id),
  valid_from TEXT NOT NULL,
  valid_to   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending / active / expired / revoked
  UNIQUE (order_id, account_id)
);

-- 外设出借记录: 出库/归还各记一次外观
CREATE TABLE IF NOT EXISTS loan_records (
  id             INTEGER PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES orders(id),
  peripheral_id  INTEGER NOT NULL REFERENCES peripherals(id),
  checked_out_at TEXT,
  appearance_out TEXT,
  checked_in_at  TEXT,
  appearance_in  TEXT,
  condition_in   TEXT,                          -- ok / damaged / missing
  UNIQUE (order_id, peripheral_id)
);
-- 同一外设同一时刻最多一条未归还记录(设备唯一性的数据库兜底)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_loan
  ON loan_records(peripheral_id) WHERE checked_in_at IS NULL;

-- 巡检工单(日常巡检 / 结账检查)
CREATE TABLE IF NOT EXISTS inspection_tickets (
  id           INTEGER PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,
  seat_id      INTEGER NOT NULL REFERENCES seats(id),
  order_id     INTEGER REFERENCES orders(id),
  type         TEXT NOT NULL,                   -- routine / checkout
  status       TEXT NOT NULL DEFAULT 'open',    -- open / closed
  findings     TEXT NOT NULL DEFAULT '',
  damage_cents INTEGER NOT NULL DEFAULT 0,      -- 定损金额
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  closed_at    TEXT
);

-- 故障工单: 停机时长用于结算补偿
CREATE TABLE IF NOT EXISTS fault_tickets (
  id               INTEGER PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  order_id         INTEGER REFERENCES orders(id),
  seat_id          INTEGER NOT NULL REFERENCES seats(id),
  type             TEXT NOT NULL,               -- network / hardware / peripheral
  description      TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  resolved_at      TEXT,
  downtime_minutes INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'open' -- open / resolved
);

-- 结算快照(消费快照落库)
CREATE TABLE IF NOT EXISTS settlements (
  id                    INTEGER PRIMARY KEY,
  order_id              INTEGER UNIQUE NOT NULL REFERENCES orders(id),
  billable_minutes      INTEGER NOT NULL,       -- 计费时长(已扣除停机)
  gross_cents           INTEGER NOT NULL,       -- 时长费
  downtime_minutes      INTEGER NOT NULL,       -- 故障停机时长
  downtime_credit_cents INTEGER NOT NULL,       -- 停机补偿(扣减项)
  damage_cents          INTEGER NOT NULL,       -- 损坏/缺失赔偿合计
  adjustment_cents      INTEGER NOT NULL DEFAULT 0, -- 异常扣费冲正(负数为退给顾客)
  deposit_cents         INTEGER NOT NULL,
  refund_cents          INTEGER NOT NULL,       -- 应退押金
  due_cents             INTEGER NOT NULL,       -- 应收金额
  status                TEXT NOT NULL DEFAULT 'pending', -- pending / confirmed / refunded
  created_at            TEXT NOT NULL
);

-- 押金扣款必须关联巡检工单
CREATE TABLE IF NOT EXISTS settlement_deductions (
  id            INTEGER PRIMARY KEY,
  settlement_id INTEGER NOT NULL REFERENCES settlements(id),
  inspection_id INTEGER NOT NULL REFERENCES inspection_tickets(id),
  amount_cents  INTEGER NOT NULL,
  reason        TEXT NOT NULL
);

-- 退款记录: 幂等键唯一 + 每个结算单最多一笔
CREATE TABLE IF NOT EXISTS refunds (
  id              INTEGER PRIMARY KEY,
  settlement_id   INTEGER NOT NULL REFERENCES settlements(id),
  idempotency_key TEXT UNIQUE NOT NULL,
  amount_cents    INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'succeeded',
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_refund_settlement ON refunds(settlement_id);

-- 设备/业务事件流水(适配器回执在此留痕)
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  message TEXT NOT NULL
);
"""


class Database:
    """轻量连接工厂: 每次操作开新连接, 线程安全。"""

    def __init__(self, path: str):
        self.path = str(path)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    @contextlib.contextmanager
    def immediate(self):
        """BEGIN IMMEDIATE 写事务: 进入即取写锁, 串行化并发写。"""
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def query(self, sql: str, args=()) -> list:
        conn = self.connect()
        try:
            return conn.execute(sql, args).fetchall()
        finally:
            conn.close()

    def one(self, sql: str, args=()):
        rows = self.query(sql, args)
        return rows[0] if rows else None


def init_db(db: Database) -> None:
    with db.immediate() as conn:
        conn.executescript(SCHEMA)
