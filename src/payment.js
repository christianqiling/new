'use strict';
// 可插拔在线支付框架。
// 默认内置 "mock" 模拟网关（完整可用、便于演示与测试）。
// 微信 / 支付宝为标准接入点：配置商户凭证(环境变量)并联网后即可启用，
// 届时 buildPayInfo 调用真实下单接口换取二维码，回调由网关 notify 触发 markPaid。
const crypto = require('node:crypto');
const { db } = require('./db');

const METHODS = {
  mock: { id: 'mock', label: '模拟支付（演示）', enabled: true },
  wechat: { id: 'wechat', label: '微信支付', enabled: !!process.env.WECHAT_MCH_ID },
  alipay: { id: 'alipay', label: '支付宝', enabled: !!process.env.ALIPAY_APP_ID },
};

function availableMethods() {
  return Object.values(METHODS).map((m) => ({ id: m.id, label: m.label, enabled: m.enabled }));
}

function genOrderNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `PO${stamp}${crypto.randomBytes(3).toString('hex')}`;
}

// 根据支付方式生成前端展示用的支付信息
function buildPayInfo(method, orderNo) {
  if (method === 'mock') {
    return { kind: 'mock', message: '演示用模拟支付：点击"我已完成支付"即可到账。' };
  }
  // 真实环境：此处应调用对应网关的统一下单接口，返回 code_url / 二维码串。
  // 当前为占位内容（未配置商户凭证时该方式不会被启用）。
  return {
    kind: 'qrcode',
    qrContent: `https://pay.example.com/${method}/${orderNo}`,
    message: `请使用${method === 'wechat' ? '微信' : '支付宝'}扫码支付。`,
  };
}

function createOrder(userId, amountCents, method) {
  const m = METHODS[method];
  if (!m || !m.enabled) throw new Error('该支付方式暂未开通');
  if (!(amountCents > 0)) throw new Error('充值金额无效');
  const orderNo = genOrderNo();
  db.prepare(
    "INSERT INTO payment_orders (order_no, user_id, amount_cents, method, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?)"
  ).run(orderNo, userId, amountCents, method, new Date().toISOString());
  return { orderNo, method, amountCents, pay: buildPayInfo(method, orderNo) };
}

function getOrder(orderNo) {
  return db.prepare('SELECT * FROM payment_orders WHERE order_no = ?').get(orderNo);
}

// 标记订单已支付并入账（幂等）。
// mock: 由前端"我已完成支付"触发；真实环境: 由网关异步回调(notify)触发。
function markPaid(orderNo) {
  const order = getOrder(orderNo);
  if (!order) throw new Error('订单不存在');
  if (order.status === 'PAID') return order; // 幂等
  if (order.status !== 'PENDING') throw new Error('订单状态异常，无法支付');
  const now = new Date().toISOString();
  db.prepare("UPDATE payment_orders SET status = 'PAID', paid_at = ? WHERE id = ?").run(now, order.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(user.balance_cents + order.amount_cents, user.id);
  db.prepare(
    "INSERT INTO transactions (user_id, type, amount_cents, operator_id, visit_id, note, created_at) VALUES (?, 'RECHARGE', ?, NULL, NULL, ?, ?)"
  ).run(order.user_id, order.amount_cents, `在线充值(${(METHODS[order.method] || {}).label || order.method})`, now);
  return getOrder(orderNo);
}

module.exports = { METHODS, availableMethods, createOrder, getOrder, markPaid };
