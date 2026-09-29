'use strict';

// 领域服务：机位 / 包机订单 / 账号授权 / 外设交接 / 巡检 / 故障 / 押金 / 结账。
// 所有跨表写入都在 BEGIN IMMEDIATE 事务内，关键状态迁移用带旧状态条件的
// CAS 型 UPDATE 完成 —— 并发（含多连接）下只有一方成功。

const FEN = 100;
const MIN = 60_000;

const ORDER_STATUS = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  ENDED: 'ENDED',
  SETTLED: 'SETTLED',
  NO_SHOW: 'NO_SHOW',
  CANCELLED: 'CANCELLED',
};

class ArenaError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const overlap = (s1, e1, s2, e2) => s1 < e2 && e1 > s2;
const mins = (ms) => Math.round(ms / MIN);

class Arena {
  constructor(db, adapters = {}) {
    this.db = db;
    this.net = adapters.network;
    this.periph = adapters.peripheral;
    this.pay = adapters.payment;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  audit(actor, action, target = '', detail = '') {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?,?,?,?,?)')
      .run(Date.now(), actor, action, target, typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  // ---------- 基础查询 ----------

  listCustomers() {
    return this.db.prepare('SELECT * FROM customers ORDER BY id').all();
  }

  listStations() {
    return this.db.prepare('SELECT * FROM stations ORDER BY grid_y, grid_x').all();
  }

  listKits() {
    const kits = this.db.prepare('SELECT * FROM kits ORDER BY id').all();
    const itemStmt = this.db.prepare('SELECT type, qty FROM kit_items WHERE kit_id=?');
    const accStmt = this.db.prepare(
      `SELECT a.* FROM accounts a JOIN kit_accounts ka ON ka.account_id=a.id WHERE ka.kit_id=? ORDER BY a.code`
    );
    for (const k of kits) {
      k.items = itemStmt.all(k.id);
      k.accounts = accStmt.all(k.id);
    }
    return kits;
  }

  listPeripherals() {
    return this.db.prepare('SELECT * FROM peripherals ORDER BY type, code').all();
  }

  listAccounts() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY platform, code').all();
  }

  getOrder(id) {
    const order = this.db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!order) throw new ArenaError('ORDER_NOT_FOUND', `订单 #${id} 不存在`);
    return this._hydrateOrder(order);
  }

  getOrderByCode(code) {
    const order = this.db.prepare('SELECT * FROM orders WHERE code=?').get(code);
    if (!order) throw new ArenaError('ORDER_NOT_FOUND', `订单 ${code} 不存在`);
    return this._hydrateOrder(order);
  }

  _hydrateOrder(order) {
    order.customer = this.db.prepare('SELECT * FROM customers WHERE id=?').get(order.customer_id);
    order.station = this.db.prepare('SELECT * FROM stations WHERE id=?').get(order.station_id);
    order.kit = this.db.prepare('SELECT * FROM kits WHERE id=?').get(order.kit_id);
    order.peripherals = this.db
      .prepare(
        `SELECT op.*, p.id AS pid, p.code AS p_code, p.type AS p_type, p.brand, p.appearance,
                p.replacement_fen, p.damage_fee_fen
         FROM order_peripherals op JOIN peripherals p ON p.id=op.peripheral_id
         WHERE op.order_id=? ORDER BY p.type, p.code`
      )
      .all(order.id);
    order.grants = this.db
      .prepare(
        `SELECT g.*, a.code AS account_code, a.platform, a.username
         FROM account_grants g JOIN accounts a ON a.id=g.account_id
         WHERE g.order_id=? ORDER BY a.platform, a.code`
      )
      .all(order.id);
    order.incidents = this.db.prepare('SELECT * FROM incidents WHERE order_id=? ORDER BY id').all(order.id);
    order.extras = this.db.prepare('SELECT * FROM order_extras WHERE order_id=? ORDER BY id').all(order.id);
    order.deposit = this.db.prepare('SELECT * FROM deposits WHERE order_id=?').get(order.id);
    order.deductions = this.db
      .prepare('SELECT * FROM deductions WHERE order_id=? ORDER BY id')
      .all(order.id);
    order.settlement = this.db.prepare('SELECT * FROM settlements WHERE order_id=?').get(order.id);
    return order;
  }

  // ---------- 下单（锁机位 + 锁外设编号 + 预建授权与押金） ----------

