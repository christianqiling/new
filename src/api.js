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

// 展示名：优先昵称，否则用户名
function displayName(u) {
  const n = (u.nickname || '').trim();
  return n || u.username;
}
// 姓名打码：取首字符 + **
function maskName(name) {
  const a = [...String(name || '')];
  if (!a.length) return '**';
  return a[0] + '**';
}

function pubUser(u) {
  return {
    id: u.id,
    username: u.username,
    qq: u.qq || '',
    nickname: u.nickname || '',
    displayName: displayName(u),
    avatar: u.avatar || null,
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

// ---------- 操作密码（敏感的用户管理操作需校验） ----------
function getOpHash() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'op_password'").get();
  return row ? row.value : null;
}
function verifyOpOrFail(ctx) {
  const pw = (ctx.body || {}).opPassword;
  const hash = getOpHash();
  if (!hash || !auth.verifyPassword(pw || '', hash)) {
    ctx.fail('操作密码错误', 403);
    return false;
  }
  return true;
}

// ---------- 鉴权相关 ----------

function createSession(ctx, userId) {
  const token = auth.randomToken();
  db.prepare('INSERT INTO auth_tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, nowIso());
  ctx.setCookie('sid', token, { httpOnly: true, path: '/', sameSite: 'Lax', maxAge: 60 * 60 * 24 * 30 });
  return token;
}

function register(ctx) {
  const { username, password, qq, nickname } = ctx.body || {};
  if (!username || !String(username).trim()) return ctx.fail('请填写用户名');
  if (!password || String(password).length < 4) return ctx.fail('密码至少 4 位');
  if (!qq || !String(qq).trim()) return ctx.fail('请填写 QQ 号');
  const uname = String(username).trim();
  const exists = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(uname);
  if (exists) return ctx.fail('该用户名已被注册');
  const info = db.prepare(
    "INSERT INTO users (username, qq, nickname, password_hash, role, permissions, balance_cents, created_at) VALUES (?, ?, ?, ?, 'USER', '[]', 0, ?)"
  ).run(uname, String(qq).trim(), (nickname ? String(nickname).trim() : ''), auth.hashPassword(password), nowIso());
  createSession(ctx, info.lastInsertRowid);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return ctx.json({ ok: true, user: pubUser(u) });
}

function login(ctx) {
  const { username, password } = ctx.body || {};
  if (!username || !password) return ctx.fail('请输入用户名和密码');
  const u = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim());
  if (!u || !auth.verifyPassword(password, u.password_hash)) return ctx.fail('用户名或密码错误', 401);
  createSession(ctx, u.id);
  return ctx.json({ ok: true, user: pubUser(u) });
}

function logout(ctx) {
  if (ctx.token) db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(ctx.token);
  ctx.setCookie('sid', '', { httpOnly: true, path: '/', maxAge: 0 });
  return ctx.json({ ok: true });
}

// 注册时实时检测用户名可用性（大小写不敏感）
function checkUsername(ctx) {
  const name = String(ctx.query.username || '').trim();
  if (!name) return ctx.json({ available: false, reason: 'empty' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name);
  return ctx.json({ available: !exists });
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
    SELECT v.start_time, v.billable, u.id AS uid, u.username, u.nickname, u.avatar, u.role
    FROM visits v JOIN users u ON u.id = v.user_id
    WHERE v.status = 'ACTIVE'
    ORDER BY v.start_time ASC
  `).all();

  const viewerAdmin = auth.isAdmin(me);
  const people = inStore.map((r) => {
    const isCustomer = r.billable === 1;
    const dn = (r.nickname && r.nickname.trim()) ? r.nickname.trim() : r.username;
    const entry = {
      isCustomer,
      role: r.role,
      avatar: r.avatar || null,
      initial: ([...dn][0] || '?'),
      startTime: r.start_time,
      elapsedSec: Math.max(0, Math.floor((Date.now() - Date.parse(r.start_time)) / 1000)),
    };
    if (viewerAdmin) {
      // 管理员可看到全部全名
      entry.id = r.uid;
      entry.name = dn;
    } else {
      // 顾客之间：顾客名字打码，管理员名字全员可见
      entry.name = isCustomer ? maskName(dn) : dn;
    }
    return entry;
  });

  const store = {
    userCount: inStore.filter((r) => r.billable === 1).length,
    adminCount: inStore.filter((r) => r.billable === 0).length,
    people,
  };

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

// ---------- 我的信息（全角色） ----------

function profileUpdate(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const { username, nickname } = ctx.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  const uname = username != null ? String(username).trim() : u.username;
  if (!uname) return ctx.fail('用户名不能为空');
  if (uname !== u.username) {
    const exists = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(uname, u.id);
    if (exists) return ctx.fail('该用户名已被占用');
  }
  const nick = nickname != null ? String(nickname).trim() : (u.nickname || '');
  db.prepare('UPDATE users SET username = ?, nickname = ? WHERE id = ?').run(uname, nick, u.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  return ctx.json({ ok: true, user: pubUser(fresh) });
}

function profileAvatar(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const { avatar } = ctx.body || {};
  if (typeof avatar !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(avatar)) {
    return ctx.fail('头像格式不支持');
  }
  if (avatar.length > 2 * 1024 * 1024) return ctx.fail('头像过大，请重新选择');
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, ctx.user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  return ctx.json({ ok: true, user: pubUser(fresh) });
}

function profileAvatarReset(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(ctx.user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  return ctx.json({ ok: true, user: pubUser(fresh) });
}

function changePassword(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const { oldPassword, newPassword } = ctx.body || {};
  if (!oldPassword || !newPassword) return ctx.fail('请填写原密码与新密码');
  if (String(newPassword).length < 4) return ctx.fail('新密码至少 4 位');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  if (!auth.verifyPassword(oldPassword, u.password_hash)) return ctx.fail('原密码不正确');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(newPassword), u.id);
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND token != ?').run(u.id, ctx.token || '');
  return ctx.json({ ok: true });
}

// ---------- 管理员：强制结束他人会话 ----------

function requirePerm(ctx, perm) {
  if (!ctx.user) { ctx.fail('未登录', 401); return false; }
  if (!auth.hasPermission(ctx.user, perm)) { ctx.fail('无权限执行该操作', 403); return false; }
  return true;
}

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

// ---------- 用户列表（合并：列表 / 增删改 / 余额 / 角色权限 / 重置头像） ----------

function adminUsers(ctx) {
  if (!ctx.user || !auth.isAdmin(ctx.user)) return ctx.fail('无权限', 403);
  if (!auth.hasPermission(ctx.user, PERMISSIONS.MANAGE_USERS)) return ctx.fail('无权限查看用户', 403);
  const rows = db.prepare('SELECT * FROM users ORDER BY id ASC').all();
  const activeIds = new Set(db.prepare("SELECT user_id FROM visits WHERE status = 'ACTIVE'").all().map((r) => r.user_id));
  return ctx.json({
    users: rows.map((u) => ({ ...pubUser(u), inStore: activeIds.has(u.id) })),
  });
}

function usersCreate(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_USERS)) return;
  if (!verifyOpOrFail(ctx)) return;
  const { username, password, qq, nickname } = ctx.body || {};
  if (!username || !String(username).trim()) return ctx.fail('请填写用户名');
  if (!password || String(password).length < 4) return ctx.fail('密码至少 4 位');
  const uname = String(username).trim();
  if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(uname)) return ctx.fail('该用户名已存在');
  db.prepare(
    "INSERT INTO users (username, qq, nickname, password_hash, role, permissions, balance_cents, created_at) VALUES (?, ?, ?, ?, 'USER', '[]', 0, ?)"
  ).run(uname, qq ? String(qq).trim() : '', nickname ? String(nickname).trim() : '', auth.hashPassword(password), nowIso());
  return ctx.json({ ok: true });
}

function usersUpdate(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_USERS)) return;
  if (!verifyOpOrFail(ctx)) return;
  const { userId, username, qq, nickname, balanceYuan } = ctx.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');

  const uname = username != null ? String(username).trim() : u.username;
  if (!uname) return ctx.fail('用户名不能为空');
  if (uname !== u.username && db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(uname, u.id)) {
    return ctx.fail('该用户名已被占用');
  }
  const nqq = qq != null ? String(qq).trim() : (u.qq || '');
  const nick = nickname != null ? String(nickname).trim() : (u.nickname || '');

  let newBalance = u.balance_cents;
  if (balanceYuan != null && balanceYuan !== '') {
    const b = Number(balanceYuan);
    if (!Number.isFinite(b) || b < 0) return ctx.fail('余额不合法');
    newBalance = Math.round(b * 100);
  }

  db.prepare('UPDATE users SET username = ?, qq = ?, nickname = ?, balance_cents = ? WHERE id = ?')
    .run(uname, nqq, nick, newBalance, u.id);

  // 余额变动记录一笔调整流水（不计入营业额）
  const delta = newBalance - u.balance_cents;
  if (delta !== 0) {
    db.prepare(
      "INSERT INTO transactions (user_id, type, amount_cents, operator_id, visit_id, note, created_at) VALUES (?, 'ADJUST', ?, ?, NULL, '管理员调整余额', ?)"
    ).run(u.id, delta, ctx.user.id, nowIso());
  }
  return ctx.json({ ok: true });
}

function usersDelete(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_USERS)) return;
  if (!verifyOpOrFail(ctx)) return;
  const { userId } = ctx.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  if (u.role === ROLES.SUPER_ADMIN) return ctx.fail('不能删除超级管理员');
  if (u.id === ctx.user.id) return ctx.fail('不能删除自己');
  // 清理关联数据
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM payment_orders WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM transactions WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM visits WHERE user_id = ?').run(u.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  return ctx.json({ ok: true });
}

function usersResetAvatar(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_USERS)) return;
  if (!verifyOpOrFail(ctx)) return;
  const { userId } = ctx.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(u.id);
  return ctx.json({ ok: true });
}

// 角色与权限（仅超级管理员，且需操作密码）
function setRole(ctx) {
  if (!ctx.user || ctx.user.role !== ROLES.SUPER_ADMIN) return ctx.fail('仅超级管理员可操作', 403);
  if (!verifyOpOrFail(ctx)) return;
  const { userId, role } = ctx.body || {};
  if (![ROLES.SUB_ADMIN, ROLES.USER].includes(role)) return ctx.fail('角色不合法');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  if (u.role === ROLES.SUPER_ADMIN) return ctx.fail('不能修改超级管理员');
  const perms = role === ROLES.USER ? '[]' : u.permissions;
  db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?').run(role, perms, u.id);
  return ctx.json({ ok: true });
}

function setPermissions(ctx) {
  if (!ctx.user || ctx.user.role !== ROLES.SUPER_ADMIN) return ctx.fail('仅超级管理员可操作', 403);
  if (!verifyOpOrFail(ctx)) return;
  const { userId, permissions } = ctx.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  if (u.role !== ROLES.SUB_ADMIN) return ctx.fail('只能给管理员分配权限');
  if (!Array.isArray(permissions)) return ctx.fail('权限格式错误');
  const valid = Object.values(PERMISSIONS);
  const clean = permissions.filter((p) => valid.includes(p));
  db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(clean), u.id);
  return ctx.json({ ok: true });
}

// 修改操作密码（仅超级管理员）
function opPasswordSet(ctx) {
  if (!ctx.user || ctx.user.role !== ROLES.SUPER_ADMIN) return ctx.fail('仅超级管理员可操作', 403);
  const { oldPassword, newPassword } = ctx.body || {};
  const hash = getOpHash();
  if (hash && !auth.verifyPassword(oldPassword || '', hash)) return ctx.fail('原操作密码不正确');
  if (!newPassword || String(newPassword).length < 4) return ctx.fail('新操作密码至少 4 位');
  db.prepare("INSERT INTO settings (key, value) VALUES ('op_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(auth.hashPassword(String(newPassword)));
  return ctx.json({ ok: true });
}

// ---------- 定价 ----------

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

// ---------- 报表 ----------

function adminReports(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.VIEW_REPORTS)) return;
  const dateStr = (ctx.query.date && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date)) ? ctx.query.date : localDate(new Date());

  const allVisits = db.prepare(`
    SELECT v.*, u.username, u.nickname FROM visits v JOIN users u ON u.id = v.user_id
    ORDER BY v.start_time DESC
  `).all();
  const dayVisits = allVisits.filter((v) => localDate(new Date(Date.parse(v.start_time))) === dateStr);
  const records = dayVisits.map((v) => {
    const endMs = v.end_time ? Date.parse(v.end_time) : Date.now();
    return {
      username: displayName(v),
      billable: !!v.billable,
      startTime: v.start_time,
      endTime: v.end_time,
      durationSec: Math.max(0, Math.floor((endMs - Date.parse(v.start_time)) / 1000)),
      chargedYuan: round2(v.charged_cents / 100),
      status: v.status,
      endReason: v.end_reason,
    };
  });

  const charges = db.prepare("SELECT amount_cents, created_at FROM transactions WHERE type = 'CHARGE'").all();
  const dayRevenueCents = charges
    .filter((c) => localDate(new Date(Date.parse(c.created_at))) === dateStr)
    .reduce((s, c) => s + c.amount_cents, 0);

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

// ---------- 在线充值（框架保留；mock 默认关闭） ----------

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

// RECHARGE / ADJUST 逐条；CHARGE 按访问(visit)聚合为一条。
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
  const type = ctx.query.type && ['RECHARGE', 'CHARGE', 'ADJUST'].includes(ctx.query.type) ? ctx.query.type : null;
  let sql = 'SELECT t.*, u.username, u.nickname FROM transactions t JOIN users u ON u.id = t.user_id WHERE 1=1';
  const args = [];
  if (userId) { sql += ' AND t.user_id = ?'; args.push(userId); }
  if (type) { sql += ' AND t.type = ?'; args.push(type); }
  sql += ' ORDER BY t.created_at DESC LIMIT 1000';
  const rows = db.prepare(sql).all(...args).map((r) => ({ ...r, username: (r.nickname && r.nickname.trim()) ? r.nickname.trim() : r.username }));
  return ctx.json({ items: buildTxList(rows).slice(0, 300) });
}

module.exports = {
  register, login, logout, status, checkUsername,
  visitStart, visitEnd,
  profileUpdate, profileAvatar, profileAvatarReset, changePassword,
  adminEndVisit,
  adminUsers, usersCreate, usersUpdate, usersDelete, usersResetAvatar,
  setRole, setPermissions, opPasswordSet,
  adminGetPricing, adminSetPricing, adminReports,
  rechargeMethods, rechargeCreate, rechargeConfirm, rechargeStatus,
  myTransactions, adminTransactions,
};
