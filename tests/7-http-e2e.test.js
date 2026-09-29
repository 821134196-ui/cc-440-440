'use strict';

// HTTP 端到端：在独立端口起服务，走完整 API 流程，含并发开机与按名称匹配的巡检扣款。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = 39117;
const BASE = `http://127.0.0.1:${PORT}`;

async function api(p, opts = {}) {
  const actorCode = opts.actor === '前台B' ? 'B' : 'A';
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Actor': actorCode },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let serverProc;
let serverLog = '';

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-http-'));
  const dbFile = path.join(dir, 'http.db');
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ARENA_DB: dbFile, ARENA_NO_DEMO: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => (serverLog += d));
  serverProc.stderr.on('data', (d) => (serverLog += d));
  serverProc.on('exit', (code) => (serverLog += `\n[exit ${code}]`));
  // 等待端口就绪
  for (let i = 0; i < 100; i++) {
    try {
      const r = await api('/api/state');
      if (r.status === 200) return;
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`测试服务未在 10 秒内启动。日志：\n${serverLog}`);
});

test.after(() => {
  serverProc?.kill('SIGTERM');
});

test('HTTP 全链路：预订 → 双前台并发开机 → 出借 → 巡检外设损坏扣款 → 关机 → 结账幂等', async () => {
  const now = Date.now();
  const H = 3600000;

  // 选一个空闲机位与 K1 套装
  const { data: st } = await api('/api/state');
  const station = st.stations.find((s) => s.status === 'AVAILABLE' && !s.activeOrder);
  assert.ok(station);

  // 新开 1 小时包机（开始时间=现在）
  const created = await api('/api/orders', {
    method: 'POST',
    body: {
      customerId: 1, stationId: station.id, kitId: 1,
      planStart: now - 5 * 60000, planEnd: now + H,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const oid = created.data.id;

  // 双前台并发开机
  const [rA, rB] = await Promise.all([
    api(`/api/orders/${oid}/start`, { method: 'POST', actor: '前台A' }),
    api(`/api/orders/${oid}/start`, { method: 'POST', actor: '前台B' }),
  ]);
  const wins = [rA, rB].filter((r) => r.status === 200);
  const loses = [rA, rB].filter((r) => r.status !== 200);
  assert.equal(wins.length, 1);
  assert.equal(loses[0].status, 409);
  assert.equal(loses[0].data.error, 'ORDER_ALREADY_ACTIVE');

  // 一键出借
  const lent = await api(`/api/orders/${oid}/lend`, { method: 'POST' });
  assert.equal(lent.status, 200);
  assert.ok(lent.data.peripherals.every((p) => p.status === 'LENT'));

  // 创建故障后巡检并提交：耳机损坏（按名称匹配订单外设，自动扣款）
  const insp = await api(`/api/stations/${station.id}/inspections`, {
    method: 'POST',
    body: { orderId: oid, type: 'POST_INCIDENT', note: 'HTTP 巡检' },
  });
  assert.equal(insp.status, 201);
  const done = await api(`/api/inspections/${insp.data.id}/complete`, {
    method: 'POST',
    body: {
      findings: [
        { item: '键盘', result: 'OK' },
        { item: '鼠标', result: 'OK' },
        { item: '耳机', result: 'DAMAGED', note: '接口弯曲无声音' },
        { item: '显示器', result: 'OK' },
        { item: '主机', result: 'OK' },
        { item: '网络', result: 'OK' },
      ],
    },
  });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.created.length, 1);
  assert.equal(done.data.created[0].type, 'DEVICE_DAMAGE');
  assert.ok(done.data.created[0].amount > 0);

  // 剩余外设完好归还（耳机已由巡检交还）
  const order = (await api(`/api/orders/${oid}`)).data;
  for (const p of order.peripherals.filter((x) => x.status === 'LENT')) {
    const r = await api(`/api/order-peripherals/${p.id}/return`, { method: 'POST', body: { scan: 'OK' } });
    assert.equal(r.status, 200);
  }

  // 关机
  const ended = await api(`/api/orders/${oid}/end`, { method: 'POST' });
  assert.equal(ended.status, 200);

  // 结账
  const s1 = await api(`/api/orders/${oid}/settle`, { method: 'POST' });
  assert.equal(s1.status, 200);
  assert.equal(s1.data.duplicated, false);
  assert.ok(s1.data.settlement.deductions_fen > 0, '耳机损坏扣款应进入快照');
  const refundReceipt = s1.data.settlement.refund_receipt;

  // 重复结账幂等
  const s2 = await api(`/api/orders/${oid}/settle`, { method: 'POST', actor: '前台B' });
  assert.equal(s2.status, 200);
  assert.equal(s2.data.duplicated, true);
  assert.equal(s2.data.settlement.refund_receipt, refundReceipt);
});

test('HTTP 冲突：重叠机位下单返回 409 与冲突订单', async () => {
  const { data: st } = await api('/api/state');
  const station = st.stations.find((s) => s.status === 'AVAILABLE' && !s.activeOrder);
  const now = Date.now();
  const H = 3600000;
  await api('/api/orders', {
    method: 'POST',
    body: { customerId: 2, stationId: station.id, kitId: 1, planStart: now + 5 * H, planEnd: now + 7 * H },
  });
  const conflict = await api('/api/orders', {
    method: 'POST',
    body: { customerId: 3, stationId: station.id, kitId: 1, planStart: now + 6 * H, planEnd: now + 8 * H },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, 'STATION_CONFLICT');
  assert.ok(conflict.data.conflict.code);
});
