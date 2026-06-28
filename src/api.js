'use strict';
const crypto = require('node:crypto');
const { db } = require('./db');
const auth = require('./auth');
const billing = require('./billing');
const payment = require('./payment');
const xlsx = require('./xlsx');
const { PERMISSIONS, ROLES } = auth;

// 内存令牌：扫码充值令牌 / 超级管理员授权二维码
const rechargeCodes = new Map();
const superAuthCodes = new Map();

function roleLabel(r) { return { SUPER_ADMIN: '超级管理员', SUB_ADMIN: '管理员', USER: '用户' }[r] || r; }
function round2(n) { return Math.round(n * 100) / 100; }
function safeParse(s) { try { return JSON.parse(s || '[]'); } catch (_) { return []; } }
function nowIso() { return new Date().toISOString(); }
function localDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function displayName(u) { const n = (u.nickname || '').trim(); return n || u.username; }
function getSetting(key) { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; }

function pubUser(u) {
  return {
    id: u.id, username: u.username, qq: u.qq || '', nickname: u.nickname || '',
    displayName: displayName(u), avatar: u.avatar || null, role: u.role,
    permissions: safeParse(u.permissions),
    balanceCents: u.balance_cents, balanceYuan: round2(u.balance_cents / 100),
    freeCents: u.free_cents || 0, freeYuan: round2((u.free_cents || 0) / 100),
  };
}
function capsFor(u) {
  return {
    isSuper: u.role === ROLES.SUPER_ADMIN, isAdmin: auth.isAdmin(u),
    RECHARGE: auth.hasPermission(u, PERMISSIONS.RECHARGE),
    MANAGE_PRICING: auth.hasPermission(u, PERMISSIONS.MANAGE_PRICING),
    VIEW_REPORTS: auth.hasPermission(u, PERMISSIONS.VIEW_REPORTS),
    MANAGE_USERS: auth.hasPermission(u, PERMISSIONS.MANAGE_USERS),
    MANAGE_CARDS: auth.hasPermission(u, PERMISSIONS.MANAGE_CARDS),
    GRANT_FREE: auth.hasPermission(u, PERMISSIONS.GRANT_FREE),
  };
}
function activeVisitOf(userId) {
  return db.prepare("SELECT * FROM visits WHERE user_id = ? AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1").get(userId);
}

