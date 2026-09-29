'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memApp, cleanup, H, M } = require('./helpers');

test('账号授权只在有效时段内开放：未开机 PLANNED 无效，到点自动 EXPIRED', () => {
  const app = memApp();
  const { arena } = app;
  const start = 10 * H;
  const end = start + 2 * H;
  const o = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1,
    planStart: start, planEnd: end,
  });

  // 预订后授权是 PLANNED，不开放
  const planned = arena.db.prepare("SELECT * FROM account_grants WHERE order_id=?").all(o.id);
  assert.ok(planned.length >= 1);
  assert.ok(planned.every((g) => g.status === 'PLANNED'));

  // 迟到 30 分钟开机：授权开放，关闭时间仍是计划结束（不因为迟到顺延）
  arena.startOrder(o.id, { now: start + 30 * M });
  let grants = arena.effectiveGrants(start + 60 * M);
  let mine = grants.filter((g) => g.order_id === o.id);
  assert.ok(mine.length >= 1);
  assert.ok(mine.every((g) => g.effective && g.status === 'ACTIVE'));
  assert.ok(mine.every((g) => g.closes_at === end));

  // 到点（含恰好 closes_at 边界）授权失效并转为 EXPIRED
  arena.expireGrants(end);
  const expiredRows = arena.db.prepare('SELECT * FROM account_grants WHERE order_id=?').all(o.id);
  assert.ok(expiredRows.length >= 1);
  assert.ok(expiredRows.every((g) => g.status === 'EXPIRED'));
  assert.ok(expiredRows.every((g) => !arena.grantEffective(g, end)));

  // 到期后有效授权列表里不再有该订单
  const anyEffective = arena.effectiveGrants(end + M).some((g) => g.order_id === o.id && g.effective);
  assert.equal(anyEffective, false);
  cleanup(app);
});

test('提前结束立即吊销授权，不必等到关闭时间', () => {
  const app = memApp();
  const { arena } = app;
  const start = 10 * H;
  const end = start + 3 * H;
  const o = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: start, planEnd: end,
  });
  arena.startOrder(o.id, { now: start });
  arena.lendAll(o.id, { now: start });
  for (const p of arena.getOrder(o.id).peripherals) {
    arena.returnPeripheral(p.id, { scan: 'OK', now: start + H });
  }
  arena.endOrder(o.id, { now: start + H });

  const grants = arena.db.prepare('SELECT * FROM account_grants WHERE order_id=?').all(o.id);
  assert.ok(grants.every((g) => g.status === 'REVOKED'));
  assert.ok(arena.effectiveGrants(start + H + M).every((g) => g.order_id !== o.id));
  cleanup(app);
});

test('同一账号在重叠时段不能授权给两个订单（同账号同刻只允许一个 ACTIVE）', () => {
  const app = memApp();
  const { arena } = app;
  // K1 与 K2 没有共享账号；给 K2 增加一个 K1 的账号制造冲突
  const acc = arena.db.prepare("SELECT id FROM accounts WHERE code='STEAM-01'").get().id;
  arena.db.prepare('INSERT OR IGNORE INTO kit_accounts (kit_id, account_id) VALUES (2,?)').run(acc);

  arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: 10 * H, planEnd: 12 * H,
  });
  assert.throws(
    () =>
      arena.createOrder({
        customerId: 2, stationId: 2, kitId: 2, planStart: 11 * H, planEnd: 13 * H,
      }),
    (e) => e.code === 'ACCOUNT_CONFLICT'
  );

  // 不重叠则允许
  const ok = arena.createOrder({
    customerId: 2, stationId: 2, kitId: 2, planStart: 12 * H, planEnd: 13 * H,
  });
  assert.ok(ok.id);
  cleanup(app);
});
