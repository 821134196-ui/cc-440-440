'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { memApp, fileApp, cleanup, H } = require('./helpers');

function runWorker(payload) {
  return new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, 'workers', 'start-worker.js'), { workerData: payload });
    w.on('message', resolve);
    w.on('error', (err) => resolve({ ok: false, code: 'WORKER_ERROR', message: err.message }));
  });
}

test('同一件外设不能同时出借给两个订单：部分唯一索引保证 LENT 唯一', () => {
  const app = memApp();
  const { arena, db } = app;
  const t0 = 10 * H;
  const o1 = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: t0, planEnd: t0 + 2 * H,
  });
  arena.startOrder(o1.id, { now: t0 });
  arena.lendAll(o1.id, { now: t0 });

  // 同机位不同时间不会撞，直接构造另一条 LENT 记录验证数据库约束：
  // 取 o1 已借出的一件外设，再给同一订单插一条 LENT 必须被部分唯一索引拒绝
  const lent = db
    .prepare("SELECT peripheral_id FROM order_peripherals WHERE order_id=? AND status='LENT' LIMIT 1")
    .get(o1.id);
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO order_peripherals (order_id, peripheral_id, status) VALUES (?, ?, 'LENT')")
        .run(o1.id, lent.peripheral_id),
    /UNIQUE|constraint/i
  );

  // 通过领域接口归还全部
  for (const p of arena.getOrder(o1.id).peripherals.filter((x) => x.status === 'LENT')) {
    arena.returnPeripheral(p.id, { scan: 'OK', now: t0 + H });
  }
  const pstatus = db.prepare('SELECT status FROM peripherals WHERE id=?').get(lent.peripheral_id);
  assert.equal(pstatus.status, 'AVAILABLE');

  // 后续订单在不与 o1 时段重叠时可以选到同一件外设
  const o2 = arena.createOrder({
    customerId: 2, stationId: 2, kitId: 1, planStart: t0 + 3 * H, planEnd: t0 + 5 * H,
  });
  const reserved = db
    .prepare('SELECT peripheral_id FROM order_peripherals WHERE order_id=? AND status=\'RESERVED\'')
    .all(o2.id)
    .map((r) => r.peripheral_id);
  assert.ok(reserved.includes(lent.peripheral_id), '归还后的外设应可被后续订单锁定');
  cleanup(app);
});

test('两个订单的外设锁定互不重叠（RESERVED 时段冲突检测）', () => {
  const app = memApp();
  const { arena, db } = app;
  // 本用例只验证外设分配唯一性：账号授权由其他用例覆盖，先解除套装-账号绑定
  db.exec('DELETE FROM kit_accounts');
  const t0 = 10 * H;
  // A01、A02 同时段各下一单 K1：系统自动分配不同编号外设
  const o1 = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: t0, planEnd: t0 + 2 * H,
  });
  const o2 = arena.createOrder({
    customerId: 2, stationId: 2, kitId: 1, planStart: t0, planEnd: t0 + 2 * H,
  });
  const p1 = db
    .prepare('SELECT peripheral_id FROM order_peripherals WHERE order_id=?')
    .all(o1.id)
    .map((r) => r.peripheral_id);
  const p2 = db
    .prepare('SELECT peripheral_id FROM order_peripherals WHERE order_id=?')
    .all(o2.id)
    .map((r) => r.peripheral_id);
  assert.equal(p1.length, 3);
  assert.equal(p2.length, 3);
  for (const id of p1) assert.ok(!p2.includes(id), `外设 ${id} 被两个订单同时锁定`);
  cleanup(app);
});

test('外设库存不足时下单整体回滚，不留下半个订单', () => {
  const app = memApp();
  const { arena, db } = app;
  db.exec('DELETE FROM kit_accounts'); // 本用例只压测外设库存
  const t0 = 10 * H;
  // K1 每类只需 1 件；库存键盘共 8 个。连续占用 8 个机位后，第 9 单应整体失败
  const stations = db.prepare('SELECT id FROM stations ORDER BY id LIMIT 9').all();
  let success = 0;
  for (let i = 0; i < 8; i++) {
    arena.createOrder({
      customerId: 1 + (i % 6), stationId: stations[i].id, kitId: 1,
      planStart: t0, planEnd: t0 + 2 * H,
    });
    success++;
  }
  assert.equal(success, 8);
  assert.throws(
    () =>
      arena.createOrder({
        customerId: 2, stationId: stations[8].id, kitId: 1,
        planStart: t0, planEnd: t0 + 2 * H,
      }),
    (e) => e.code === 'PERIPHERAL_SHORTAGE'
  );
  // 第 9 单不应残留订单/押金/授权/预留外设
  assert.equal(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 8);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM deposits').get().c, 8);
  cleanup(app);
});

test('并发出借同一预留外设：数据库部分唯一索引只允许一个 LENT', async () => {
  const app = fileApp();
  const { arena } = app;
  const t0 = 20 * H;
  const o1 = arena.createOrder({
    customerId: 1, stationId: 1, kitId: 1, planStart: t0, planEnd: t0 + 2 * H,
  });
  arena.startOrder(o1.id, { now: t0 });

  // 用两个独立连接同时尝试把同一外设置为 LENT（该外设已有 RESERVED 行）
  const row = arena.db
    .prepare('SELECT peripheral_id FROM order_peripherals WHERE order_id=? LIMIT 1')
    .get(o1.id);
  const tries = await Promise.all(
    [1, 2].map(
      () =>
        new Promise((resolve) => {
          const w = new Worker(
            `
            const { parentPort, workerData } = require('node:worker_threads');
            const { createApp } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'app'))});
            const app = createApp(workerData.dbPath);
            try {
              app.db.exec('BEGIN IMMEDIATE');
              app.db.prepare("INSERT INTO order_peripherals (order_id, peripheral_id, status) VALUES (?, ?, 'LENT')").run(workerData.oid, workerData.pid);
              app.db.exec('COMMIT');
              parentPort.postMessage({ ok: true });
            } catch (e) {
              try { app.db.exec('ROLLBACK'); } catch {}
              parentPort.postMessage({ ok: false, code: String(e.code || e.message) });
            }
            process.exit(0);
          `,
            { eval: true, workerData: { dbPath: app.file, pid: row.peripheral_id, oid: o1.id } }
          );
          w.on('message', resolve);
          w.on('error', (e) => resolve({ ok: false, code: e.message }));
        })
    )
  );
  assert.equal(tries.filter((t) => t.ok).length, 1);
  cleanup(app);
});
