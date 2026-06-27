'use strict';
const { db } = require('./db');
const auth = require('./auth');
const billing = require('./billing');
const payment = require('./payment');
const { PERMISSIONS, ROLES } = auth;

function round2(n) { return Math.round(n * 100) / 100; }
function safeParse(s) { try { return JSON.parse(s || '[]'); } catch (_) { return []; } }
function nowIso() { return new Date().toISOString(); }

// 本地日期字符串 YYYY-MM-DD（按服务器本地时区）
function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pubUser(u) {
  return {
    id: u.id,
    username: u.username,
    qq: u.qq || '',
    role: u.role,
    permissions: safeParse(u.permissions),
    balanceCents: u.balance_cents,
    balanceYuan: round2(u.balance_cents / 100),
  };
}

function capsFor(u) {
  return {
    isSuper: u.role === ROLES.SUPER_ADMIN,
    isAdmin: auth.isAdmin(u),
    RECHARGE: auth.hasPermission(u, PERMISSIONS.RECHARGE),
    MANAGE_PRICING: auth.hasPermission(u, PERMISSIONS.MANAGE_PRICING),
    VIEW_REPORTS: auth.hasPermission(u, PERMISSIONS.VIEW_REPORTS),
    MANAGE_USERS: auth.hasPermission(u, PERMISSIONS.MANAGE_USERS),
  };
}

function activeVisitOf(userId) {
  return db.prepare("SELECT * FROM visits WHERE user_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1").get(userId);
}

// ---------- 鉴权相关 ----------

function createSession(ctx, userId) {
  const token = auth.randomToken();
  db.prepare('INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, nowIso());
  ctx.setCookie('sid', token, { httpOnly: true, path: '/', sameSite: 'Lax', maxAge: 60 * 60 * 24 * 30 });
  return token;
}

function register(ctx) {
  const { username, password, qq } = ctx.body || {};
  if (!username || !String(username).trim()) return ctx.fail('请填写用户名');
  if (!password || String(password).length < 4) return ctx.fail('密码至少 4 位');
  if (!qq || !String(qq).trim()) return ctx.fail('请填写 QQ 号');
  const uname = String(username).trim();
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (exists) return ctx.fail('该用户名已被注册');
  const info = db.prepare(
    "INSERT INTO users (username, qq, password_hash, role, permissions, balance_cents, created_at) VALUES (?, ?, ?, 'USER', '[]', 0, ?)"
  ).run(uname, String(qq).trim(), auth.hashPassword(password), nowIso());
  createSession(ctx, info.lastInsertRowid);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return ctx.json({ ok: true, user: pubUser(u) });
}

function login(ctx) {
  const { username, password } = ctx.body || {};
  if (!username || !password) return ctx.fail('请输入用户名和密码');
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!u || !auth.verifyPassword(password, u.password_hash)) return ctx.fail('用户名或密码错误', 401);
  createSession(ctx, u.id);
  return ctx.json({ ok: true, user: pubUser(u) });
}

function logout(ctx) {
  if (ctx.token) db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(ctx.token);
  ctx.setCookie('sid', '', { httpOnly: true, path: '/', maxAge: 0 });
  return ctx.json({ ok: true });
}

// ---------- 状态 ----------

function status(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);

  const av = activeVisitOf(me.id);
  let activeVisit = null;
  if (av) {
    const p = billing.projectVisit(av, Date.now());
    activeVisit = {
      id: av.id,
      billable: !!av.billable,
      startTime: av.start_time,
      elapsedSec: p.elapsedSec,
      currentCostCents: round2(p.currentCost),
      currentCostYuan: round2(p.currentCost / 100),
      projectedBalanceCents: p.projectedBalance == null ? null : round2(p.projectedBalance),
      projectedBalanceYuan: p.projectedBalance == null ? null : round2(p.projectedBalance / 100),
      rateNowCents: p.rateNow,
      rateNowYuan: round2(p.rateNow / 100),
    };
  }

  // 在店人员（ACTIVE 访问 join 用户）
  const inStore = db.prepare(`
    SELECT v.id AS vid, v.start_time, v.billable, u.id AS uid, u.username, u.role
    FROM visits v JOIN users u ON u.id = v.user_id
    WHERE v.status = 'ACTIVE'
    ORDER BY v.start_time ASC
  `).all();

  const customers = inStore.filter((r) => r.billable === 1);
  const admins = inStore.filter((r) => r.billable === 0);

  const store = {
    userCount: customers.length,
    adminCount: admins.length,
    adminNames: admins.map((a) => a.username), // 所有人可见管理员名字
  };

  // 仅管理员可见全部在店人名
  if (auth.isAdmin(me)) {
    store.people = inStore.map((r) => ({
      id: r.uid,
      username: r.username,
      role: r.role,
      startTime: r.start_time,
      elapsedSec: Math.max(0, Math.floor((Date.now() - Date.parse(r.start_time)) / 1000)),
    }));
  }

  const rules = billing.getPricingRules().map((r) => ({
    startHour: r.start_hour, endHour: r.end_hour, rateCents: r.rate_cents, rateYuan: round2(r.rate_cents / 100),
  }));

  return ctx.json({
    user: pubUser(me),
    caps: capsFor(me),
    activeVisit,
    store,
    pricing: rules,
    serverTime: nowIso(),
  });
}

