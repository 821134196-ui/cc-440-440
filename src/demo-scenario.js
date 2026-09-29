'use strict';

// 可复用的演示场景：被 bin/demo.js（打印复核摘要）与服务端管理接口共用。
// 所有时间相对 now，保证每次生成后都有一单进行中、一单待开始。

const H = 3600_000;
const M = 60_000;

function resetData(db) {
  db.exec(
    `DELETE FROM audit_log; DELETE FROM payments; DELETE FROM settlements; DELETE FROM order_extras;
     DELETE FROM deductions; DELETE FROM deposits; DELETE FROM incidents;
     DELETE FROM inspection_findings; DELETE FROM inspections;
     DELETE FROM account_grants; DELETE FROM order_peripherals; DELETE FROM orders;
     DELETE FROM kit_accounts; DELETE FROM kit_items; DELETE FROM kits;
     DELETE FROM peripherals; DELETE FROM accounts; DELETE FROM stations; DELETE FROM customers;`
  );
}

function buildDemo(arena, { now = Date.now() } = {}) {
  const t = (h, m = 0) => now + h * H + m * M;
  const db = arena.db;
  const station = (code) => db.prepare('SELECT * FROM stations WHERE code=?').get(code);
  const customer = (code) => db.prepare('SELECT * FROM customers WHERE code=?').get(code);
  const kit = (code) => db.prepare('SELECT * FROM kits WHERE code=?').get(code);

  // 订单 A：迟到 20 分钟 + 网络中断 30 分钟（停机补偿从结算快照扣除）
  const oa = arena.createOrder({
    customerId: customer('C001').id,
    stationId: station('A01').id,
    kitId: kit('K1').id,
    planStart: t(-4),
    planEnd: t(-2),
    by: '前台A',
    note: '老顾客陈一帆，2 小时档',
  });
  arena.startOrder(oa.id, { by: '前台A', now: t(-3, -40) });
  arena.lendAll(oa.id, { by: '前台A', now: t(-3, -40) });
  arena.addExtra(oa.id, { name: '红牛维生素饮料', qty: 2, unitFen: 800, now: t(-3) });
  const net = arena.openNetworkIncident(oa.id, { by: '前台A', now: t(-3, -20) });
  arena.resolveNetworkIncident(net.id, { by: '前台B', now: t(-2, -50) });
  const a0 = arena.getOrder(oa.id);
  arena.returnPeripheral(a0.peripherals[0].id, { scan: 'OK', by: '前台A', now: t(-2, -2) });
  arena.returnPeripheral(a0.peripherals[1].id, { scan: 'OK', by: '前台A', now: t(-2, -1) });
  arena.returnPeripheral(a0.peripherals[2].id, { scan: 'OK', by: '前台A', now: t(-2) });
  arena.endOrder(oa.id, { by: '前台A', now: t(-2) });
  const sa = arena.settleOrder(oa.id, { by: '前台A', now: t(-2) });

  // 订单 B：耳机损坏（巡检回链扣款）+ 显示器损坏 300 元，提前 30 分钟下机
  const ob = arena.createOrder({
    customerId: customer('C002').id,
    stationId: station('A03').id,
    kitId: kit('K2').id,
    planStart: t(-3),
    planEnd: t(0, -30),
    by: '前台B',
  });
  arena.startOrder(ob.id, { by: '前台B', now: t(-3) });
  const liveB = arena.lendAll(ob.id, { by: '前台B', now: t(-3) });
  arena.addExtra(ob.id, { name: '泡面（代泡）', qty: 1, unitFen: 900, now: t(-2) });
  const headset = liveB.peripherals.find((p) => p.p_type === 'HEADSET');
  arena.returnPeripheral(headset.id, {
    scan: 'DAMAGED',
    appearance: '左耳罩破裂，头梁变形',
    note: '顾客承认拉扯导致',
    by: '前台A',
    now: t(-1, -5),
  });
  for (const p of liveB.peripherals.filter((x) => x.status === 'LENT' && x.id !== headset.id)) {
    arena.returnPeripheral(p.id, { scan: 'OK', by: '前台A', now: t(-1, -4) });
  }
  const insp = arena.createRoutineInspection(station('A03').id, {
    by: '前台A',
    now: t(-1, -3),
    orderId: ob.id,
    type: 'POST_INCIDENT',
    note: '下机交接设备巡检',
  });
  arena.completeInspection(insp.id, {
    inspector: '前台A',
    now: t(-1, -3),
    findings: [
      { item: '显示器', result: 'DAMAGED', note: '屏幕右下角碎裂', amountFen: 30000 },
      { item: '主机', result: 'OK' },
      { item: '网络', result: 'OK' },
    ],
  });
  arena.endOrder(ob.id, { by: '前台B', now: t(-1) });
  const sb = arena.settleOrder(ob.id, { by: '前台B', now: t(-1) });

  // 订单 E：鼠标缺失，按价赔偿（押金不足部分补收）
  const oe = arena.createOrder({
    customerId: customer('C005').id,
    stationId: station('A07').id,
    kitId: kit('K1').id,
    planStart: t(-1, -20),
    planEnd: t(0, -20),
    by: '前台A',
  });
  arena.startOrder(oe.id, { by: '前台A', now: t(-1, -20) });
  const liveE = arena.lendAll(oe.id, { by: '前台A', now: t(-1, -20) });
  const mouse = liveE.peripherals.find((p) => p.p_type === 'MOUSE');
  arena.returnPeripheral(mouse.id, { scan: 'MISSING', note: '包内未找到鼠标', by: '前台B', now: t(-0, -22) });
  for (const p of liveE.peripherals.filter((x) => x.status === 'LENT' && x.id !== mouse.id)) {
    arena.returnPeripheral(p.id, { scan: 'OK', by: '前台B', now: t(-0, -21) });
  }
  arena.endOrder(oe.id, { by: '前台B', now: t(-0, -20) });
  const se = arena.settleOrder(oe.id, { by: '前台B', now: t(-0, -20) });

  // 订单 C：进行中（平面图细进度条演示；迟到 10 分钟）
  const oc = arena.createOrder({
    customerId: customer('C003').id,
    stationId: station('A05').id,
    kitId: kit('K1').id,
    planStart: t(0, -40),
    planEnd: t(2, 20),
    by: '前台A',
    note: '散客王浩然',
  });
  arena.startOrder(oc.id, { by: '前台A', now: t(0, -30) });
  arena.lendAll(oc.id, { by: '前台A', now: t(0, -30) });
  arena.addExtra(oc.id, { name: '柠檬茶', qty: 1, unitFen: 600, now });

  // 订单 D：已预订未开始（包机日历演示）
  const od = arena.createOrder({
    customerId: customer('C004').id,
    stationId: station('B01').id,
    kitId: kit('K2').id,
    planStart: t(2),
    planEnd: t(5),
    by: '前台B',
    note: '包厢五黑预约',
  });

  // 爽约样例
  const on = arena.createOrder({
    customerId: customer('C006').id,
    stationId: station('A09').id,
    kitId: kit('K1').id,
    planStart: t(-6),
    planEnd: t(-5),
    by: '前台A',
  });
  arena.markNoShow(on.id, { by: '前台A', now: t(-4, -50) });

  // 待处理开班巡检工单
  arena.createRoutineInspection(station('A02').id, { by: '值班经理', now, note: '每日开班巡检' });

  return { ids: { A: oa.id, B: ob.id, C: oc.id, D: od.id, E: oe.id, N: on.id }, settlements: { A: sa, B: sb, E: se } };
}

module.exports = { buildDemo, resetData };
