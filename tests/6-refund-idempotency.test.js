'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memApp, cleanup, H, M } = require('./helpers');

function endAndSettle(arena, o, { now, extras = [], damageMouse = false, missingMouse = false }) {
  arena.startOrder(o.id, { now });
  arena.lendAll(o.id, { now });
  for (const e of extras) {
    arena.addExtra(o.id, { name: e.name, qty: e.qty ?? 1, unitFen: e.unitFen, now });
  }
  const live = arena.getOrder(o.id);
  let mouseFee = 0;
  if (damageMouse || missingMouse) {
    const mouse = live.peripherals.find((p) => p.p_type === 'MOUSE');
    mouseFee = missingMouse ? mouse.replacement_fen : mouse.damage_fee_fen;
    arena.returnPeripheral(mouse.id, {
      scan: missingMouse ? 'MISSING' : 'DAMAGED',
      note: 'test',
      now: now + M,
    });
  }
  for (const p of arena.getOrder(o.id).peripherals.filter((x) => x.status === 'LENT')) {
    arena.returnPeripheral(p.id, { scan: 'OK', now: now + 2 * M });
  }
  arena.endOrder(o.id, { now: now + 2 * H });
  const result = arena.settleOrder(o.id, { now: now + 2 * H });
  return { result, mouseFee };
}

test('重复结账返回同一快照与同一退款流水，不产生第二笔退款', () => {
  const app = memApp();
  const { arena, db } = app;
  const now = 10 * H;
  const o = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: now, planEnd: now + 2 * H,
  });
  const { result } = endAndSettle(arena, o, { now, extras: [{ name: '红牛', unitFen: 800, qty: 2 }] });
  assert.equal(result.duplicated, false);
  assert.ok(result.settlement.refund_fen > 0);
  const refundReceipt = result.settlement.refund_receipt;
  assert.ok(refundReceipt);

  // 再连续调用 3 次结账
  const repeats = [1, 2, 3].map(() => arena.settleOrder(o.id, { by: '前台B', now: now + 3 * H }));
  for (const r of repeats) {
    assert.equal(r.duplicated, true);
    assert.equal(r.settlement.refund_receipt, refundReceipt);
    assert.equal(r.settlement.id, result.settlement.id);
  }
  const refunds = db
    .prepare("SELECT COUNT(*) c, COALESCE(SUM(amount_fen),0) sum FROM payments WHERE order_id=? AND kind='REFUND'")
    .get(o.id);
  assert.equal(refunds.c, 1, '只能有一笔退款流水');
  assert.equal(refunds.sum, result.settlement.refund_fen);
  const settlements = db.prepare('SELECT COUNT(*) c FROM settlements WHERE order_id=?').get(o.id).c;
  assert.equal(settlements, 1);
  cleanup(app);
});

test('押金不足时补收一笔；重复结账不会重复扣款', () => {
  const app = memApp();
  const { arena, db } = app;
  const now = 10 * H;
  const o = arena.createOrder({
    customerId: 5, stationId: 1, kitId: 1, planStart: now, planEnd: now + 2 * H,
  });
  const { result, mouseFee } = endAndSettle(arena, o, { now, missingMouse: true });
  assert.ok(mouseFee > 20000, '演示鼠标赔偿应高于 K1 押金 200 元');
  assert.ok(result.settlement.charge_fen > 0);
  assert.equal(result.settlement.refund_fen, 0);
  assert.ok(result.settlement.pay_receipt);

  arena.settleOrder(o.id, { now: now + H });
  const charges = db
    .prepare("SELECT COUNT(*) c, COALESCE(SUM(amount_fen),0) sum FROM payments WHERE order_id=? AND kind='CHARGE'")
    .get(o.id);
  assert.equal(charges.c, 1);
  assert.equal(charges.sum, result.settlement.charge_fen);
  cleanup(app);
});

test('支付适配器层面相同幂等键重复请求只落一笔（即使绕过订单结算）', () => {
  const app = memApp();
  const { payment, db } = app;
  // order_id 为 NULL（不关联订单的通用流水），只验证幂等键约束
  const r1 = payment.charge(null, 5000, 'charge:standalone:1');
  const r2 = payment.charge(null, 5000, 'charge:standalone:1');
  const r3 = payment.charge(null, 9999, 'charge:standalone:1'); // 金额不同也返回原流水
  assert.equal(r1.duplicated, false);
  assert.equal(r2.duplicated, true);
  assert.equal(r3.duplicated, true);
  assert.equal(r1.receiptNo, r2.receiptNo);
  assert.equal(r1.receiptNo, r3.receiptNo);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM payments WHERE idempotency_key='charge:standalone:1'").get().c, 1);

  const f1 = payment.refund(null, 3000, 'refund:standalone:1');
  const f2 = payment.refund(null, 3000, 'refund:standalone:1');
  assert.equal(f1.receiptNo, f2.receiptNo);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM payments WHERE idempotency_key='refund:standalone:1'").get().c, 1);
  cleanup(app);
});

test('外设缺失赔偿 + 租金 + 消费的结账金额平衡：应收 = 租金+消费+扣款', () => {
  const app = memApp();
  const { arena } = app;
  const now = 10 * H;
  const o = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: now, planEnd: now + 2 * H,
  });
  const { result } = endAndSettle(arena, o, {
    now,
    damageMouse: true,
    extras: [{ name: '泡面', unitFen: 900 }],
  });
  const s = result.settlement;
  assert.equal(s.total_due_fen, s.rental_fen + s.extras_fen + s.deductions_fen);
  assert.equal(s.total_due_fen, s.deposit_fen - s.refund_fen + s.charge_fen);
  assert.equal(s.extras_fen, 900);
  assert.equal(s.rental_fen, 2400);
  assert.ok(s.deductions_fen > 0);
  cleanup(app);
});