// ---------- 进店 / 离店 ----------

function visitStart(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  if (activeVisitOf(me.id)) return ctx.fail('你已在店内，无需重复进店');
  const billable = me.role === ROLES.USER ? 1 : 0;
  if (billable && me.balance_cents <= 0) return ctx.fail('余额不足，请先联系管理员充值');
  const t = nowIso();
  db.prepare(
    "INSERT INTO visits (user_id, start_time, end_time, last_tick, charged_cents, status, billable, end_reason) VALUES (?, ?, NULL, ?, 0, 'ACTIVE', ?, NULL)"
  ).run(me.id, t, t, billable);
  return ctx.json({ ok: true });
}

function visitEnd(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const av = activeVisitOf(ctx.user.id);
  if (!av) return ctx.fail('你当前不在店内');
  const settled = billing.settleVisit(av, Date.now(), true);
  const durationSec = Math.max(0, Math.floor((Date.parse(settled.end_time) - Date.parse(settled.start_time)) / 1000));
  return ctx.json({
    ok: true,
    durationSec,
    chargedCents: round2(settled.charged_cents),
    chargedYuan: round2(settled.charged_cents / 100),
    reason: settled.end_reason,
  });
}

// ---------- 管理员：用户与充值 ----------

function requirePerm(ctx, perm) {
  if (!ctx.user) { ctx.fail('未登录', 401); return false; }
  if (!auth.hasPermission(ctx.user, perm)) { ctx.fail('无权限执行该操作', 403); return false; }
  return true;
}

function adminUsers(ctx) {
  if (!ctx.user || !auth.isAdmin(ctx.user)) return ctx.fail('无权限', 403);
  if (!auth.hasPermission(ctx.user, PERMISSIONS.MANAGE_USERS) && !auth.hasPermission(ctx.user, PERMISSIONS.RECHARGE)) {
    return ctx.fail('无权限查看用户', 403);
  }
  const rows = db.prepare('SELECT * FROM users ORDER BY id ASC').all();
  const activeIds = new Set(db.prepare("SELECT user_id FROM visits WHERE status = 'ACTIVE'").all().map((r) => r.user_id));
  return ctx.json({
    users: rows.map((u) => ({ ...pubUser(u), inStore: activeIds.has(u.id) })),
  });
}

function adminRecharge(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.RECHARGE)) return;
  const { userId, amountYuan, note } = ctx.body || {};
  const amount = Number(amountYuan);
  if (!userId || !Number.isFinite(amount) || amount <= 0) return ctx.fail('请填写有效的充值金额');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  const cents = Math.round(amount * 100);
  const newBal = u.balance_cents + cents;
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(newBal, u.id);
  db.prepare(
    "INSERT INTO transactions (user_id, type, amount_cents, operator_id, visit_id, note, created_at) VALUES (?, 'RECHARGE', ?, ?, NULL, ?, ?)"
  ).run(u.id, cents, ctx.user.id, note ? String(note) : '人工充值', nowIso());
  return ctx.json({ ok: true, balanceYuan: round2(newBal / 100) });
}

// ---------- 管理员：定价 ----------

function adminGetPricing(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_PRICING)) return;
  const rules = billing.getPricingRules().map((r) => ({
    startHour: r.start_hour, endHour: r.end_hour, rateYuan: round2(r.rate_cents / 100),
  }));
  return ctx.json({ rules });
}

function adminSetPricing(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_PRICING)) return;
  const { rules } = ctx.body || {};
  if (!Array.isArray(rules) || rules.length === 0) return ctx.fail('请至少设置一条时价规则');
  const parsed = [];
  for (const r of rules) {
    const sh = Number(r.startHour), eh = Number(r.endHour), rate = Number(r.rateYuan);
    if (!Number.isInteger(sh) || !Number.isInteger(eh) || sh < 0 || eh > 24 || sh >= eh) {
      return ctx.fail('时间段不合法（0-24 整点，开始须小于结束）');
    }
    if (!Number.isFinite(rate) || rate < 0) return ctx.fail('单价不合法');
    parsed.push({ sh, eh, cents: Math.round(rate * 100) });
  }
  parsed.sort((a, b) => a.sh - b.sh);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].sh < parsed[i - 1].eh) return ctx.fail('时间段不能重叠');
  }
  db.exec('DELETE FROM pricing_rules');
  const ins = db.prepare('INSERT INTO pricing_rules (start_hour, end_hour, rate_cents) VALUES (?, ?, ?)');
  for (const p of parsed) ins.run(p.sh, p.eh, p.cents);
  return ctx.json({ ok: true });
}

