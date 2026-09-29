'use strict';

// 进程内模拟适配器：网络状态、外设交接回执、支付/退款（幂等）。
// 真实部署时替换为设备 SDK / 网关客户端即可，领域服务只依赖下面的接口。

let seq = 0;
function receipt(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${String(seq).padStart(4, '0')}`;
}

// 本地网络适配器：按机位维护链路状态，模拟中断/恢复，事件带回执。
class NetworkAdapter {
  constructor(db) {
    this.db = db;
    this.downStations = new Map(); // stationId -> since(ms)
  }

  isOnline(stationId) {
    return !this.downStations.has(stationId);
  }

  outageStart(stationId, at = Date.now()) {
    if (this.downStations.has(stationId)) {
      return { ok: false, code: 'ALREADY_DOWN', since: this.downStations.get(stationId) };
    }
    this.downStations.set(stationId, at);
    return { ok: true, receipt: receipt('NETDOWN'), since: at };
  }

  outageEnd(stationId, at = Date.now()) {
    const since = this.downStations.get(stationId);
    if (since === undefined) return { ok: false, code: 'NOT_DOWN' };
    this.downStations.delete(stationId);
    return { ok: true, receipt: receipt('NETUP'), since, until: at, durationMs: at - since };
  }

  // 模拟授权网关心跳：授权是否应开放（机位在线且在时段内由领域层另行判断）
  gatewayPing() {
    return { ok: true, receipt: receipt('PING'), at: Date.now() };
  }
}

// 外设柜适配器：出借/归还都给硬件回执；归还时可上报外观与状态。
class PeripheralAdapter {
  constructor(db) {
    this.db = db;
  }

  lend(peripheral) {
    if (peripheral.status !== 'AVAILABLE') {
      return { ok: false, code: 'NOT_AVAILABLE', status: peripheral.status };
    }
    return { ok: true, receipt: receipt('LEND'), at: Date.now() };
  }

  // scan: 'OK' | 'DAMAGED' | 'MISSING'，柜机扫码/人工核验结果
  giveBack(peripheral, scan) {
    const accepted = ['OK', 'DAMAGED', 'MISSING'];
    if (!accepted.includes(scan)) {
      return { ok: false, code: 'BAD_SCAN' };
    }
    return { ok: true, receipt: receipt('RET'), at: Date.now(), scan };
  }
}

// 支付适配器：幂等键保证重复扣款/退款只落一笔；退款金额必须 <= 原押金-已扣。
class PaymentAdapter {
  constructor(db) {
    this.db = db;
  }

  _record({ orderId, key, kind, amountFen, channel }) {
    const exists = this.db
      .prepare('SELECT * FROM payments WHERE idempotency_key = ?')
      .get(key);
    if (exists) {
      return { ok: true, duplicated: true, receiptNo: exists.receipt_no, payment: exists };
    }
    const receiptNo = receipt(kind === 'REFUND' ? 'RF' : 'PAY');
    const info = this.db
      .prepare(
        `INSERT INTO payments (order_id, idempotency_key, kind, channel, amount_fen, receipt_no, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(orderId ?? null, key, kind, channel, amountFen, receiptNo, Date.now());
    const payment = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid);
    return { ok: true, duplicated: false, receiptNo, payment };
  }

  charge(orderId, amountFen, key) {
    return this._record({
      orderId,
      key,
      kind: 'CHARGE',
      amountFen,
      channel: '模拟收银',
    });
  }

  refund(orderId, amountFen, key) {
    return this._record({
      orderId,
      key,
      kind: 'REFUND',
      amountFen,
      channel: '模拟原路退回',
    });
  }
}

module.exports = { NetworkAdapter, PeripheralAdapter, PaymentAdapter, receipt };