// ---------- 分级鉴权 ----------
function verifyAdminPw(u, pw) { return !!(u && u.admin_password_hash && auth.verifyPassword(pw || '', u.admin_password_hash)); }
function verifyLevel2(pw) { const h = getSetting('level2_password'); return !!(h && auth.verifyPassword(pw || '', h)); }
function getSuperUser() { return db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN' ORDER BY id ASC LIMIT 1").get(); }
function verifySuperPw(pw) { const s = getSuperUser(); return !!(s && auth.verifyPassword(pw || '', s.password_hash)); }
function verifySuperCard(cardNo) {
  const no = String(cardNo || '').trim(); if (!no) return false;
  const c = db.prepare('SELECT user_id FROM cards WHERE card_no = ?').get(no); if (!c) return false;
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(c.user_id);
  return !!(u && u.role === ROLES.SUPER_ADMIN);
}
function verifySuperQr(code) {
  const c = String(code || '').trim(); const rec = superAuthCodes.get(c);
  if (!rec) return false; if (rec.expires < Date.now()) { superAuthCodes.delete(c); return false; } return true;
}
function verifySuperAuth(b) { b = b || {}; return verifySuperPw(b.superPw) || verifySuperCard(b.superCard) || verifySuperQr(b.superQr); }

// 简单操作：本管理员密码（或二级统一密码）
function requireSimple(ctx) {
  const b = ctx.body || {};
  if (verifyAdminPw(ctx.user, b.adminPassword) || verifyLevel2(b.level2)) return true;
  ctx.fail('管理员密码错误', 403); return false;
}
// 重要操作：二级统一密码
function requireImportant(ctx) {
  if (verifyLevel2((ctx.body || {}).level2)) return true;
  ctx.fail('二级统一密码错误', 403); return false;
}
// 针对目标角色选择鉴权级别：操作管理员/超管=重要；操作普通用户=简单
function verifyForTarget(ctx, targetRole) {
  if (targetRole === ROLES.SUPER_ADMIN || targetRole === ROLES.SUB_ADMIN) return requireImportant(ctx);
  return requireSimple(ctx);
}
function requirePerm(ctx, perm) {
  if (!ctx.user) { ctx.fail('未登录', 401); return false; }
  if (!auth.hasPermission(ctx.user, perm)) { ctx.fail('无权限执行该操作', 403); return false; }
  return true;
}

// ---------- 会话/注册/登录 ----------
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
  if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(uname)) return ctx.fail('该用户名已被注册');
  const info = db.prepare(
    "INSERT INTO users (username, qq, nickname, password_hash, role, permissions, balance_cents, created_at) VALUES (?, ?, ?, ?, 'USER', '[]', 0, ?)"
  ).run(uname, String(qq).trim(), (nickname ? String(nickname).trim() : ''), auth.hashPassword(password), nowIso());
  createSession(ctx, info.lastInsertRowid);
  return ctx.json({ ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
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
function checkUsername(ctx) {
  const name = String(ctx.query.username || '').trim();
  if (!name) return ctx.json({ available: false, reason: 'empty' });
  return ctx.json({ available: !db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name) });
}

// ---------- 状态 ----------
function monthlyDurationSec(userId) {
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const vs = db.prepare('SELECT start_time, end_time FROM visits WHERE user_id = ?').all(userId);
  const now = Date.now(); let total = 0;
  for (const v of vs) {
    const s = Date.parse(v.start_time); if (s < monthStart.getTime()) continue;
    const e = v.end_time ? Date.parse(v.end_time) : now;
    total += Math.max(0, (e - s) / 1000);
  }
  return Math.floor(total);
}

function status(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  const av = activeVisitOf(me.id);
  let activeVisit = null;
  if (av) {
    const p = billing.projectVisit(av, Date.now());
    activeVisit = {
      id: av.id, billable: !!av.billable, startTime: av.start_time, elapsedSec: p.elapsedSec,
      currentCostCents: round2(p.currentCost), currentCostYuan: round2(p.currentCost / 100),
      projectedBalanceCents: p.projectedBalance == null ? null : round2(p.projectedBalance),
      projectedBalanceYuan: p.projectedBalance == null ? null : round2(p.projectedBalance / 100),
      projectedFreeCents: p.projectedFree == null ? null : round2(p.projectedFree),
      projectedFreeYuan: p.projectedFree == null ? null : round2(p.projectedFree / 100),
      rateNowCents: p.rateNow, rateNowYuan: round2(p.rateNow / 100),
    };
  }
  const inStore = db.prepare(`
    SELECT v.start_time, u.id AS uid, u.username, u.nickname, u.avatar, u.role
    FROM visits v JOIN users u ON u.id = v.user_id WHERE v.status = 'ACTIVE' ORDER BY v.start_time ASC
  `).all();
  const people = inStore.map((r) => {
    const isCustomer = r.role === ROLES.USER;
    const dn = (r.nickname && r.nickname.trim()) ? r.nickname.trim() : r.username;
    return {
      id: r.uid, isCustomer, role: r.role, avatar: r.avatar || null, initial: ([...dn][0] || '?'),
      name: dn, startTime: r.start_time, elapsedSec: Math.max(0, Math.floor((Date.now() - Date.parse(r.start_time)) / 1000)),
    };
  });
  const store = {
    userCount: people.filter((p) => p.isCustomer).length,
    adminCount: people.filter((p) => !p.isCustomer).length,
    customers: people.filter((p) => p.isCustomer),
    admins: people.filter((p) => !p.isCustomer),
  };
  const rules = billing.getPricingRules().map((r) => ({ startHour: r.start_hour, endHour: r.end_hour, rateCents: r.rate_cents, rateYuan: round2(r.rate_cents / 100) }));
  const baseFeeCents = Number(getSetting('base_fee_cents') || 0);
  return ctx.json({
    user: pubUser(me), caps: capsFor(me), activeVisit, store, pricing: rules,
    baseFeeYuan: round2(baseFeeCents / 100),
    monthlyDurationSec: auth.isAdmin(me) ? monthlyDurationSec(me.id) : null,
    serverTime: nowIso(),
  });
}

// ---------- 进店 / 离店 ----------
function visitStart(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  if (activeVisitOf(me.id)) return ctx.fail('你已在店内，无需重复进店');
  const billable = me.role === ROLES.USER ? 1 : 0; // 管理员不计费（仅记录在店时长）
  if (billable) {
    const available = (me.free_cents || 0) + me.balance_cents;
    if (available <= 0) return ctx.fail('可用额度不足（免费额度 + 余额需大于 0），请先充值');
  }
  const t = nowIso();
  const info = db.prepare(
    "INSERT INTO visits (user_id, start_time, end_time, last_tick, charged_cents, status, billable, end_reason) VALUES (?, ?, NULL, ?, 0, 'ACTIVE', ?, NULL)"
  ).run(me.id, t, t, billable);
  // 起步费（仅顾客）
  if (billable) {
    const baseFee = Number(getSetting('base_fee_cents') || 0);
    if (baseFee > 0) { billing.chargeOnce(me.id, info.lastInsertRowid, baseFee, '起步费'); db.prepare('UPDATE visits SET charged_cents = ? WHERE id = ?').run(baseFee, info.lastInsertRowid); }
  }
  return ctx.json({ ok: true });
}
function visitEnd(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const av = activeVisitOf(ctx.user.id);
  if (!av) return ctx.fail('你当前不在店内');
  const settled = billing.settleVisit(av, Date.now(), true);
  return ctx.json({
    ok: true,
    durationSec: Math.max(0, Math.floor((Date.parse(settled.end_time) - Date.parse(settled.start_time)) / 1000)),
    chargedYuan: round2(settled.charged_cents / 100), reason: settled.end_reason,
  });
}

// ---------- 我的信息 ----------
function profileUpdate(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const { username, nickname } = ctx.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  const uname = username != null ? String(username).trim() : u.username;
  if (!uname) return ctx.fail('用户名不能为空');
  if (uname !== u.username && db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(uname, u.id)) return ctx.fail('该用户名已被占用');
  const nick = nickname != null ? String(nickname).trim() : (u.nickname || '');
  db.prepare('UPDATE users SET username = ?, nickname = ? WHERE id = ?').run(uname, nick, u.id);
  return ctx.json({ ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
}
function profileAvatar(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const { avatar } = ctx.body || {};
  if (typeof avatar !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(avatar)) return ctx.fail('头像格式不支持');
  if (avatar.length > 2 * 1024 * 1024) return ctx.fail('头像过大，请重新选择');
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, ctx.user.id);
  return ctx.json({ ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id)) });
}
function profileAvatarReset(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(ctx.user.id);
  return ctx.json({ ok: true, user: pubUser(db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id)) });
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

