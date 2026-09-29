'use strict';

const path = require('node:path');
const { openDatabase } = require('./db');
const { Arena } = require('./arena');
const { NetworkAdapter, PeripheralAdapter, PaymentAdapter } = require('./adapters');
const { seed } = require('./seed');

function createApp(dbPath = process.env.ARENA_DB || path.join(process.cwd(), 'data', 'arena.db')) {
  const db = openDatabase(dbPath);
  const network = new NetworkAdapter(db);
  const peripheral = new PeripheralAdapter(db);
  const payment = new PaymentAdapter(db);
  const arena = new Arena(db, { network, peripheral, payment });
  const seeded = seed(db);
  return { db, arena, network, peripheral, payment, seeded };
}

module.exports = { createApp };
