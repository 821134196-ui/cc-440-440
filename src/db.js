'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- 顾客（演示数据）
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT '普通',
  balance_fen INTEGER NOT NULL DEFAULT 0
);

-- 机位（固定网格 grid_x / grid_y）
CREATE TABLE IF NOT EXISTS stations (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,          -- A01
  zone        TEXT NOT NULL,                 -- 对战区 A / 包厢 B
  grid_x      INTEGER NOT NULL,
  grid_y      INTEGER NOT NULL,
  spec        TEXT NOT NULL,                 -- 配置
  hourly_fen  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'AVAILABLE' -- AVAILABLE/ACTIVE/MAINT
);

-- 账号商品池（游戏/平台授权凭据，同一账号同时只允许一个 ACTIVE 授权）
CREATE TABLE IF NOT EXISTS accounts (
  id       INTEGER PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,             -- STEAM-01
  platform TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL
);

-- 外设套装
CREATE TABLE IF NOT EXISTS kits (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  deposit_fen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kit_items (
  kit_id INTEGER NOT NULL REFERENCES kits(id),
  type   TEXT NOT NULL,                      -- KEYBOARD/MOUSE/HEADSET
  qty    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (kit_id, type)
);
CREATE TABLE IF NOT EXISTS kit_accounts (
  kit_id     INTEGER NOT NULL REFERENCES kits(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  PRIMARY KEY (kit_id, account_id)
);

-- 外设实物（编号 + 外观）
CREATE TABLE IF NOT EXISTS peripherals (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,     -- KB-0007
  type             TEXT NOT NULL,            -- KEYBOARD/MOUSE/HEADSET
  brand            TEXT NOT NULL,
  appearance       TEXT NOT NULL,            -- 外观描述
  replacement_fen  INTEGER NOT NULL,         -- 缺失赔偿
  damage_fee_fen   INTEGER NOT NULL,         -- 损坏扣款基准
  status           TEXT NOT NULL DEFAULT 'AVAILABLE' -- AVAILABLE/ON_LOAN/MAINT/RETIRED
);

-- 包机订单
CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,       -- B20260929-001
  customer_id    INTEGER NOT NULL REFERENCES customers(id),
  station_id     INTEGER NOT NULL REFERENCES stations(id),
  kit_id         INTEGER NOT NULL REFERENCES kits(id),
  plan_start     INTEGER NOT NULL,           -- ms
  plan_end       INTEGER NOT NULL,
  actual_start   INTEGER,                    -- 开机时间
  actual_end     INTEGER,                    -- 结束时间（提前结束为实际时间）
  billing_start  INTEGER,                    -- 计费起点（迟到按计划开始计）
  late_minutes   INTEGER NOT NULL DEFAULT 0,
  early_minutes  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'PENDING',
                 -- PENDING 已预订 / ACTIVE 进行中 / ENDED 已关机待结 / SETTLED 已结账
                 -- NO_SHOW 爽约 / CANCELLED 已取消
  note           TEXT NOT NULL DEFAULT '',
  started_by     TEXT,
  created_by     TEXT NOT NULL DEFAULT '前台A',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_station_time ON orders(station_id, plan_start, plan_end);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- 订单外设：下单即锁定具体编号（RESERVED），出借 LENT，归还 RETURNED，损坏 DAMAGED，缺失 MISSING
CREATE TABLE IF NOT EXISTS order_peripherals (
  id                 INTEGER PRIMARY KEY,
  order_id           INTEGER NOT NULL REFERENCES orders(id),
  peripheral_id      INTEGER NOT NULL REFERENCES peripherals(id),
  status             TEXT NOT NULL DEFAULT 'RESERVED',
  lent_at            INTEGER,
  lent_by            TEXT,
  lent_appearance    TEXT,                   -- 出借时外观快照
  lent_receipt       TEXT,                   -- 适配器回执号
  returned_at        INTEGER,
  returned_by        TEXT,
  return_appearance  TEXT,
  return_receipt     TEXT,
  deduction_id       INTEGER
);
-- LENT 全局唯一：同一件外设不可能同时出借给两个订单
CREATE UNIQUE INDEX IF NOT EXISTS idx_periph_lent_unique
  ON order_peripherals(peripheral_id) WHERE status = 'LENT';

-- 账号授权（仅在有效时段内开放）
CREATE TABLE IF NOT EXISTS account_grants (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  opens_at   INTEGER NOT NULL,
  closes_at  INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE/EXPIRED/REVOKED
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_grant_active_unique
  ON account_grants(account_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_grants_order ON account_grants(order_id);

-- 巡检工单
CREATE TABLE IF NOT EXISTS inspections (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  station_id   INTEGER NOT NULL REFERENCES stations(id),
  order_id     INTEGER REFERENCES orders(id),
  type         TEXT NOT NULL,                 -- PRE_USE 交接前 / ROUTINE 例行 / POST_INCIDENT 故障后
  status       TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/DONE
  result       TEXT,                          -- PASS/FAIL
  inspector    TEXT,
  scheduled_at INTEGER NOT NULL,
  checked_at   INTEGER,
  note         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_insp_station ON inspections(station_id, status);

-- 巡检逐项结果（押金扣款必须回链这里）
CREATE TABLE IF NOT EXISTS inspection_findings (
  id            INTEGER PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id),
  item          TEXT NOT NULL,                -- 键盘/鼠标/耳机/显示器/网络...
  result        TEXT NOT NULL,                -- OK/DAMAGED/MISSING
  note          TEXT NOT NULL DEFAULT ''
);

-- 故障/异常事件：网络中断、设备损坏、外设缺失…
CREATE TABLE IF NOT EXISTS incidents (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  order_id         INTEGER REFERENCES orders(id),
  station_id       INTEGER NOT NULL REFERENCES stations(id),
  type             TEXT NOT NULL,             -- NETWORK_OUTAGE/DEVICE_DAMAGE/PERIPHERAL_MISSING/OTHER
  status           TEXT NOT NULL DEFAULT 'OPEN', -- OPEN/RESOLVED
  start_time       INTEGER NOT NULL,
  end_time         INTEGER,
  duration_minutes INTEGER,
  comp_minutes     INTEGER NOT NULL DEFAULT 0, -- 结算可扣除的停机补偿分钟
  evidence         TEXT NOT NULL DEFAULT '',   -- 适配器回执/证据
  inspection_id    INTEGER REFERENCES inspections(id),
  note             TEXT NOT NULL DEFAULT '',
  reported_by      TEXT NOT NULL DEFAULT '前台A'
);
CREATE INDEX IF NOT EXISTS idx_incidents_order ON incidents(order_id);

-- 押金
CREATE TABLE IF NOT EXISTS deposits (
  order_id      INTEGER PRIMARY KEY REFERENCES orders(id),
  amount_fen    INTEGER NOT NULL,
  deducted_fen  INTEGER NOT NULL DEFAULT 0,
  refunded_fen  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'HELD'   -- HELD/SETTLED
);

-- 押金扣款（必须关联巡检记录）
CREATE TABLE IF NOT EXISTS deductions (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  incident_id   INTEGER REFERENCES incidents(id),
  inspection_id INTEGER NOT NULL REFERENCES inspections(id),
  reason        TEXT NOT NULL,
  amount_fen    INTEGER NOT NULL,
  created_by    TEXT NOT NULL DEFAULT '前台A',
  created_at    INTEGER NOT NULL
);

-- 店内消费（饮品小食，演示数据）
CREATE TABLE IF NOT EXISTS order_extras (
  id        INTEGER PRIMARY KEY,
  order_id  INTEGER NOT NULL REFERENCES orders(id),
  name      TEXT NOT NULL,
  qty       INTEGER NOT NULL,
  unit_fen  INTEGER NOT NULL,
  amount_fen INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 结算快照（结账复核依据；停机时间从此处扣除）
CREATE TABLE IF NOT EXISTS settlements (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  snap_time        INTEGER NOT NULL,
  plan_minutes     INTEGER NOT NULL,
  used_minutes     INTEGER NOT NULL,
  comp_minutes     INTEGER NOT NULL,
  billable_minutes INTEGER NOT NULL,
  rental_fen       INTEGER NOT NULL,
  extras_fen       INTEGER NOT NULL,
  deductions_fen   INTEGER NOT NULL,
  deposit_fen      INTEGER NOT NULL,
  total_due_fen    INTEGER NOT NULL,
  charge_fen       INTEGER NOT NULL,
  refund_fen       INTEGER NOT NULL,
  breakdown_json   TEXT NOT NULL,
  pay_receipt      TEXT NOT NULL DEFAULT '',
  refund_receipt   TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL DEFAULT '前台A'
);

-- 支付流水（幂等键唯一）
CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER REFERENCES orders(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,              -- CHARGE/REFUND
  channel         TEXT NOT NULL DEFAULT '模拟收银',
  amount_fen      INTEGER NOT NULL,
  receipt_no      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OK',
  created_at      INTEGER NOT NULL
);

-- 前台操作审计
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT NOT NULL DEFAULT '',
  detail  TEXT NOT NULL DEFAULT ''
);
`;

function openDatabase(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDatabase };
