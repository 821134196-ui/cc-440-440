'use strict';
/* 电竞馆前台触控端：无框架原生 JS，单层侧滑面板 + 大号触控点。 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      // HTTP 头只接受 latin1，发送 A/B 代号由服务端映射为「前台A/B」
      'X-Actor': state.actor === '前台B' ? 'B' : 'A',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || '请求失败'), { code: data.error, data });
  return data;
};

const yuan = (f) => `¥${(f / 100).toFixed(2)}`;
const pad2 = (n) => String(n).padStart(2, '0');
const dtLocal = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const hm = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtCountdown = (ms) => {
  if (ms <= 0) return '已到期';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}小时${m % 60}分` : `${m}分${Math.floor((ms % 60000) / 1000)}秒`;
};
const STATUS_TAG = {
  PENDING: ['已预订', 'yellow'], ACTIVE: ['进行中', 'cyan'], ENDED: ['待结账', 'orange'],
  SETTLED: ['已结账', 'green'], NO_SHOW: ['爽约', 'red'], CANCELLED: ['已取消', 'gray'],
};
const PHASE = {
  RESERVED: ['已锁定', 'gray'], LENT: ['出借中', 'cyan'], RETURNED: ['已归还', 'green'],
  DAMAGED: ['损坏', 'orange'], MISSING: ['缺失', 'red'],
};
const PTYPE = { KEYBOARD: '键盘', MOUSE: '鼠标', HEADSET: '耳机' };

const state = {
  actor: '前台A',
  now: Date.now(),
  stations: [],
  customers: [],
  kits: [],
  view: 'floor',
  calDate: new Date().toISOString().slice(0, 10),
  inspStatus: '',
};

// ---------- 轻提示 ----------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function guard(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(e.message, 'err');
    throw e;
  }
}

// ---------- 侧滑面板（全局唯一，不叠层） ----------
function openDrawer(title, node) {
  $('#drawerTitle').textContent = title;
  const body = $('#drawerBody');
  body.replaceChildren(node);
  $('#drawer').classList.add('on');
  $('#drawerMask').classList.add('on');
}
function closeDrawer() {
  $('#drawer').classList.remove('on');
  $('#drawerMask').classList.remove('on');
}
$('#drawerClose').onclick = closeDrawer;
$('#drawerMask').onclick = closeDrawer;

const card = (title, innerHtml) => {
  const c = document.createElement('div');
  c.className = 'card';
  c.innerHTML = title ? `<h3>${title}</h3>${innerHtml}` : innerHtml;
  return c;
};

// ---------- 数据加载 ----------
async function loadBase() {
  const [customers, kits, st] = await Promise.all([
    api('/api/customers'), api('/api/kits'), api('/api/state'),
  ]);
  state.customers = customers;
  state.kits = kits;
  state.stations = st.stations;
}

async function refresh() {
  state.now = Date.now();
  if (state.view === 'floor') {
    const s = await api('/api/state');
    state.stations = s.stations;
    renderFloor(s.stats);
  } else if (state.view === 'calendar') {
    renderCalendar();
  } else if (state.view === 'orders') {
    renderOrders();
  } else if (state.view === 'grants') {
    renderGrants();
  } else if (state.view === 'inspections') {
    renderInspections();
  }
}

// ---------- 机位平面图 ----------
function renderFloor(stats) {
  $('#stats').innerHTML = `
    <div class="stat"><b>${stats.all}</b><span>机位总数</span></div>
    <div class="stat"><b>${stats.active}</b><span>使用中</span></div>
    <div class="stat"><b>${stats.available}</b><span>空闲</span></div>
    <div class="stat ${stats.openIncidents ? 'bad' : ''}"><b>${stats.openIncidents}</b><span>网络故障</span></div>
    <div class="stat ${stats.pendingInspections ? 'warn' : ''}"><b>${stats.pendingInspections}</b><span>待巡检</span></div>
    <div class="stat ${stats.maint ? 'warn' : ''}"><b>${stats.maint}</b><span>维修中</span></div>`;

  const fill = (el, list) => {
    el.replaceChildren();
    for (const s of list) {
      const b = document.createElement('button');
      let cls = 'station free';
      let pill = '<span class="state-pill free">空闲</span>';
      let inner = '';
      if (s.status === 'MAINT') {
        cls = 'station maint';
        pill = '<span class="state-pill maint">维修</span>';
        inner = `<div class="meta">${s.spec}</div>`;
      } else if (s.activeOrder) {
        const a = s.activeOrder;
        const pct = Math.round(a.progress * 100);
        cls = a.online ? 'station active' : 'station offline';
        pill = a.online
          ? '<span class="state-pill active">使用中</span>'
          : '<span class="state-pill offline">网络中断</span>';
        inner = `
          <div class="cust">${a.customerName}</div>
          <div class="meta">${a.code} · ${hm(a.planStart)}–${hm(a.planEnd)}</div>
          <div class="remain" data-remain="${a.planEnd}">剩余 ${fmtCountdown(a.remainMs)}</div>
          <div class="bar"><i style="width:${pct}%"></i></div>`;
      } else if (s.next) {
        pill = `<span class="state-pill booked">预约 ${hm(s.next.plan_start)}</span>`;
        inner = `<div class="meta">${s.spec}</div><div class="meta">下一场 ${s.next.code}</div>`;
      } else {
        inner = `<div class="meta">${s.spec}</div>`;
      }
      b.className = cls;
      b.innerHTML = `<span class="code">${s.code}</span>${pill}${inner}`;
      b.onclick = () => openStation(s.id);
      el.appendChild(b);
    }
  };
  fill($('#gridA'), state.stations.filter((s) => s.zone === '对战区'));
  fill($('#gridB'), state.stations.filter((s) => s.zone === '包厢区'));
}

// 本地每秒刷新进度条，避免频繁请求
setInterval(() => {
  if (state.view !== 'floor') return;
  const now = Date.now();
  $$('[data-remain]').forEach((el) => {
    el.textContent = `剩余 ${fmtCountdown(Number(el.dataset.remain) - now)}`;
  });
}, 1000);

// ---------- 机位 / 订单详情 ----------
async function openStation(stationId) {
  const s = state.stations.find((x) => x.id === stationId);
  if (s.activeOrder) return openOrder(s.activeOrder.id);
  const wrap = document.createElement('div');
  wrap.appendChild(card('', `
    <dl class="kv">
      <dt>机位</dt><dd><b style="font-size:22px;color:var(--cyan)">${s.code}</b> ${s.zone}</dd>
      <dt>配置</dt><dd>${s.spec}</dd>
      <dt>资费</dt><dd>${yuan(s.hourly_fen)} / 小时</dd>
      <dt>状态</dt><dd>${s.status === 'MAINT' ? '维修中' : '空闲可预订'}</dd>
    </dl>`));
  if (s.next) {
    wrap.appendChild(card('下一场预订', `<div class="muted">${s.next.code} · ${hm(s.next.plan_start)}–${hm(s.next.plan_end)}</div>`));
  }
  if (s.status === 'MAINT') {
    const btn = document.createElement('button');
    btn.className = 'btn green';
    btn.textContent = '维修完成，恢复机位';
    btn.onclick = () => guard(async () => {
      await api(`/api/stations/${s.id}/repair`, { method: 'POST' });
      closeDrawer(); refresh();
    }, '机位已恢复');
    wrap.appendChild(btn);
  } else {
    wrap.appendChild(newOrderForm(s.id));
    const ib = document.createElement('button');
    ib.className = 'btn ghost';
    ib.style.marginTop = '10px';
    ib.textContent = '创建例行巡检工单';
    ib.onclick = () => guard(async () => {
      await api(`/api/stations/${s.id}/inspections`, { method: 'POST', body: { note: '前台手动创建' } });
      toast('巡检工单已创建', 'ok');
      switchView('inspections'); refresh();
    }, '巡检工单已创建');
    wrap.appendChild(ib);
  }
  openDrawer(`机位 ${s.code}`, wrap);
}

function newOrderForm(stationId = null) {
  const c = document.createElement('div');
  c.className = 'card';
  const now = Date.now();
  c.innerHTML = `
    <h3>新开包机</h3>
    <div class="field"><label>顾客</label>
      <select id="nf-cust">${state.customers.map((x) => `<option value="${x.id}">${x.name}（${x.level}）</option>`).join('')}</select>
    </div>
    <div class="field"><label>机位</label>
      <select id="nf-station">${state.stations.filter((s) => s.status !== 'MAINT').map((x) =>
        `<option value="${x.id}" ${x.id === stationId ? 'selected' : ''}>${x.code} ${x.zone}</option>`).join('')}</select>
    </div>
    <div class="field"><label>外设套装</label>
      <select id="nf-kit">${state.kits.map((k) =>
        `<option value="${k.id}">${k.name}（押金 ${yuan(k.deposit_fen)}）</option>`).join('')}</select>
    </div>
    <div class="form-grid">
      <div class="field"><label>开始时间</label><input type="datetime-local" id="nf-start" value="${dtLocal(now)}" step="60"></div>
      <div class="field"><label>结束时间</label><input type="datetime-local" id="nf-end" value="${dtLocal(now + 3 * 3600000)}" step="60"></div>
    </div>
    <div class="pill-input" id="nf-quick"></div>
    <div class="field" style="margin-top:10px"><label>备注</label><input id="nf-note" placeholder="选填" /></div>`;
  const quick = $('#nf-quick', c);
  const presets = [['1小时', 1], ['2小时', 2], ['3小时', 3], ['5小时', 5], ['包夜8小时', 8]];
  for (const [label, h] of presets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.onclick = () => {
      const st = new Date($('#nf-start', c).value).getTime();
      $('#nf-end', c).value = dtLocal(st + h * 3600000);
    };
    quick.appendChild(b);
  }
  $('#nf-start', c).onchange = () => {
    const st = new Date($('#nf-start', c).value).getTime();
    $('#nf-end', c).value = dtLocal(st + 3 * 3600000);
  };
  const submit = document.createElement('button');
  submit.className = 'btn yellow';
  submit.textContent = '锁定机位与外设，创建订单';
  submit.onclick = () => guard(async () => {
    const body = {
      customerId: $('#nf-cust', c).value,
      stationId: $('#nf-station', c).value,
      kitId: $('#nf-kit', c).value,
      planStart: new Date($('#nf-start', c).value).getTime(),
      planEnd: new Date($('#nf-end', c).value).getTime(),
      note: $('#nf-note', c).value,
    };
    const o = await api('/api/orders', { method: 'POST', body });
    closeDrawer();
    toast(`订单 ${o.code} 已创建，机位与外设已锁定`, 'ok');
    refresh();
  });
  const btnRow = document.createElement('div');
  btnRow.className = 'btn-row';
  btnRow.appendChild(submit);
  c.appendChild(btnRow);
  return c;
}

async function openOrder(id) {
  const o = await api(`/api/orders/${id}`);
  const wrap = document.createElement('div');
  const [tagText, tagCls] = STATUS_TAG[o.status];

  wrap.appendChild(card('', `
    <div class="row" style="justify-content:space-between">
      <b style="font-size:22px">${o.code}</b>
      <span class="tag ${tagCls}">${tagText}</span>
    </div>
    <dl class="kv" style="margin-top:10px">
      <dt>顾客</dt><dd>${o.customer.name}（${o.customer.level}）${o.customer.phone}</dd>
      <dt>机位</dt><dd>${o.station.code} · ${o.station.zone}</dd>
      <dt>套装</dt><dd>${o.kit.name} · 押金 ${yuan(o.kit.deposit_fen)}</dd>
      <dt>计划</dt><dd>${new Date(o.plan_start).toLocaleString('zh-CN', { hour12: false })}<br>至 ${new Date(o.plan_end).toLocaleString('zh-CN', { hour12: false })}</dd>
      ${o.actual_start ? `<dt>开机</dt><dd>${new Date(o.actual_start).toLocaleString('zh-CN', { hour12: false })}（${o.started_by}）${o.late_minutes ? ` · <span style="color:var(--orange)">迟到 ${o.late_minutes} 分钟，不补时</span>` : ''}</dd>` : ''}
      ${o.actual_end ? `<dt>关机</dt><dd>${new Date(o.actual_end).toLocaleString('zh-CN', { hour12: false })}${o.early_minutes ? ` · <span style="color:var(--green)">提前 ${o.early_minutes} 分钟</span>` : ''}</dd>` : ''}
      ${o.note ? `<dt>备注</dt><dd class="muted">${o.note}</dd>` : ''}
    </dl>`));

  if (o.status === 'PENDING') pendingActions(wrap, o);
  if (o.status === 'ACTIVE') await activeActions(wrap, o);
  if (o.status === 'ENDED') endedActions(wrap, o);
  if (o.status === 'SETTLED') settledView(wrap, o);

  if (o.extras?.length) {
    wrap.appendChild(card('店内消费', o.extras.map((e) =>
      `<div class="row" style="justify-content:space-between"><span>${e.name} ×${e.qty}</span><b>${yuan(e.amount_fen)}</b></div>`).join('')));
  }
  if (o.incidents?.length) wrap.appendChild(incidentsCard(o));
  if (o.deductions?.length) wrap.appendChild(deductionsCard(o));

  openDrawer(`订单 ${o.code}`, wrap);
}

function pendingActions(wrap, o) {
  const row = document.createElement('div');
  row.className = 'btn-row';
  const start = document.createElement('button');
  start.className = 'btn';
  start.textContent = '开机并开放账号授权';
  start.onclick = () => guard(async () => {
    const r = await api(`/api/orders/${o.id}/start`, { method: 'POST' });
    toast(`开机成功（${r.started_by}），授权已开放`, 'ok');
    openOrder(o.id); refresh();
  }).catch(() => {});
  row.appendChild(start);

  const cancel = document.createElement('button');
  cancel.className = 'btn ghost';
  cancel.textContent = '取消订单';
  cancel.onclick = inlineConfirm(cancel, '确认取消？锁定的机位与外设将立即释放。', async () => {
    await api(`/api/orders/${o.id}/cancel`, { method: 'POST', body: { reason: '前台操作取消' } });
    closeDrawer(); toast('订单已取消', 'ok'); refresh();
  });
  row.appendChild(cancel);

  if (Date.now() > o.plan_end) {
    const ns = document.createElement('button');
    ns.className = 'btn red';
    ns.textContent = '标记爽约';
    ns.onclick = inlineConfirm(ns, '顾客未到店且时段已过，确认爽约？', async () => {
      await api(`/api/orders/${o.id}/noshow`, { method: 'POST' });
      closeDrawer(); toast('已标记爽约', 'ok'); refresh();
    });
    row.appendChild(ns);
  }
  wrap.appendChild(row);
}

async function activeActions(wrap, o) {
  // 剩余时间进度
  const now = Date.now();
  const total = o.plan_end - o.plan_start;
  const pct = Math.min(100, Math.max(0, ((now - o.plan_start) / total) * 100));
  wrap.appendChild(card('包机剩余时间', `
    <div class="remain" id="ao-remain">${fmtCountdown(o.plan_end - now)}</div>
    <div class="bar"><i id="ao-bar" style="width:${pct}%"></i></div>
    <div class="muted" style="margin-top:6px">${hm(o.plan_start)} – ${hm(o.plan_end)}，授权准时关闭</div>`));
  const tick = setInterval(() => {
    if (!$('#ao-remain')) return clearInterval(tick);
    const t = Date.now();
    $('#ao-remain').textContent = fmtCountdown(o.plan_end - t);
    $('#ao-bar').style.width = `${Math.min(100, Math.max(0, ((t - o.plan_start) / total) * 100))}%`;
  }, 1000);

  // 外设交接编号清单
  const pc = card('外设交接清单', '');
  const list = document.createElement('div');
  for (const p of o.peripherals) {
    list.appendChild(peripheralItem(o, p));
  }
  pc.appendChild(list);
  if (o.peripherals.some((p) => p.status === 'RESERVED')) {
    const b = document.createElement('button');
    b.className = 'btn yellow';
    b.textContent = '一键出借全部外设（柜机回执）';
    b.onclick = () => guard(async () => {
      await api(`/api/orders/${o.id}/lend`, { method: 'POST' });
      toast('外设已全部出借', 'ok');
      openOrder(o.id); refresh();
    }).catch(() => {});
    pc.appendChild(b);
  }
  wrap.appendChild(pc);

  // 网络中断
  const openInc = o.incidents.find((i) => i.status === 'OPEN');
  const nc = card('网络与故障', '');
  if (openInc) {
    nc.innerHTML += `<div class="inline-warn">网络中断中，开始于 ${new Date(openInc.start_time).toLocaleTimeString('zh-CN', { hour12: false })}，停机时间将在结账时补偿</div>`;
    const b = document.createElement('button');
    b.className = 'btn green';
    b.style.marginTop = '10px';
    b.textContent = '网络恢复，停止计时';
    b.onclick = () => guard(async () => {
      const r = await api(`/api/incidents/${openInc.id}/resolve`, { method: 'POST' });
      toast(`网络已恢复，登记停机 ${r.duration_minutes} 分钟`, 'ok');
      openOrder(o.id); refresh();
    }).catch(() => {});
    nc.appendChild(b);
  } else {
    const b = document.createElement('button');
    b.className = 'btn red';
    b.textContent = '上报网络中断（开始停机计时）';
    b.onclick = () => guard(async () => {
      await api(`/api/orders/${o.id}/network/open`, { method: 'POST' });
      toast('网络中断已登记，停机计时开始', 'ok');
      openOrder(o.id); refresh();
    }).catch(() => {});
    nc.appendChild(b);
  }
  wrap.appendChild(nc);

  // 店内消费快捷记账
  const menu = await api('/api/menu');
  const mc = card('店内消费快捷记账', '<div class="pill-input" id="ex-chips"></div>');
  const chips = $('#ex-chips', mc);
  for (const m of menu) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = `${m.name} ${yuan(m.unitFen)}`;
    b.onclick = () => guard(async () => {
      await api(`/api/orders/${o.id}/extras`, { method: 'POST', body: { name: m.name, unitFen: m.unitFen, qty: 1 } });
      toast(`${m.name} 已记账`, 'ok');
      openOrder(o.id);
    }).catch(() => {});
    chips.appendChild(b);
  }
  wrap.appendChild(mc);

  // 关机
  const lentCount = o.peripherals.filter((p) => p.status === 'LENT').length;
  const ec = card('', '');
  const end = document.createElement('button');
  end.className = 'btn orange';
  end.textContent = '提前结束 / 关机';
  if (lentCount > 0) {
    end.disabled = true;
    ec.appendChild(document.createTextNode(''));
    const warn = document.createElement('div');
    warn.className = 'inline-warn';
    warn.textContent = `还有 ${lentCount} 件外设未归还，逐项归还后才能关机结账`;
    ec.appendChild(warn);
  }
  end.onclick = inlineConfirm(end, '确认关机？实际用时将重新计费，未用完时间按提前结束处理，账号授权立即吊销。', async () => {
    await api(`/api/orders/${o.id}/end`, { method: 'POST' });
    toast('已关机，可以结账', 'ok');
    openOrder(o.id); refresh();
  });
  ec.appendChild(end);
  wrap.appendChild(ec);
}

function peripheralItem(o, p) {
  const item = document.createElement('div');
  item.className = 'periph-item';
  const [pt, pc] = PHASE[p.status];
  item.innerHTML = `
    <div class="periph-head">
      <span class="periph-code">${p.p_code}</span>
      <span class="tag gray">${PTYPE[p.p_type]}</span>
      <span class="tag ${pc}">${pt}</span>
      <span class="muted" style="margin-left:auto">${p.brand}</span>
    </div>
    <div class="periph-appearance">外观：${p.appearance}</div>
    ${p.lent_receipt ? `<div class="receipt">出借回执 ${p.lent_receipt} · ${p.lent_by} · ${new Date(p.lent_at).toLocaleTimeString('zh-CN', { hour12: false })}</div>` : ''}
    ${p.return_receipt ? `<div class="receipt">归还回执 ${p.return_receipt} · ${p.returned_by}</div>` : ''}`;

  if (p.status === 'LENT') {
    const row = document.createElement('div');
    row.className = 'btn-row';
    const ok = document.createElement('button');
    ok.className = 'btn green small';
    ok.textContent = '✓ 完好归还';
    ok.onclick = () => guard(async () => {
      await api(`/api/order-peripherals/${p.id}/return`, { method: 'POST', body: { scan: 'OK' } });
      toast(`${p.p_code} 已归还`, 'ok');
      openOrder(o.id); refresh();
    }).catch(() => {});
    row.appendChild(ok);

    const dmg = document.createElement('button');
    dmg.className = 'btn orange small';
    dmg.textContent = '损坏';
    dmg.onclick = () => showIssueForm(row, o, p, 'DAMAGED');
    row.appendChild(dmg);

    const miss = document.createElement('button');
    miss.className = 'btn red small';
    miss.textContent = '缺失';
    miss.onclick = () => showIssueForm(row, o, p, 'MISSING');
    row.appendChild(miss);
    item.appendChild(row);
  }
  if (p.status === 'DAMAGED' || p.status === 'MISSING') {
    const w = document.createElement('div');
    w.className = 'inline-warn';
    w.textContent = `${p.status === 'MISSING' ? '缺失赔偿' : '损坏扣款'} ${yuan(p.status === 'MISSING' ? p.replacement_fen : p.damage_fee_fen)}（已关联巡检与故障记录，结账时从押金扣除）`;
    item.appendChild(w);
  }
  return item;
}

// 损坏/缺失：就地展开确认条，不弹第二层窗口
function showIssueForm(row, o, p, scan) {
  const existing = row.parentElement.querySelector('.issue-form');
  if (existing) existing.remove();
  const form = document.createElement('div');
  form.className = 'issue-form inline-warn';
  form.innerHTML = `
    <div>${scan === 'MISSING' ? '确认外设缺失？将按价赔偿' : '确认设备损坏？将从押金扣款'}：<b>${yuan(scan === 'MISSING' ? p.replacement_fen : p.damage_fee_fen)}</b></div>
    <textarea id="isf-note" placeholder="登记损坏/缺失情况，例如：左耳罩破裂" style="margin:8px 0;min-height:64px"></textarea>`;
  const br = document.createElement('div');
  br.className = 'btn-row';
  const yes = document.createElement('button');
  yes.className = scan === 'MISSING' ? 'btn red small' : 'btn orange small';
  yes.textContent = '确认登记并生成巡检扣款';
  yes.onclick = () => guard(async () => {
    await api(`/api/order-peripherals/${p.id}/return`, {
      method: 'POST',
      body: { scan, note: $('#isf-note', form).value },
    });
    toast('已登记，巡检工单与扣款已生成', 'ok');
    openOrder(o.id); refresh();
  }).catch(() => {});
  const no = document.createElement('button');
  no.className = 'btn ghost small';
  no.textContent = '取消';
  no.onclick = () => form.remove();
  br.append(yes, no);
  form.appendChild(br);
  row.parentElement.appendChild(form);
}

function incidentsCard(o) {
  const typeText = { NETWORK_OUTAGE: '网络中断', DEVICE_DAMAGE: '设备损坏', PERIPHERAL_MISSING: '外设缺失', OTHER: '其他' };
  return card('故障记录', o.incidents.map((i) => `
    <div class="row" style="justify-content:space-between">
      <span><span class="tag ${i.status === 'OPEN' ? 'red' : 'gray'}">${typeText[i.type]}</span>
        ${i.code}${i.duration_minutes ? ` · 停机 ${i.duration_minutes} 分钟（补偿 ${i.comp_minutes} 分）` : ''}</span>
      <span class="muted">${i.status === 'OPEN' ? '处理中' : '已解决'}</span>
    </div>
    <div class="muted" style="font-size:14px;margin:2px 0 8px">${i.note}${i.evidence ? ` · 回执 ${i.evidence}` : ''}</div>`).join(''));
}

function deductionsCard(o) {
  return card('押金扣款（均回链巡检工单）', o.deductions.map((d) => `
    <div class="row" style="justify-content:space-between">
      <span><a data-insp="${d.inspection_id}" style="color:var(--cyan)">巡检 #${d.inspection_id}</a> · ${d.reason}</span>
      <b style="color:var(--orange)">${yuan(d.amount_fen)}</b>
    </div>`).join(''));
}

function endedActions(wrap, o) {
  const openInc = o.incidents.filter((i) => i.status === 'OPEN').length;
  const c = document.createElement('div');
  if (openInc) {
    c.innerHTML = `<div class="inline-warn">还有 ${openInc} 起故障未处理完成，请先恢复网络后再结账</div>`;
  }
  const b = document.createElement('button');
  b.className = 'btn yellow';
  b.style.fontSize = '19px';
  b.textContent = '生成结算快照并结账';
  b.disabled = openInc > 0;
  b.onclick = () => guard(async () => {
    const r = await api(`/api/orders/${o.id}/settle`, { method: 'POST' });
    toast(r.duplicated ? '该订单已结账（幂等返回原快照）' : '结账完成', 'ok');
    openOrder(o.id); refresh();
  }).catch(() => {});
  c.appendChild(b);
  wrap.appendChild(c);
}

function settledView(wrap, o) {
  const s = o.settlement;
  const b = JSON.parse(s.breakdown_json);
  const rows = [];
  rows.push(['comp', `包机时长 ${b.usedMinutes} 分钟（计划 ${b.planMinutes}）`, '']);
  if (b.lateMinutes) rows.push(['', `迟到 ${b.lateMinutes} 分钟（按计划开始计费，不补时）`, '']);
  if (b.earlyMinutes) rows.push(['', `提前结束 ${b.earlyMinutes} 分钟`, '']);
  if (b.compMinutes) rows.push(['comp', `故障停机补偿 −${b.compMinutes} 分钟`, `计费 ${b.billableMinutes} 分钟`]);
  rows.push(['', '包机费', yuan(b.rentalFen)]);
  if (b.extrasFen) rows.push(['', '店内消费', yuan(b.extrasFen)]);
  if (b.deductionsFen) rows.push(['deduct', '押金扣款（外设/设备）', yuan(b.deductionsFen)]);
  rows.push(['', '应收合计', yuan(b.totalDue)]);
  rows.push(['', '押金预授', yuan(b.depositFen)]);
  rows.push(['total', b.chargeFen ? '补收金额' : '押金抵扣后', b.chargeFen ? yuan(b.chargeFen) : '—']);
  rows.push(['total', '原路退还', b.refundFen ? yuan(b.refundFen) : '—']);

  const c = card('结账复核（结算快照）', `
    <table class="settle-lines">
      ${rows.map(([cls, k, v]) => `<tr class="${cls}"><td>${k}</td><td>${v}</td></tr>`).join('')}
    </table>
    <div class="divider"></div>
    <div class="receipt">收款回执：${s.pay_receipt || '—'}</div>
    <div class="receipt">退款回执：${s.refund_receipt || '—'}</div>
    <div class="muted" style="margin-top:6px">快照时间 ${new Date(s.snap_time).toLocaleString('zh-CN', { hour12: false })} · 经办人 ${s.created_by}</div>`);
  wrap.appendChild(c);

  // 再次结账按钮，演示退款幂等
  const again = document.createElement('button');
  again.className = 'btn ghost';
  again.textContent = '重复提交结账（验证退款幂等）';
  again.onclick = () => guard(async () => {
    const r = await api(`/api/orders/${o.id}/settle`, { method: 'POST' });
    toast(r.duplicated ? `幂等命中：退款仍为 ${r.settlement.refund_receipt || r.settlement.pay_receipt}` : '已结账', 'ok');
  }).catch(() => {});
  wrap.appendChild(again);

  setTimeout(() => {
    $$('a[data-insp]', wrap).forEach((a) => {
      a.onclick = () => openInspection(Number(a.dataset.insp));
    });
  }, 0);
}

// ---------- 包机日历 ----------
async function renderCalendar() {
  const { dayStart, dayEnd, orders } = await api(`/api/calendar?date=${state.calDate}`);
  const el = $('#calendar');
  el.replaceChildren();
  const stations = state.stations.length ? state.stations : (await api('/api/state')).stations;
  state.stations = stations;

  const hours = Array.from({ length: 25 }, (_, i) => i);
  const pct = (ms) => ((ms - dayStart) / (dayEnd - dayStart)) * 100;

  for (const s of stations) {
    const row = document.createElement('div');
    row.style.position = 'relative';
    row.style.height = '44px';
    row.style.marginBottom = '6px';
    row.innerHTML = `<span style="position:absolute;left:-70px;top:10px;font-weight:800;color:var(--cyan);width:60px">${s.code}</span>`;
    for (const h of hours.slice(0, 24)) {
      const line2 = document.createElement('div');
      line2.style.cssText = 'position:absolute;top:0;bottom:0;left:' + (h / 24) * 100 + '%;border-left:1px dashed #2a333d';
      row.appendChild(line2);
    }
    for (const o of orders.filter((x) => x.station_id === s.id)) {
      const left = pct(Math.max(o.plan_start, dayStart));
      const width = Math.max(1.5, pct(Math.min(o.plan_end, dayEnd)) - pct(Math.max(o.plan_start, dayStart)));
      const bar = document.createElement('button');
      bar.className = `cal-order ${o.status}`;
      bar.style.left = `${left}%`;
      bar.style.width = `calc(${width}% - 4px)`;
      bar.style.top = '4px';
      bar.style.height = '36px';
      bar.textContent = `${hm(o.plan_start)} ${o.customer_name} · ${o.kit_name}`;
      bar.title = o.code;
      bar.onclick = () => openOrder(o.id);
      row.appendChild(bar);
    }
    el.appendChild(row);
  }
  const axis = document.createElement('div');
  axis.style.cssText = 'position:relative;height:24px;margin-left:0';
  axis.innerHTML = hours.slice(0, 24).map((h) =>
    `<span style="position:absolute;left:${(h / 24) * 100}%;color:var(--muted);font-size:12px">${pad2(h)}:00</span>`).join('');
  el.appendChild(axis);

  if (!orders.length) el.appendChild(Object.assign(document.createElement('div'), { className: 'empty', textContent: '当日暂无包机订单' }));
}

// ---------- 订单列表 ----------
async function renderOrders() {
  const rows = await api('/api/orders');
  const el = $('#orderList');
  if (!rows.length) {
    el.innerHTML = '<div class="empty">暂无订单</div>';
    return;
  }
  el.replaceChildren();
  for (const o of rows) {
    const [tagText, tagCls] = STATUS_TAG[o.status];
    const c = document.createElement('button');
    c.className = 'card';
    c.style.cssText = 'width:100%;text-align:left;cursor:pointer';
    c.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <b style="font-size:18px">${o.code}</b>
        <span class="tag ${tagCls}">${tagText}</span>
      </div>
      <div class="row" style="margin-top:6px">
        <span>${o.customer_name}</span><span class="muted">·</span>
        <span>${o.station_code}</span><span class="muted">·</span>
        <span>${o.kit_name}</span>
      </div>
      <div class="muted" style="margin-top:4px">
        ${new Date(o.plan_start).toLocaleString('zh-CN', { hour12: false })} –
        ${hm(o.plan_end)}
      </div>`;
    c.onclick = () => openOrder(o.id);
    el.appendChild(c);
  }
}

// ---------- 账号授权 ----------
async function renderGrants() {
  const grants = await api('/api/grants');
  const el = $('#grantList');
  el.replaceChildren();
  if (!grants.length) {
    el.innerHTML = '<div class="empty">当前没有任何授权记录</div>';
    return;
  }
  for (const g of grants) {
    const c = document.createElement('div');
    c.className = `card grant-card ${g.effective ? '' : 'exp'}`;
    c.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <b style="font-size:18px">${g.account_code}</b>
        <span class="tag ${g.effective ? 'green' : 'red'}">${g.effective ? '授权开放' : (g.status === 'EXPIRED' ? '已到期关闭' : g.status === 'REVOKED' ? '已吊销' : g.status)}</span>
      </div>
      <dl class="kv" style="margin-top:8px">
        <dt>平台</dt><dd>${g.platform} · ${g.username}</dd>
        <dt>机位</dt><dd>${g.station_code} · 订单 ${g.order_code}</dd>
        <dt>窗口</dt><dd>${hm(g.opens_at)} – ${hm(g.closes_at)}</dd>
      </dl>
      ${g.effective ? `<div class="countdown" data-close="${g.closes_at}">${fmtCountdown(g.closes_at - Date.now())} 后关闭</div>` : ''}`;
    c.onclick = () => openOrder(g.order_id);
    c.style.cursor = 'pointer';
    el.appendChild(c);
  }
}

// ---------- 巡检工单 ----------
async function renderInspections() {
  const list = await api(`/api/inspections${state.inspStatus ? '?status=' + state.inspStatus : ''}`);
  const el = $('#inspList');
  el.replaceChildren();
  if (!list.length) {
    el.innerHTML = '<div class="empty">没有巡检工单</div>';
    return;
  }
  const typeText = { PRE_USE: '交接前', ROUTINE: '例行', POST_INCIDENT: '故障后' };
  for (const i of list) {
    const c = document.createElement('button');
    c.className = 'card';
    c.style.cssText = 'width:100%;text-align:left;cursor:pointer';
    c.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <b style="font-size:18px">${i.code}</b>
        <span class="tag ${i.status === 'PENDING' ? 'yellow' : i.result === 'FAIL' ? 'red' : 'green'}">
          ${i.status === 'PENDING' ? '待处理' : i.result === 'FAIL' ? '不合格' : '合格'}
        </span>
      </div>
      <div class="muted" style="margin-top:4px">
        ${i.station_code} · ${typeText[i.type]}巡检 · 计划 ${new Date(i.scheduled_at).toLocaleString('zh-CN', { hour12: false })}
        ${i.order_code ? ` · 订单 ${i.order_code}` : ''}
      </div>
      <div class="muted">${i.note}</div>`;
    c.onclick = () => openInspection(i.id);
    el.appendChild(c);
  }
}

async function openInspection(id) {
  const i = await api(`/api/inspections/${id}`);
  const wrap = document.createElement('div');
  const typeText = { PRE_USE: '交接前', ROUTINE: '例行', POST_INCIDENT: '故障后' };
  wrap.appendChild(card('', `
    <dl class="kv">
      <dt>工单号</dt><dd><b>${i.code}</b></dd>
      <dt>机位</dt><dd>${i.station_code}${i.order_code ? ` · 订单 ${i.order_code}` : ''}</dd>
      <dt>类型</dt><dd>${typeText[i.type]}巡检</dd>
      <dt>状态</dt><dd>${i.status === 'DONE' ? (i.result === 'FAIL' ? '不合格' : '合格') + ` · ${i.inspector} · ${new Date(i.checked_at).toLocaleString('zh-CN', { hour12: false })}` : '待处理'}</dd>
      <dt>说明</dt><dd class="muted">${i.note}</dd>
    </dl>`));

  if (i.status === 'DONE') {
    wrap.appendChild(card('检查项', i.findings.map((f) => `
      <div class="row" style="justify-content:space-between">
        <span>${f.item}</span>
        <span class="tag ${f.result === 'OK' ? 'green' : f.result === 'MISSING' ? 'red' : 'orange'}">
          ${f.result === 'OK' ? '正常' : f.result === 'MISSING' ? '缺失' : '损坏'}
        </span>
      </div>
      ${f.note ? `<div class="muted" style="font-size:14px">${f.note}</div>` : ''}`).join('')));
  } else {
    wrap.appendChild(inspectionForm(i));
  }
  openDrawer(`巡检工单 ${i.code}`, wrap);
}

function inspectionForm(i) {
  const c = document.createElement('div');
  c.className = 'card';
  c.innerHTML = '<h3>逐项检查（异常项必须登记，扣款自动回链本工单）</h3>';
  const items = ['键盘', '鼠标', '耳机', '显示器', '主机', '网络', '座椅'];
  const PERIPH_ITEMS = ['键盘', '鼠标', '耳机'];
  const rowsState = {};
  const list = document.createElement('div');
  for (const name of items) {
    const row = document.createElement('div');
    row.className = 'findings-row';
    rowsState[name] = { result: 'OK', amount: 0, note: '' };
    row.innerHTML = `<span class="fname">${name}</span>`;
    const seg = document.createElement('div');
    seg.className = 'seg';
    const mkSeg = (label, result, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn small ${result === 'OK' ? 'on-green' : ''}`;
      b.textContent = label;
      b.onclick = () => {
        rowsState[name].result = result;
        $$('.btn', seg).forEach((x) => x.classList.remove('on-green', 'on-orange', 'on-red'));
        b.classList.add(cls);
        amountWrap.style.display = result === 'DAMAGED' && !PERIPH_ITEMS.includes(name) ? 'block' : 'none';
      };
      seg.appendChild(b);
      return b;
    };
    mkSeg('正常', 'OK', 'on-green');
    mkSeg('损坏', 'DAMAGED', 'on-orange');
    // 只有外借外设支持“缺失”登记
    if (PERIPH_ITEMS.includes(name)) mkSeg('缺失', 'MISSING', 'on-red');
    row.appendChild(seg);
    const amountWrap = document.createElement('div');
    amountWrap.style.cssText = 'flex-basis:100%;display:none';
    amountWrap.innerHTML = `<label>赔偿金额（元）</label><input type="number" min="0" step="1" value="0" style="max-width:180px">
      <label style="margin-top:8px">情况说明</label><input placeholder="例如：屏幕右下角碎裂">`;
    row.appendChild(amountWrap);
    list.appendChild(row);
  }
  c.appendChild(list);
  const submit = document.createElement('button');
  submit.className = 'btn yellow';
  submit.textContent = '提交巡检结果';
  submit.onclick = () => guard(async () => {
    const findings = [];
    $$('.findings-row', c).forEach((row, idx) => {
      const name = items[idx];
      const st = rowsState[name];
      const amountInput = row.querySelector('input[type=number]');
      const noteInput = row.querySelector('input[placeholder]');
      st.amount = Number(amountInput.value) * 100;
      st.note = noteInput.value;
      findings.push({ item: name, result: st.result, amountFen: st.amount, note: st.note });
    });
    const bad = findings.filter((f) =>
      ['显示器', '主机', '座椅'].includes(f.item) && f.result === 'DAMAGED' && f.amountFen <= 0);
    if (bad.length) {
      toast(`请为损坏的「${bad[0].item}」核定赔偿金额`, 'err');
      return;
    }
    await api(`/api/inspections/${i.id}/complete`, { method: 'POST', body: { findings } });
    toast('巡检结果已提交', 'ok');
    closeDrawer(); refresh();
  }).catch(() => {});
  c.appendChild(submit);
  return c;
}

// ---------- 外设套装 ----------
async function renderPeripherals() {
  const [kits, all] = await Promise.all([api('/api/kits'), api('/api/peripherals')]);
  const el = $('#kitList');
  el.replaceChildren();
  for (const k of kits) {
    const c = card(`套装 ${k.code} · ${k.name}`, `
      <div class="muted">${k.description}</div>
      <div class="row" style="margin-top:8px">
        <span class="tag yellow">押金 ${yuan(k.deposit_fen)}</span>
        ${k.items.map((it) => `<span class="tag cyan">${PTYPE[it.type]} ×${it.qty}</span>`).join('')}
      </div>
      <div class="muted" style="margin-top:8px">含账号：${k.accounts.map((a) => a.code).join('、')}</div>`);
    el.appendChild(c);
  }
  const statusText = { AVAILABLE: ['在柜', 'green'], ON_LOAN: ['出借中', 'cyan'], MAINT: ['检修', 'orange'], RETIRED: ['报废/丢失', 'red'] };
  const pc = card('外设编号实物清单', '');
  const groups = document.createElement('div');
  for (const type of ['KEYBOARD', 'MOUSE', 'HEADSET']) {
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = PTYPE[type];
    groups.appendChild(title);
    for (const p of all.filter((x) => x.type === type)) {
      const [txt, cls] = statusText[p.status];
      const d = document.createElement('div');
      d.className = 'periph-item';
      d.innerHTML = `
        <div class="periph-head">
          <span class="periph-code">${p.code}</span>
          <span class="tag ${cls}">${txt}</span>
          <span class="muted" style="margin-left:auto">${p.brand}</span>
        </div>
        <div class="periph-appearance">外观：${p.appearance}</div>
        <div class="muted" style="font-size:13px">缺失赔偿 ${yuan(p.replacement_fen)} · 损坏扣款基准 ${yuan(p.damage_fee_fen)}</div>`;
      groups.appendChild(d);
    }
  }
  pc.appendChild(groups);
  el.appendChild(pc);
}

// ---------- 就地确认（不叠弹窗） ----------
function inlineConfirm(btn, text, onYes) {
  return () => {
    const host = btn.parentElement;
    if (host.querySelector('.inline-confirm')) return;
    const box = document.createElement('div');
    box.className = 'inline-warn inline-confirm';
    box.style.flexBasis = '100%';
    box.textContent = text;
    const br = document.createElement('div');
    br.className = 'btn-row';
    const yes = document.createElement('button');
    yes.className = 'btn red small';
    yes.textContent = '确认';
    yes.onclick = async () => {
      try {
        await onYes();
      } catch { /* 错误已提示 */ }
    };
    const no = document.createElement('button');
    no.className = 'btn ghost small';
    no.textContent = '再想想';
    no.onclick = () => box.remove();
    br.append(yes, no);
    box.appendChild(br);
    host.appendChild(box);
  };
}

