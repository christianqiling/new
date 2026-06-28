'use strict';
// 纯加密/权限工具，不依赖数据库，避免循环引用
const crypto = require('node:crypto');

// 可分配给管理员的权限
const PERMISSIONS = {
  RECHARGE: 'RECHARGE', // 给用户充值
  MANAGE_PRICING: 'MANAGE_PRICING', // 调整营业价格
  VIEW_REPORTS: 'VIEW_REPORTS', // 查看营业报表
  MANAGE_USERS: 'MANAGE_USERS', // 查看/管理用户
  MANAGE_CARDS: 'MANAGE_CARDS', // 增删用户卡片
  GRANT_FREE: 'GRANT_FREE', // 发放/调整免费额度
  BAN_USERS: 'BAN_USERS', // 封禁用户
};

const PERMISSION_LABELS = {
  RECHARGE: '为用户充值',
  MANAGE_PRICING: '调整营业价格',
  VIEW_REPORTS: '查看营业报表',
  MANAGE_USERS: '管理用户',
  MANAGE_CARDS: '增删用户卡片',
  GRANT_FREE: '发放/调整免费额度',
  BAN_USERS: '封禁用户',
};

const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  SUB_ADMIN: 'SUB_ADMIN',
  USER: 'USER',
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 判断用户是否拥有某权限。总管理员拥有全部权限。
function hasPermission(user, perm) {
  if (!user) return false;
  if (user.role === ROLES.SUPER_ADMIN) return true;
  if (user.role === ROLES.SUB_ADMIN) {
    let perms = [];
    try { perms = JSON.parse(user.permissions || '[]'); } catch (_) { perms = []; }
    return perms.includes(perm);
  }
  return false;
}

function isAdmin(user) {
  return !!user && (user.role === ROLES.SUPER_ADMIN || user.role === ROLES.SUB_ADMIN);
}

module.exports = {
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLES,
  hashPassword,
  verifyPassword,
  randomToken,
  hasPermission,
  isAdmin,
};
