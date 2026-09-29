'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./src/app');
const { ArenaError } = require('./src/arena');
const { buildDemo, resetData } = require('./src/demo-scenario');
const { seed, EXTRAS_MENU } = require('./src/seed');

const PORT = Number(process.env.PORT || 3000);
const dbFile = process.env.ARENA_DB || path.join(process.cwd(), 'data', 'arena.db');
const app = createApp(dbFile);
const { arena } = app;

// 首次启动（库内无订单）自动生成包机/故障/结账演示场景（测试可用 ARENA_NO_DEMO=1 跳过）
if (!process.env.ARENA_NO_DEMO && arena.db.prepare('SELECT COUNT(*) c FROM orders').get().c === 0) {
  buildDemo(arena, { now: Date.now() });
}

const DAY = 86_400_000;
function dayRange(dateStr) {
  const d = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return [start, start + DAY];
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1_000_000) reject(new ArenaError('BAD_REQUEST', '请求体过大'));
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new ArenaError('BAD_REQUEST', 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });
}

const actorOf = (req, body = {}) => {
  // HTTP 头只能是 latin1：前端传 A/B 代号，也兼容 percent-encoded 中文
  const raw = req.headers['x-actor'];
  if (raw === 'A' || raw === 'B') return `前台${raw}`;
  if (raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return '前台A';
    }
  }
  return body.by || '前台A';
};

// ---------- 查询接口 ----------
route('GET', '/api/state', async (req, res, body, params) => {
  const now = Date.now();
  const stations = arena.floorplan(now);
  const stats = {
    all: stations.length,
    active: stations.filter((s) => s.activeOrder).length,
    available: stations.filter((s) => !s.activeOrder && s.status === 'AVAILABLE').length,
    maint: stations.filter((s) => s.status === 'MAINT').length,
    pendingOrders: arena.db.prepare("SELECT COUNT(*) c FROM orders WHERE status='PENDING'").get().c,
    openIncidents: arena.db.prepare("SELECT COUNT(*) c FROM incidents WHERE status='OPEN'").get().c,
    pendingInspections: arena.db.prepare("SELECT COUNT(*) c FROM inspections WHERE status='PENDING'").get().c,
  };
  sendJson(res, 200, { now, stations, stats });
});

route('GET', '/api/menu', async (req, res) => sendJson(res, 200, EXTRAS_MENU));

route('GET', '/api/orders', async (req, res) => {
  const rows = arena.db
    .prepare(
      `SELECT o.*, c.name customer_name, s.code station_code, k.name kit_name
       FROM orders o JOIN customers c ON c.id=o.customer_id
       JOIN stations s ON s.id=o.station_id JOIN kits k ON k.id=o.kit_id
       ORDER BY o.plan_start DESC LIMIT 100`
    )
    .all();
  sendJson(res, 200, rows);
});

route('GET', '/api/orders/(\\d+)', async (req, res, body, p) => {
  sendJson(res, 200, arena.getOrder(Number(p[0])));
});

route('GET', '/api/calendar', async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const [s, e] = dayRange(url.searchParams.get('date'));
  sendJson(res, 200, { dayStart: s, dayEnd: e, orders: arena.calendar(s, e) });
});

route('GET', '/api/grants', async (req, res) => {
  sendJson(res, 200, arena.effectiveGrants(Date.now()));
});

route('GET', '/api/inspections', async (req, res) => {
  const url = new URL(req.url, 'http://x');
  sendJson(res, 200, arena.listInspections(url.searchParams.get('status')));
});

route('GET', '/api/inspections/(\\d+)', async (req, res, body, p) => {
  const id = Number(p[0]);
  const inspection = arena.db
    .prepare(
      `SELECT i.*, s.code station_code, o.code order_code FROM inspections i
       JOIN stations s ON s.id=i.station_id LEFT JOIN orders o ON o.id=i.order_id WHERE i.id=?`
    )
    .get(id);
  if (!inspection) throw new ArenaError('INSP_NOT_FOUND', '巡检工单不存在');
  inspection.findings = arena.findingsOf(id);
  sendJson(res, 200, inspection);
});

// ---------- 订单操作 ----------
route('POST', '/api/orders', async (req, res, body) => {
  const o = arena.createOrder({
    customerId: Number(body.customerId),
    stationId: Number(body.stationId),
    kitId: Number(body.kitId),
    planStart: Number(body.planStart),
    planEnd: Number(body.planEnd),
    by: actorOf(req, body),
    note: body.note || '',
  });
  sendJson(res, 201, o);
});

route('POST', '/api/orders/(\\d+)/start', async (req, res, body, p) => {
  sendJson(res, 200, arena.startOrder(Number(p[0]), { by: actorOf(req, body) }));
});

route('POST', '/api/orders/(\\d+)/cancel', async (req, res, body, p) => {
  sendJson(res, 200, arena.cancelOrder(Number(p[0]), { by: actorOf(req, body), reason: body.reason }));
});

