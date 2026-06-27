'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, ROLES } = require('./auth');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'store.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      qq            TEXT,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'USER',
      permissions   TEXT NOT NULL DEFAULT '[]',
      balance_cents REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      start_time    TEXT NOT NULL,
      end_time      TEXT,
      last_tick     TEXT NOT NULL,
      charged_cents REAL NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'ACTIVE',
      billable      INTEGER NOT NULL DEFAULT 1,
      end_reason    TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      type         TEXT NOT NULL,            -- RECHARGE | CHARGE
      amount_cents REAL NOT NULL,            -- 正数
      operator_id  INTEGER,                  -- 充值操作人
      visit_id     INTEGER,
      note         TEXT,
      created_at   TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS pricing_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      start_hour INTEGER NOT NULL,           -- 0-23
      end_hour   INTEGER NOT NULL,           -- 1-24 (不含)
      rate_cents REAL NOT NULL               -- 每小时单价(分)
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS payment_orders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no     TEXT NOT NULL UNIQUE,
      user_id      INTEGER NOT NULL,
      amount_cents REAL NOT NULL,
      method       TEXT NOT NULL,            -- mock | wechat | alipay
      status       TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | PAID | CANCELLED
      created_at   TEXT NOT NULL,
      paid_at      TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
    CREATE INDEX IF NOT EXISTS idx_visits_user ON visits(user_id);
    CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_no ON payment_orders(order_no);
  `);
}

function seed() {
  const now = new Date().toISOString();

  // 种子总管理员
  const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = ?").get(ROLES.SUPER_ADMIN).c;
  if (adminCount === 0) {
    const username = process.env.SUPER_ADMIN_USER || 'admin';
    const password = process.env.SUPER_ADMIN_PASS || 'admin123';
    db.prepare(
      "INSERT INTO users (username, qq, password_hash, role, permissions, balance_cents, created_at) VALUES (?, ?, ?, ?, '[]', 0, ?)"
    ).run(username, '', hashPassword(password), ROLES.SUPER_ADMIN, now);
    console.log(`[seed] 已创建总管理员账号: ${username} / ${password} (请尽快修改密码)`);
  }

  // 种子默认时价：全天 10 元/小时 (1000 分)
  const ruleCount = db.prepare('SELECT COUNT(*) AS c FROM pricing_rules').get().c;
  if (ruleCount === 0) {
    db.prepare('INSERT INTO pricing_rules (start_hour, end_hour, rate_cents) VALUES (?, ?, ?)').run(0, 24, 1000);
    console.log('[seed] 已创建默认时价: 全天 10 元/小时');
  }
}

migrate();
seed();

module.exports = { db };
