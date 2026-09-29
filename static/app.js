/* 霓虹电竞馆 · 包机管理台前端(原生 JS, 触控优先) */
"use strict";

const $ = (sel) => document.querySelector(sel);
const main = $("#main");

const fmtMoney = (c) => (c < 0 ? "-¥" : "¥") + (Math.abs(c) / 100).toFixed(2);
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "--";
const fmtDT = (iso) => iso ? new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "--";
const fmtMin = (sec) => {
  const m = Math.ceil(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}小时${m % 60 ? (m % 60) + "分" : ""}` : `${m} 分钟`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function req(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `请求失败(${r.status})`);
  return j;
}
const api = {
  get: (p) => req("GET", p),
  post: (p, b) => req("POST", p, b || {}),
};

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}
async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

/* ---------------- 单层操作面板 ---------------- */
function openSheet(html) {
  $("#sheet").innerHTML = html + "";
  $("#sheet-mask").classList.remove("hidden");
}
function closeSheet() {
  $("#sheet-mask").classList.add("hidden");
  $("#sheet").innerHTML = "";
}
$("#sheet-mask").addEventListener("click", (e) => {
  if (e.target.id === "sheet-mask") closeSheet();
});

/* ---------------- 全局状态 ---------------- */
const App = {
  view: "floor",
  cache: {},
  returns: {},      // 外设归还清单状态 {peripheral_id: {condition, appearance}}
  refundKeys: {},   // 结算单 -> 幂等键(幂等演示用)
};
window.App = App;

const ORDER_STATUS = {
  reserved: ["待开机", "yellow"], active: ["进行中", "cyan"], ended: ["待结算", "yellow"],
  settled: ["已结账", "green"], cancelled: ["已取消", ""],
};
const PERI_STATUS = { available: "在库", lent: "借出", maintenance: "维修", missing: "缺失" };
const PERI_TYPE = { keyboard: "键盘", mouse: "鼠标", headset: "耳机" };
const GRANT_STATUS = { pending: ["未开始", "yellow"], active: ["有效", "cyan"], expired: ["已过期", ""], revoked: ["已回收", ""] };

/* ================= 机位平面图 ================= */
async function renderFloor() {
  const [seats, events] = await Promise.all([api.get("/api/state"), api.get("/api/events")]);
  App.cache.seats = seats;
  const zones = {};
  seats.forEach((s) => (zones[s.zone] = zones[s.zone] || []).push(s));

  let html = `
    <div class="legend">
      <span><i style="background:var(--panel)"></i>空闲</span>
      <span><i style="background:var(--cyan)"></i>进行中</span>
      <span><i style="background:var(--yellow)"></i>即将开始</span>
      <span><i style="background:var(--red)"></i>维护中</span>
      <span class="muted">点击机位进行操作</span>
    </div>`;

  for (const [zone, list] of Object.entries(zones)) {
    html += `<div class="zone-name">${esc(zone)} · ${fmtMoney(list[0].hourly_price_cents)}/小时</div><div class="seat-grid">`;
    for (const s of list) {
      let cls = "st-idle", status = "空闲", extra = "", bar = "";
      if (s.status === "maintenance") {
        cls = "st-maint"; status = "维护中";
      } else if (s.active_order) {
        cls = "st-active";
        const low = s.active_order.remaining_sec < 15 * 60;
        status = `进行中 · ${esc(s.active_order.customer_name)}`;
        extra = `<div class="seat-remain ${low ? "low" : ""}">剩余 ${fmtMin(s.active_order.remaining_sec)}</div>`;
        bar = `<div class="bar"><i class="${low ? "low" : ""}" style="width:${(s.active_order.progress * 100).toFixed(1)}%"></i></div>`;
      } else if (s.next_order) {
        cls = "st-next";
        status = `${fmtTime(s.next_order.start_at)} ${esc(s.next_order.customer_name)}`;
      }
      const net = s.net && s.net.link === false ? `<span class="net-dot down" title="网络中断"></span>` : `<span class="net-dot" title="网络正常"></span>`;
      html += `
        <div class="seat ${cls}" onclick="App.openSeat(${s.id})">
          <div class="seat-code">${net}${esc(s.code)}</div>
          <div class="seat-status">${status}</div>
          ${extra}
          <div class="seat-meta">${esc(s.specs)}</div>
          ${bar}
        </div>`;
    }
    html += `</div>`;
  }

  html += `<div class="events"><div class="section-title">设备回执流水</div>`;
  for (const e of events.slice(0, 8)) {
    html += `<div class="event-line"><span class="ts">${fmtTime(e.ts)}</span><span class="kind">${esc(e.kind)}</span><span>${esc(e.message)}</span></div>`;
  }
  html += `</div>`;
  main.innerHTML = html;
}

App.openSeat = async function (seatId) {
  const s = (App.cache.seats || []).find((x) => x.id === seatId);
  if (!s) return;
  let body = `<div class="sheet-title">机位 ${esc(s.code)} <button class="sheet-close" onclick="App.closeSheet()">✕</button></div>
    <div class="muted" style="margin:6px 0 14px">${esc(s.zone)} · ${fmtMoney(s.hourly_price_cents)}/小时 · ${esc(s.specs)}</div>`;
  let actions = "";

  if (s.active_order) {
    const o = await api.get(`/api/orders/${s.active_order.id}`);
    body += `<div class="money-lines">
      <div class="money-line"><span class="k">订单</span><span class="v">${esc(o.code)} · ${esc(o.customer_name)}</span></div>
      <div class="money-line"><span class="k">时段</span><span class="v mono">${fmtTime(o.start_at)} – ${fmtTime(o.end_at)}</span></div>
      <div class="money-line"><span class="k">外设套装</span><span class="v">${esc(o.kit_name)}(${o.loans.length} 件)</span></div>
    </div>`;
    actions = `
      <button class="btn btn-primary" onclick="App.openReturnSheet(${o.id})">外设归还并结束</button>
      <button class="btn btn-yellow" onclick="App.openFaultSheet(${s.id}, ${o.id})">报故障</button>`;
  } else if (s.status === "maintenance") {
    body += `<p class="muted">该机位维护中, 可创建巡检/故障工单跟进。</p>`;
    actions = `<button class="btn btn-yellow" onclick="App.openFaultSheet(${s.id}, null)">报故障</button>`;
  } else if (s.next_order) {
    const o = await api.get(`/api/orders/${s.next_order.id}`);
    body += `<div class="money-lines">
      <div class="money-line"><span class="k">下一单</span><span class="v">${esc(o.code)} · ${esc(o.customer_name)}</span></div>
      <div class="money-line"><span class="k">预约时段</span><span class="v mono">${fmtTime(o.start_at)} – ${fmtTime(o.end_at)}</span></div>
      <div class="money-line"><span class="k">押金</span><span class="v">${fmtMoney(o.deposit_cents)}</span></div>
    </div>`;
    actions = `
      <button class="btn btn-primary" onclick="App.startOrder(${o.id})">开机</button>
      <button class="btn btn-danger" onclick="App.cancelOrder(${o.id})">取消预约</button>`;
  } else {
    body += `<p class="muted">机位空闲, 可前往「包机日历」新建包机。</p>`;
    actions = `<button class="btn btn-primary" onclick="App.closeSheet(); App.switchView('calendar')">新建包机</button>`;
  }
  openSheet(body + `<div class="sheet-actions">${actions}</div>`);
};

App.closeSheet = closeSheet;

App.startOrder = async function (orderId) {
  const r = await run(() => api.post(`/api/orders/${orderId}/start`), "已开机, 账号授权生效");
  if (r) { closeSheet(); refresh(); }
};

App.cancelOrder = async function (orderId) {
  const r = await run(() => api.post(`/api/orders/${orderId}/cancel`), "预约已取消");
  if (r) { closeSheet(); refresh(); }
};

/* ---------- 外设交接: 编号清单 ---------- */
App.openReturnSheet = async function (orderId) {
  const o = await api.get(`/api/orders/${orderId}`);
  App.returns = {};
  const items = o.loans.filter((l) => !l.checked_in_at);
  items.forEach((l) => (App.returns[l.peripheral_id] = { condition: "ok", appearance: "与出借一致" }));

  let html = `<div class="sheet-title">外设归还 · ${esc(o.code)} <button class="sheet-close" onclick="App.closeSheet()">✕</button></div>
    <div class="muted" style="margin:6px 0 4px">逐项核对编号与外观, 选择归还状态</div>
    <ol class="checklist">`;
  items.forEach((l, i) => {
    html += `
      <li class="check-item">
        <div class="check-head">
          <span class="item-no">${i + 1}</span>
          <span class="serial">${esc(l.serial)}</span>
          <span>${esc(l.model)}(${PERI_TYPE[l.type] || l.type})</span>
        </div>
        <div class="muted" style="font-size:14px">出借外观: ${esc(l.appearance_out || "外观完好")}</div>
        <div class="seg" data-pid="${l.peripheral_id}">
          <button class="on-ok" onclick="App.setCond(${l.peripheral_id}, 'ok', this)">完好</button>
          <button onclick="App.setCond(${l.peripheral_id}, 'damaged', this)">损坏</button>
          <button onclick="App.setCond(${l.peripheral_id}, 'missing', this)">缺失</button>
        </div>
        <input placeholder="归还外观备注" value="与出借一致"
               onchange="App.setAppearance(${l.peripheral_id}, this.value)">
      </li>`;
  });
  html += `</ol>
    <div class="sheet-actions">
      <button class="btn btn-primary" onclick="App.finishOrder(${o.id})">确认归还并结束订单</button>
    </div>`;
  openSheet(html);
};

App.setCond = function (pid, cond, btn) {
  App.returns[pid].condition = cond;
  const seg = btn.closest(".seg");
  seg.querySelectorAll("button").forEach((b) => (b.className = ""));
  btn.className = "on-" + cond;
};
App.setAppearance = function (pid, val) {
  App.returns[pid].appearance = val;
};

App.finishOrder = async function (orderId) {
  const returns = Object.entries(App.returns).map(([pid, r]) => ({
    peripheral_id: Number(pid), condition: r.condition, appearance: r.appearance,
  }));
  const r = await run(async () => {
    const o = await api.post(`/api/orders/${orderId}/end`, { returns });
    const bad = o.loans.filter((l) => l.condition_in && l.condition_in !== "ok");
    if (bad.length) toast(`已结束; ${bad.length} 件外设异常, 已生成结账检查工单`);
    else toast("订单已结束, 外设全部完好归还");
    return o;
  });
  if (r) { closeSheet(); refresh(); }
};

/* ---------- 故障 ---------- */
App.openFaultSheet = function (seatId, orderId) {
  openSheet(`
    <div class="sheet-title">上报故障 <button class="sheet-close" onclick="App.closeSheet()">✕</button></div>
    <div class="form-grid" style="margin-top:14px">
      <label class="field">故障类型
        <select id="fault-type">
          <option value="network">网络中断</option>
          <option value="hardware">硬件故障</option>
          <option value="peripheral">外设故障</option>
        </select>
      </label>
      <label class="field">故障描述
        <input id="fault-desc" placeholder="例如: 对局中掉线 / 键盘失灵">
      </label>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-yellow" onclick="App.submitFault(${seatId}, ${orderId === null ? "null" : orderId})">提交故障工单</button>
    </div>`);
};

App.submitFault = async function (seatId, orderId) {
  const body = {
    seat_id: seatId,
    order_id: orderId,
    type: $("#fault-type").value,
    description: $("#fault-desc").value.trim(),
  };
  const r = await run(() => api.post("/api/faults", body), "故障工单已创建, 停机时间将计入补偿");
  if (r) { closeSheet(); refresh(); }
};

/* ================= 包机日历 ================= */
const CAL_H0 = 8, CAL_H1 = 24;

async function renderCalendar() {
  const [orders, seats, customers, kits, accounts] = await Promise.all([
    api.get("/api/orders"), api.get("/api/seats"), api.get("/api/customers"),
    api.get("/api/kits"), api.get("/api/accounts"),
  ]);
  App.cache.seatList = seats;

  const now = new Date();
  const toLocal = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const start0 = new Date(now.getTime() + (30 - (now.getMinutes() % 30)) * 60000);
  const end0 = new Date(start0.getTime() + 2 * 3600 * 1000);

  let html = `
    <div class="card">
      <div class="section-title" style="margin-top:0">新建包机</div>
      <div class="form-grid">
        <label class="field">顾客
          <select id="nb-customer">${customers.map((c) => `<option value="${c.id}">${esc(c.name)} ${esc(c.phone)}</option>`).join("")}</select>
        </label>
        <label class="field">机位
          <select id="nb-seat">${seats.filter((s) => s.status !== "maintenance").map((s) => `<option value="${s.id}">${esc(s.code)} · ${esc(s.zone)} · ${fmtMoney(s.hourly_price_cents)}/时</option>`).join("")}</select>
        </label>
        <label class="field">外设套装
          <select id="nb-kit">${kits.map((k) => `<option value="${k.id}">${esc(k.name)} · 押金 ${fmtMoney(k.deposit_cents)}</option>`).join("")}</select>
        </label>
        <label class="field">开始时间
          <input id="nb-start" type="datetime-local" value="${toLocal(start0)}">
        </label>
        <label class="field">结束时间
          <input id="nb-end" type="datetime-local" value="${toLocal(end0)}">
        </label>
      </div>
      <div style="margin:12px 0 6px" class="muted">游戏账号授权(只在包机时段内开放)</div>
      <div class="chips" id="nb-accounts">
        ${accounts.map((a) => `<button class="chip" data-aid="${a.id}" onclick="this.classList.toggle('on')">${esc(a.game)} · ${esc(a.login_name)}</button>`).join("")}
      </div>
      <div class="sheet-actions">
        <button class="btn btn-primary" onclick="App.createOrder()">创建包机订单</button>
      </div>
    </div>

    <div class="section-title">今日包机日历</div>
    <div class="card cal-scroll"><div class="calendar">
      <div class="cal-axis"><div></div><div class="hours">${Array.from({ length: 5 }, (_, i) => `<span>${CAL_H0 + i * 4}:00</span>`).join("")}</div></div>`;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const s of seats) {
    html += `<div class="cal-row"><div class="cal-seat">${esc(s.code)}</div><div class="cal-track">`;
    for (const o of orders.filter((x) => x.seat_id === s.id)) {
      const st = new Date(o.start_at), en = new Date(o.end_at);
      if (en < today || st > new Date(today.getTime() + 86400000)) continue;
      const h0 = CAL_H0, span = CAL_H1 - CAL_H0;
      const left = Math.max(0, Math.min(100, ((st.getHours() + st.getMinutes() / 60 - h0) / span) * 100));
      const right = Math.max(0, Math.min(100, ((en.getHours() + en.getMinutes() / 60 - h0) / span) * 100));
      if (right <= 0 || left >= 100) continue;
      html += `<div class="cal-bar ${o.status}" style="left:${left}%;width:${Math.max(3, right - left)}%"
        title="${esc(o.code)} ${esc(o.customer_name)}"
        onclick="App.openOrder(${o.id})">${fmtTime(o.start_at)} ${esc(o.customer_name)}</div>`;
    }
    html += `</div></div>`;
  }
  html += `</div></div>`;
  main.innerHTML = html;
}

App.createOrder = async function () {
  const aids = [...document.querySelectorAll("#nb-accounts .chip.on")].map((c) => Number(c.dataset.aid));
  const body = {
    customer_id: Number($("#nb-customer").value),
    seat_id: Number($("#nb-seat").value),
    kit_id: Number($("#nb-kit").value),
    account_ids: aids,
    start_at: new Date($("#nb-start").value).toISOString(),
    end_at: new Date($("#nb-end").value).toISOString(),
  };
  const r = await run(() => api.post("/api/orders", body), "包机订单已创建");
  if (r) refresh();
};

App.openOrder = async function (orderId) {
  const o = await api.get(`/api/orders/${orderId}`);
  const [label, color] = ORDER_STATUS[o.status] || [o.status, ""];
  let html = `<div class="sheet-title">${esc(o.code)} <span class="pill ${color}">${label}</span>
    <button class="sheet-close" onclick="App.closeSheet()">✕</button></div>
    <div class="money-lines" style="margin-top:12px">
      <div class="money-line"><span class="k">顾客</span><span class="v">${esc(o.customer_name)}</span></div>
      <div class="money-line"><span class="k">机位</span><span class="v">${esc(o.seat_code)}(${esc(o.seat_zone)})</span></div>
      <div class="money-line"><span class="k">时段</span><span class="v mono">${fmtDT(o.start_at)} – ${fmtDT(o.end_at)}</span></div>
      <div class="money-line"><span class="k">外设套装</span><span class="v">${esc(o.kit_name)} · 押金 ${fmtMoney(o.deposit_cents)}</span></div>
    </div>`;
  if (o.loans.length) {
    html += `<div class="muted" style="margin:8px 0 4px">外设出借记录</div><ul class="kit-items">` +
      o.loans.map((l, i) => `<li><span class="item-no">${i + 1}</span><span class="serial">${esc(l.serial)}</span>${esc(l.model)}
        <span class="pill ${l.condition_in && l.condition_in !== "ok" ? "red" : ""}" style="margin-left:auto">
        ${l.checked_in_at ? "已归还·" + { ok: "完好", damaged: "损坏", missing: "缺失" }[l.condition_in] : "借出中"}</span></li>`).join("") + `</ul>`;
  }
  if (o.faults.length) {
    html += `<div class="muted" style="margin:8px 0 4px">故障记录</div>` +
      o.faults.map((f) => `<div class="money-line"><span class="k">${esc(f.code)} · ${esc(f.description)}</span>
        <span class="v">${f.status === "resolved" ? `停机 ${f.downtime_minutes} 分钟` : "处理中"}</span></div>`).join("");
  }
  let actions = "";
  if (o.status === "reserved") {
    actions = `<button class="btn btn-primary" onclick="App.startOrder(${o.id})">开机</button>
               <button class="btn btn-danger" onclick="App.cancelOrder(${o.id})">取消预约</button>`;
  } else if (o.status === "active") {
    actions = `<button class="btn btn-primary" onclick="App.openReturnSheet(${o.id})">外设归还并结束</button>
               <button class="btn btn-yellow" onclick="App.openFaultSheet(${o.seat_id}, ${o.id})">报故障</button>`;
  } else if (o.status === "ended") {
    actions = `<button class="btn btn-primary" onclick="App.settleOrder(${o.id})">生成结算快照</button>`;
  } else if (o.status === "settled" && o.settlement) {
    actions = `<button class="btn" onclick="App.closeSheet(); App.switchView('settlements')">查看结账复核</button>`;
  }
  openSheet(html + (actions ? `<div class="sheet-actions">${actions}</div>` : ""));
};

App.settleOrder = async function (orderId) {
  const r = await run(() => api.post(`/api/orders/${orderId}/settle`), "结算快照已生成");
  if (r) { closeSheet(); App.switchView("settlements"); }
};

/* ================= 账号授权 ================= */
async function renderGrants() {
  const grants = await api.get("/api/grants");
  let html = `<div class="section-title" style="margin-top:0">账号授权 · 只在包机有效时段内开放</div>
    <div class="grant-grid">`;
  if (!grants.length) html += `<div class="card muted">暂无授权记录</div>`;
  for (const g of grants) {
    const [label, color] = GRANT_STATUS[g.status] || [g.status, ""];
    html += `
      <div class="card grant-card">
        <div class="row" style="justify-content:space-between">
          <span class="grant-game">${esc(g.game)} · ${esc(g.login_name)}</span>
          <span class="pill ${color}">${label}</span>
        </div>
        <div class="grant-window">订单 ${esc(g.order_code)} · 机位 ${esc(g.seat_code)}</div>
        <div class="grant-window">有效时段 ${fmtDT(g.valid_from)} – ${fmtDT(g.valid_to)}</div>
      </div>`;
  }
  html += `</div>`;
  main.innerHTML = html;
}

/* ================= 外设套装 ================= */
async function renderKits() {
  const [kits, peripherals] = await Promise.all([api.get("/api/kits"), api.get("/api/peripherals")]);
  let html = `<div class="section-title" style="margin-top:0">外设套装</div><div class="kit-grid">`;
  for (const k of kits) {
    html += `<div class="card">
      <div class="row" style="justify-content:space-between">
        <strong style="font-size:18px">${esc(k.name)}</strong>
        <span class="pill yellow">押金 ${fmtMoney(k.deposit_cents)}</span>
      </div>
      <ul class="kit-items">
        ${k.items.map((p, i) => `<li><span class="item-no">${i + 1}</span>
          <span class="serial">${esc(p.serial)}</span><span>${esc(p.model)}</span>
          <span class="pill ${p.status === "available" ? "green" : p.status === "lent" ? "cyan" : "red"}" style="margin-left:auto">${PERI_STATUS[p.status]}</span></li>`).join("")}
      </ul>
    </div>`;
  }
  html += `</div><div class="section-title">外设库存(编号清单)</div>
    <div class="card"><ul class="kit-items">
      ${peripherals.map((p, i) => `<li><span class="item-no">${i + 1}</span>
        <span class="serial">${esc(p.serial)}</span>
        <span>${PERI_TYPE[p.type]} · ${esc(p.model)}</span>
        <span class="muted" style="font-size:14px">${esc(p.appearance)}</span>
        <span class="pill ${p.status === "available" ? "green" : p.status === "lent" ? "cyan" : "red"}" style="margin-left:auto">${PERI_STATUS[p.status]}</span>
      </li>`).join("")}
    </ul></div>`;
  main.innerHTML = html;
}

/* ================= 巡检工单 ================= */
async function renderInspections() {
  const [tickets, faults, seats] = await Promise.all([
    api.get("/api/inspections"), api.get("/api/faults"), api.get("/api/seats"),
  ]);
  const openFaults = faults.filter((f) => f.status === "open");
  const doneFaults = faults.filter((f) => f.status !== "open");

  let html = `
    <div class="card">
      <div class="section-title" style="margin-top:0">新建巡检工单</div>
      <div class="form-grid">
        <label class="field">机位
          <select id="insp-seat">${seats.map((s) => `<option value="${s.id}">${esc(s.code)} · ${esc(s.zone)}</option>`).join("")}</select>
        </label>
        <label class="field">发现的问题
          <input id="insp-findings" placeholder="例如: 键盘缝隙积灰 / 耳机罩老化">
        </label>
        <label class="field">定损金额(元, 无则 0)
          <input id="insp-damage" type="number" min="0" step="1" value="0">
        </label>
      </div>
      <div class="sheet-actions">
        <button class="btn btn-primary" onclick="App.createInspection()">创建巡检工单</button>
      </div>
    </div>

    <div class="section-title">故障工单(进行中 ${openFaults.length})</div>
    <div class="ticket-list">
      ${openFaults.map((f) => `
        <div class="card ticket">
          <div class="ticket-head">
            <span class="ticket-code">${esc(f.code)}</span>
            <span class="pill red">${{ network: "网络中断", hardware: "硬件", peripheral: "外设" }[f.type] || f.type}</span>
            <span class="pill">机位 ${esc(f.seat_code)}</span>
            ${f.order_code ? `<span class="pill cyan">${esc(f.order_code)}</span>` : ""}
          </div>
          <div>${esc(f.description)}</div>
          <div class="muted" style="font-size:14px">发生时间 ${fmtDT(f.started_at)} · 停机时长将计入结算补偿</div>
          <div class="sheet-actions"><button class="btn btn-primary" onclick="App.resolveFault(${f.id})">标记已解决</button></div>
        </div>`).join("") || `<div class="card muted">暂无进行中的故障</div>`}
    </div>

    <div class="section-title">巡检工单</div>
    <div class="ticket-list">
      ${tickets.map((t) => `
        <div class="card ticket">
          <div class="ticket-head">
            <span class="ticket-code">${esc(t.code)}</span>
            <span class="pill ${t.status === "open" ? "yellow" : "green"}">${t.status === "open" ? "待处理" : "已关闭"}</span>
            <span class="pill">${t.type === "checkout" ? "结账检查" : "日常巡检"}</span>
            <span class="pill">机位 ${esc(t.seat_code)}</span>
            ${t.order_code ? `<span class="pill cyan">${esc(t.order_code)}</span>` : ""}
            ${t.damage_cents ? `<span class="pill red">定损 ${fmtMoney(t.damage_cents)}</span>` : ""}
          </div>
          <div>${esc(t.findings || "—")}</div>
          <div class="muted" style="font-size:14px">${esc(t.created_by)} · ${fmtDT(t.created_at)}</div>
          ${t.status === "open" ? `<div class="sheet-actions"><button class="btn" onclick="App.closeInspection(${t.id})">关闭工单</button></div>` : ""}
        </div>`).join("") || `<div class="card muted">暂无巡检工单</div>`}
    </div>`;

  if (doneFaults.length) {
    html += `<div class="section-title">故障历史</div><div class="ticket-list">` +
      doneFaults.map((f) => `
        <div class="card ticket">
          <div class="ticket-head">
            <span class="ticket-code">${esc(f.code)}</span>
            <span class="pill green">已解决</span>
            <span class="pill">机位 ${esc(f.seat_code)}</span>
            <span class="pill yellow">停机 ${f.downtime_minutes} 分钟</span>
          </div>
          <div class="muted">${esc(f.description)}</div>
        </div>`).join("") + `</div>`;
  }
  main.innerHTML = html;
};

App.createInspection = async function () {
  const body = {
    seat_id: Number($("#insp-seat").value),
    type: "routine",
    findings: $("#insp-findings").value.trim(),
    damage_cents: Math.round(Number($("#insp-damage").value || 0) * 100),
    created_by: "前台",
  };
  const r = await run(() => api.post("/api/inspections", body), "巡检工单已创建");
  if (r) refresh();
};
App.closeInspection = async function (id) {
  const r = await run(() => api.post(`/api/inspections/${id}/close`), "工单已关闭");
  if (r) refresh();
};
App.resolveFault = async function (id) {
  const r = await run(() => api.post(`/api/faults/${id}/resolve`), "故障已解决, 停机时长已记录");
  if (r) refresh();
};

/* ================= 结账复核 ================= */
async function renderSettlements() {
  const [settlements, ended] = await Promise.all([
    api.get("/api/settlements"), api.get("/api/orders?status=ended"),
  ]);

  let html = "";
  if (ended.length) {
    html += `<div class="section-title" style="margin-top:0">待结算订单</div><div class="ticket-list">` +
      ended.map((o) => `
        <div class="card ticket">
          <div class="ticket-head">
            <span class="ticket-code">${esc(o.code)}</span>
            <span class="pill">${esc(o.seat_code)}</span>
            <span class="pill cyan">${esc(o.customer_name)}</span>
            <span class="muted">结束于 ${fmtDT(o.ended_at)}</span>
          </div>
          <div class="sheet-actions">
            <button class="btn btn-primary" onclick="App.settleOrder(${o.id})">生成结算快照</button>
          </div>
        </div>`).join("") + `</div>`;
  }

  html += `<div class="section-title">结算快照复核</div><div class="ticket-list">`;
  if (!settlements.length) html += `<div class="card muted">暂无结算记录</div>`;
  for (const s of settlements) {
    const statusPill = { pending: ["待确认", "yellow"], confirmed: ["已收款", "cyan"], refunded: ["已退款", "green"] }[s.status];
    html += `
      <div class="card ticket">
        <div class="ticket-head">
          <span class="ticket-code">结算 #${s.id} · ${esc(s.order_code)}</span>
          <span class="pill ${statusPill[1]}">${statusPill[0]}</span>
          <span class="pill">${esc(s.seat_code)}</span>
          <span class="pill cyan">${esc(s.customer_name)}</span>
        </div>
        <div class="money-lines">
          <div class="money-line"><span class="k">计费时长(已扣停机)</span><span class="v">${s.billable_minutes} 分钟</span></div>
          <div class="money-line"><span class="k">时长费</span><span class="v pos">${fmtMoney(s.gross_cents)}</span></div>
          <div class="money-line"><span class="k">故障停机补偿</span><span class="v neg">-${s.downtime_minutes} 分钟 / ${fmtMoney(s.downtime_credit_cents)}</span></div>
          ${s.deductions.map((d) => `<div class="money-line"><span class="k">赔偿扣款 · 关联 ${esc(d.inspection_code)}</span><span class="v neg">${fmtMoney(d.amount_cents)}</span></div>`).join("")}
          ${s.adjustment_cents ? `<div class="money-line"><span class="k">异常扣费冲正</span><span class="v neg">${fmtMoney(s.adjustment_cents)}</span></div>` : ""}
          <div class="money-line"><span class="k">押金</span><span class="v">${fmtMoney(s.deposit_cents)}</span></div>
          <div class="money-line total"><span class="k">应收 / 应退押金</span>
            <span class="v"><span class="pos">${fmtMoney(s.due_cents)}</span> / <span class="neg">${fmtMoney(s.refund_cents)}</span></span></div>
        </div>
        ${s.refund ? `<div class="muted" style="font-size:14px">退款单 #${s.refund.id} · 幂等键 ${esc(s.refund.idempotency_key)} · ${fmtMoney(s.refund.amount_cents)}</div>` : ""}
        <div class="sheet-actions">
          ${s.status === "pending" ? `
            <button class="btn btn-primary" onclick="App.confirmSettlement(${s.id})">确认收款</button>
            <button class="btn btn-yellow" onclick="App.openAdjust(${s.id})">异常扣费冲正</button>` : ""}
          ${s.status === "confirmed" ? `<button class="btn btn-primary" onclick="App.refund(${s.id}, ${s.refund_cents})">退押金 ${fmtMoney(s.refund_cents)}</button>` : ""}
          ${s.status === "refunded" ? `<button class="btn" onclick="App.refundAgain(${s.id})">再次点击退款(幂等演示)</button>` : ""}
        </div>
      </div>`;
  }
  html += `</div>`;
  main.innerHTML = html;
};

App.confirmSettlement = async function (id) {
  const r = await run(() => api.post(`/api/settlements/${id}/confirm`), "已确认收款");
  if (r) refresh();
};

App.openAdjust = function (id) {
  openSheet(`
    <div class="sheet-title">异常扣费冲正 · 结算 #${id} <button class="sheet-close" onclick="App.closeSheet()">✕</button></div>
    <div class="form-grid" style="margin-top:14px">
      <label class="field">冲正金额(元, 负数为退给顾客)
        <input id="adj-amount" type="number" step="0.01" value="-10">
      </label>
      <label class="field">原因
        <input id="adj-reason" placeholder="例如: 重复计时, 退还 10 元">
      </label>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-yellow" onclick="App.submitAdjust(${id})">提交冲正</button>
    </div>`);
};

App.submitAdjust = async function (id) {
  const body = {
    amount_cents: Math.round(Number($("#adj-amount").value) * 100),
    reason: $("#adj-reason").value.trim(),
  };
  const r = await run(() => api.post(`/api/settlements/${id}/adjust`, body), "冲正已记录");
  if (r) { closeSheet(); refresh(); }
};

App.refund = async function (id, cents) {
  const key = `RF-${id}-${Date.now()}`;
  App.refundKeys[id] = key;
  const r = await run(async () => {
    const j = await api.post(`/api/settlements/${id}/refund`, { idempotency_key: key });
    toast(j.replayed ? "幂等重放: 未产生新退款" : `押金已退还 ${fmtMoney(cents)}`);
    return j;
  });
  if (r) refresh();
};

App.refundAgain = async function (id) {
  const key = App.refundKeys[id];
  if (!key) {
    const s = (await api.get("/api/settlements")).find((x) => x.id === id);
    if (s && s.refund) App.refundKeys[id] = s.refund.idempotency_key;
  }
  const r = await run(async () => {
    const j = await api.post(`/api/settlements/${id}/refund`, { idempotency_key: App.refundKeys[id] });
    toast(j.replayed ? "幂等重放: 同一请求只退款一次, 未重复扣款" : "已退款");
    return j;
  });
  if (r) refresh();
};

/* ================= 路由与刷新 ================= */
const VIEWS = {
  floor: renderFloor,
  calendar: renderCalendar,
  grants: renderGrants,
  kits: renderKits,
  inspections: renderInspections,
  settlements: renderSettlements,
};

App.switchView = function (view) {
  App.view = view;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  refresh();
};

async function refresh() {
  try {
    await VIEWS[App.view]();
  } catch (e) {
    console.error(e);
  }
}

$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (btn) App.switchView(btn.dataset.view);
});

setInterval(() => {
  $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}, 1000);

/* 面板打开时暂停自动刷新, 避免打断触控输入 */
setInterval(() => {
  if ($("#sheet-mask").classList.contains("hidden")) refresh();
}, 5000);

refresh();