// ---------- 卡片 ----------
function cardRow(c) { return { id: c.id, cardNo: c.card_no, createdAt: c.created_at }; }
function myCards(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  return ctx.json({ cards: db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY id ASC').all(ctx.user.id).map(cardRow) });
}
function cardDeleteSelf(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number((ctx.body || {}).cardId));
  if (!c || c.user_id !== ctx.user.id) return ctx.fail('卡片不存在');
  db.prepare('DELETE FROM cards WHERE id = ?').run(c.id);
  return ctx.json({ ok: true });
}
// 管理员自助添加自己的卡片（普通用户不可添加）
function cardAddSelf(ctx) {
  if (!ctx.user || !auth.isAdmin(ctx.user)) return ctx.fail('仅管理员可自助添加卡片', 403);
  const no = String((ctx.body || {}).cardNo || '').trim();
  if (!no) return ctx.fail('请输入卡号');
  if (db.prepare('SELECT COUNT(*) AS c FROM cards WHERE user_id = ?').get(ctx.user.id).c >= 3) return ctx.fail('最多 3 张卡片');
  if (db.prepare('SELECT id FROM cards WHERE card_no = ?').get(no)) return ctx.fail('该卡号已被绑定');
  db.prepare('INSERT INTO cards (user_id, card_no, created_at) VALUES (?, ?, ?)').run(ctx.user.id, no, nowIso());
  return ctx.json({ ok: true });
}
function adminUserCards(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_CARDS)) return;
  return ctx.json({ cards: db.prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY id ASC').all(Number(ctx.query.userId)).map(cardRow) });
}
function adminCardAdd(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_CARDS)) return;
  const { userId, cardNo } = ctx.body || {};
  const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  if (!verifyForTarget(ctx, u.role)) return;
  const no = String(cardNo || '').trim();
  if (!no) return ctx.fail('请输入卡号');
  if (db.prepare('SELECT COUNT(*) AS c FROM cards WHERE user_id = ?').get(u.id).c >= 3) return ctx.fail('每位用户最多 3 张卡片');
  if (db.prepare('SELECT id FROM cards WHERE card_no = ?').get(no)) return ctx.fail('该卡号已被绑定');
  db.prepare('INSERT INTO cards (user_id, card_no, created_at) VALUES (?, ?, ?)').run(u.id, no, nowIso());
  return ctx.json({ ok: true });
}
function adminCardDelete(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_CARDS)) return;
  const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(Number((ctx.body || {}).cardId));
  if (!c) return ctx.fail('卡片不存在');
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(c.user_id);
  if (!verifyForTarget(ctx, u ? u.role : ROLES.USER)) return;
  db.prepare('DELETE FROM cards WHERE id = ?').run(c.id);
  return ctx.json({ ok: true });
}

