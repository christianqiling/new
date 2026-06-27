'use strict';

// ---------- 工具 ----------
const $ = (sel) => document.querySelector(sel);
const content = $('#content');
const topbar = $('#topbar');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function money(yuan) { return '¥' + Number(yuan || 0).toFixed(2); }
function dur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}
function roleName(r) { return { SUPER_ADMIN: '总管理员', SUB_ADMIN: '分管理员', USER: '用户' }[r] || r; }
function roleBadge(r) {
  const cls = { SUPER_ADMIN: 'super', SUB_ADMIN: 'sub', USER: 'user' }[r] || 'user';
  return `<span class="badge ${cls}">${roleName(r)}</span>`;
}

let toastTimer = null;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// ---------- 全局状态 ----------
const state = {
  status: null,
  statusAt: 0,
  view: 'auth',      // auth | user | admin
  adminTab: 'overview',
  authTab: 'login',
};
let pollTimer = null;
let uiTimer = null;

const PERM_LABELS = {
  RECHARGE: '为用户充值',
  MANAGE_PRICING: '调整营业价格',
  VIEW_REPORTS: '查看营业报表',
  MANAGE_USERS: '查看用户列表',
};

// ---------- 启动 ----------
async function boot() {
  try {
    state.status = await api('/api/status');
    state.statusAt = Date.now();
    enterApp();
  } catch (e) {
    showAuth();
  }
}

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
  state.status = null;
  showAuth();
});

$('#changePwBtn').addEventListener('click', openChangePassword);

// ---------- 通用弹窗 ----------
function openModal(title, bodyHtml, onMount) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal">
        <div class="modal-head"><h2>${title}</h2><button class="modal-close" aria-label="关闭">×</button></div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.modal-close').addEventListener('click', close);
  root.querySelector('.modal-overlay').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) close();
  });
  if (onMount) onMount(close);
}