  _newOrderCode(now) {
    const day = new Date(now);
    const ymd = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(
      day.getDate()
    ).padStart(2, '0')}`;
    const n =
      this.db.prepare(`SELECT COUNT(*) c FROM orders WHERE code LIKE ?`).get(`B${ymd}-%`).c + 1;
    return `B${ymd}-${String(n).padStart(3, '0')}`;
  }

  // 占用机位的订单（PENDING/ACTIVE 用计划时段；ENDED 只用至 actual_end）
  _stationBlocked(stationId, start, end, excludeOrderId = 0) {
    const rows = this.db
      .prepare(
        `SELECT id, code, status, plan_start, plan_end, actual_end FROM orders
         WHERE station_id=? AND id<>? AND status IN ('PENDING','ACTIVE','ENDED')`
      )
      .all(stationId, excludeOrderId);
    return rows.find((r) => {
      const e = r.status === 'ENDED' ? r.actual_end ?? r.plan_end : r.plan_end;
      return overlap(start, end, r.plan_start, e);
    });
  }

  _availablePeripherals(type, start, end, kitId, limit) {
    return this.db
      .prepare(
        `SELECT p.* FROM peripherals p
         WHERE p.type=? AND p.status='AVAILABLE'
           AND NOT EXISTS (
             SELECT 1 FROM order_peripherals op JOIN orders o ON o.id=op.order_id
             WHERE op.peripheral_id=p.id AND op.status IN ('RESERVED','LENT')
               AND o.status IN ('PENDING','ACTIVE')
               AND ? < o.plan_end AND ? > o.plan_start
           )
         ORDER BY p.code LIMIT ?`
      )
      .all(type, start, end, limit);
  }

  _accountBlocked(accountId, start, end) {
    return this.db
      .prepare(
        `SELECT g.id, o.code FROM account_grants g JOIN orders o ON o.id=g.order_id
         WHERE g.account_id=? AND g.status IN ('PLANNED','ACTIVE') AND o.status IN ('PENDING','ACTIVE')
           AND ? < o.plan_end AND ? > o.plan_start`
      )
      .get(accountId, start, end);
  }

  createOrder({ customerId, stationId, kitId, planStart, planEnd, by = '前台A', note = '', now = Date.now() }) {
    planStart = Number(planStart);
    planEnd = Number(planEnd);
    if (!Number.isFinite(planStart) || !Number.isFinite(planEnd) || planEnd <= planStart) {
      throw new ArenaError('BAD_TIME', '结束时间必须晚于开始时间');
    }
    if (planEnd - planStart < 30 * MIN) throw new ArenaError('BAD_TIME', '包机时长至少 30 分钟');

    return this.tx(() => {
      const customer = this.db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
      if (!customer) throw new ArenaError('CUSTOMER_NOT_FOUND', '顾客不存在');
      const station = this.db.prepare('SELECT * FROM stations WHERE id=?').get(stationId);
      if (!station) throw new ArenaError('STATION_NOT_FOUND', '机位不存在');
      if (station.status === 'MAINT') throw new ArenaError('STATION_MAINT', `${station.code} 正在维修维护`);
      const kit = this.db.prepare('SELECT * FROM kits WHERE id=?').get(kitId);
      if (!kit) throw new ArenaError('KIT_NOT_FOUND', '外设套装不存在');

      const blocked = this._stationBlocked(stationId, planStart, planEnd);
      if (blocked) {
        throw new ArenaError('STATION_CONFLICT', `机位时段冲突，已被订单 ${blocked.code} 占用`, {
          conflict: blocked,
        });
      }

      const info = this.db
        .prepare(
          `INSERT INTO orders (code, customer_id, station_id, kit_id, plan_start, plan_end,
                               status, note, created_by, created_at)
           VALUES (?,?,?,?,?,?, 'PENDING', ?, ?, ?)`
        )
        .run(
          this._newOrderCode(now),
          customerId,
          stationId,
          kitId,
          planStart,
          planEnd,
          note,
          by,
          now
        );
      const orderId = Number(info.lastInsertRowid);

      // 锁定套装所需的具体外设编号
      const need = this.db.prepare('SELECT type, qty FROM kit_items WHERE kit_id=?').all(kitId);
      for (const { type, qty } of need) {
        const picks = this._availablePeripherals(type, planStart, planEnd, kitId, qty);
        if (picks.length < qty) {
          throw new ArenaError(
            'PERIPHERAL_SHORTAGE',
            `${type} 可用数量不足（需 ${qty}，余 ${picks.length}）`
          );
        }
        for (const p of picks) {
          this.db
            .prepare('INSERT INTO order_peripherals (order_id, peripheral_id, status) VALUES (?,?,\'RESERVED\')')
            .run(orderId, p.id);
        }
      }

      // 预建账号授权（PLANNED），同时段同账号不可重复
      const accRows = this.db.prepare('SELECT account_id FROM kit_accounts WHERE kit_id=?').all(kitId);
      for (const { account_id } of accRows) {
        if (this._accountBlocked(account_id, planStart, planEnd)) {
          const a = this.db.prepare('SELECT code FROM accounts WHERE id=?').get(account_id);
          throw new ArenaError('ACCOUNT_CONFLICT', `账号 ${a.code} 在该时段已授权给其他订单`);
        }
        this.db
          .prepare(
            `INSERT INTO account_grants (order_id, account_id, opens_at, closes_at, status)
             VALUES (?,?,?,?,'PLANNED')`
          )
          .run(orderId, account_id, planStart, planEnd);
      }

      // 预授押金
      this.db
        .prepare('INSERT INTO deposits (order_id, amount_fen, status) VALUES (?,?,\'HELD\')')
        .run(orderId, kit.deposit_fen);

      // 交接前巡检工单
      const inspCode = `J${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${String(orderId).padStart(3, '0')}`;
      this.db
        .prepare(
          `INSERT INTO inspections (code, station_id, order_id, type, status, scheduled_at, note)
           VALUES (?,?,?, 'PRE_USE','PENDING', ?, '开机交接前检查')`
        )
        .run(inspCode, stationId, orderId, planStart);

      this.audit(by, 'ORDER_CREATE', String(orderId), { station: station.code, kit: kit.code });
      return this.getOrder(orderId);
    });
  }

  cancelOrder(orderId, { by = '前台A', reason = '顾客取消' } = {}) {
    return this.tx(() => {
      const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o) throw new ArenaError('ORDER_NOT_FOUND', '订单不存在');
      if (o.status !== 'PENDING') throw new ArenaError('BAD_STATE', `当前状态 ${o.status} 不可取消`);
      this.db.prepare("UPDATE orders SET status='CANCELLED', note=note||? WHERE id=?").run(
        ` [取消：${reason}]`,
        orderId
      );
      this.db
        .prepare("UPDATE inspections SET status='DONE', result=NULL, checked_at=?, note=note||? WHERE order_id=? AND status='PENDING'")
        .run(Date.now(), ' [订单取消，未交接]', orderId);
      this.db.prepare("DELETE FROM order_peripherals WHERE order_id=? AND status='RESERVED'").run(orderId);
      this.db.prepare("DELETE FROM account_grants WHERE order_id=? AND status='PLANNED'").run(orderId);
      this.db.prepare("UPDATE deposits SET status='SETTLED', refunded_fen=0 WHERE order_id=?").run(orderId);
      this.audit(by, 'ORDER_CANCEL', String(orderId), reason);
      return this.getOrder(orderId);
    });
  }

  markNoShow(orderId, { by = '前台A', now = Date.now() } = {}) {
    return this.tx(() => {
      const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o) throw new ArenaError('ORDER_NOT_FOUND', '订单不存在');
      if (o.status !== 'PENDING') throw new ArenaError('BAD_STATE', `当前状态 ${o.status}，不能标记爽约`);
      if (now < o.plan_end) throw new ArenaError('TOO_EARLY', '时段未结束，暂不能标记爽约');
      this.db.prepare("UPDATE orders SET status='NO_SHOW' WHERE id=?").run(orderId);
      this.db
        .prepare("UPDATE inspections SET status='DONE', result='CANCELLED', checked_at=?, note=note||? WHERE order_id=? AND status='PENDING'")
        .run(now, ' [顾客爽约，未交接]', orderId);
      this.db.prepare("DELETE FROM order_peripherals WHERE order_id=? AND status='RESERVED'").run(orderId);
      this.db.prepare("DELETE FROM account_grants WHERE order_id=? AND status='PLANNED'").run(orderId);
      this.db.prepare("UPDATE deposits SET status='SETTLED' WHERE order_id=?").run(orderId);
      this.audit(by, 'ORDER_NOSHOW', String(orderId));
      return this.getOrder(orderId);
    });
  }

  // ---------- 开机：CAS 保证两名前台同时操作只有一次成功 ----------

  startOrder(orderId, { by = '前台A', now = Date.now() } = {}) {
    return this.tx(() => {
      const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o) throw new ArenaError('ORDER_NOT_FOUND', '订单不存在');
      if (o.status !== 'PENDING') {
        const first = o.started_by ? `（已由 ${o.started_by} 开机）` : '';
        throw new ArenaError('ORDER_ALREADY_ACTIVE', `订单已处于 ${o.status} 状态${first}`, {
          status: o.status,
        });
      }

      const lateMinutes = Math.max(0, mins(now - o.plan_start));
      // 迟到不补时：计费起点仍是计划开始时间，授权窗口在实际开机时开放、准时关闭
      const info = this.db
        .prepare(
          `UPDATE orders
             SET status='ACTIVE', actual_start=?, billing_start=?, late_minutes=?, started_by=?
           WHERE id=? AND status='PENDING'`
        )
        .run(now, o.plan_start, lateMinutes, by, orderId);
      if (info.changes === 0) {
        throw new ArenaError('ORDER_ALREADY_ACTIVE', '该订单刚刚已被另一位前台开机');
      }

      this.db
        .prepare(
          `UPDATE account_grants SET status='ACTIVE', opens_at=?
           WHERE order_id=? AND status='PLANNED'`
        )
        .run(Math.max(now, o.plan_start), orderId);
      // 交接前巡检随开机归档为合格（异常应改走故障后巡检与扣款）
      const preUse = this.db
        .prepare("SELECT id FROM inspections WHERE order_id=? AND type='PRE_USE' AND status='PENDING'")
        .get(orderId);
      if (preUse) {
        this.db
          .prepare("UPDATE inspections SET status='DONE', result='PASS', inspector=?, checked_at=? WHERE id=?")
          .run(by, now, preUse.id);
        for (const item of ['键盘', '鼠标', '耳机', '显示器', '主机', '网络']) {
          this.db
            .prepare('INSERT INTO inspection_findings (inspection_id, item, result, note) VALUES (?,?, \'OK\', \'开机交接核验\')')
            .run(preUse.id, item);
        }
      }
      this.db.prepare("UPDATE stations SET status='ACTIVE' WHERE id=?").run(o.station_id);
      this.audit(by, 'ORDER_START', String(orderId), { lateMinutes });
      return this.getOrder(orderId);
    });
  }

  // ---------- 账号授权有效期 ----------

  // 把已到关闭时间的 ACTIVE 授权置为 EXPIRED
  expireGrants(now = Date.now()) {
    return this.db
      .prepare("UPDATE account_grants SET status='EXPIRED' WHERE status='ACTIVE' AND closes_at<=?")
      .run(now).changes;
  }

  grantEffective(grant, now = Date.now()) {
    return grant.status === 'ACTIVE' && grant.opens_at <= now && now < grant.closes_at;
  }

  effectiveGrants(now = Date.now()) {
    this.expireGrants(now);
    return this.db
      .prepare(
        `SELECT g.*, a.code AS account_code, a.platform, a.username, o.code AS order_code, s.code AS station_code
         FROM account_grants g
         JOIN accounts a ON a.id=g.account_id
         JOIN orders o ON o.id=g.order_id
         JOIN stations s ON s.id=o.station_id
         WHERE g.status='ACTIVE' ORDER BY g.closes_at`
      )
      .all()
      .map((g) => ({ ...g, effective: this.grantEffective(g, now) }));
  }

  // ---------- 外设交接 ----------

  lendAll(orderId, { by = '前台A', now = Date.now() } = {}) {
    return this.tx(() => {
      const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o) throw new ArenaError('ORDER_NOT_FOUND', '订单不存在');
      if (o.status !== 'ACTIVE') throw new ArenaError('BAD_STATE', '只有进行中的订单可以出借外设');
      const rows = this.db
        .prepare(
          `SELECT op.*, p.* , op.id AS op_id, p.id AS pid, p.status AS p_status
           FROM order_peripherals op JOIN peripherals p ON p.id=op.peripheral_id
           WHERE op.order_id=? AND op.status='RESERVED' ORDER BY p.type, p.code`
        )
        .all(orderId);
      for (const r of rows) {
        const ack = this.periph.lend(r);
        if (!ack.ok) throw new ArenaError('LEND_FAILED', `${r.code} 出借失败：${ack.code}`);
        this.db
          .prepare(
            `UPDATE order_peripherals
               SET status='LENT', lent_at=?, lent_by=?, lent_appearance=?, lent_receipt=?
             WHERE id=? AND status='RESERVED'`
          )
          .run(now, by, r.appearance, ack.receipt, r.op_id);
        this.db.prepare("UPDATE peripherals SET status='ON_LOAN' WHERE id=?").run(r.pid);
      }
      this.audit(by, 'PERIPH_LEND', String(orderId), { count: rows.length });
      return this.getOrder(orderId);
    });
  }

  // 归还单件：OK / DAMAGED（损坏扣款）/ MISSING（赔偿）
  returnPeripheral(opId, { scan = 'OK', appearance = '', note = '', by = '前台A', now = Date.now() } = {}) {
    return this.tx(() => {
      const row = this.db
        .prepare(
          `SELECT op.*, p.code AS p_code, p.type AS p_type, p.appearance AS p_appearance,
                  p.replacement_fen, p.damage_fee_fen, p.id AS pid
           FROM order_peripherals op JOIN peripherals p ON p.id=op.peripheral_id
           WHERE op.id=?`
        )
        .get(opId);
      if (!row) throw new ArenaError('ITEM_NOT_FOUND', '交接记录不存在');
      if (row.status !== 'LENT') throw new ArenaError('BAD_STATE', `该外设当前状态为 ${row.status}`);

      const ack = this.periph.giveBack(row, scan);
      if (!ack.ok) throw new ArenaError('RETURN_FAILED', `归还回执失败：${ack.code}`);

      if (scan === 'OK') {
        this.db
          .prepare(
            `UPDATE order_peripherals SET status='RETURNED', returned_at=?, returned_by=?,
                   return_appearance=?, return_receipt=? WHERE id=?`
          )
          .run(now, by, appearance || row.lent_appearance || row.p_appearance, ack.receipt, opId);
        this.db.prepare("UPDATE peripherals SET status='AVAILABLE' WHERE id=?").run(row.pid);
        this.audit(by, 'PERIPH_RETURN', String(opId), { code: row.p_code });
      } else {
        const kind = scan === 'MISSING' ? 'PERIPHERAL_MISSING' : 'DEVICE_DAMAGE';
        const amount = scan === 'MISSING' ? row.replacement_fen : row.damage_fee_fen;
        const insp = this._createInspection(
          {
            stationId: row.order_id ? this.db.prepare('SELECT station_id FROM orders WHERE id=?').get(row.order_id).station_id : null,
            orderId: row.order_id,
            type: 'POST_INCIDENT',
            inspector: by,
            now,
            note: `归还核验：${row.p_code} ${scan === 'MISSING' ? '缺失' : '损坏'}`,
          },
          true
        );
        this.db
          .prepare(
            `INSERT INTO inspection_findings (inspection_id, item, result, note) VALUES (?,?,?,?)`
          )
          .run(insp.id, `${row.p_type} ${row.p_code}`, scan, note || appearance || '归还时发现');
        const incCode = `G${now.toString(36).toUpperCase()}-${opId}`;
        const incInfo = this.db
          .prepare(
            `INSERT INTO incidents (code, order_id, station_id, type, status, start_time, end_time,
                                    duration_minutes, evidence, inspection_id, note, reported_by)
             VALUES (?,?,?,?,'RESOLVED',?,?,0,?,?,?,?)`
          )
          .run(
            incCode,
            row.order_id,
            (this.db.prepare('SELECT station_id FROM orders WHERE id=?').get(row.order_id)).station_id,
            kind,
            now,
            now,
            ack.receipt,
            insp.id,
            note || (scan === 'MISSING' ? '外设未归还，按缺失赔偿' : '外观/功能损坏扣款'),
            by
          );
        const dInfo = this.db
          .prepare(
            `INSERT INTO deductions (order_id, incident_id, inspection_id, reason, amount_fen, created_by, created_at)
             VALUES (?,?,?,?,?,?,?)`
          )
          .run(
            row.order_id,
            Number(incInfo.lastInsertRowid),
            insp.id,
            `${row.p_code} ${scan === 'MISSING' ? '缺失赔偿' : '损坏扣款'}`,
            amount,
            by,
            now
          );
        this.db
          .prepare(
            `UPDATE order_peripherals SET status=?, returned_at=?, returned_by=?, return_appearance=?,
                   return_receipt=?, deduction_id=? WHERE id=?`
          )
          .run(scan, now, by, appearance || note, ack.receipt, Number(dInfo.lastInsertRowid), opId);
        this.db
          .prepare("UPDATE peripherals SET status=? WHERE id=?")
          .run(scan === 'MISSING' ? 'RETIRED' : 'MAINT', row.pid);
        this.audit(by, 'PERIPH_ISSUE', String(opId), { code: row.p_code, scan, amount });
      }
      return this.getOrder(row.order_id);
    });
  }

  // ---------- 巡检 ----------

  _createInspection({ stationId, orderId, type = 'ROUTINE', inspector = null, now = Date.now(), note = '' }, done = false) {
    const n = this.db.prepare('SELECT COUNT(*) c FROM inspections').get().c + 1;
    const code = `J${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${String(n).padStart(4, '0')}`;
    const sql = done
      ? `INSERT INTO inspections (code, station_id, order_id, type, status, inspector, scheduled_at, checked_at, note)
         VALUES (?,?,?,?,'DONE',?,?,?,?)`
      : `INSERT INTO inspections (code, station_id, order_id, type, status, scheduled_at, note)
         VALUES (?,?,?,?,'PENDING',?,?)`;
    const params = done
      ? [code, stationId, orderId ?? null, type, inspector, now, now, note]
      : [code, stationId, orderId ?? null, type, now, note];
    const r = this.db.prepare(sql).run(...params);
    return { id: Number(r.lastInsertRowid), code };
  }

  createRoutineInspection(stationId, { by = '前台A', now = Date.now(), note = '', orderId = null, type = 'ROUTINE' } = {}) {
    const station = this.db.prepare('SELECT * FROM stations WHERE id=?').get(stationId);
    if (!station) throw new ArenaError('STATION_NOT_FOUND', '机位不存在');
    return this.tx(() => {
      const insp = this._createInspection({ stationId, orderId, type, now, note });
      this.audit(by, 'INSP_CREATE', String(insp.id), { station: station.code, orderId });
      return this.db.prepare('SELECT * FROM inspections WHERE id=?').get(insp.id);
    });
  }

  listInspections(status) {
    const sql = status
      ? `SELECT i.*, s.code AS station_code, o.code AS order_code FROM inspections i
         JOIN stations s ON s.id=i.station_id LEFT JOIN orders o ON o.id=i.order_id
         WHERE i.status=? ORDER BY i.scheduled_at DESC`
      : `SELECT i.*, s.code AS station_code, o.code AS order_code FROM inspections i
         JOIN stations s ON s.id=i.station_id LEFT JOIN orders o ON o.id=i.order_id
         ORDER BY i.scheduled_at DESC`;
    return status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all();
  }

  // findings: [{ item, result:'OK'|'DAMAGED'|'MISSING', note, peripheralId?, amountFen? }]
  completeInspection(inspId, { inspector = '前台A', findings = [], now = Date.now() } = {}) {
    return this.tx(() => {
      const insp = this.db.prepare('SELECT * FROM inspections WHERE id=?').get(inspId);
      if (!insp) throw new ArenaError('INSP_NOT_FOUND', '巡检工单不存在');
      if (insp.status === 'DONE') throw new ArenaError('BAD_STATE', '工单已完成');
      if (!findings.length) throw new ArenaError('NO_FINDINGS', '请至少填写一项检查结果');

      const hasIssue = findings.some((f) => f.result !== 'OK');
      this.db
        .prepare("UPDATE inspections SET status='DONE', result=?, inspector=?, checked_at=?, note=? WHERE id=?")
        .run(hasIssue ? 'FAIL' : 'PASS', inspector, now, insp.note, inspId);
      for (const f of findings) {
        this.db
          .prepare('INSERT INTO inspection_findings (inspection_id, item, result, note) VALUES (?,?,?,?)')
          .run(inspId, f.item, f.result, f.note || '');
      }

      const created = [];
      const ITEM_TO_TYPE = { 键盘: 'KEYBOARD', 鼠标: 'MOUSE', 耳机: 'HEADSET' };
      for (const f of findings) {
        if (f.result === 'OK') continue;
        const periphType = ITEM_TO_TYPE[f.item];
        // 外设类检查项：自动匹配该订单当前出借中的同类型编号实物
        if ((f.peripheralId || periphType) && insp.order_id) {
          let p;
          let op;
          if (f.peripheralId) {
            p = this.db.prepare('SELECT * FROM peripherals WHERE id=?').get(f.peripheralId);
            op = this.db
              .prepare('SELECT * FROM order_peripherals WHERE order_id=? AND peripheral_id=? AND status=\'LENT\'')
              .get(insp.order_id, f.peripheralId);
          } else {
            op = this.db
              .prepare(
                `SELECT op.* FROM order_peripherals op JOIN peripherals p ON p.id=op.peripheral_id
                 WHERE op.order_id=? AND p.type=? AND op.status='LENT' ORDER BY op.id LIMIT 1`
              )
              .get(insp.order_id, periphType);
            p = op ? this.db.prepare('SELECT * FROM peripherals WHERE id=?').get(op.peripheral_id) : null;
          }
          if (!p) throw new ArenaError('PERIPH_NOT_FOUND', `巡检项「${f.item}」找不到该订单出借中的对应外设`);
          const amount = f.amountFen > 0
            ? f.amountFen
            : f.result === 'MISSING' ? p.replacement_fen : p.damage_fee_fen;
          const incType = f.result === 'MISSING' ? 'PERIPHERAL_MISSING' : 'DEVICE_DAMAGE';
          const incInfo = this.db
            .prepare(
              `INSERT INTO incidents (code, order_id, station_id, type, status, start_time, end_time,
                                      duration_minutes, evidence, inspection_id, note, reported_by)
               VALUES (?,?,?,?,'RESOLVED',?,?,0,?,?,?,?)`
            )
            .run(
              `G${now.toString(36).toUpperCase()}-P${p.id}-${inspId}`,
              insp.order_id,
              insp.station_id,
              incType,
              now,
              now,
              `巡检工单 ${insp.code}`,
              inspId,
              f.note || `${p.code} ${f.result === 'MISSING' ? '缺失' : '损坏'}`,
              inspector
            );
          const dInfo = this.db
            .prepare(
              `INSERT INTO deductions (order_id, incident_id, inspection_id, reason, amount_fen, created_by, created_at)
               VALUES (?,?,?,?,?,?,?)`
            )
            .run(
              insp.order_id,
              Number(incInfo.lastInsertRowid),
              inspId,
              `${p.code} ${f.result === 'MISSING' ? '缺失赔偿' : '损坏扣款'}`,
              amount,
              inspector,
              now
            );
          if (op) {
            this.db
              .prepare("UPDATE order_peripherals SET status=?, returned_at=?, returned_by=?, deduction_id=? WHERE id=?")
              .run(f.result, now, inspector, Number(dInfo.lastInsertRowid), op.id);
          }
          this.db
            .prepare('UPDATE peripherals SET status=? WHERE id=?')
            .run(f.result === 'MISSING' ? 'RETIRED' : 'MAINT', p.id);
          created.push({ type: incType, code: p.code, amount });
        } else if (periphType && !insp.order_id) {
          throw new ArenaError('NO_ORDER', `巡检项「${f.item}」异常需要关联订单才能登记扣款`);
        } else if (f.result === 'MISSING') {
          throw new ArenaError('BAD_FINDING', `机位设备「${f.item}」不支持缺失登记，请按损坏核定金额`);
        } else if (f.amountFen > 0 && insp.order_id) {
          // 机位设备（显示器/主机/座椅等）损坏，前台核定金额
          const incInfo = this.db
            .prepare(
              `INSERT INTO incidents (code, order_id, station_id, type, status, start_time, end_time,
                                      duration_minutes, evidence, inspection_id, note, reported_by)
               VALUES (?,?,?, 'DEVICE_DAMAGE','RESOLVED',?,?,0,?,?,?,?)`
            )
            .run(
              `G${now.toString(36).toUpperCase()}-S${insp.station_id}-${inspId}`,
              insp.order_id,
              insp.station_id,
              now,
              now,
              `巡检工单 ${insp.code}`,
              inspId,
              f.note || `${f.item} 损坏`,
              inspector
            );
          this.db
            .prepare(
              `INSERT INTO deductions (order_id, incident_id, inspection_id, reason, amount_fen, created_by, created_at)
               VALUES (?,?,?,?,?,?,?)`
            )
            .run(insp.order_id, Number(incInfo.lastInsertRowid), inspId, `${f.item} 损坏赔偿`, f.amountFen, inspector, now);
          this.db.prepare("UPDATE stations SET status='MAINT' WHERE id=?").run(insp.station_id);
          created.push({ type: 'DEVICE_DAMAGE', code: f.item, amount: f.amountFen });
        } else if (f.result === 'DAMAGED') {
          // 无金额的机位设备异常：只转维修，不计扣款
          this.db.prepare("UPDATE stations SET status='MAINT' WHERE id=?").run(insp.station_id);
          if (insp.order_id) {
            this.db
              .prepare(
                `INSERT INTO incidents (code, order_id, station_id, type, status, start_time, end_time,
                                        duration_minutes, evidence, inspection_id, note, reported_by)
                 VALUES (?,?,?, 'DEVICE_DAMAGE','RESOLVED',?,?,0,?,?,?,?)`
              )
              .run(
                `G${now.toString(36).toUpperCase()}-S${insp.station_id}-${inspId}`,
                insp.order_id, insp.station_id, now, now,
                `巡检工单 ${insp.code}`, inspId, f.note || `${f.item} 损坏（维修处理，未计赔偿）`, inspector
              );
          }
        }
      }
      this.audit(inspector, 'INSP_DONE', String(inspId), { hasIssue, count: findings.length });
      return {
        inspection: this.db
          .prepare(
            `SELECT i.*, s.code AS station_code FROM inspections i JOIN stations s ON s.id=i.station_id WHERE i.id=?`
          )
          .get(inspId),
        findings: this.db.prepare('SELECT * FROM inspection_findings WHERE inspection_id=?').all(inspId),
        created,
      };
    });
  }

  repairStation(stationId, { by = '维修员', now = Date.now() } = {}) {
    return this.tx(() => {
      this.db.prepare("UPDATE stations SET status='AVAILABLE' WHERE id=? AND status='MAINT'").run(stationId);
      this.db
        .prepare("UPDATE peripherals SET status='AVAILABLE' WHERE status='MAINT'")
        .run();
      this.audit(by, 'STATION_REPAIR', String(stationId));
      return this.db.prepare('SELECT * FROM stations WHERE id=?').get(stationId);
    });
  }

  // ---------- 网络中断（本地设备适配器） ----------

  openNetworkIncident(orderId, { by = '前台A', now = Date.now() } = {}) {
    return this.tx(() => {
      const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o) throw new ArenaError('ORDER_NOT_FOUND', '订单不存在');
      if (o.status !== 'ACTIVE') throw new ArenaError('BAD_STATE', '只有进行中的订单可以报网络故障');
      const open = this.db
        .prepare("SELECT id FROM incidents WHERE order_id=? AND type='NETWORK_OUTAGE' AND status='OPEN'")
        .get(orderId);
      if (open) throw new ArenaError('INCIDENT_OPEN', '该订单已有未恢复的网络中断事件');
      const ack = this.net.outageStart(o.station_id, now);
      if (!ack.ok) throw new ArenaError('NET_FAILED', `网络适配器：${ack.code}`);
      const info = this.db
        .prepare(
          `INSERT INTO incidents (code, order_id, station_id, type, status, start_time, evidence, reported_by)
           VALUES (?,?,?, 'NETWORK_OUTAGE','OPEN',?,?,?)`
        )
        .run(`N${now.toString(36).toUpperCase()}-${orderId}`, orderId, o.station_id, now, ack.receipt, by);
      this.audit(by, 'NET_DOWN', String(orderId), ack.receipt);
      return this.db.prepare('SELECT * FROM incidents WHERE id=?').get(Number(info.lastInsertRowid));
    });
  }

  resolveNetworkIncident(incidentId, { by = '前台A', now = Date.now() } = {}) {
    return this.tx(() => {
      const inc = this.db.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId);
      if (!inc) throw new ArenaError('INCIDENT_NOT_FOUND', '故障事件不存在');
      if (inc.status !== 'OPEN') throw new ArenaError('BAD_STATE', '故障事件已恢复');
      const ack = this.net.outageEnd(inc.station_id, now);
      if (!ack.ok) throw new ArenaError('NET_FAILED', `网络适配器：${ack.code}`);
      const duration = Math.max(1, mins(ack.durationMs));
      this.db
        .prepare(
          `UPDATE incidents SET status='RESOLVED', end_time=?, duration_minutes=?, comp_minutes=? WHERE id=?`
        )
        .run(now, duration, duration, incidentId);
      this.audit(by, 'NET_UP', String(incidentId), { duration, receipt: ack.receipt });
      return this.db.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId);
    });
  }

  // ---------- 店内消费（演示） ----------

  addExtra(orderId, { name, qty = 1, unitFen, now = Date.now() }) {
    return this.tx(() => {
      const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o) throw new ArenaError('ORDER_NOT_FOUND', '订单不存在');
      if (!['ACTIVE', 'ENDED'].includes(o.status)) throw new ArenaError('BAD_STATE', '当前状态不可记账');
      const info = this.db
        .prepare(
          `INSERT INTO order_extras (order_id, name, qty, unit_fen, amount_fen, created_at)
           VALUES (?,?,?,?,?,?)`
        )
        .run(orderId, name, qty, unitFen, qty * unitFen, now);
      return this.db.prepare('SELECT * FROM order_extras WHERE id=?').get(Number(info.lastInsertRowid));
    });
  }

  // ---------- 结束（提前结束/正常结束） ----------

  endOrder(orderId, { by = '前台A', now = Date.now() } = {}) {
    return this.tx(() => {
      const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o) throw new ArenaError('ORDER_NOT_FOUND', '订单不存在');
      if (o.status !== 'ACTIVE') throw new ArenaError('BAD_STATE', `订单 ${o.status}，不能结束`);

      const lent = this.db
        .prepare("SELECT COUNT(*) c FROM order_peripherals WHERE order_id=? AND status='LENT'")
        .get(orderId).c;
      if (lent > 0) throw new ArenaError('PENDING_RETURNS', `还有 ${lent} 件外设未归还，不能结账关机`);

      // 未恢复的网络中断在关机时刻自动恢复，停机补偿计到关机为止
      const openNet = this.db
        .prepare("SELECT * FROM incidents WHERE order_id=? AND type='NETWORK_OUTAGE' AND status='OPEN'")
        .all(orderId);
      for (const inc of openNet) {
        const ack = this.net.outageEnd(inc.station_id, now);
        if (ack.ok) {
          const duration = Math.max(1, mins(ack.durationMs));
          this.db
            .prepare(
              `UPDATE incidents SET status='RESOLVED', end_time=?, duration_minutes=?, comp_minutes=? WHERE id=?`
            )
            .run(now, duration, duration, inc.id);
        }
      }

      const earlyMinutes = Math.max(0, mins(o.plan_end - now));
      this.db
        .prepare(
          `UPDATE orders SET status='ENDED', actual_end=?, early_minutes=? WHERE id=? AND status='ACTIVE'`
        )
        .run(now, earlyMinutes, orderId);
      // 未出借的预留外设释放
      this.db.prepare("DELETE FROM order_peripherals WHERE order_id=? AND status='RESERVED'").run(orderId);
      // 授权立即关闭（不等自然到期）
      this.db
        .prepare("UPDATE account_grants SET status='REVOKED', revoked_at=? WHERE order_id=? AND status IN ('ACTIVE','EXPIRED')")
        .run(now, orderId);
      // 机位恢复；若处于维修则保持 MAINT
      const station = this.db.prepare('SELECT status FROM stations WHERE id=?').get(o.station_id);
      if (station.status !== 'MAINT') this.db.prepare("UPDATE stations SET status='AVAILABLE' WHERE id=?").run(o.station_id);
      this.audit(by, 'ORDER_END', String(orderId), { earlyMinutes });
      return this.getOrder(orderId);
    });
  }

  // ---------- 结账（结算快照 + 停机扣除 + 押金扣款 + 幂等收退款） ----------

  settleOrder(orderId, { by = '前台A', now = Date.now() } = {}) {
    const existing = this.db.prepare('SELECT * FROM settlements WHERE order_id=?').get(orderId);
    if (existing) {
      return { duplicated: true, settlement: existing, order: this.getOrder(orderId) };
    }

    return this.tx(() => {
      const o = this.db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o) throw new ArenaError('ORDER_NOT_FOUND', '订单不存在');
      if (o.status !== 'ENDED') throw new ArenaError('BAD_STATE', `订单 ${o.status}，需要先关机再结账`);
      const openInc = this.db
        .prepare("SELECT COUNT(*) c FROM incidents WHERE order_id=? AND status='OPEN'")
        .get(orderId).c;
      if (openInc) throw new ArenaError('INCIDENT_OPEN', '还有未处理完的故障事件');

      const station = this.db.prepare('SELECT * FROM stations WHERE id=?').get(o.station_id);
      const planMinutes = Math.max(0, mins(o.plan_end - (o.billing_start ?? o.plan_start)));
      const usedMinutes = Math.max(0, mins(o.actual_end - (o.billing_start ?? o.plan_start)));
      const compRaw =
        this.db
          .prepare("SELECT COALESCE(SUM(comp_minutes),0) c FROM incidents WHERE order_id=? AND status='RESOLVED'")
          .get(orderId).c || 0;
      const compMinutes = Math.min(compRaw, usedMinutes);
      const billableMinutes = Math.max(0, usedMinutes - compMinutes);
      const rentalFen = Math.ceil((billableMinutes * station.hourly_fen) / 60);
      const extrasFen =
        this.db.prepare('SELECT COALESCE(SUM(amount_fen),0) c FROM order_extras WHERE order_id=?').get(orderId).c;
      const deductionsFen =
        this.db.prepare('SELECT COALESCE(SUM(amount_fen),0) c FROM deductions WHERE order_id=?').get(orderId).c;
      const deposit = this.db.prepare('SELECT * FROM deposits WHERE order_id=?').get(orderId);

      const totalDue = rentalFen + extrasFen + deductionsFen;
      const refundFen = Math.max(0, deposit.amount_fen - totalDue);
      const chargeFen = Math.max(0, totalDue - deposit.amount_fen);

      const breakdown = {
        planMinutes,
        usedMinutes,
        compMinutes,
        billableMinutes,
        lateMinutes: o.late_minutes,
        earlyMinutes: o.early_minutes,
        rentalFen,
        extrasFen,
        deductionsFen,
        depositFen: deposit.amount_fen,
        totalDue,
        chargeFen,
        refundFen,
        incidents: this.db
          .prepare('SELECT code, type, duration_minutes, comp_minutes FROM incidents WHERE order_id=?')
          .all(orderId),
        deductions: this.db.prepare('SELECT id, reason, amount_fen, inspection_id FROM deductions WHERE order_id=?').all(orderId),
        extras: this.db.prepare('SELECT name, qty, amount_fen FROM order_extras WHERE order_id=?').all(orderId),
      };

      // 固定幂等键：重复结账只可能拿到同一笔流水
      let chargeReceipt = '';
      let refundReceipt = '';
      if (chargeFen > 0) {
        const r = this.pay.charge(orderId, chargeFen, `charge:order:${orderId}`);
        chargeReceipt = r.receiptNo;
      }
      if (refundFen > 0) {
        const r = this.pay.refund(orderId, refundFen, `refund:order:${orderId}`);
        refundReceipt = r.receiptNo;
      }

      const info = this.db
        .prepare(
          `INSERT INTO settlements (order_id, snap_time, plan_minutes, used_minutes, comp_minutes,
               billable_minutes, rental_fen, extras_fen, deductions_fen, deposit_fen, total_due_fen,
               charge_fen, refund_fen, breakdown_json, pay_receipt, refund_receipt, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          orderId,
          now,
          planMinutes,
          usedMinutes,
          compMinutes,
          billableMinutes,
          rentalFen,
          extrasFen,
          deductionsFen,
          deposit.amount_fen,
          totalDue,
          chargeFen,
          refundFen,
          JSON.stringify(breakdown),
          chargeReceipt,
          refundReceipt,
          by
        );

      this.db
        .prepare('UPDATE deposits SET status=\'SETTLED\', deducted_fen=?, refunded_fen=? WHERE order_id=?')
        .run(Math.min(deductionsFen, deposit.amount_fen), refundFen, orderId);
      this.db.prepare("UPDATE orders SET status='SETTLED' WHERE id=?").run(orderId);
      this.audit(by, 'ORDER_SETTLE', String(orderId), { totalDue, chargeFen, refundFen });
      return {
        duplicated: false,
        settlement: this.db.prepare('SELECT * FROM settlements WHERE id=?').get(Number(info.lastInsertRowid)),
        order: this.getOrder(orderId),
      };
    });
  }

  // ---------- 界面聚合 ----------

  floorplan(now = Date.now()) {
    this.expireGrants(now);
    const stations = this.listStations();
    const activeStmt = this.db
      .prepare(
        `SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id=o.customer_id
         WHERE o.station_id=? AND o.status='ACTIVE'`
      );
    return stations.map((s) => {
      const active = activeStmt.get(s.id);
      let activeOrder = null;
      if (active) {
        const total = active.plan_end - active.plan_start;
        const elapsed = Math.min(Math.max(now - active.plan_start, 0), total);
        activeOrder = {
          id: active.id,
          code: active.code,
          customerName: active.customer_name,
          planStart: active.plan_start,
          planEnd: active.plan_end,
          remainMs: Math.max(active.plan_end - now, 0),
          progress: total > 0 ? elapsed / total : 0,
          online: this.net ? this.net.isOnline(s.id) : true,
        };
      }
      const next = this.db
        .prepare(
          `SELECT code, plan_start, plan_end FROM orders WHERE station_id=? AND status='PENDING'
           AND plan_end>? ORDER BY plan_start LIMIT 1`
        )
        .get(s.id, now);
      return { ...s, activeOrder, next };
    });
  }

  calendar(dayStart, dayEnd) {
    return this.db
      .prepare(
        `SELECT o.*, c.name AS customer_name, s.code AS station_code, k.name AS kit_name
         FROM orders o JOIN customers c ON c.id=o.customer_id
         JOIN stations s ON s.id=o.station_id JOIN kits k ON k.id=o.kit_id
         WHERE o.plan_start>=? AND o.plan_start<? ORDER BY o.plan_start`
      )
      .all(dayStart, dayEnd);
  }

  paymentsOf(orderId) {
    return this.db.prepare('SELECT * FROM payments WHERE order_id=? ORDER BY id').all(orderId);
  }

  findingsOf(inspId) {
    return this.db.prepare('SELECT * FROM inspection_findings WHERE inspection_id=?').all(inspId);
  }
}

module.exports = { Arena, ArenaError, ORDER_STATUS, overlap, mins, FEN, MIN };
