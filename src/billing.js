'use strict';
const { db } = require('./db');

// 货币单位：分 (cents)。1 元 = 100 分。
// 时长费率：rate_cents 表示"每小时多少分"。

function getPricingRules() {
  return db.prepare('SELECT * FROM pricing_rules ORDER BY start_hour ASC').all();
}

// 给定某个小时(0-23)，返回适用的每小时费率(分)。无匹配则返回 0(免费)。
function rateForHour(rules, hour) {
  for (const r of rules) {
    if (hour >= r.start_hour && hour < r.end_hour) return r.rate_cents;
  }
  return 0;
}

// 计算 [fromMs, toMs) 区间的费用(分)，按小时边界分段套用费率。
function costForInterval(rules, fromMs, toMs) {
  if (toMs <= fromMs) return 0;
  let cost = 0;
  let t = fromMs;
  while (t < toMs) {
    const d = new Date(t);
    const hour = d.getHours();
    const boundary = new Date(d);
    boundary.setMinutes(0, 0, 0);
    boundary.setHours(hour + 1); // 下一个整点
    const segEnd = Math.min(toMs, boundary.getTime());
    const seconds = (segEnd - t) / 1000;
    cost += rateForHour(rules, hour) * (seconds / 3600);
    t = segEnd;
  }
  return cost;
}

// 在 [fromMs, toMs) 内，按费率累计扣费直到达到 budget(分) 为止，
// 返回 { charged, reachedMs, depleted }。
//  - 若区间内费用未超过预算: charged=区间总费用, reachedMs=toMs, depleted=false
//  - 若预算先耗尽: charged=budget, reachedMs=耗尽时刻, depleted=true
function chargeUntilBudget(rules, fromMs, toMs, budget) {
  let charged = 0;
  let t = fromMs;
  while (t < toMs) {
    if (budget - charged <= 1e-9) {
      return { charged, reachedMs: t, depleted: true };
    }
    const d = new Date(t);
    const hour = d.getHours();
    const boundary = new Date(d);
    boundary.setMinutes(0, 0, 0);
    boundary.setHours(hour + 1);
    const segEnd = Math.min(toMs, boundary.getTime());
    const seconds = (segEnd - t) / 1000;
    const rate = rateForHour(rules, hour); // 分/小时
    const segCost = rate * (seconds / 3600);
    const remaining = budget - charged;
    if (segCost > remaining) {
      // 预算在本段内耗尽 (rate 必然 > 0)
      const affordableSeconds = (remaining / rate) * 3600;
      return { charged: budget, reachedMs: t + affordableSeconds * 1000, depleted: true };
    }
    charged += segCost;
    t = segEnd;
  }
  return { charged, reachedMs: toMs, depleted: false };
}

const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const updateBalanceStmt = db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?');
const updateVisitStmt = db.prepare(
  'UPDATE visits SET end_time = ?, last_tick = ?, charged_cents = ?, status = ?, end_reason = ? WHERE id = ?'
);
const insertTxStmt = db.prepare(
  'INSERT INTO transactions (user_id, type, amount_cents, operator_id, visit_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

// 结算一个进行中的计费访问，从 last_tick 扣费到 upToMs。
// endManually=true 表示用户主动离店（结算后强制结束）。
// 返回结算后的 visit 行。
function settleVisit(visit, upToMs, endManually = false) {
  const now = upToMs;
  const rules = getPricingRules();

  // 管理员打卡(不计费)：仅推进 last_tick；离店时结束。
  if (!visit.billable) {
    const end = endManually ? new Date(now).toISOString() : visit.end_time;
    const status = endManually ? 'ENDED' : visit.status;
    const reason = endManually ? 'MANUAL' : visit.end_reason;
    updateVisitStmt.run(end, new Date(now).toISOString(), visit.charged_cents, status, reason, visit.id);
    return db.prepare('SELECT * FROM visits WHERE id = ?').get(visit.id);
  }

  const user = getUserStmt.get(visit.user_id);
  const fromMs = Date.parse(visit.last_tick);
  let balance = user.balance_cents;

  // 余额已为 0：直接因余额耗尽结束。
  if (balance <= 1e-9) {
    updateVisitStmt.run(visit.last_tick, visit.last_tick, visit.charged_cents, 'ENDED', 'NO_BALANCE', visit.id);
    return db.prepare('SELECT * FROM visits WHERE id = ?').get(visit.id);
  }

  if (now <= fromMs) {
    if (endManually) {
      updateVisitStmt.run(new Date(now).toISOString(), new Date(now).toISOString(), visit.charged_cents, 'ENDED', 'MANUAL', visit.id);
      return db.prepare('SELECT * FROM visits WHERE id = ?').get(visit.id);
    }
    return visit;
  }

  const { charged, reachedMs, depleted } = chargeUntilBudget(rules, fromMs, now, balance);

  if (charged > 0) {
    const newBalance = Math.max(0, balance - charged);
    updateBalanceStmt.run(newBalance, user.id);
    insertTxStmt.run(user.id, 'CHARGE', charged, null, visit.id, '游玩计费', new Date(now).toISOString());
    visit.charged_cents += charged;
  }

  let status = visit.status;
  let endTime = visit.end_time;
  let reason = visit.end_reason;
  let lastTick = new Date(reachedMs).toISOString();

  if (depleted) {
    status = 'ENDED';
    endTime = new Date(reachedMs).toISOString();
    reason = 'NO_BALANCE';
  } else if (endManually) {
    status = 'ENDED';
    endTime = new Date(now).toISOString();
    reason = 'MANUAL';
    lastTick = new Date(now).toISOString();
  }

  updateVisitStmt.run(endTime, lastTick, visit.charged_cents, status, reason, visit.id);
  return db.prepare('SELECT * FROM visits WHERE id = ?').get(visit.id);
}

// 对所有进行中的可计费访问进行一次扣费（定时任务调用）。
function tickAll(nowMs = Date.now()) {
  const active = db.prepare("SELECT * FROM visits WHERE status = 'ACTIVE' AND billable = 1").all();
  for (const v of active) {
    try { settleVisit(v, nowMs, false); } catch (e) { console.error('[tick] 结算失败 visit', v.id, e.message); }
  }
}

// 计算进行中访问“到此刻为止”的预测信息（用于实时展示，不落库）。
function projectVisit(visit, nowMs = Date.now()) {
  const rules = getPricingRules();
  const startMs = Date.parse(visit.start_time);
  const elapsedSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  if (!visit.billable) {
    return { elapsedSec, currentCost: 0, projectedBalance: null, rateNow: 0 };
  }
  const user = getUserStmt.get(visit.user_id);
  const sinceTick = costForInterval(rules, Date.parse(visit.last_tick), nowMs);
  const currentCost = visit.charged_cents + sinceTick;
  const projectedBalance = Math.max(0, user.balance_cents - sinceTick);
  const rateNow = rateForHour(rules, new Date(nowMs).getHours());
  return { elapsedSec, currentCost, projectedBalance, rateNow };
}

module.exports = {
  getPricingRules,
  rateForHour,
  costForInterval,
  settleVisit,
  tickAll,
  projectVisit,
};