// ---------- 管理员：强制结束 ----------
function adminEndVisit(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_USERS)) return;
  const av = activeVisitOf(Number((ctx.body || {}).userId));
  if (!av) return ctx.fail('该用户当前不在店内');
  const settled = billing.settleVisit(av, Date.now(), true);
  return ctx.json({ ok: true, chargedYuan: round2(settled.charged_cents / 100), durationSec: Math.max(0, Math.floor((Date.parse(settled.end_time) - Date.parse(settled.start_time)) / 1000)) });
}

// ---------- 用户列表 ----------
function adminUsers(ctx) {
  if (!ctx.user || !auth.hasPermission(ctx.user, PERMISSIONS.MANAGE_USERS)) return ctx.fail('无权限查看用户', 403);
  const rows = db.prepare('SELECT * FROM users ORDER BY id ASC').all();
  const activeIds = new Set(db.prepare("SELECT user_id FROM visits WHERE status = 'ACTIVE'").all().map((r) => r.user_id));
  return ctx.json({ users: rows.map((u) => ({ ...pubUser(u), inStore: activeIds.has(u.id) })) });
}
function usersCreate(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_USERS)) return;
  if (!requireSimple(ctx)) return;
  const { username, password, qq, nickname } = ctx.body || {};
  if (!username || !String(username).trim()) return ctx.fail('请填写用户名');
  if (!password || String(password).length < 4) return ctx.fail('密码至少 4 位');
  const uname = String(username).trim();
  if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(uname)) return ctx.fail('该用户名已存在');
  db.prepare("INSERT INTO users (username, qq, nickname, password_hash, role, permissions, balance_cents, created_at) VALUES (?, ?, ?, ?, 'USER', '[]', 0, ?)")
    .run(uname, qq ? String(qq).trim() : '', nickname ? String(nickname).trim() : '', auth.hashPassword(password), nowIso());
  return ctx.json({ ok: true });
}
function usersUpdate(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_USERS)) return;
  const { userId, username, qq, nickname, balanceYuan, freeYuan } = ctx.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  if (!verifyForTarget(ctx, u.role)) return;
  const uname = username != null ? String(username).trim() : u.username;
  if (!uname) return ctx.fail('用户名不能为空');
  if (uname !== u.username && db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(uname, u.id)) return ctx.fail('该用户名已被占用');
  const nqq = qq != null ? String(qq).trim() : (u.qq || '');
  const nick = nickname != null ? String(nickname).trim() : (u.nickname || '');
  let newBalance = u.balance_cents;
  if (balanceYuan != null && balanceYuan !== '') { const b = Number(balanceYuan); if (!Number.isFinite(b)) return ctx.fail('余额不合法'); newBalance = Math.round(b * 100); }
  let newFree = u.free_cents || 0;
  if (freeYuan != null && freeYuan !== '') { const f = Number(freeYuan); if (!Number.isFinite(f) || f < 0) return ctx.fail('免费额度不合法'); newFree = Math.round(f * 100); }
  db.prepare('UPDATE users SET username = ?, qq = ?, nickname = ?, balance_cents = ?, free_cents = ? WHERE id = ?').run(uname, nqq, nick, newBalance, newFree, u.id);
  const delta = newBalance - u.balance_cents;
  if (delta !== 0) db.prepare("INSERT INTO transactions (user_id, type, amount_cents, operator_id, visit_id, note, created_at) VALUES (?, 'ADJUST', ?, ?, NULL, '管理员调整余额', ?)").run(u.id, delta, ctx.user.id, nowIso());
  return ctx.json({ ok: true });
}
function usersDelete(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_USERS)) return;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number((ctx.body || {}).userId));
  if (!u) return ctx.fail('用户不存在');
  if (u.role === ROLES.SUPER_ADMIN) return ctx.fail('不能删除超级管理员');
  if (u.id === ctx.user.id) return ctx.fail('不能删除自己');
  if (!verifyForTarget(ctx, u.role)) return;
  ['auth_tokens', 'payment_orders', 'transactions', 'visits', 'cards'].forEach((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(u.id));
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  return ctx.json({ ok: true });
}
function usersResetAvatar(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_USERS)) return;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number((ctx.body || {}).userId));
  if (!u) return ctx.fail('用户不存在');
  if (!verifyForTarget(ctx, u.role)) return;
  db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(u.id);
  return ctx.json({ ok: true });
}
// 角色与权限（超级管理员 + 二级统一密码）
function setRole(ctx) {
  if (!ctx.user || ctx.user.role !== ROLES.SUPER_ADMIN) return ctx.fail('仅超级管理员可操作', 403);
  if (!requireImportant(ctx)) return;
  const { userId, role } = ctx.body || {};
  if (![ROLES.SUB_ADMIN, ROLES.USER].includes(role)) return ctx.fail('角色不合法');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  if (u.role === ROLES.SUPER_ADMIN) return ctx.fail('不能修改超级管理员');
  const perms = role === ROLES.USER ? '[]' : u.permissions;
  let setPw = '';
  if (role === ROLES.SUB_ADMIN && (!u.admin_password_hash)) setPw = ', admin_password_hash = ' + "'" + auth.hashPassword('123456') + "'";
  db.prepare(`UPDATE users SET role = ?, permissions = ?${setPw} WHERE id = ?`).run(role, perms, u.id);
  return ctx.json({ ok: true });
}
function setPermissions(ctx) {
  if (!ctx.user || ctx.user.role !== ROLES.SUPER_ADMIN) return ctx.fail('仅超级管理员可操作', 403);
  if (!requireImportant(ctx)) return;
  const { userId, permissions } = ctx.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) return ctx.fail('用户不存在');
  if (u.role !== ROLES.SUB_ADMIN) return ctx.fail('只能给管理员分配权限');
  if (!Array.isArray(permissions)) return ctx.fail('权限格式错误');
  const valid = Object.values(PERMISSIONS);
  db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions.filter((p) => valid.includes(p))), u.id);
  return ctx.json({ ok: true });
}

