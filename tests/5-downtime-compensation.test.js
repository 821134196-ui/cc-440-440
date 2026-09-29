'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memApp, cleanup, H, M } = require('./helpers');

// 走完一单（无外设问题），返回结账结果
function runFullSession(arena, { start, end, actions = {} }) {
  const o = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: start, planEnd: end,
  });
  arena.startOrder(o.id, { by: '前台A', now: actions.startAt ?? start });
  arena.lendAll(o.id, { now: actions.lendAt ?? actions.startAt ?? start });

  if (actions.outages) {
    for (const out of actions.outages) {
      const inc = arena.openNetworkIncident(o.id, { by: '前台A', now: out[0] });
      arena.resolveNetworkIncident(inc.id, { by: '前台B', now: out[1] });
    }
  }
  for (const p of arena.getOrder(o.id).peripherals) {
    arena.returnPeripheral(p.id, { scan: 'OK', now: actions.endAt ?? end });
  }
  arena.endOrder(o.id, { by: '前台A', now: actions.endAt ?? end });
  return { order: o, result: arena.settleOrder(o.id, { by: '前台A', now: actions.endAt ?? end }) };
}

test('网络中断的停机时间从结算快照中等额扣除（30 分钟）', () => {
  const app = memApp();
  const { arena } = app;
  const start = 10 * H;
  const end = start + 2 * H;
  const { result } = runFullSession(arena, {
    start,
    end,
    actions: {
      startAt: start,
      outages: [[start + 30 * M, start + 60 * M]], // 中断 30 分钟
      endAt: end,
    },
  });
  const s = result.settlement;
  const b = JSON.parse(s.breakdown_json);
  assert.equal(s.used_minutes, 120);
  assert.equal(s.comp_minutes, 30);
  assert.equal(s.billable_minutes, 90);
  assert.equal(s.rental_fen, Math.ceil((90 * 1200) / 60));
  assert.ok(s.rental_fen < 2400);

  const netRow = b.incidents.find((i) => i.type === 'NETWORK_OUTAGE');
  assert.equal(netRow.duration_minutes, 30);
  assert.equal(netRow.comp_minutes, 30);
  cleanup(app);
});

test('关机时仍未恢复的网络中断自动恢复，停机时间计到关机时刻', () => {
  const app = memApp();
  const { arena } = app;
  const start = 10 * H;
  const end = start + 2 * H;
  const o = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: start, planEnd: end,
  });
  arena.startOrder(o.id, { now: start });
  arena.lendAll(o.id, { now: start });
  arena.openNetworkIncident(o.id, { now: start + 60 * M }); // 一小时后断网，未恢复
  for (const p of arena.getOrder(o.id).peripherals) {
    arena.returnPeripheral(p.id, { scan: 'OK', now: start + 90 * M });
  }
  arena.endOrder(o.id, { now: start + 90 * M }); // 提前 30 分钟关机
  const result = arena.settleOrder(o.id, { now: start + 90 * M });
  assert.equal(result.settlement.comp_minutes, 30);
  assert.equal(result.settlement.billable_minutes, 60); // 90 - 30
  cleanup(app);
});

test('补偿分钟不超过实际使用分钟（异常数据下不为负）', () => {
  const app = memApp();
  const { arena, db } = app;
  const start = 10 * H;
  const end = start + H;
  const o = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: start, planEnd: end,
  });
  arena.startOrder(o.id, { now: start });
  arena.lendAll(o.id, { now: start });
  // 手工插入一条 comp 远超用时的已解决事件，验证结算钳制
  db.prepare(
    `INSERT INTO incidents (code, order_id, station_id, type, status, start_time, end_time,
                            duration_minutes, comp_minutes, evidence)
     VALUES ('X1', ?, 1, 'NETWORK_OUTAGE','RESOLVED', ?, ?, 999, 999, 'test')`
  ).run(o.id, start, end);
  for (const p of arena.getOrder(o.id).peripherals) {
    arena.returnPeripheral(p.id, { scan: 'OK', now: end });
  }
  arena.endOrder(o.id, { now: end });
  const result = arena.settleOrder(o.id, { now: end });
  assert.equal(result.settlement.comp_minutes, 60);
  assert.equal(result.settlement.billable_minutes, 0);
  assert.equal(result.settlement.rental_fen, 0);
  cleanup(app);
});

test('迟到不补时：计费起点仍是计划开始时间，30 分钟迟到计入 late_minutes', () => {
  const app = memApp();
  const { arena } = app;
  const start = 10 * H;
  const end = start + 2 * H;
  const { result } = runFullSession(arena, {
    start,
    end,
    actions: { startAt: start + 30 * M, endAt: end },
  });
  assert.equal(result.order.late_minutes, 30);
  assert.equal(result.settlement.used_minutes, 120);
  assert.equal(result.settlement.billable_minutes, 120);
  cleanup(app);
});

test('提前结束按实际使用分钟计费，记录 early_minutes', () => {
  const app = memApp();
  const { arena } = app;
  const start = 10 * H;
  const end = start + 3 * H;
  const { result } = runFullSession(arena, {
    start,
    end,
    actions: { startAt: start, endAt: start + 2 * H },
  });
  assert.equal(result.settlement.used_minutes, 120);
  assert.equal(result.order.early_minutes, 60);
  assert.equal(result.settlement.billable_minutes, 120);
  assert.equal(result.settlement.rental_fen, 2400);
  cleanup(app);
});

test('设备损坏：巡检回链的押金扣款计入快照，机位转维修', () => {
  const app = memApp();
  const { arena, db } = app;
  const start = 10 * H;
  const end = start + 2 * H;
  const o = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: start, planEnd: end,
  });
  arena.startOrder(o.id, { now: start });
  arena.lendAll(o.id, { now: start });
  const live = arena.getOrder(o.id);
  const headset = live.peripherals.find((p) => p.p_type === 'HEADSET');
  arena.returnPeripheral(headset.id, { scan: 'DAMAGED', note: '头梁断裂', now: end - M });
  for (const p of arena.getOrder(o.id).peripherals.filter((x) => x.status === 'LENT')) {
    arena.returnPeripheral(p.id, { scan: 'OK', now: end });
  }
  arena.endOrder(o.id, { now: end });
  const result = arena.settleOrder(o.id, { now: end });

  const b = JSON.parse(result.settlement.breakdown_json);
  assert.equal(b.deductionsFen, headset.damage_fee_fen);
  assert.ok(b.deductions[0].inspection_id > 0, '扣款必须关联巡检记录');
  const deduct = db.prepare('SELECT * FROM deductions WHERE order_id=?').get(o.id);
  assert.ok(deduct.inspection_id);
  const finding = db.prepare('SELECT * FROM inspection_findings WHERE inspection_id=?').get(deduct.inspection_id);
  assert.equal(finding.result, 'DAMAGED');
  const periph = db.prepare('SELECT status FROM peripherals WHERE id=?').get(headset.pid);
  assert.equal(periph.status, 'MAINT');
  cleanup(app);
});
