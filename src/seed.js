'use strict';

// 演示数据：顾客、机位（固定网格）、外设套装与编号实物、账号商品、消费菜单。

const FEN = 100;

function seed(db) {
  const count = db.prepare('SELECT COUNT(*) c FROM stations').get().c;
  if (count > 0) return false;

  const insCustomer = db.prepare(
    'INSERT INTO customers (code, name, phone, level, balance_fen) VALUES (?,?,?,?,?)'
  );
  const customers = [
    ['C001', '陈一帆', '138****1001', '钻石', 50000],
    ['C002', '林晓彤', '139****1002', '黄金', 12800],
    ['C003', '王浩然', '137****1003', '普通', 0],
    ['C004', '赵子墨', '136****1004', '铂金', 30000],
    ['C005', '周雨桐', '135****1005', '普通', 6600],
    ['C006', '孙启铭', '134****1006', '王者', 88800],
  ];
  for (const c of customers) insCustomer.run(...c);

  // 机位：A 对战区 4列×3行；B 包厢区 3列×2行（网格上留一列间隔）
  const insStation = db.prepare(
    'INSERT INTO stations (code, zone, grid_x, grid_y, spec, hourly_fen) VALUES (?,?,?,?,?,?)'
  );
  const aSpec = 'i7-14700K / RTX4070S / 2K 240Hz';
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      insStation.run(`A${String(y * 4 + x + 1).padStart(2, '0')}`, '对战区', x, y, aSpec, 1200);
    }
  }
  const bSpec = 'i9-14900K / RTX4080S / 2K 360Hz 双人沙发';
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 3; x++) {
      insStation.run(`B${String(y * 3 + x + 1).padStart(2, '0')}`, '包厢区', x + 5, y, bSpec, 1800);
    }
  }

  const insAccount = db.prepare(
    'INSERT INTO accounts (code, platform, username, password) VALUES (?,?,?,?)'
  );
  const accounts = [
    ['STEAM-01', 'Steam', 'arena_steam01', 'Demo#2026'],
    ['STEAM-02', 'Steam', 'arena_steam02', 'Demo#2026'],
    ['WANGYI-01', '网易', 'arena_wy01', 'Demo#2026'],
    ['WANGYI-02', '网易', 'arena_wy02', 'Demo#2026'],
    ['TENCENT-01', '腾讯', 'arena_tx01', 'Demo#2026'],
    ['EPIC-01', 'Epic', 'arena_epic01', 'Demo#2026'],
    ['RIOT-01', 'Riot', 'arena_riot01', 'Demo#2026'],
  ];
  for (const a of accounts) insAccount.run(...a);

  const insKit = db.prepare(
    'INSERT INTO kits (code, name, description, deposit_fen) VALUES (?,?,?,?)'
  );
  const insItem = db.prepare('INSERT INTO kit_items (kit_id, type, qty) VALUES (?,?,?)');
  const insKitAcc = db.prepare('INSERT INTO kit_accounts (kit_id, account_id) VALUES (?,?)');

  const kit1 = Number(
    insKit.run('K1', '电竞标准套', '机械键盘 + 电竞鼠标 + 头戴耳机', 20000).lastInsertRowid
  );
  for (const t of ['KEYBOARD', 'MOUSE', 'HEADSET']) insItem.run(kit1, t, 1);
  for (const code of ['STEAM-01', 'TENCENT-01', 'WANGYI-01']) {
    insKitAcc.run(kit1, db.prepare('SELECT id FROM accounts WHERE code=?').get(code).id);
  }

  const kit2 = Number(
    insKit.run('K2', '旗舰外设套', '磁轴键盘 + 轻量化鼠标 + 无线降噪耳机', 50000).lastInsertRowid
  );
  for (const t of ['KEYBOARD', 'MOUSE', 'HEADSET']) insItem.run(kit2, t, 1);
  for (const code of ['STEAM-02', 'EPIC-01', 'RIOT-01', 'WANGYI-02']) {
    insKitAcc.run(kit2, db.prepare('SELECT id FROM accounts WHERE code=?').get(code).id);
  }

  // 外设实物：编号 + 外观 + 赔偿/扣款基准
  const insP = db.prepare(
    `INSERT INTO peripherals (code, type, brand, appearance, replacement_fen, damage_fee_fen)
     VALUES (?,?,?,?,?,?)`
  );
  const mk = (prefix, type, list) =>
    list.forEach(([brand, appearance, rep, dmg], i) =>
      insP.run(`${prefix}-${String(i + 1).padStart(4, '0')}`, type, brand, appearance, rep, dmg)
    );
  mk('KB', 'KEYBOARD', [
    ['罗技', '黑色，WASD 轻微打油', 89900, 15000],
    ['雷蛇', '黑色绿轴，键帽齐全', 109900, 18000],
    ['狼蛛', '白色磁轴，近乎全新', 69900, 12000],
    ['樱桃', '黑色红轴，线材完好', 79900, 12000],
    ['罗技', '黑色 TKL，腕托在柜', 65900, 10000],
    ['雷蛇', '白色光轴，灯效正常', 129900, 20000],
    ['达尔优', '黑色青轴，略沾手汗', 45900, 8000],
    ['华硕', '黑色银轴，原盒保存', 99900, 16000],
  ]);
  mk('MS', 'MOUSE', [
    ['罗技 GPW', '黑色，脚垫微磨', 79900, 12000],
    ['雷蛇 毒蝰', '黑色，侧键完好', 59900, 9000],
    ['卓威 EC2', '哑光黑，近乎全新', 47900, 8000],
    ['罗技 G502', '黑色带配重', 42900, 7000],
    ['赛睿 Rival', '黑色，线材完好', 39900, 6000],
    ['雷蛇 炼狱蝰蛇', '黑色人体工学', 45900, 7000],
    ['罗技 GPW2', '白色，脚垫全新', 109900, 18000],
    ['外星人', '黑色三模', 89900, 15000],
    ['海盗船', '黑色 RGB', 35900, 6000],
    ['Xtrfy', '白色轻量化', 52900, 8000],
  ]);
  mk('HS', 'HEADSET', [
    [' HyperX Cloud', '黑色，耳罩无破损', 39900, 8000],
    ['森海塞尔', '黑色，麦克风正常', 89900, 15000],
    ['雷蛇 北海巨妖', '黑色，头梁完好', 49900, 8000],
    ['罗技 Pro X', '黑色，备用耳罩在柜', 99900, 16000],
    ['海盗船', '白色无线，接收器齐', 79900, 12000],
    ['华硕 降临', '黑色 RGB', 59900, 9000],
    ['音特美', '黑色入耳式', 29900, 5000],
    ['漫步者', '黑色头戴', 25900, 4000],
    ['雷蛇 旋风黑鲨', '白色，箱说齐全', 109900, 18000],
    ['罗技 A40', '黑色带调音器', 119900, 20000],
  ]);

  return true;
}

// 店内消费菜单（演示）
const EXTRAS_MENU = [
  { name: '红牛维生素饮料', unitFen: 800 },
  { name: '气泡水', unitFen: 500 },
  { name: '泡面（代泡）', unitFen: 900 },
  { name: '鸡胸肉肠', unitFen: 600 },
  { name: '薯片', unitFen: 700 },
  { name: '柠檬茶', unitFen: 600 },
];

module.exports = { seed, EXTRAS_MENU, FEN };