// ---------- 密码管理 ----------
function level2PasswordSet(ctx) {
  if (!ctx.user || !auth.isAdmin(ctx.user)) return ctx.fail('无权限', 403);
  if (!verifySuperAuth(ctx.body)) return ctx.fail('需验证超级管理员授权（账户密码 / 二维码 / 卡片）', 403);
  const np = (ctx.body || {}).newPassword;
  if (!np || String(np).length < 4) return ctx.fail('新二级密码至少 4 位');
  db.prepare("INSERT INTO settings (key, value) VALUES ('level2_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(auth.hashPassword(String(np)));
  return ctx.json({ ok: true });
}
function myAdminPasswordSet(ctx) {
  if (!ctx.user || !auth.isAdmin(ctx.user)) return ctx.fail('无权限', 403);
  const b = ctx.body || {};
  if (!(verifyAdminPw(ctx.user, b.oldAdminPassword) || verifyLevel2(b.level2) || verifySuperQr(b.superQr))) return ctx.fail('需验证：原管理员密码 / 二级统一密码 / 超级管理员二维码', 403);
  if (!b.newPassword || String(b.newPassword).length < 4) return ctx.fail('新密码至少 4 位');
  db.prepare('UPDATE users SET admin_password_hash = ? WHERE id = ?').run(auth.hashPassword(String(b.newPassword)), ctx.user.id);
  return ctx.json({ ok: true });
}
function resetAdminPassword(ctx) {
  if (!ctx.user || ctx.user.role !== ROLES.SUPER_ADMIN) return ctx.fail('仅超级管理员可操作', 403);
  const b = ctx.body || {};
  if (!(verifyLevel2(b.level2) || verifySuperQr(b.superQr))) return ctx.fail('需验证：二级统一密码 或 超级管理员二维码', 403);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(b.userId));
  if (!u || !auth.isAdmin(u)) return ctx.fail('目标不是管理员');
  if (!b.newPassword || String(b.newPassword).length < 4) return ctx.fail('新密码至少 4 位');
  db.prepare('UPDATE users SET admin_password_hash = ? WHERE id = ?').run(auth.hashPassword(String(b.newPassword)), u.id);
  return ctx.json({ ok: true });
}
function superAuthCode(ctx) {
  if (!ctx.user || ctx.user.role !== ROLES.SUPER_ADMIN) return ctx.fail('仅超级管理员可操作', 403);
  const now = Date.now();
  for (const [k, v] of superAuthCodes) if (v.expires < now) superAuthCodes.delete(k);
  const code = 'SA' + crypto.randomBytes(6).toString('hex').toUpperCase();
  superAuthCodes.set(code, { expires: now + 60000 });
  return ctx.json({ code, ttl: 60 });
}

