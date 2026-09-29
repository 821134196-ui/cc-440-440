'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createApp } = require('../../src/app');

try {
  const app = createApp(workerData.dbPath);
  const order = app.arena.startOrder(workerData.orderId, {
    by: workerData.actor,
    now: workerData.now,
  });
  parentPort.postMessage({ ok: true, actor: workerData.actor, startedBy: order.started_by });
} catch (e) {
  parentPort.postMessage({ ok: false, actor: workerData.actor, code: e.code, message: e.message });
}
process.exit(0);
