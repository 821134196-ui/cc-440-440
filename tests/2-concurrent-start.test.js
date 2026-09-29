'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { fileApp, cleanup, H } = require('./helpers');

function runWorker(file, payload) {
  return new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, 'workers', file), { workerData: payload });
    w.on('message', (msg) => resolve(msg));
    w.on('error', (err) => resolve({ ok: false, code: 'WORKER_ERROR', message: err.message }));
  });
}

test('两名前台同时开机同一订单：只有一次成功（跨连接真实并发）', async () => {
  const app = fileApp();
  const { arena } = app;
  const now = 10 * H;
  const order = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1,
    planStart: now, planEnd: now + 2 * H, by: '前台A',
  });

  const barrier = Date.now();
  const [a, b] = await Promise.all([
    runWorker('start-worker.js', { dbPath: app.file, orderId: order.id, actor: '前台A', now: barrier }),
    runWorker('start-worker.js', { dbPath: app.file, orderId: order.id, actor: '前台B', now: barrier }),
  ]);

  const wins = [a, b].filter((r) => r.ok);
  const loses = [a, b].filter((r) => !r.ok);
  assert.equal(wins.length, 1, `应有且仅有一次开机成功，实际 ${wins.length}`);
  assert.equal(loses.length, 1);
  assert.equal(loses[0].code, 'ORDER_ALREADY_ACTIVE');

  const fresh = arena.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.equal(fresh.status, 'ACTIVE');
  assert.ok(['前台A', '前台B'].includes(fresh.started_by));
  assert.equal(fresh.started_by, wins[0].actor);

  // 第三个开机请求同样被拒绝
  const third = await runWorker('start-worker.js', {
    dbPath: app.file, orderId: order.id, actor: '前台C', now: barrier,
  });
  assert.equal(third.ok, false);
  assert.equal(third.code, 'ORDER_ALREADY_ACTIVE');

  cleanup(app);
});

test('同进程内连续两次开机：第二次失败且订单不被重复修改', () => {
  const app = fileApp();
  const { arena } = app;
  const now = 10 * H;
  const order = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1,
    planStart: now, planEnd: now + 2 * H,
  });
  const first = arena.startOrder(order.id, { by: '前台A', now });
  assert.equal(first.status, 'ACTIVE');
  assert.throws(
    () => arena.startOrder(order.id, { by: '前台B', now: now + 1000 }),
    (e) => e.code === 'ORDER_ALREADY_ACTIVE'
  );
  const row = arena.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
  assert.equal(row.started_by, '前台A');
  assert.equal(row.late_minutes, 0);
  cleanup(app);
});