function openChangePassword() {
  openModal('修改密码', `
    <label>原密码</label>
    <input id="cpOld" type="password" placeholder="请输入当前密码" autocomplete="current-password" />
    <label>新密码</label>
    <input id="cpNew" type="password" placeholder="至少 4 位" autocomplete="new-password" />
    <label>确认新密码</label>
    <input id="cpNew2" type="password" placeholder="再次输入新密码" autocomplete="new-password" />
    <button id="cpBtn" class="btn btn-block" style="margin-top:18px">确认修改</button>
    <small class="hint" style="display:block;margin-top:10px">修改后其它设备的登录将失效。</small>
  `, (close) => {
    $('#cpBtn').addEventListener('click', async () => {
      const oldPassword = $('#cpOld').value;
      const newPassword = $('#cpNew').value;
      if (newPassword !== $('#cpNew2').value) return toast('两次输入的新密码不一致', 'err');
      if (newPassword.length < 4) return toast('新密码至少 4 位', 'err');
      try {
        await api('/api/change-password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
        toast('密码修改成功', 'ok');
        close();
      } catch (e) { toast(e.message, 'err'); }
    });
  });
}

// ---------- 鉴权视图 ----------
function showAuth() {
  stopTimers();
  state.view = 'auth';
  topbar.classList.add('hidden');
  renderAuth();
}

function renderAuth() {
  const t = state.authTab;
  content.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-title">🎮 店内计时收费系统</div>
      <div class="auth-sub">按进店时长计费 · 充值畅玩</div>
      <div class="card">
        <div class="tabs">
          <button data-tab="login" class="${t === 'login' ? 'active' : ''}">登录</button>
          <button data-tab="register" class="${t === 'register' ? 'active' : ''}">注册</button>
        </div>
        ${t === 'login' ? `
          <label>用户名</label>
          <input id="lu" placeholder="请输入用户名" autocomplete="username" />
          <label>密码</label>
          <input id="lp" type="password" placeholder="请输入密码" autocomplete="current-password" />
          <button id="loginBtn" class="btn btn-block" style="margin-top:18px">登录</button>
          <p class="muted" style="margin-top:14px;font-size:13px">还没有账号？点上方"注册"。管理员账号由总管理员分配。</p>
        ` : `
          <label>用户名</label>
          <input id="ru" placeholder="设置用户名" autocomplete="username" />
          <label>QQ 号</label>
          <input id="rq" placeholder="请输入 QQ 号" inputmode="numeric" />
          <label>密码</label>
          <input id="rp" type="password" placeholder="至少 4 位" autocomplete="new-password" />
          <button id="regBtn" class="btn btn-block" style="margin-top:18px">注册并登录</button>
        `}
      </div>
    </div>`;

  content.querySelectorAll('.tabs button').forEach((b) =>
    b.addEventListener('click', () => { state.authTab = b.dataset.tab; renderAuth(); }));

  if (t === 'login') {
    const submit = async () => {
      try {
        await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#lu').value, password: $('#lp').value }) });
        await boot();
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#loginBtn').addEventListener('click', submit);
    $('#lp').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  } else {
    $('#regBtn').addEventListener('click', async () => {
      try {
        await api('/api/register', { method: 'POST', body: JSON.stringify({ username: $('#ru').value, qq: $('#rq').value, password: $('#rp').value }) });
        await boot();
        toast('注册成功，欢迎！', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
  }
}

// ---------- 进入应用 ----------
function enterApp() {
  topbar.classList.remove('hidden');
  const u = state.status.user;
  $('#whoami').innerHTML = `${esc(u.username)} ${roleBadge(u.role)}`;
  state.view = state.status.caps.isAdmin ? 'admin' : 'user';
  fullRender();
  startTimers();
}

function startTimers() {
  stopTimers();
  pollTimer = setInterval(pollTick, 3000);
  uiTimer = setInterval(uiTick, 1000);
}
function stopTimers() {
  if (pollTimer) clearInterval(pollTimer);
  if (uiTimer) clearInterval(uiTimer);
  pollTimer = uiTimer = null;
}

async function pollTick() {
  let prevActive = !!(state.status && state.status.activeVisit);
  let prevAdmin = state.status ? state.status.caps.isAdmin : false;
  try {
    state.status = await api('/api/status');
    state.statusAt = Date.now();
  } catch (e) { showAuth(); return; }

  const nowActive = !!state.status.activeVisit;
  const nowAdmin = state.status.caps.isAdmin;
  $('#whoami').innerHTML = `${esc(state.status.user.username)} ${roleBadge(state.status.user.role)}`;

  // 结构性变化（进店/离店/被提权）→ 整页重渲染
  if (nowActive !== prevActive || nowAdmin !== prevAdmin) { fullRender(); return; }

  // 仅在“实时视图”上刷新动态部分
  if (state.view === 'user' || (state.view === 'admin' && state.adminTab === 'overview')) {
    fullRender();
  }
}

// 1 秒插值，让计时与扣费“跳动”起来
function uiTick() {
  const st = state.status;
  if (!st || !st.activeVisit) return;
  const av = st.activeVisit;
  const extraSec = (Date.now() - state.statusAt) / 1000;
  const elEl = $('#mElapsed');
  if (elEl) elEl.textContent = dur(av.elapsedSec + extraSec);
  if (av.billable) {
    const extraCost = (av.rateNowCents * extraSec) / 3600; // 分
    const costEl = $('#mCost');
    const balEl = $('#mBalance');
    if (costEl) costEl.textContent = money((av.currentCostCents + extraCost) / 100);
    if (balEl) balEl.textContent = money(Math.max(0, av.projectedBalanceCents - extraCost) / 100);
  }
}

// ---------- 总渲染分发 ----------
function fullRender() {
  if (state.view === 'user') renderUser();
  else if (state.view === 'admin') renderAdmin();
}

// ---------- 用户视图 ----------
function pricingTableHtml(pricing) {
  if (!pricing || !pricing.length) return '<p class="muted">未设置价格</p>';
  return `<table><thead><tr><th>时间段</th><th class="right">单价</th></tr></thead><tbody>
    ${pricing.map((p) => `<tr><td>${String(p.startHour).padStart(2, '0')}:00 - ${String(p.endHour).padStart(2, '0')}:00</td>
      <td class="right">${p.rateYuan > 0 ? money(p.rateYuan) + ' / 小时' : '<span class="muted">免费</span>'}</td></tr>`).join('')}
  </tbody></table>`;
}

function renderUser() {
  const st = state.status;
  const u = st.user;
  const av = st.activeVisit;
  const playing = !!av;

  content.innerHTML = `
    <div class="grid cols-2">
      <div>
        <div class="card">
          <h2>我的账户</h2>
          <div class="metric">
            <span class="label">账户余额</span>
            <span class="bignum green mono" id="mBalance">${money(playing ? av.projectedBalanceYuan : u.balanceYuan)}</span>
          </div>
          <p class="muted" style="margin-top:10px">余额由管理员人工充值。当前时价：<b>${st.pricing.length ? '见右侧价格表' : '未设置'}</b></p>
        </div>

        <div class="card">
          <h2>${playing ? '正在游玩中' : '开始游玩'}</h2>
          ${playing ? `
            <div class="metrics" style="margin-bottom:18px">
              <div class="metric"><span class="label">已用时长</span><span class="val mono" id="mElapsed">${dur(av.elapsedSec)}</span></div>
              <div class="metric"><span class="label">本次费用</span><span class="val mono amber" id="mCost">${money(av.currentCostYuan)}</span></div>
              <div class="metric"><span class="label">当前时价</span><span class="val mono">${money(av.rateNowYuan)}/时</span></div>
            </div>
            <button id="endBtn" class="btn btn-red btn-block">结束游玩 · 离店</button>
            <small class="hint">余额耗尽将自动结束并下线。</small>
          ` : `
            <p class="muted">点击下方按钮进店，系统将按当前时段单价实时扣费。</p>
            <button id="startBtn" class="btn btn-green btn-block" style="margin-top:8px" ${u.balanceYuan <= 0 ? 'disabled' : ''}>进店 · 开始游玩</button>
            ${u.balanceYuan <= 0 ? '<small class="hint" style="color:var(--red)">余额不足，请先充值后再进店。</small>' : ''}
          `}
        </div>

        <div class="card">
          <h2>在线充值</h2>
          <div class="row">
            <div><label>充值金额（元）</label><input id="rcAmount" type="number" min="1" step="1" placeholder="如 50" /></div>
            <div style="flex:none;align-self:flex-end"><button id="rcGo" class="btn btn-green">去充值</button></div>
          </div>
          <small class="hint" style="display:block;margin-top:8px">在线支付到账后即可进店；也可由管理员人工充值。</small>
        </div>
      </div>

      <div>
        <div class="card">
          <h2>店内实况</h2>
          <div class="statusline"><span class="dot"></span>当前在店</div>
          <div class="metrics">
            <div class="metric"><span class="label">在店顾客</span><span class="val">${st.store.userCount} 人</span></div>
            <div class="metric"><span class="label">在店管理员</span><span class="val">${st.store.adminCount} 人</span></div>
          </div>
          <h3 style="margin-top:18px">在店管理员</h3>
          <div class="people-list">
            ${st.store.adminNames.length ? st.store.adminNames.map((n) => `<span class="chip">${esc(n)}</span>`).join('') : '<span class="muted">暂无管理员在店</span>'}
          </div>
          <small class="hint" style="display:block;margin-top:12px">为保护隐私，顾客之间不显示彼此姓名。</small>
        </div>

        <div class="card">
          <h2>价格表</h2>
          ${pricingTableHtml(st.pricing)}
        </div>

        <div class="card">
          <h2>我的明细（充值 / 消费）</h2>
          <div id="myTxBox"><p class="muted">加载中…</p></div>
        </div>
      </div>
    </div>`;

  if (playing) {
    $('#endBtn').addEventListener('click', async () => {
      try {
        const r = await api('/api/visit/end', { method: 'POST' });
        toast(`已离店，本次时长 ${dur(r.durationSec)}，扣费 ${money(r.chargedYuan)}`, 'ok');
        await refreshNow();
      } catch (e) { toast(e.message, 'err'); }
    });
  } else {
    const sb = $('#startBtn');
    if (sb) sb.addEventListener('click', async () => {
      try { await api('/api/visit/start', { method: 'POST' }); toast('进店成功，开始计时！', 'ok'); await refreshNow(); }
      catch (e) { toast(e.message, 'err'); }
    });
  }

  $('#rcGo').addEventListener('click', () => openRechargeModal(Number($('#rcAmount').value) || ''));
  loadMyTransactions();
}

// 加载并渲染“我的明细”
async function loadMyTransactions() {
  const box = $('#myTxBox');
  if (!box) return;
  try {
    const data = await api('/api/transactions');
    box.innerHTML = txTableHtml(data.items, false);
  } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

// 流水表格（showUser=true 时显示用户名列，供管理员使用）
function txTableHtml(items, showUser) {
  if (!items || !items.length) return '<p class="empty">暂无记录</p>';
  return `<table><thead><tr>${showUser ? '<th>用户</th>' : ''}<th>类型</th><th>说明</th><th>时间</th><th class="right">金额</th></tr></thead><tbody>
    ${items.map((it) => {
      const isIn = it.type === 'RECHARGE';
      return `<tr>
        ${showUser ? `<td>${esc(it.username)}</td>` : ''}
        <td>${isIn ? '<span class="pill in">充值</span>' : '<span class="pill out">消费</span>'}</td>
        <td class="muted">${esc(it.note || (isIn ? '充值' : '游玩消费'))}</td>
        <td class="mono muted">${new Date(it.time).toLocaleString('zh-CN')}</td>
        <td class="right mono ${isIn ? 'tx-in' : 'tx-out'}">${isIn ? '+' : '-'}${money(it.amountYuan)}</td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

// ---------- 在线充值流程 ----------
async function openRechargeModal(presetAmount) {
  let methods = [];
  try { methods = (await api('/api/recharge/methods')).methods; } catch (_) {}
  const enabled = methods.filter((m) => m.enabled);
  const def = enabled[0] ? enabled[0].id : 'mock';

  openModal('在线充值', `
    <label>充值金额（元）</label>
    <input id="omAmt" type="number" min="1" step="1" value="${presetAmount || ''}" placeholder="请输入金额" />
    <label>支付方式</label>
    <div class="pay-methods">
      ${methods.map((m) => `<div class="pay-method ${m.id === def ? 'active' : ''} ${m.enabled ? '' : 'disabled'}" data-m="${m.id}">${m.label}${m.enabled ? '' : '<br><small>未开通</small>'}</div>`).join('')}
    </div>
    <button id="omNext" class="btn btn-block" style="margin-top:16px">确认充值</button>
    <div id="omPay"></div>
  `, (close) => {
    let method = def;
    const root = $('#modalRoot');
    root.querySelectorAll('.pay-method').forEach((el) => el.addEventListener('click', () => {
      if (el.classList.contains('disabled')) return;
      root.querySelectorAll('.pay-method').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      method = el.dataset.m;
    }));

    $('#omNext').addEventListener('click', async () => {
      const amountYuan = Number($('#omAmt').value);
      if (!(amountYuan > 0)) return toast('请输入有效金额', 'err');
      try {
        const order = await api('/api/recharge/create', { method: 'POST', body: JSON.stringify({ amountYuan, method }) });
        renderPayStep(order, close);
      } catch (e) { toast(e.message, 'err'); }
    });
  });
}

function renderPayStep(order, close) {
  const payBox = $('#omPay');
  $('#omNext').classList.add('hidden');
  if (order.pay.kind === 'mock') {
    payBox.innerHTML = `
      <div class="card" style="margin-top:16px;background:var(--panel-2)">
        <p>待支付金额：<b class="tx-in">${money(order.amountYuan)}</b></p>
        <p class="muted">${esc(order.pay.message)}</p>
        <button id="omPaid" class="btn btn-green btn-block">我已完成支付</button>
      </div>`;
    $('#omPaid').addEventListener('click', async () => {
      try {
        const r = await api('/api/recharge/confirm', { method: 'POST', body: JSON.stringify({ orderNo: order.orderNo }) });
        toast(`充值成功，当前余额 ${money(r.balanceYuan)}`, 'ok');
        close();
        await refreshNow();
      } catch (e) { toast(e.message, 'err'); }
    });
  } else {
    payBox.innerHTML = `
      <div class="card" style="margin-top:16px;background:var(--panel-2)">
        <p>待支付金额：<b class="tx-in">${money(order.amountYuan)}</b></p>
        <div class="qr-box"><div class="qr"><code style="color:#111;word-break:break-all">${esc(order.pay.qrContent || '')}</code></div></div>
        <p class="muted">${esc(order.pay.message)}</p>
        <small class="hint">真实环境下此处显示支付二维码，到账由支付平台异步回调确认。</small>
      </div>`;
    pollOrder(order.orderNo, close);
  }
}

// 轮询真实渠道订单状态（到账由后端回调写入）
function pollOrder(orderNo, close) {
  let n = 0;
  const t = setInterval(async () => {
    n++;
    if (n > 60) return clearInterval(t);
    try {
      const r = await api('/api/recharge/status?orderNo=' + encodeURIComponent(orderNo));
      if (r.status === 'PAID') {
        clearInterval(t);
        toast(`充值成功，当前余额 ${money(r.balanceYuan)}`, 'ok');
        close();
        await refreshNow();
      }
    } catch (_) { clearInterval(t); }
  }, 2000);
}

async function refreshNow() {
  try {
    state.status = await api('/api/status');
    state.statusAt = Date.now();
    $('#whoami').innerHTML = `${esc(state.status.user.username)} ${roleBadge(state.status.user.role)}`;
    fullRender();
  } catch (e) { showAuth(); }
}

// ---------- 管理员视图 ----------
function renderAdmin() {
  const st = state.status;
  const caps = st.caps;
  const tabs = [['overview', '店内总览']];
  if (caps.MANAGE_USERS || caps.RECHARGE) tabs.push(['users', '用户与充值']);
  if (caps.MANAGE_PRICING) tabs.push(['pricing', '营业定价']);
  if (caps.VIEW_REPORTS) tabs.push(['reports', '营业报表']);
  if (caps.VIEW_REPORTS) tabs.push(['txns', '流水明细']);
  if (caps.isSuper) tabs.push(['admins', '管理员与权限']);

  if (!tabs.find((t) => t[0] === state.adminTab)) state.adminTab = 'overview';

  content.innerHTML = `
    <div class="adminnav">
      ${tabs.map(([k, label]) => `<button data-tab="${k}" class="${state.adminTab === k ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    <div id="adminBody"></div>`;

  content.querySelectorAll('.adminnav button').forEach((b) =>
    b.addEventListener('click', () => { state.adminTab = b.dataset.tab; renderAdminBody(); }));

  renderAdminBody();
}

function renderAdminBody() {
  // 切到非总览标签时高亮同步
  content.querySelectorAll('.adminnav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === state.adminTab));
  const body = $('#adminBody');
  const tab = state.adminTab;
  if (tab === 'overview') return renderAdminOverview(body);
  if (tab === 'users') return renderAdminUsers(body);
  if (tab === 'pricing') return renderAdminPricing(body);
  if (tab === 'reports') return renderAdminReports(body);
  if (tab === 'txns') return renderAdminTxns(body);
  if (tab === 'admins') return renderAdminAdmins(body);
}

function renderAdminOverview(body) {
  const st = state.status;
  const av = st.activeVisit;
  const people = st.store.people || [];
  const canManage = st.caps.MANAGE_USERS;
  body.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h2>我的打卡</h2>
        ${av ? `
          <div class="statusline"><span class="dot"></span>在店打卡中</div>
          <div class="metric"><span class="label">在店时长</span><span class="val mono" id="mElapsed">${dur(av.elapsedSec)}</span></div>
          <button id="endBtn" class="btn btn-red btn-block" style="margin-top:16px">离店打卡</button>
          <small class="hint">管理员打卡不计费。</small>
        ` : `
          <p class="muted">点击进店打卡，顾客即可在“店内实况”看到你在店。</p>
          <button id="startBtn" class="btn btn-green btn-block" style="margin-top:8px">进店打卡</button>
        `}
      </div>
      <div class="card">
        <h2>店内人数</h2>
        <div class="metrics">
          <div class="metric"><span class="label">在店顾客</span><span class="val">${st.store.userCount} 人</span></div>
          <div class="metric"><span class="label">在店管理员</span><span class="val">${st.store.adminCount} 人</span></div>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>当前在店人员（管理员可见全部姓名）</h2>
      ${people.length ? `<table><thead><tr><th>姓名</th><th>身份</th><th>进店时间</th><th class="right">已在店</th>${canManage ? '<th class="right">操作</th>' : ''}</tr></thead><tbody>
        ${people.map((p) => `<tr><td>${esc(p.username)}</td><td>${roleBadge(p.role)}</td>
          <td>${new Date(p.startTime).toLocaleTimeString('zh-CN')}</td>
          <td class="right mono">${dur(p.elapsedSec)}</td>
          ${canManage ? `<td class="right"><button class="btn btn-sm btn-red endUserBtn" data-id="${p.id}" data-name="${esc(p.username)}">结束</button></td>` : ''}</tr>`).join('')}
      </tbody></table>` : '<p class="empty">当前没有人在店</p>'}
    </div>`;

  if (canManage) body.querySelectorAll('.endUserBtn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`确定结束「${b.dataset.name}」的当前会话？`)) return;
    try {
      const r = await api('/api/admin/end-visit', { method: 'POST', body: JSON.stringify({ userId: Number(b.dataset.id) }) });
      toast(`已结束，时长 ${dur(r.durationSec)}，扣费 ${money(r.chargedYuan)}`, 'ok');
      await refreshNow();
    } catch (e) { toast(e.message, 'err'); }
  }));

  if (av) $('#endBtn').addEventListener('click', async () => {
    try { await api('/api/visit/end', { method: 'POST' }); toast('已离店打卡', 'ok'); await refreshNow(); }
    catch (e) { toast(e.message, 'err'); }
  });
  else $('#startBtn').addEventListener('click', async () => {
    try { await api('/api/visit/start', { method: 'POST' }); toast('已进店打卡', 'ok'); await refreshNow(); }
    catch (e) { toast(e.message, 'err'); }
  });
}

async function renderAdminUsers(body) {
  body.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  let data;
  try { data = await api('/api/admin/users'); } catch (e) { body.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p></div>`; return; }
  const canRecharge = state.status.caps.RECHARGE;
  body.innerHTML = `
    <div class="card">
      <h2>用户列表</h2>
      <table><thead><tr><th>ID</th><th>用户名</th><th>QQ</th><th>身份</th><th class="right">余额</th><th>状态</th>${canRecharge ? '<th class="right">操作</th>' : ''}</tr></thead>
      <tbody>
        ${data.users.map((u) => `<tr>
          <td class="muted">${u.id}</td>
          <td>${esc(u.username)}</td>
          <td class="muted">${esc(u.qq)}</td>
          <td>${roleBadge(u.role)}</td>
          <td class="right mono">${money(u.balanceYuan)}</td>
          <td>${u.inStore ? '<span class="pill in">在店</span>' : '<span class="pill out">离店</span>'}</td>
          ${canRecharge ? `<td class="right"><button class="btn btn-sm rechargeBtn" data-id="${u.id}" data-name="${esc(u.username)}">充值</button></td>` : ''}
        </tr>`).join('')}
      </tbody></table>
    </div>
    ${canRecharge ? `
    <div class="card" id="rechargeCard">
      <h2>人工充值</h2>
      <div class="row">
        <div style="flex:2"><label>用户</label>
          <select id="rcUser">${data.users.map((u) => `<option value="${u.id}">${esc(u.username)}（余额 ${money(u.balanceYuan)}）</option>`).join('')}</select>
        </div>
        <div><label>充值金额（元）</label><input id="rcAmt" type="number" min="0" step="0.01" placeholder="如 50" /></div>
        <div style="flex:none"><button id="rcBtn" class="btn btn-green">确认充值</button></div>
      </div>
    </div>` : ''}`;

  body.querySelectorAll('.rechargeBtn').forEach((b) => b.addEventListener('click', () => {
    $('#rcUser').value = b.dataset.id;
    $('#rcAmt').focus();
    $('#rechargeCard').scrollIntoView({ behavior: 'smooth' });
  }));
  if (canRecharge) $('#rcBtn').addEventListener('click', async () => {
    const userId = Number($('#rcUser').value);
    const amountYuan = Number($('#rcAmt').value);
    if (!(amountYuan > 0)) return toast('请输入有效金额', 'err');
    try {
      const r = await api('/api/admin/recharge', { method: 'POST', body: JSON.stringify({ userId, amountYuan }) });
      toast(`充值成功，新余额 ${money(r.balanceYuan)}`, 'ok');
      renderAdminUsers(body);
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function renderAdminPricing(body) {
  body.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  let data;
  try { data = await api('/api/admin/pricing'); } catch (e) { body.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p></div>`; return; }

  const renderRows = (rules) => rules.map((r, i) => `
    <div class="rule-row" data-i="${i}">
      <select class="rStart">${hourOpts(r.startHour)}</select><span>:00 至</span>
      <select class="rEnd">${hourOpts(r.endHour)}</select><span>:00 =</span>
      <input class="rRate" type="number" min="0" step="0.01" value="${r.rateYuan}" /><span>元/小时</span>
      <button class="btn btn-ghost btn-sm rDel">删除</button>
    </div>`).join('');

  body.innerHTML = `
    <div class="card">
      <h2>营业定价（分时段）</h2>
      <p class="muted">设置不同时间段的每小时单价，进店时按当前时段费率实时扣费。时间为 0–24 整点，时段之间不可重叠；未覆盖的时段视为免费。</p>
      <div id="rules">${renderRows(data.rules.length ? data.rules : [{ startHour: 0, endHour: 24, rateYuan: 10 }])}</div>
      <div class="row" style="margin-top:6px">
        <button id="addRule" class="btn btn-ghost btn-sm" style="flex:none">+ 添加时段</button>
        <div></div>
        <button id="savePricing" class="btn" style="flex:none">保存价格</button>
      </div>
    </div>`;

  const rulesBox = $('#rules');
  const attachDel = () => rulesBox.querySelectorAll('.rDel').forEach((b) =>
    b.addEventListener('click', (e) => { e.target.closest('.rule-row').remove(); }));
  attachDel();

  $('#addRule').addEventListener('click', () => {
    const div = document.createElement('div');
    div.innerHTML = renderRows([{ startHour: 0, endHour: 24, rateYuan: 0 }]);
    const node = div.firstElementChild;
    rulesBox.appendChild(node);
    node.querySelector('.rDel').addEventListener('click', () => node.remove());
  });

  $('#savePricing').addEventListener('click', async () => {
    const rules = [...rulesBox.querySelectorAll('.rule-row')].map((row) => ({
      startHour: Number(row.querySelector('.rStart').value),
      endHour: Number(row.querySelector('.rEnd').value),
      rateYuan: Number(row.querySelector('.rRate').value),
    }));
    try {
      await api('/api/admin/pricing', { method: 'POST', body: JSON.stringify({ rules }) });
      toast('价格已保存', 'ok');
      await refreshNow();
      renderAdminPricing(body);
    } catch (e) { toast(e.message, 'err'); }
  });
}

function hourOpts(sel) {
  let s = '';
  for (let h = 0; h <= 24; h++) s += `<option value="${h}" ${h === sel ? 'selected' : ''}>${String(h).padStart(2, '0')}</option>`;
  return s;
}

async function renderAdminReports(body) {
  body.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  const today = new Date().toISOString().slice(0, 10);
  if (!state._reportDate) state._reportDate = today;
  let data;
  try { data = await api('/api/admin/reports?date=' + state._reportDate); } catch (e) { body.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p></div>`; return; }

  body.innerHTML = `
    <div class="card">
      <h2>营业报表</h2>
      <div class="row" style="margin-bottom:18px">
        <div style="flex:none"><label>选择日期</label><input id="repDate" type="date" value="${data.date}" /></div>
      </div>
      <div class="metrics">
        <div class="metric"><span class="label">当日营业额</span><span class="bignum amber mono">${money(data.dayRevenueYuan)}</span></div>
        <div class="metric"><span class="label">当日顾客场次</span><span class="val">${data.customerVisits} 场</span></div>
      </div>
    </div>

    <div class="card">
      <h2>近 7 天营业额</h2>
      ${weeklyChart(data.weekly)}
    </div>

    <div class="card">
      <h2>当日进出记录</h2>
      ${data.records.length ? `<table><thead><tr><th>姓名</th><th>身份</th><th>进店</th><th>离店</th><th class="right">时长</th><th class="right">消费</th><th>状态</th></tr></thead><tbody>
        ${data.records.map((r) => `<tr>
          <td>${esc(r.username)}</td>
          <td>${r.billable ? '<span class="badge user">顾客</span>' : '<span class="badge sub">管理员</span>'}</td>
          <td class="mono">${new Date(r.startTime).toLocaleTimeString('zh-CN')}</td>
          <td class="mono">${r.endTime ? new Date(r.endTime).toLocaleTimeString('zh-CN') : '<span class="pill in">在店中</span>'}</td>
          <td class="right mono">${dur(r.durationSec)}</td>
          <td class="right mono">${money(r.chargedYuan)}</td>
          <td>${endReasonLabel(r)}</td>
        </tr>`).join('')}
      </tbody></table>` : '<p class="empty">当日暂无记录</p>'}
    </div>`;

  $('#repDate').addEventListener('change', (e) => { state._reportDate = e.target.value; renderAdminReports(body); });
}

function endReasonLabel(r) {
  if (r.status === 'ACTIVE') return '<span class="pill in">在店中</span>';
  if (r.endReason === 'NO_BALANCE') return '<span class="pill out">余额耗尽</span>';
  return '<span class="pill out">正常离店</span>';
}

// 周营业额 SVG 柱状图
function weeklyChart(weekly) {
  const W = 720, H = 240, padL = 44, padB = 34, padT = 16, padR = 16;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(1, ...weekly.map((d) => d.revenueYuan));
  const niceMax = Math.ceil(max / 5) * 5 || 5;
  const n = weekly.length;
  const slot = innerW / n;
  const barW = Math.min(46, slot * 0.55);

  let bars = '', labels = '', vals = '';
  weekly.forEach((d, i) => {
    const h = (d.revenueYuan / niceMax) * innerH;
    const x = padL + slot * i + (slot - barW) / 2;
    const y = padT + innerH - h;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="5" fill="#5b8cff"></rect>`;
    if (d.revenueYuan > 0) vals += `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="11" fill="#ffb454">${d.revenueYuan.toFixed(0)}</text>`;
    labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#98a2c0">${d.date.slice(5)}</text>`;
  });

  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const val = (niceMax / 4) * g;
    const y = padT + innerH - (val / niceMax) * innerH;
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#2c3550" stroke-width="1"></line>`;
    grid += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#98a2c0">${val.toFixed(0)}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img">
    ${grid}${bars}${vals}${labels}
  </svg>`;
}

// 管理员：流水明细（可筛选）
async function renderAdminTxns(body) {
  body.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  if (!state._txFilter) state._txFilter = { userId: '', type: '' };
  let users = [];
  try { users = (await api('/api/admin/users')).users; } catch (_) {}

  const load = async () => {
    const box = $('#txBox');
    box.innerHTML = '<p class="muted">加载中…</p>';
    const q = [];
    if (state._txFilter.userId) q.push('userId=' + state._txFilter.userId);
    if (state._txFilter.type) q.push('type=' + state._txFilter.type);
    try {
      const data = await api('/api/admin/transactions' + (q.length ? '?' + q.join('&') : ''));
      box.innerHTML = txTableHtml(data.items, true);
    } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
  };

  body.innerHTML = `
    <div class="card">
      <h2>流水明细</h2>
      <div class="filters">
        <div><label>用户</label>
          <select id="fUser"><option value="">全部用户</option>
            ${users.map((u) => `<option value="${u.id}" ${state._txFilter.userId == u.id ? 'selected' : ''}>${esc(u.username)}</option>`).join('')}
          </select>
        </div>
        <div><label>类型</label>
          <select id="fType">
            <option value="" ${state._txFilter.type === '' ? 'selected' : ''}>全部</option>
            <option value="RECHARGE" ${state._txFilter.type === 'RECHARGE' ? 'selected' : ''}>充值</option>
            <option value="CHARGE" ${state._txFilter.type === 'CHARGE' ? 'selected' : ''}>消费</option>
          </select>
        </div>
      </div>
      <div id="txBox"></div>
      <small class="hint" style="display:block;margin-top:10px">消费记录按每次游玩(单次进店)聚合显示。</small>
    </div>`;

  $('#fUser').addEventListener('change', (e) => { state._txFilter.userId = e.target.value; load(); });
  $('#fType').addEventListener('change', (e) => { state._txFilter.type = e.target.value; load(); });
  load();
}

// 总管理员：角色与权限
async function renderAdminAdmins(body) {
  body.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  let data;
  try { data = await api('/api/admin/users'); } catch (e) { body.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p></div>`; return; }
  const allPerms = Object.keys(PERM_LABELS);

  body.innerHTML = `
    <div class="card">
      <h2>管理员与权限分配</h2>
      <p class="muted">将用户设为分管理员，并勾选其权限。总管理员默认拥有全部权限。</p>
      <table><thead><tr><th>用户名</th><th>当前身份</th><th>权限设置</th></tr></thead><tbody>
        ${data.users.map((u) => {
          if (u.role === 'SUPER_ADMIN') {
            return `<tr><td>${esc(u.username)}</td><td>${roleBadge(u.role)}</td><td class="muted">全部权限</td></tr>`;
          }
          const isSub = u.role === 'SUB_ADMIN';
          return `<tr data-uid="${u.id}">
            <td>${esc(u.username)}</td>
            <td>
              <select class="roleSel">
                <option value="USER" ${!isSub ? 'selected' : ''}>用户</option>
                <option value="SUB_ADMIN" ${isSub ? 'selected' : ''}>分管理员</option>
              </select>
            </td>
            <td>
              <div class="perm-grid">
                ${allPerms.map((p) => `<label><input type="checkbox" class="permChk" value="${p}" ${u.permissions.includes(p) ? 'checked' : ''} ${isSub ? '' : 'disabled'}>${PERM_LABELS[p]}</label>`).join('')}
              </div>
              <button class="btn btn-sm saveAdmin">保存</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody></table>
    </div>`;

  body.querySelectorAll('tr[data-uid]').forEach((row) => {
    const uid = Number(row.dataset.uid);
    const roleSel = row.querySelector('.roleSel');
    roleSel.addEventListener('change', () => {
      const isSub = roleSel.value === 'SUB_ADMIN';
      row.querySelectorAll('.permChk').forEach((c) => { c.disabled = !isSub; if (!isSub) c.checked = false; });
    });
    row.querySelector('.saveAdmin').addEventListener('click', async () => {
      const role = roleSel.value;
      try {
        await api('/api/admin/set-role', { method: 'POST', body: JSON.stringify({ userId: uid, role }) });
        if (role === 'SUB_ADMIN') {
          const permissions = [...row.querySelectorAll('.permChk:checked')].map((c) => c.value);
          await api('/api/admin/set-permissions', { method: 'POST', body: JSON.stringify({ userId: uid, permissions }) });
        }
        toast('已保存', 'ok');
        renderAdminAdmins(body);
      } catch (e) { toast(e.message, 'err'); }
    });
  });
}

// 启动
boot();
