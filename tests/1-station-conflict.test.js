'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memApp, cleanup, H } = require('./helpers');

test('同一机位：重叠时段拒绝，首尾相接（半开区间）允许', () => {
  const app = memApp();
  const { arena } = app;
  const o1 = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1,
    planStart: 12 * H, planEnd: 14 * H, by: '前台A',
  });
  assert.ok(o1.id);

  assert.throws(
    () =>
      arena.createOrder({
        customerId: 2, stationId: 1, kitId: 1,
        planStart: 13 * H, planEnd: 15 * H, by: '前台A',
      }),
    (e) => e.code === 'STATION_CONFLICT'
  );

  // 10:00–12:00 与 12:00–14:00 不重叠
  const before = arena.createOrder({
    customerId: 2, stationId: 1, kitId: 1,
    planStart: 10 * H, planEnd: 12 * H, by: '前台A',
  });
  assert.ok(before.id);

  // 14:00–16:00 也不重叠
  const after = arena.createOrder({
    customerId: 3, stationId: 1, kitId: 1,
    planStart: 14 * H, planEnd: 16 * H, by: '前台A',
  });
  assert.ok(after.id);

  cleanup(app);
});

test('已结束订单只占用到 actual_end，之后可重新预订该机位', () => {
  const app = memApp();
  const { arena } = app;
  // 12:00–14:00 的订单 13:00 提前关机
  const o = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1,
    planStart: 12 * H, planEnd: 14 * H,
  });
  arena.startOrder(o.id, { now: 12 * H });
  arena.lendAll(o.id, { now: 12 * H });
  for (const p of arena.getOrder(o.id).peripherals) {
    arena.returnPeripheral(p.id, { scan: 'OK', now: 13 * H });
  }
  arena.endOrder(o.id, { now: 13 * H });

  // 13:30 开始的新订单可以落到同一机位
  const next = arena.createOrder({
    customerId: 2, stationId: 1, kitId: 1,
    planStart: 13 * H + 1800000, planEnd: 15 * H,
  });
  assert.ok(next.id);

  // 但 12:30–13:30 仍然与实际占用冲突
  assert.throws(
    () =>
      arena.createOrder({
        customerId: 3, stationId: 1, kitId: 1,
        planStart: 12 * H + 1800000, planEnd: 13 * H + 1800000,
      }),
    (e) => e.code === 'STATION_CONFLICT'
  );
  cleanup(app);
});

test('取消/爽约后释放机位，可立即被新订单占用', () => {
  const app = memApp();
  const { arena } = app;
  const o = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1,
    planStart: 20 * H, planEnd: 22 * H,
  });
  arena.cancelOrder(o.id, { reason: '改期' });
  const again = arena.createOrder({
    customerId: 2, stationId: 1, kitId: 1,
    planStart: 20 * H, planEnd: 22 * H,
  });
  assert.ok(again.id);
  cleanup(app);
});