// ---------- 定价（含起步费） ----------
function adminGetPricing(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_PRICING)) return;
  const rules = billing.getPricingRules().map((r) => ({ startHour: r.start_hour, endHour: r.end_hour, rateYuan: round2(r.rate_cents / 100) }));
  return ctx.json({ rules, baseFeeYuan: round2(Number(getSetting('base_fee_cents') || 0) / 100) });
}
function adminSetPricing(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.MANAGE_PRICING)) return;
  const { rules, baseFeeYuan } = ctx.body || {};
  if (!Array.isArray(rules) || rules.length === 0) return ctx.fail('请至少设置一条时价规则');
  const parsed = [];
  for (const r of rules) {
    const sh = Number(r.startHour), eh = Number(r.endHour), rate = Number(r.rateYuan);
    if (!Number.isInteger(sh) || !Number.isInteger(eh) || sh < 0 || eh > 24 || sh >= eh) return ctx.fail('时间段不合法（0-24 整点，开始须小于结束）');
    if (!Number.isFinite(rate) || rate < 0) return ctx.fail('单价不合法');
    parsed.push({ sh, eh, cents: Math.round(rate * 100) });
  }
  parsed.sort((a, b) => a.sh - b.sh);
  for (let i = 1; i < parsed.length; i++) if (parsed[i].sh < parsed[i - 1].eh) return ctx.fail('时间段不能重叠');
  let bf = 0;
  if (baseFeeYuan != null && baseFeeYuan !== '') { const v = Number(baseFeeYuan); if (!Number.isFinite(v) || v < 0) return ctx.fail('起步费不合法'); bf = Math.round(v * 100); }
  db.exec('DELETE FROM pricing_rules');
  const ins = db.prepare('INSERT INTO pricing_rules (start_hour, end_hour, rate_cents) VALUES (?, ?, ?)');
  for (const p of parsed) ins.run(p.sh, p.eh, p.cents);
  db.prepare("INSERT INTO settings (key, value) VALUES ('base_fee_cents', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(bf));
  return ctx.json({ ok: true });
}

// ---------- 报表 ----------
function adminReports(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.VIEW_REPORTS)) return;
  const dateStr = (ctx.query.date && /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date)) ? ctx.query.date : localDate(new Date());
  const allVisits = db.prepare('SELECT v.*, u.username, u.nickname FROM visits v JOIN users u ON u.id = v.user_id ORDER BY v.start_time DESC').all();
  const dayVisits = allVisits.filter((v) => localDate(new Date(Date.parse(v.start_time))) === dateStr);
  const records = dayVisits.map((v) => {
    const endMs = v.end_time ? Date.parse(v.end_time) : Date.now();
    return { username: displayName(v), billable: !!v.billable, startTime: v.start_time, endTime: v.end_time, durationSec: Math.max(0, Math.floor((endMs - Date.parse(v.start_time)) / 1000)), chargedYuan: round2(v.charged_cents / 100), status: v.status, endReason: v.end_reason };
  });
  const charges = db.prepare("SELECT amount_cents, created_at FROM transactions WHERE type = 'CHARGE'").all();
  const dayRevenueCents = charges.filter((c) => localDate(new Date(Date.parse(c.created_at))) === dateStr).reduce((s, c) => s + c.amount_cents, 0);
  const buckets = {}, labels = [], base = new Date(dateStr + 'T00:00:00');
  for (let i = 6; i >= 0; i--) { const d = new Date(base); d.setDate(base.getDate() - i); const key = localDate(d); buckets[key] = 0; labels.push(key); }
  for (const c of charges) { const key = localDate(new Date(Date.parse(c.created_at))); if (key in buckets) buckets[key] += c.amount_cents; }
  const weekly = labels.map((k) => ({ date: k, revenueYuan: round2(buckets[k] / 100) }));
  return ctx.json({ date: dateStr, dayRevenueYuan: round2(dayRevenueCents / 100), customerVisits: records.filter((r) => r.billable).length, records, weekly });
}

// ---------- 在线充值（保留框架，mock 默认关闭） ----------
function rechargeMethods(ctx) { if (!ctx.user) return ctx.fail('未登录', 401); return ctx.json({ methods: payment.availableMethods() }); }
function rechargeCreate(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const amount = Number((ctx.body || {}).amountYuan);
  if (!Number.isFinite(amount) || amount <= 0) return ctx.fail('请填写有效的充值金额');
  try { const order = payment.createOrder(ctx.user.id, Math.round(amount * 100), String((ctx.body || {}).method || 'mock')); return ctx.json({ ok: true, orderNo: order.orderNo, method: order.method, amountYuan: round2(order.amountCents / 100), pay: order.pay }); } catch (e) { return ctx.fail(e.message); }
}
function rechargeConfirm(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const order = payment.getOrder(String((ctx.body || {}).orderNo || ''));
  if (!order || order.user_id !== ctx.user.id) return ctx.fail('订单不存在');
  if (order.method !== 'mock') return ctx.fail('该支付方式请通过扫码完成');
  try { payment.markPaid(order.order_no); return ctx.json({ ok: true, balanceYuan: round2(db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id).balance_cents / 100) }); } catch (e) { return ctx.fail(e.message); }
}
function rechargeStatus(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const order = payment.getOrder(String(ctx.query.orderNo || ''));
  if (!order || order.user_id !== ctx.user.id) return ctx.fail('订单不存在');
  return ctx.json({ status: order.status, balanceYuan: round2(db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id).balance_cents / 100) });
}

