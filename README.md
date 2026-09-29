# 电竞馆电脑包机与外设交接系统

管理机位、包机时段、账号授权、键鼠耳机外设交接、押金、设备巡检、故障与结账的前台触控系统。
零第三方依赖，仅使用 Node.js 22 内置的 `node:sqlite`、`node:http` 与 `node:test`。

## 单条命令开始

```bash
npm run demo     # 生成包机/故障/结账样例并打印结账复核（data/demo.db）
npm start        # 启动前台触控端 http://localhost:3000（首次启动自动生成演示数据）
npm test         # 运行全部 24 个测试
```

也可以直接 `node bin/demo.js` / `node server.js`，无需 `npm install`。

## 业务规则

- **下单即锁定**：订单锁定机位、计划起止时间与外设套装；系统自动分配具体编号外设（RESERVED）并预建账号授权（PLANNED）与押金。
- **账号授权时段**：开机才开放（ACTIVE），到达计划结束时间自动 EXPIRED，提前下机立即 REVOKED；同一账号同一时刻只允许一个有效授权。
- **外设交接**：出借时记录编号、外观与柜机回执；结束时逐件扫码归还（完好 / 损坏 / 缺失），缺一件不能关机结账。
- **唯一性**：同一机位时间区间互斥（半开区间，首尾相接允许）；同一件外设由数据库部分唯一索引保证不能同时 LENT 给两个订单。
- **迟到**：计费起点仍是计划开始时间，不补时，记录 `late_minutes`。
- **提前结束**：按实际使用分钟计费，记录 `early_minutes`，授权立即吊销。
- **网络中断**：本地网络适配器给中断/恢复回执并计时，停机分钟从结算快照的计费分钟中等额扣除（钳制不为负）；关机时未恢复会自动恢复。
- **设备损坏 / 外设缺失**：归还或巡检发现异常时自动生成巡检工单、故障单与押金扣款；**每一笔扣款都回链 `inspection_findings`**。外设按损坏基准价/缺失赔偿价，机位设备由前台核定金额。
- **押金与结账**：结算生成不可变快照（分钟、租金、消费、扣款、押金、补收、退还、回执全量留痕）；应收 = 租金 + 消费 + 扣款，押金多退少补。
- **退款幂等**：收/退款使用固定幂等键（`charge:order:<id>` / `refund:order:<id>`），重复结账或重复退款只产生一笔流水。
- **双前台并发**：开机用 `BEGIN IMMEDIATE` + CAS 型 UPDATE，两名前台同时点开机只有一次成功（有 worker 线程跨连接测试）。

## 六个交付界面

顶栏可切换 **前台A / 前台B**（用于演示并发开机），右侧可一键重置演示数据。

1. **机位平面图**：固定网格（对战区 4×3、包厢区 3×2），机位卡片显示状态、顾客、时段、细进度条与剩余倒计时、网络在线/中断态。
2. **包机日历**：按天、按机位泳道的甘特图，可前后翻日，点色块进订单。
3. **账号授权**：授权网关视图，显示开放/到期/吊销与倒计时。
4. **外设套装**：套装押金、含项、含账号，以及全部编号实物的外观、赔偿价与状态。
5. **巡检工单**：逐项 正常/损坏/缺失 大按钮分段选择，异常自动回链扣款。
6. **订单详情与结账复核**：侧滑单层面板（无多层弹窗）、外设编号清单、网络中断计时、消费快捷记账、结算快照明细表与幂等复核按钮。

界面配色：深炭灰底、电光青主色、明黄强调；触控元素 ≥44px。

## 结构

```
src/db.js             SQLite schema（部分唯一索引、外键、WAL）
src/arena.js          领域服务：全部事务与业务规则
src/adapters.js       进程内模拟适配器：Network / Peripheral 柜机 / Payment 幂等
src/seed.js           演示主数据（顾客/机位/套装/编号外设/账号/消费菜单）
src/demo-scenario.js  可复用演示场景（CLI 与服务端共用）
bin/demo.js           npm run demo
server.js             HTTP API + 静态资源
public/               触控前端（原生 JS）
tests/                node:test，含 worker 线程真实并发与 HTTP 端到端
```

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 机位平面图 + 统计 |
| GET | `/api/calendar?date=YYYY-MM-DD` | 包机日历 |
| GET | `/api/grants` | 当前账号授权（自动过期） |
| POST | `/api/orders` | 预订（锁机位/外设/授权/押金） |
| POST | `/api/orders/:id/start` | 开机（CAS 并发唯一） |
| POST | `/api/orders/:id/lend` | 一键出借外设 |
| POST | `/api/order-peripherals/:opId/return` | 单件归还 `scan=OK/DAMAGED/MISSING` |
| POST | `/api/orders/:id/network/open` · `/api/incidents/:id/resolve` | 网络中断计时 |
| POST | `/api/inspections/:id/complete` | 巡检结果（异常生成扣款） |
| POST | `/api/orders/:id/end` · `/settle` | 关机 / 结算快照（幂等） |
| POST | `/api/admin/demo-reset` | 重置为演示数据 |

金额单位全部为 **分**；时间全部为毫秒时间戳。