// ---------- 管理员：报表 ----------

function adminReports(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.VIEW_REPORTS)) return;
  const dateStr = (ctx.query.date && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date)) ? ctx.query.date : localDate(new Date());

  // 当日访问记录（按 start_time 的本地日期）
  const allVisits = db.prepare(`
    SELECT v.*, u.username FROM visits v JOIN users u ON u.id = v.user_id
    ORDER BY v.start_time DESC
  `).all();
  const dayVisits = allVisits.filter((v) => localDate(new Date(Date.parse(v.start_time))) === dateStr);
  const records = dayVisits.map((v) => {
    const endMs = v.end_time ? Date.parse(v.end_time) : Date.now();
    return {
      username: v.username,
      billable: !!v.billable,
      startTime: v.start_time,
      endTime: v.end_time,
      durationSec: Math.max(0, Math.floor((endMs - Date.parse(v.start_time)) / 1000)),
      chargedYuan: round2(v.charged_cents / 100),
      status: v.status,
      endReason: v.end_reason,
    };
  });

  // 营收（按 CHARGE 流水的本地日期）
  const charges = db.prepare("SELECT amount_cents, created_at FROM transactions WHERE type = 'CHARGE'").all();
  const dayRevenueCents = charges
    .filter((c) => localDate(new Date(Date.parse(c.created_at))) === dateStr)
    .reduce((s, c) => s + c.amount_cents, 0);

  // 近 7 天营收曲线（以 dateStr 为最后一天往前 7 天）
  const buckets = {};
  const labels = [];
  const base = new Date(dateStr + 'T00:00:00');
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    const key = localDate(d);
    buckets[key] = 0;
    labels.push(key);
  }
  for (const c of charges) {
    const key = localDate(new Date(Date.parse(c.created_at)));
    if (key in buckets) buckets[key] += c.amount_cents;
  }
  const weekly = labels.map((k) => ({ date: k, revenueYuan: round2(buckets[k] / 100) }));

  return ctx.json({
    date: dateStr,
    dayRevenueYuan: round2(dayRevenueCents / 100),
    customerVisits: records.filter((r) => r.billable).length,
    records,
    weekly,
  });
}

// ---------- 总管理员：角色与权限 ----------

function setRole(ctx) {
  if (!ctx.user || ctx.user.role !== ROLES.SUPER_ADMIN) return ctx.fail('仅总管理员可操作', 403);
  const { userId, role } = ctx.body || {};
  if (![ROLES.SUB_ADMIN, ROLES.USER].includes(role)) return ctx.fail('角色不合法');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  if (u.role === ROLES.SUPER_ADMIN) return ctx.fail('不能修改总管理员');
  const perms = role === ROLES.USER ? '[]' : u.permissions;
  db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?').run(role, perms, u.id);
  return ctx.json({ ok: true });
}

function setPermissions(ctx) {
  if (!ctx.user || ctx.user.role !== ROLES.SUPER_ADMIN) return ctx.fail('仅总管理员可操作', 403);
  const { userId, permissions } = ctx.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  if (u.role !== ROLES.SUB_ADMIN) return ctx.fail('只能给分管理员分配权限');
  if (!Array.isArray(permissions)) return ctx.fail('权限格式错误');
  const valid = Object.values(PERMISSIONS);
  const clean = permissions.filter((p) => valid.includes(p));
  db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(clean), u.id);
  return ctx.json({ ok: true });
}

// ---------- 修改密码（全角色） ----------

function changePassword(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const { oldPassword, newPassword } = ctx.body || {};
  if (!oldPassword || !newPassword) return ctx.fail('请填写原密码与新密码');
  if (String(newPassword).length < 4) return ctx.fail('新密码至少 4 位');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  if (!auth.verifyPassword(oldPassword, u.password_hash)) return ctx.fail('原密码不正确');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(newPassword), u.id);
  // 安全起见：踢掉除当前会话外的其它登录
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND token != ?').run(u.id, ctx.token || '');
  return ctx.json({ ok: true });
}

// ---------- 管理员：强制结束他人会话 ----------