// ---------- 扫码 / 刷卡充值 ----------
function rechargeCode(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const now = Date.now();
  for (const [k, v] of rechargeCodes) if (v.expires < now) rechargeCodes.delete(k);
  const code = 'RC' + crypto.randomBytes(6).toString('hex').toUpperCase();
  rechargeCodes.set(code, { userId: ctx.user.id, expires: now + 30000 });
  return ctx.json({ code, ttl: 30 });
}
// 二维码内容(RC...) 或 卡号 均可
function adminRechargeByInput(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.RECHARGE)) return;
  const val = String((ctx.body || {}).value || '').trim();
  const amt = Number((ctx.body || {}).amountYuan);
  if (!val) return ctx.fail('请扫描/输入二维码或卡号');
  if (!(amt > 0)) return ctx.fail('请输入有效的充值金额');
  let userId = null, via = '';
  const rec = rechargeCodes.get(val);
  if (rec && rec.expires >= Date.now()) { userId = rec.userId; via = 'code'; }
  else { const c = db.prepare('SELECT user_id FROM cards WHERE card_no = ?').get(val); if (c) { userId = c.user_id; via = 'card'; } }
  if (!userId) return ctx.fail('无效的二维码/卡号（二维码可能已过期）');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return ctx.fail('用户不存在');
  const cents = Math.round(amt * 100), newBal = u.balance_cents + cents;
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(newBal, u.id);
  db.prepare("INSERT INTO transactions (user_id, type, amount_cents, operator_id, visit_id, note, created_at) VALUES (?, 'RECHARGE', ?, ?, NULL, ?, ?)").run(u.id, cents, ctx.user.id, via === 'card' ? '刷卡充值' : '扫码充值', nowIso());
  if (via === 'code') rechargeCodes.delete(val);
  return ctx.json({ ok: true, username: displayName(u), balanceYuan: round2(newBal / 100), via });
}

// ---------- 免费额度发放（可批量选择用户） ----------
function grantFree(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.GRANT_FREE)) return;
  if (!requireSimple(ctx)) return;
  const amt = Number((ctx.body || {}).amountYuan);
  if (!Number.isFinite(amt) || amt <= 0) return ctx.fail('请填写有效的发放金额');
  const cents = Math.round(amt * 100);
  const ids = (ctx.body || {}).userIds;
  let users = db.prepare("SELECT id, free_cents FROM users WHERE role = 'USER'").all();
  if (Array.isArray(ids) && ids.length) { const set = new Set(ids.map(Number)); users = users.filter((u) => set.has(u.id)); }
  const upd = db.prepare('UPDATE users SET free_cents = ? WHERE id = ?');
  for (const u of users) upd.run((u.free_cents || 0) + cents, u.id);
  return ctx.json({ ok: true, count: users.length });
}

