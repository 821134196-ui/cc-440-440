#!/usr/bin/env node
'use strict';

// 单条本地命令：node bin/demo.js
// 在 data/demo.db 生成包机、故障与结账样例，并打印结账复核摘要。

const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('../src/app');
const { buildDemo, resetData } = require('../src/demo-scenario');
const { seed } = require('../src/seed');

const M = 60_000;
const yuan = (fen) => `¥${(fen / 100).toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n);
const clock = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
const line = (c = '─') => console.log(c.repeat(72));

function resetDb(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(file + suffix);
    } catch {
      /* 忽略 */
    }
  }
}

function printSettle(title, r) {
  const b = JSON.parse(r.settlement.breakdown_json);
  const o = r.order;
  console.log(`【${title}】订单 ${o.code}  ${o.customer.name}  机位 ${o.station.code}`);
  console.log(
    `  计划 ${b.planMinutes} 分钟 · 实际计费用时 ${b.usedMinutes} 分钟` +
      (b.lateMinutes ? ` · 迟到 ${b.lateMinutes} 分钟（不补时）` : '') +
      (b.earlyMinutes ? ` · 提前结束 ${b.earlyMinutes} 分钟` : '')
  );
  if (b.compMinutes) {
    console.log(`  故障停机补偿 -${b.compMinutes} 分钟（${b.incidents.map((i) => i.code).join('、')}）`);
  }
  console.log(
    `  计费分钟 ${b.billableMinutes} → 包机费 ${yuan(b.rentalFen)} · 消费 ${yuan(b.extrasFen)} · 扣款 ${yuan(b.deductionsFen)}`
  );
  for (const d of b.deductions) {
    console.log(`    ↳ 扣款回链巡检 #${d.inspection_id}：${d.reason} ${yuan(d.amount_fen)}`);
  }
  console.log(
    `  押金 ${yuan(b.depositFen)} → 应收合计 ${yuan(b.totalDue)} · 补收 ${yuan(b.chargeFen)} · 退还 ${yuan(b.refundFen)}`
  );
  console.log(`  收款回执 ${r.settlement.pay_receipt || '—'}   退款回执 ${r.settlement.refund_receipt || '—'}`);
}

function main() {
  const dbFile = path.join(process.cwd(), 'data', 'demo.db');
  resetDb(dbFile);
  const { db, arena } = createApp(dbFile);

  const now = Date.now();
  line('═');
  console.log('电竞馆包机与外设交接系统 — 演示数据生成');
  console.log('当前时间：', new Date(now).toLocaleString('zh-CN', { hour12: false }));
  line('═');

  const { settlements } = buildDemo(arena, { now });
  const repeat = arena.settleOrder(settlements.A.order.id, { by: '前台B', now });

  line();
  console.log('一、订单台账');
  line();
  console.log(`${pad('订单号', 16)}${pad('顾客', 8)}${pad('机位', 6)}${pad('套装', 6)}状态        计划时段`);
  const statusText = {
    PENDING: '已预订', ACTIVE: '进行中', ENDED: '已关机',
    SETTLED: '已结账', NO_SHOW: '爽约', CANCELLED: '已取消',
  };
  const rows = db
    .prepare(
      `SELECT o.code, c.name customer, s.code station, k.code kit, o.status, o.plan_start ps, o.plan_end pe
       FROM orders o JOIN customers c ON c.id=o.customer_id
       JOIN stations s ON s.id=o.station_id JOIN kits k ON k.id=o.kit_id ORDER BY o.plan_start`
    )
    .all();
  for (const r of rows) {
    console.log(
      `${pad(r.code, 16)}${pad(r.customer, 8)}${pad(r.station, 6)}${pad(r.kit, 6)}${pad(statusText[r.status], 10)}  ${clock(r.ps)}–${clock(r.pe)}`
    );
  }

  line();
  console.log('二、结账复核（结算快照）');
  line();
  printSettle('A 迟到 + 网络中断补偿', settlements.A);
  console.log();
  printSettle('B 外设/设备损坏 + 提前结束', settlements.B);
  console.log();
  printSettle('E 外设缺失赔偿', settlements.E);
  console.log();
  console.log(
    `幂等复核：对 A 单重复结账 → duplicated=${repeat.duplicated}，` +
      `退款回执仍为 ${repeat.settlement.refund_receipt}（未产生第二笔退款）`
  );

  line();
  console.log('三、进行中订单（前台触控端平面图数据）');
  line();
  for (const s of arena.floorplan(now).filter((x) => x.activeOrder)) {
    const pct = Math.round(s.activeOrder.progress * 100);
    console.log(
      `${s.code} ${s.activeOrder.customerName}  剩余 ${Math.round(s.activeOrder.remainMs / M)} 分钟 ` +
        `[${'█'.repeat(pct / 5)}${'░'.repeat(20 - pct / 5)}] ${pct}%  ` +
        `${s.activeOrder.online ? '网络在线' : '网络中断'}`
    );
  }

  line();
  console.log('四、押金与支付流水');
  line();
  for (const p of db.prepare('SELECT * FROM payments ORDER BY id').all()) {
    console.log(`${pad(p.kind, 7)} ${yuan(p.amount_fen)}  回执 ${p.receipt_no}  幂等键 ${p.idempotency_key}`);
  }

  line();
  console.log('五、机位与授权');
  line();
  const maint = db.prepare("SELECT code, zone FROM stations WHERE status='MAINT'").all();
  console.log('维修中机位：', maint.map((x) => `${x.code}(${x.zone})`).join('、') || '无');
  const grants = arena.effectiveGrants(now).filter((g) => g.effective);
  console.log(
    '当前开放的账号授权：',
    grants.map((g) => `${g.account_code}@${g.station_code} 至 ${clock(g.closes_at)}`).join('；') || '无'
  );

  line('═');
  console.log('演示完成。启动触控端：npm start  （默认 http://localhost:3000）');
  line('═');
}

main();