function adminEndVisit(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_USERS)) return;
  const { userId } = ctx.body || {};
  const av = activeVisitOf(Number(userId));
  if (!av) return ctx.fail('该用户当前不在店内');
  const settled = billing.settleVisit(av, Date.now(), true);
  return ctx.json({
    ok: true,
    chargedYuan: round2(settled.charged_cents / 100),
    durationSec: Math.max(0, Math.floor((Date.parse(settled.end_time) - Date.parse(settled.start_time)) / 1000)),
  });
}

// ---------- 在线充值（可插拔支付） ----------

function rechargeMethods(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  return ctx.json({ methods: payment.availableMethods() });
}

function rechargeCreate(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const { amountYuan, method } = ctx.body || {};
  const amount = Number(amountYuan);
  if (!Number.isFinite(amount) || amount <= 0) return ctx.fail('请填写有效的充值金额');
  if (amount > 100000) return ctx.fail('单笔充值金额过大');
  try {
    const order = payment.createOrder(ctx.user.id, Math.round(amount * 100), String(method || 'mock'));
    return ctx.json({ ok: true, orderNo: order.orderNo, method: order.method, amountYuan: round2(order.amountCents / 100), pay: order.pay });
  } catch (e) { return ctx.fail(e.message); }
}

function rechargeConfirm(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const { orderNo } = ctx.body || {};
  const order = payment.getOrder(String(orderNo || ''));
  if (!order || order.user_id !== ctx.user.id) return ctx.fail('订单不存在');
  // 仅模拟网关允许前端直接确认；真实渠道由网关异步回调入账。
  if (order.method !== 'mock') return ctx.fail('该支付方式请通过扫码完成，到账以支付平台回调为准');
  try {
    payment.markPaid(orderNo);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    return ctx.json({ ok: true, balanceYuan: round2(u.balance_cents / 100) });
  } catch (e) { return ctx.fail(e.message); }
}

function rechargeStatus(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const order = payment.getOrder(String(ctx.query.orderNo || ''));
  if (!order || order.user_id !== ctx.user.id) return ctx.fail('订单不存在');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  return ctx.json({ status: order.status, amountYuan: round2(order.amount_cents / 100), balanceYuan: round2(u.balance_cents / 100) });
}

// ---------- 流水明细 ----------

// 将原始流水整理为友好列表：RECHARGE 逐条；CHARGE 按访问(visit)聚合为一条。
function buildTxList(rows) {
  const items = [];
  const chargeByVisit = new Map();
  for (const r of rows) {
    if (r.type === 'CHARGE' && r.visit_id) {
      const g = chargeByVisit.get(r.visit_id) || { amount: 0, last: r.created_at, username: r.username, visitId: r.visit_id };
      g.amount += r.amount_cents;
      if (r.created_at > g.last) g.last = r.created_at;
      chargeByVisit.set(r.visit_id, g);
    } else {
      items.push({
        type: r.type, amountYuan: round2(r.amount_cents / 100), time: r.created_at,
        note: r.note || '', username: r.username,
      });
    }
  }
  for (const g of chargeByVisit.values()) {
    items.push({ type: 'CHARGE', amountYuan: round2(g.amount / 100), time: g.last, note: '游玩消费', username: g.username, visitId: g.visitId });
  }
  items.sort((a, b) => (a.time < b.time ? 1 : -1));
  return items;
}

function myTransactions(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 500').all(ctx.user.id);
  return ctx.json({ items: buildTxList(rows).slice(0, 200) });
}

function adminTransactions(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.VIEW_REPORTS)) return;
  const userId = ctx.query.userId ? Number(ctx.query.userId) : null;
  const type = ctx.query.type && ['RECHARGE', 'CHARGE'].includes(ctx.query.type) ? ctx.query.type : null;
  let sql = 'SELECT t.*, u.username FROM transactions t JOIN users u ON u.id = t.user_id WHERE 1=1';
  const args = [];
  if (userId) { sql += ' AND t.user_id = ?'; args.push(userId); }
  if (type) { sql += ' AND t.type = ?'; args.push(type); }
  sql += ' ORDER BY t.created_at DESC LIMIT 1000';
  const rows = db.prepare(sql).all(...args);
  return ctx.json({ items: buildTxList(rows).slice(0, 300) });
}

module.exports = {
  register, login, logout, status,
  visitStart, visitEnd,
  adminUsers, adminRecharge,
  adminGetPricing, adminSetPricing,
  adminReports,
  setRole, setPermissions,
  changePassword, adminEndVisit,
  rechargeMethods, rechargeCreate, rechargeConfirm, rechargeStatus,
  myTransactions, adminTransactions,
};