route('POST', '/api/orders/(\\d+)/noshow', async (req, res, body, p) => {
  sendJson(res, 200, arena.markNoShow(Number(p[0]), { by: actorOf(req, body) }));
});

route('POST', '/api/orders/(\\d+)/lend', async (req, res, body, p) => {
  sendJson(res, 200, arena.lendAll(Number(p[0]), { by: actorOf(req, body) }));
});

route('POST', '/api/orders/(\\d+)/end', async (req, res, body, p) => {
  sendJson(res, 200, arena.endOrder(Number(p[0]), { by: actorOf(req, body) }));
});

route('POST', '/api/orders/(\\d+)/settle', async (req, res, body, p) => {
  sendJson(res, 200, arena.settleOrder(Number(p[0]), { by: actorOf(req, body) }));
});

route('POST', '/api/orders/(\\d+)/extras', async (req, res, body, p) => {
  sendJson(
    res,
    200,
    arena.addExtra(Number(p[0]), {
      name: body.name,
      qty: Number(body.qty || 1),
      unitFen: Number(body.unitFen),
    })
  );
});

route('POST', '/api/orders/(\\d+)/network/open', async (req, res, body, p) => {
  sendJson(res, 200, arena.openNetworkIncident(Number(p[0]), { by: actorOf(req, body) }));
});

route('POST', '/api/incidents/(\\d+)/resolve', async (req, res, body, p) => {
  sendJson(res, 200, arena.resolveNetworkIncident(Number(p[0]), { by: actorOf(req, body) }));
});

route('POST', '/api/order-peripherals/(\\d+)/return', async (req, res, body, p) => {
  sendJson(
    res,
    200,
    arena.returnPeripheral(Number(p[0]), {
      scan: body.scan || 'OK',
      appearance: body.appearance || '',
      note: body.note || '',
      by: actorOf(req, body),
    })
  );
});

// ---------- 巡检 / 维修 ----------
route('POST', '/api/stations/(\\d+)/inspections', async (req, res, body, p) => {
  sendJson(
    res,
    201,
    arena.createRoutineInspection(Number(p[0]), {
      by: actorOf(req, body),
      note: body.note || '',
      orderId: body.orderId ? Number(body.orderId) : null,
      type: body.type || 'ROUTINE',
    })
  );
});

route('POST', '/api/inspections/(\\d+)/complete', async (req, res, body, p) => {
  sendJson(
    res,
    200,
    arena.completeInspection(Number(p[0]), {
      inspector: actorOf(req, body),
      findings: body.findings || [],
    })
  );
});

route('POST', '/api/stations/(\\d+)/repair', async (req, res, body, p) => {
  sendJson(res, 200, arena.repairStation(Number(p[0]), { by: actorOf(req, body) }));
});

// ---------- 管理 ----------
route('POST', '/api/admin/demo-reset', async (req, res) => {
  arena.tx(() => {
    resetData(arena.db);
    seed(arena.db);
  });
  const result = buildDemo(arena, { now: Date.now() });
  sendJson(res, 200, { ok: true, ...result });
});

// ---------- 静态资源 ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('未找到');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    const body = req.method === 'POST' ? await readBody(req) : {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (m) {
        const result = await r.handler(req, res, body, m.slice(1));
        // 简单 GET 路由直接返回领域对象
        if (result !== undefined && !res.writableEnded) sendJson(res, 200, result);
        return;
      }
    }
    // 直接返回列表的便捷路由
    if (req.method === 'GET') {
      const map = {
        '/api/customers': arena.listCustomers(),
        '/api/kits': arena.listKits(),
        '/api/peripherals': arena.listPeripherals(),
        '/api/accounts': arena.listAccounts(),
      };
      if (map[url.pathname]) return sendJson(res, 200, map[url.pathname]);
    }
    sendJson(res, 404, { error: 'NOT_FOUND', message: '接口不存在' });
  } catch (e) {
    if (e instanceof ArenaError) {
      const notFound = ['ORDER_NOT_FOUND', 'STATION_NOT_FOUND', 'CUSTOMER_NOT_FOUND', 'KIT_NOT_FOUND',
        'INSP_NOT_FOUND', 'INCIDENT_NOT_FOUND', 'ITEM_NOT_FOUND'];
      const badRequest = ['BAD_TIME', 'BAD_REQUEST', 'NO_FINDINGS'];
      const status = notFound.includes(e.code) ? 404 : badRequest.includes(e.code) ? 400 : 409;
      sendJson(res, status, {
        error: e.code,
        message: e.message,
        ...(e.conflict ? { conflict: e.conflict } : {}),
      });
    } else {
      console.error(e);
      sendJson(res, 500, { error: 'INTERNAL', message: e.message });
    }
  }
});

server.listen(PORT, () => {
  console.log(`电竞馆包机系统已启动：http://localhost:${PORT}`);
  console.log(`数据库：${dbFile}`);
});

module.exports = { server };
