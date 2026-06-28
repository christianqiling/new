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

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT,
      content     TEXT NOT NULL,
      pinned      INTEGER NOT NULL DEFAULT 0,
      author_id   INTEGER,
      author_name TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      card_no    TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id   INTEGER,
      actor_name TEXT,
      action     TEXT NOT NULL,
      detail     TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);
    CREATE INDEX IF NOT EXISTS idx_visits_user ON visits(user_id);
    CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_no ON payment_orders(order_no);
  `);

  // 为既有数据库补充新增列（昵称 / 头像）
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes('nickname')) db.exec("ALTER TABLE users ADD COLUMN nickname TEXT");
  if (!cols.includes('avatar')) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT");
  if (!cols.includes('free_cents')) db.exec("ALTER TABLE users ADD COLUMN free_cents REAL NOT NULL DEFAULT 0");
  if (!cols.includes('admin_password_hash')) db.exec("ALTER TABLE users ADD COLUMN admin_password_hash TEXT");
}

function seed() {
  const now = new Date().toISOString();
  let seeded = false;

  // 种子超级管理员（仅当数据库中不存在时创建一次）
  const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = ?").get(ROLES.SUPER_ADMIN).c;
  if (adminCount === 0) {
    const username = process.env.SUPER_ADMIN_USER || 'admin';
    const password = process.env.SUPER_ADMIN_PASS || 'admin123';
    db.prepare(
      "INSERT INTO users (username, qq, password_hash, role, permissions, balance_cents, created_at) VALUES (?, ?, ?, ?, '[]', 0, ?)"
    ).run(username, '', hashPassword(password), ROLES.SUPER_ADMIN, now);
    console.log(`[seed] 首次初始化：已创建超级管理员账号 ${username} / ${password} (请尽快修改密码)`);
    seeded = true;
  }

  // 种子默认时价：全天 10 元/小时 (1000 分)
  const ruleCount = db.prepare('SELECT COUNT(*) AS c FROM pricing_rules').get().c;
  if (ruleCount === 0) {
    db.prepare('INSERT INTO pricing_rules (start_hour, end_hour, rate_cents) VALUES (?, ?, ?)').run(0, 24, 1000);
    console.log('[seed] 首次初始化：已创建默认时价 全天 10 元/小时');
    seeded = true;
  }

  // 二级统一密码（重要操作：修改管理员/超管信息、角色权限等）
  const lv2 = db.prepare("SELECT value FROM settings WHERE key = 'level2_password'").get();
  if (!lv2) {
    const old = db.prepare("SELECT value FROM settings WHERE key = 'op_password'").get(); // 兼容旧库迁移
    const val = old ? old.value : hashPassword(process.env.LEVEL2_PASSWORD || '123456');
    db.prepare("INSERT INTO settings (key, value) VALUES ('level2_password', ?)").run(val);
    console.log('[seed] 首次初始化：已设置二级统一密码（默认 123456，请尽快修改）');
    seeded = true;
  }

  // 起步费（分），默认 0
  const bf = db.prepare("SELECT value FROM settings WHERE key = 'base_fee_cents'").get();
  if (!bf) db.prepare("INSERT INTO settings (key, value) VALUES ('base_fee_cents', '0')").run();

  // 为所有管理员设置默认"管理员密码"(123456)（若未设置）
  const adminsNoPw = db.prepare("SELECT id FROM users WHERE role IN ('SUPER_ADMIN','SUB_ADMIN') AND (admin_password_hash IS NULL OR admin_password_hash = '')").all();
  if (adminsNoPw.length) {
    const def = hashPassword('123456');
    const upd = db.prepare('UPDATE users SET admin_password_hash = ? WHERE id = ?');
    for (const a of adminsNoPw) upd.run(def, a.id);
  }

  if (!seeded) {
    console.log(`[db] 已加载现有数据库 (${DB_PATH})：管理员、密码、时价、用户等全部从数据库读取，不会重复创建。`);
  } else {
    console.log(`[db] 数据库位置：${DB_PATH}（数据持久保存，重启不会丢失，请勿删除 data 目录）`);
  }
}

migrate();
seed();

module.exports = { db };