// ---------- 视图切换 / 顶栏 ----------
function switchView(v) {
  state.view = v;
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === v));
  $$('.view').forEach((x) => x.classList.toggle('on', x.id === `view-${v}`));
  refresh();
}
$$('.tab').forEach((t) => (t.onclick = () => switchView(t.dataset.view)));

$$('.actor-btn').forEach((b) => {
  b.onclick = () => {
    state.actor = b.dataset.actor;
    $$('.actor-btn').forEach((x) => x.classList.toggle('on', x === b));
    toast(`当前操作人：${state.actor}`);
  };
});

$('#resetBtn').onclick = () => {
  const btn = $('#resetBtn');
  btn.disabled = true;
  guard(async () => {
    await api('/api/admin/demo-reset', { method: 'POST', body: {} });
    await loadBase();
    toast('演示数据已重置', 'ok');
    switchView('floor');
  }).finally(() => (btn.disabled = false));
};

$('#newOrderBtn').onclick = $('#newOrderBtn2').onclick = () => {
  openDrawer('新开包机', newOrderForm(null));
};

$('#calDate').value = state.calDate;
$('#calDate').onchange = (e) => { state.calDate = e.target.value; renderCalendar(); };
$('#calPrev').onclick = () => shiftDay(-1);
$('#calNext').onclick = () => shiftDay(1);
function shiftDay(d) {
  const x = new Date(state.calDate + 'T00:00:00');
  x.setDate(x.getDate() + d);
  state.calDate = x.toISOString().slice(0, 10);
  $('#calDate').value = state.calDate;
  renderCalendar();
}

$('#inspFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.inspStatus = b.dataset.status;
  $$('#inspFilter .btn').forEach((x) => x.classList.remove('on-green'));
  b.classList.add('on-green');
  renderInspections();
});

setInterval(() => {
  const d = new Date();
  $('#clock').textContent = d.toLocaleString('zh-CN', { hour12: false });
}, 1000);

// 后台轮询（进度条本地每秒更新，数据 5 秒同步一次）
setInterval(() => { if (!$('#drawer').classList.contains('on')) refresh(); }, 5000);

loadBase().then(refresh);