// ---------- 流水 / 导出 / 公告 ----------
function buildTxList(rows) {
  const items = [], byVisit = new Map();
  for (const r of rows) {
    if ((r.type === 'CHARGE' || r.type === 'FREE_USE') && r.visit_id) {
      const key = r.type + '|' + r.visit_id;
      const g = byVisit.get(key) || { type: r.type, amount: 0, last: r.created_at, username: r.username, visitId: r.visit_id };
      g.amount += r.amount_cents; if (r.created_at > g.last) g.last = r.created_at; byVisit.set(key, g);
    } else items.push({ type: r.type, amountYuan: round2(r.amount_cents / 100), time: r.created_at, note: r.note || '', username: r.username });
  }
  for (const g of byVisit.values()) items.push({ type: g.type, amountYuan: round2(g.amount / 100), time: g.last, note: g.type === 'FREE_USE' ? '免费额度抵扣' : '游玩消费', username: g.username, visitId: g.visitId });
  items.sort((a, b) => (a.time < b.time ? 1 : -1));
  return items;
}
function myTransactions(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  return ctx.json({ items: buildTxList(db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 500').all(ctx.user.id)).slice(0, 200) });
}
function adminTransactions(ctx) {
  if (!requirePerm(ctx, PERMISSIONS.VIEW_REPORTS)) return;
  const userId = ctx.query.userId ? Number(ctx.query.userId) : null;
  const type = ctx.query.type && ['RECHARGE', 'CHARGE', 'ADJUST', 'FREE_USE'].includes(ctx.query.type) ? ctx.query.type : null;
  let sql = 'SELECT t.*, u.username, u.nickname FROM transactions t JOIN users u ON u.id = t.user_id WHERE 1=1';
  const args = [];
  if (userId) { sql += ' AND t.user_id = ?'; args.push(userId); }
  if (type) { sql += ' AND t.type = ?'; args.push(type); }
  sql += ' ORDER BY t.created_at DESC LIMIT 1000';
  const rows = db.prepare(sql).all(...args).map((r) => ({ ...r, username: (r.nickname && r.nickname.trim()) ? r.nickname.trim() : r.username }));
  return ctx.json({ items: buildTxList(rows).slice(0, 300) });
}
function usersExport(ctx) {
  if (!ctx.user || !auth.hasPermission(ctx.user, PERMISSIONS.MANAGE_USERS)) return ctx.fail('无权限', 403);
  const rows = db.prepare('SELECT * FROM users ORDER BY id ASC').all();
  const activeIds = new Set(db.prepare("SELECT user_id FROM visits WHERE status = 'ACTIVE'").all().map((r) => r.user_id));
  const header = ['ID', '用户名', '昵称', 'QQ号', '身份', '余额(元)', '免费额度(元)', '状态', '权限', '注册时间'];
  const data = [header.map((h) => ({ t: 's', v: h }))];
  for (const u of rows) data.push([
    { t: 'n', v: u.id }, { t: 's', v: u.username }, { t: 's', v: u.nickname || '' }, { t: 's', v: u.qq || '' },
    { t: 's', v: roleLabel(u.role) }, { t: 'n', v: round2(u.balance_cents / 100) }, { t: 'n', v: round2((u.free_cents || 0) / 100) },
    { t: 's', v: activeIds.has(u.id) ? '在店' : '离店' }, { t: 's', v: safeParse(u.permissions).join(',') }, { t: 's', v: u.created_at || '' },
  ]);
  const buf = xlsx.buildXlsx('用户列表', data);
  ctx.res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="users_${localDate(new Date())}.xlsx"`, 'Content-Length': buf.length });
  ctx.res.end(buf);
}
function announcementsList(ctx) {
  if (!ctx.user) return ctx.fail('未登录', 401);
  const rows = db.prepare('SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC').all();
  return ctx.json({ items: rows.map((a) => ({ id: a.id, title: a.title || '', content: a.content, pinned: !!a.pinned, authorName: a.author_name || '', createdAt: a.created_at })), canManage: auth.isAdmin(ctx.user) });
}
function announceCreate(ctx) {
  if (!ctx.user || !auth.isAdmin(ctx.user)) return ctx.fail('无权限', 403);
  const { title, content, pinned } = ctx.body || {};
  if (!content || !String(content).trim()) return ctx.fail('请填写公告内容');
  db.prepare('INSERT INTO announcements (title, content, pinned, author_id, author_name, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(title ? String(title).trim() : '', String(content).trim(), pinned ? 1 : 0, ctx.user.id, displayName(ctx.user), nowIso());
  return ctx.json({ ok: true });
}
function announceDelete(ctx) { if (!ctx.user || !auth.isAdmin(ctx.user)) return ctx.fail('无权限', 403); db.prepare('DELETE FROM announcements WHERE id = ?').run(Number((ctx.body || {}).id)); return ctx.json({ ok: true }); }
function announcePin(ctx) { if (!ctx.user || !auth.isAdmin(ctx.user)) return ctx.fail('无权限', 403); const { id, pinned } = ctx.body || {}; db.prepare('UPDATE announcements SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, Number(id)); return ctx.json({ ok: true }); }

module.exports = {
  register, login, logout, status, checkUsername,
  visitStart, visitEnd,
  profileUpdate, profileAvatar, profileAvatarReset, changePassword,
  myCards, cardDeleteSelf, cardAddSelf,
  adminEndVisit,
  adminUsers, usersCreate, usersUpdate, usersDelete, usersResetAvatar,
  grantFree,
  adminUserCards, adminCardAdd, adminCardDelete,
  rechargeCode, adminRechargeByInput,
  setRole, setPermissions,
  level2PasswordSet, myAdminPasswordSet, resetAdminPassword, superAuthCode,
  usersExport,
  announcementsList, announceCreate, announceDelete, announcePin,
  adminGetPricing, adminSetPricing, adminReports,
  rechargeMethods, rechargeCreate, rechargeConfirm, rechargeStatus,
  myTransactions, adminTransactions,
};
