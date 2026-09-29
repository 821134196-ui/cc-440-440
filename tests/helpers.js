'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const H = 3600_000;
const M = 60_000;

function memApp() {
  return createApp(':memory:');
}

function fileApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-test-'));
  const file = path.join(dir, 'test.db');
  return { ...createApp(file), file, dir };
}

function cleanup(app) {
  app.db.close();
  if (app.dir) fs.rmSync(app.dir, { recursive: true, force: true });
}

function ids(arena) {
  const get = (sql) => arena.db.prepare(sql).get().id;
  return {
    customer: (code) => get(`SELECT id FROM customers WHERE code='${code}'`),
    station: (code) => get(`SELECT id FROM stations WHERE code='${code}'`),
    kit: (code) => get(`SELECT id FROM kits WHERE code='${code}'`),
  };
}

// 创建并走完一单：默认 12:00–14:00，可覆盖
async function bookedOrder(arena, q = {}) {
  const u = ids(arena);
  const now = q.now ?? 0;
  return arena.createOrder({
    customerId: q.customer ?? u.customer('C003'),
    stationId: q.station ?? u.station('A01'),
    kitId: q.kit ?? u.kit('K1'),
    planStart: q.start ?? now,
    planEnd: q.end ?? now + 2 * H,
    by: q.by ?? '前台A',
    note: q.note ?? '',
  });
}

module.exports = { memApp, fileApp, cleanup, ids, H, M };
