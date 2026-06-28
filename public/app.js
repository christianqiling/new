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
function roleName(r) { return { SUPER_ADMIN: '超级管理员', SUB_ADMIN: '管理员', USER: '用户' }[r] || r; }
function roleBadge(r) {
  const cls = { SUPER_ADMIN: 'super', SUB_ADMIN: 'sub', USER: 'user' }[r] || 'user';
  return `<span class="badge ${cls}">${roleName(r)}</span>`;
}
function avatarHtml(avatarUrl, label, sz = 'sz-40') {
  if (avatarUrl) return `<span class="avatar ${sz}"><img src="${esc(avatarUrl)}" alt=""></span>`;
  const ini = esc(([...String(label || '?')][0]) || '?');
  return `<span class="avatar ${sz}">${ini}</span>`;
}

let toastTimer = null;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

const PERM_LABELS = {
  RECHARGE: '为用户充值', MANAGE_PRICING: '调整营业价格',
  VIEW_REPORTS: '查看营业报表', MANAGE_USERS: '管理用户',
};

const state = {
  status: null, statusAt: 0, view: 'auth',
  adminTab: 'overview', bizTab: 'reports', authTab: 'login',
  _reportDate: null, _txFilter: { userId: '', type: '' }, _userSearch: '',
};
let pollTimer = null, uiTimer = null;

// ---------- 启动 ----------
async function boot() {
  try {
    state.status = await api('/api/status');
    state.statusAt = Date.now();
    enterApp();
  } catch (e) { showAuth(); }
}

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
  state.status = null;
  showAuth();
});
$('#profileBtn').addEventListener('click', openProfile);

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
  return close;
}

// 点保存/删除后弹出"请输入操作密码"，验证后执行 onConfirm(opPassword, closePrompt)。
// 作为叠加层显示在当前弹窗之上；onConfirm 成功应调用 closePrompt()，失败抛错则保留以便重试。
function promptOpPassword(onConfirm) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.style.zIndex = '250';
  wrap.innerHTML = `
    <div class="modal" style="max-width:380px">
      <div class="modal-head"><h2>请输入操作密码</h2><button class="modal-close" aria-label="关闭">×</button></div>
      <div class="modal-body">
        <p class="muted">该操作需要验证操作密码。</p>
        <label>操作密码</label>
        <input id="opInput" type="password" placeholder="请输入管理操作密码" />
        <button id="opOk" class="btn btn-block" style="margin-top:16px">确认并保存</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.modal-close').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  const input = wrap.querySelector('#opInput');
  setTimeout(() => input.focus(), 50);
  const submit = async () => {
    const pw = input.value;
    if (!pw) return toast('请输入操作密码', 'err');
    try { await onConfirm(pw, close); } catch (e) { toast(e.message, 'err'); }
  };
  wrap.querySelector('#opOk').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

// 文件 -> 128px 方形头像 dataURL
function fileToAvatar(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const s = 128, c = document.createElement('canvas');
        c.width = s; c.height = s;
        const ctx = c.getContext('2d');
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2, sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, s, s);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject; img.src = r.result;
    };
    r.onerror = reject; r.readAsDataURL(file);
  });
}

// ---------- 我的信息 ----------
function openProfile() {
  const u = state.status.user;
  openModal('我的信息', `
    <div class="avatar-edit">
      <span id="pfAvatar">${avatarHtml(u.avatar, u.displayName, 'sz-96')}</span>
      <div class="acts">
        <button id="pfUpload" class="btn btn-sm">上传头像</button>
        <button id="pfReset" class="btn btn-ghost btn-sm">恢复默认</button>
        <input id="pfFile" type="file" accept="image/*" class="hidden" />
      </div>
    </div>
    <small class="hint">默认头像为用户名首字。</small>
    <label>用户名</label>
    <input id="pfUsername" value="${esc(u.username)}" />
    <label>昵称</label>
    <input id="pfNickname" value="${esc(u.nickname)}" placeholder="店内显示的名字（选填）" />
    <button id="pfSave" class="btn btn-block" style="margin-top:16px">保存资料</button>

    <hr class="section-divider" />
    <h3>修改密码</h3>
    <label>原密码</label><input id="pfOld" type="password" autocomplete="current-password" />
    <label>新密码</label><input id="pfNew" type="password" placeholder="至少 4 位" autocomplete="new-password" />
    <label>确认新密码</label><input id="pfNew2" type="password" autocomplete="new-password" />
    <button id="pfPwBtn" class="btn btn-block" style="margin-top:14px">修改密码</button>
    <small class="hint" style="display:block;margin-top:8px">修改密码后其它设备登录将失效。</small>
  `, (close) => {
    $('#pfUpload').addEventListener('click', () => $('#pfFile').click());
    $('#pfFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const dataUrl = await fileToAvatar(f);
        await api('/api/profile/avatar', { method: 'POST', body: JSON.stringify({ avatar: dataUrl }) });
        toast('头像已更新', 'ok'); await refreshNow();
        $('#pfAvatar').innerHTML = avatarHtml(state.status.user.avatar, state.status.user.displayName, 'sz-96');
      } catch (err) { toast(err.message || '上传失败', 'err'); }
    });
    $('#pfReset').addEventListener('click', async () => {
      try {
        await api('/api/profile/avatar/reset', { method: 'POST' });
        toast('已恢复默认头像', 'ok'); await refreshNow();
        $('#pfAvatar').innerHTML = avatarHtml(null, state.status.user.displayName, 'sz-96');
      } catch (err) { toast(err.message, 'err'); }
    });
    $('#pfSave').addEventListener('click', async () => {
      try {
        await api('/api/profile/update', { method: 'POST', body: JSON.stringify({ username: $('#pfUsername').value, nickname: $('#pfNickname').value }) });
        toast('资料已保存', 'ok'); await refreshNow();
      } catch (err) { toast(err.message, 'err'); }
    });
    $('#pfPwBtn').addEventListener('click', async () => {
      const oldPassword = $('#pfOld').value, newPassword = $('#pfNew').value;
      if (newPassword !== $('#pfNew2').value) return toast('两次新密码不一致', 'err');
      if (newPassword.length < 4) return toast('新密码至少 4 位', 'err');
      try {
        await api('/api/change-password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
        toast('密码修改成功', 'ok'); close();
      } catch (err) { toast(err.message, 'err'); }
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
          <label>用户名</label><input id="lu" placeholder="请输入用户名" autocomplete="username" />
          <label>密码</label><input id="lp" type="password" placeholder="请输入密码" autocomplete="current-password" />
          <button id="loginBtn" class="btn btn-block" style="margin-top:18px">登录</button>
        ` : `
          <label>用户名</label><input id="ru" placeholder="设置用户名" autocomplete="username" />
          <div id="ruHint" class="uname-hint"></div>
          <label>QQ 号</label><input id="rq" placeholder="请输入 QQ 号" inputmode="numeric" />
          <label>密码</label><input id="rp" type="password" placeholder="至少 4 位" autocomplete="new-password" />
          <button id="regBtn" class="btn btn-block" style="margin-top:18px">注册并登录</button>
        `}
      </div>
    </div>`;
  content.querySelectorAll('.tabs button').forEach((b) =>
    b.addEventListener('click', () => { state.authTab = b.dataset.tab; renderAuth(); }));
  if (t === 'login') {
    const submit = async () => {
      try { await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#lu').value, password: $('#lp').value }) }); await boot(); }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#loginBtn').addEventListener('click', submit);
    $('#lp').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  } else {
    let unameTimer = null;
    const ruEl = $('#ru'), hintEl = $('#ruHint');
    ruEl.addEventListener('input', () => {
      const v = ruEl.value.trim();
      clearTimeout(unameTimer);
      if (!v) { hintEl.textContent = ''; hintEl.className = 'uname-hint'; return; }
      hintEl.textContent = '检测中…'; hintEl.className = 'uname-hint';
      unameTimer = setTimeout(async () => {
        try {
          const r = await api('/api/check-username?username=' + encodeURIComponent(v));
          if (r.available) { hintEl.textContent = '✓ 用户名可用'; hintEl.className = 'uname-hint ok'; }
          else { hintEl.textContent = '✗ 用户名已被占用'; hintEl.className = 'uname-hint err'; }
        } catch (_) { hintEl.textContent = ''; }
      }, 400);
    });
    $('#regBtn').addEventListener('click', async () => {
      try {
        await api('/api/register', { method: 'POST', body: JSON.stringify({ username: $('#ru').value, qq: $('#rq').value, password: $('#rp').value }) });
        await boot(); toast('注册成功，欢迎！', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
  }
}

// ---------- 进入应用 ----------
function enterApp() {
  topbar.classList.remove('hidden');
  renderTopbar();
  state.view = state.status.caps.isAdmin ? 'admin' : 'user';
  state._navAnim = true;
  fullRender();
  startTimers();
}
function renderTopbar() {
  const u = state.status.user;
  $('#whoami').innerHTML = `${avatarHtml(u.avatar, u.displayName, 'sz-32')}<span>${esc(u.displayName)}</span> ${roleBadge(u.role)}`;
}
function startTimers() { stopTimers(); pollTimer = setInterval(pollTick, 3000); uiTimer = setInterval(uiTick, 1000); }
function stopTimers() { if (pollTimer) clearInterval(pollTimer); if (uiTimer) clearInterval(uiTimer); pollTimer = uiTimer = null; }

async function pollTick() {
  const prevActive = !!(state.status && state.status.activeVisit);
  const prevAdmin = state.status ? state.status.caps.isAdmin : false;
  try { state.status = await api('/api/status'); state.statusAt = Date.now(); }
  catch (e) { showAuth(); return; }
  renderTopbar();
  if ((!!state.status.activeVisit) !== prevActive || state.status.caps.isAdmin !== prevAdmin) { fullRender(); return; }
  if (state.view === 'user' || (state.view === 'admin' && state.adminTab === 'overview')) fullRender();
}
function uiTick() {
  const st = state.status;
  if (!st || !st.activeVisit) return;
  const av = st.activeVisit;
  const extraSec = (Date.now() - state.statusAt) / 1000;
  const elEl = $('#mElapsed'); if (elEl) elEl.textContent = dur(av.elapsedSec + extraSec);
  if (av.billable) {
    const extraCost = (av.rateNowCents * extraSec) / 3600;
    const costEl = $('#mCost'), balEl = $('#mBalance');
    if (costEl) costEl.textContent = money((av.currentCostCents + extraCost) / 100);
    if (balEl) {
      const liveBal = (av.projectedBalanceCents - extraCost) / 100;
      balEl.textContent = money(liveBal);
      balEl.classList.toggle('neg', liveBal < 0);
      balEl.classList.toggle('green', liveBal >= 0);
    }
  }
}
function fullRender() { if (state.view === 'user') renderUser(); else if (state.view === 'admin') renderAdmin(); }

// 导航切换时给视图根节点添加一次淡入动画（轮询刷新不触发）
function applyNavAnim() {
  if (!state._navAnim) return;
  state._navAnim = false;
  const root = content.firstElementChild;
  if (root) root.classList.add('fx-in');
}

async function refreshNow() {
  try { state.status = await api('/api/status'); state.statusAt = Date.now(); renderTopbar(); fullRender(); }
  catch (e) { showAuth(); }
}

// ---------- 在店人员展示 ----------
function peopleListHtml(people) {
  if (!people || !people.length) return '<span class="muted">当前没有人在店</span>';
  return `<div class="people-list">${people.map((p) => `
    <span class="chip">${avatarHtml(p.avatar, p.initial || p.name, 'sz-32')}
      <span><span class="nm">${esc(p.name)}</span> <span class="role">${p.isCustomer ? '顾客' : roleName(p.role)}</span></span>
    </span>`).join('')}</div>`;
}

// ---------- 公告板块 ----------
async function renderAnnouncements(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  let data;
  try { data = await api('/api/announcements'); } catch (_) { box.innerHTML = '<p class="muted">公告加载失败</p>'; return; }
  const items = data.items || [];
  const list = items.length ? `<div class="ann-list">${items.map((a) => `
    <div class="ann-item ${a.pinned ? 'pinned' : ''}">
      <div class="ann-top">${a.pinned ? '<span class="ann-tag">📌 置顶</span>' : ''}${a.title ? `<span class="ann-title">${esc(a.title)}</span>` : ''}</div>
      <div class="ann-content">${esc(a.content)}</div>
      <div class="ann-meta"><span>${esc(a.authorName || '管理员')}</span><span>${new Date(a.createdAt).toLocaleString('zh-CN')}</span>
        ${data.canManage ? `<span class="ann-acts">
          <button class="btn btn-ghost annPin" data-id="${a.id}" data-p="${a.pinned ? 0 : 1}">${a.pinned ? '取消置顶' : '置顶'}</button>
          <button class="btn btn-red annDel" data-id="${a.id}">删除</button></span>` : ''}
      </div>
    </div>`).join('')}</div>` : '<p class="empty">暂无公告</p>';
  box.innerHTML = (data.canManage ? '<div style="margin-bottom:12px"><button id="annAdd" class="btn btn-sm">+ 发布公告</button></div>' : '') + list;
  if (data.canManage) {
    const add = document.getElementById('annAdd');
    if (add) add.addEventListener('click', () => openAnnounceModal(boxId));
    box.querySelectorAll('.annPin').forEach((b) => b.addEventListener('click', async () => {
      try { await api('/api/admin/announcements/pin', { method: 'POST', body: JSON.stringify({ id: Number(b.dataset.id), pinned: Number(b.dataset.p) }) }); renderAnnouncements(boxId); }
      catch (e) { toast(e.message, 'err'); }
    }));
    box.querySelectorAll('.annDel').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('确定删除该公告？')) return;
      try { await api('/api/admin/announcements/delete', { method: 'POST', body: JSON.stringify({ id: Number(b.dataset.id) }) }); renderAnnouncements(boxId); }
      catch (e) { toast(e.message, 'err'); }
    }));
  }
}

function openAnnounceModal(boxId) {
  openModal('发布公告', `
    <label>标题（选填）</label><input id="anT" placeholder="公告标题" />
    <label>内容</label>
    <textarea id="anC" rows="4" placeholder="请输入公告内容" style="width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--text);font-size:14px;font-family:inherit;resize:vertical"></textarea>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input id="anP" type="checkbox" style="width:auto"> 置顶此公告</label>
    <button id="anBtn" class="btn btn-block" style="margin-top:14px">发布</button>
  `, (close) => {
    $('#anBtn').addEventListener('click', async () => {
      try {
        await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify({ title: $('#anT').value, content: $('#anC').value, pinned: $('#anP').checked }) });
        toast('公告已发布', 'ok'); close(); renderAnnouncements(boxId);
      } catch (e) { toast(e.message, 'err'); }
    });
  });
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
  const st = state.status, u = st.user, av = st.activeVisit, playing = !!av;
  const bal = playing ? av.projectedBalanceYuan : u.balanceYuan;
  content.innerHTML = `
    <div class="view-root">
    <div class="card"><h2>📢 店内公告</h2><div id="annBox"><p class="muted">加载中…</p></div></div>
    <div class="grid cols-2">
      <div>
        <div class="card">
          <h2>我的账户</h2>
          <div class="metric">
            <span class="label">账户余额</span>
            <span class="bignum mono ${bal < 0 ? 'neg' : 'green'}" id="mBalance">${money(bal)}</span>
          </div>
          <p class="muted" style="margin-top:10px">余额由管理员充值，详见右侧价格表。${bal < 0 ? '<span style="color:var(--red)"> 当前余额为负，请尽快充值。</span>' : ''}</p>
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
            <p class="muted">点击进店，系统按当前时段单价实时扣费。</p>
            <button id="startBtn" class="btn btn-green btn-block" style="margin-top:8px" ${u.balanceYuan <= 0 ? 'disabled' : ''}>进店 · 开始游玩</button>
            ${u.balanceYuan <= 0 ? '<small class="hint" style="color:var(--red)">余额不足，请联系管理员充值。</small>' : ''}
          `}
        </div>
      </div>
      <div>
        <div class="card">
          <h2>店内实况</h2>
          <div class="statusline"><span class="dot"></span>当前在店</div>
          <div class="metrics" style="margin-bottom:16px">
            <div class="metric"><span class="label">在店顾客</span><span class="val">${st.store.userCount} 人</span></div>
            <div class="metric"><span class="label">在店管理员</span><span class="val">${st.store.adminCount} 人</span></div>
          </div>
          ${peopleListHtml(st.store.people)}
        </div>
        <div class="card"><h2>价格表</h2>${pricingTableHtml(st.pricing)}</div>
        <div class="card"><h2>我的明细（充值 / 消费）</h2><div id="myTxBox"><p class="muted">加载中…</p></div></div>
      </div>
    </div>
    </div>`;

  if (playing) $('#endBtn').addEventListener('click', async () => {
    try { const r = await api('/api/visit/end', { method: 'POST' }); toast(`已离店，时长 ${dur(r.durationSec)}，扣费 ${money(r.chargedYuan)}`, 'ok'); await refreshNow(); }
    catch (e) { toast(e.message, 'err'); }
  });
  else { const sb = $('#startBtn'); if (sb) sb.addEventListener('click', async () => {
    try { await api('/api/visit/start', { method: 'POST' }); toast('进店成功，开始计时！', 'ok'); await refreshNow(); }
    catch (e) { toast(e.message, 'err'); }
  }); }
  loadMyTransactions();
  renderAnnouncements('annBox');
  applyNavAnim();
}

async function loadMyTransactions() {
  const box = $('#myTxBox'); if (!box) return;
  try { const data = await api('/api/transactions'); box.innerHTML = txTableHtml(data.items, false); }
  catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

function txTableHtml(items, showUser) {
  if (!items || !items.length) return '<p class="empty">暂无记录</p>';
  return `<table><thead><tr>${showUser ? '<th>用户</th>' : ''}<th>类型</th><th>说明</th><th>时间</th><th class="right">金额</th></tr></thead><tbody>
    ${items.map((it) => {
      let cls, sign, label;
      if (it.type === 'RECHARGE') { cls = 'tx-in'; sign = '+'; label = '<span class="pill in">充值</span>'; }
      else if (it.type === 'CHARGE') { cls = 'tx-out'; sign = '-'; label = '<span class="pill out">消费</span>'; }
      else { const pos = it.amountYuan >= 0; cls = pos ? 'tx-in' : 'tx-out'; sign = pos ? '+' : '-'; label = '<span class="pill out">余额调整</span>'; }
      return `<tr>${showUser ? `<td>${esc(it.username)}</td>` : ''}
        <td>${label}</td>
        <td class="muted">${esc(it.note || '')}</td>
        <td class="mono muted">${new Date(it.time).toLocaleString('zh-CN')}</td>
        <td class="right mono ${cls}">${sign}${money(Math.abs(it.amountYuan))}</td></tr>`;
    }).join('')}
  </tbody></table>`;
}

// ---------- 管理员视图 ----------
function renderAdmin() {
  const caps = state.status.caps;
  const tabs = [['overview', '店内总览']];
  if (caps.MANAGE_USERS) tabs.push(['users', '用户列表']);
  if (caps.VIEW_REPORTS || caps.MANAGE_PRICING) tabs.push(['business', '营业管理']);
  if (!tabs.find((t) => t[0] === state.adminTab)) state.adminTab = 'overview';

  content.innerHTML = `
    <div class="adminnav">
      ${tabs.map(([k, label]) => `<button data-tab="${k}" class="${state.adminTab === k ? 'active' : ''}">${label}</button>`).join('')}
    </div>
    <div id="adminBody"></div>`;
  content.querySelectorAll('.adminnav button').forEach((b) =>
    b.addEventListener('click', () => { state._navAnim = true; state.adminTab = b.dataset.tab; renderAdmin(); }));

  const body = $('#adminBody');
  if (state._navAnim) { state._navAnim = false; body.classList.add('fx-in'); }
  if (state.adminTab === 'overview') renderAdminOverview(body);
  else if (state.adminTab === 'users') renderAdminUserList(body);
  else if (state.adminTab === 'business') renderAdminBusiness(body);
}

function renderAdminOverview(body) {
  const st = state.status, av = st.activeVisit, people = st.store.people || [], canManage = st.caps.MANAGE_USERS;
  body.innerHTML = `
    <div class="card"><h2>📢 店内公告</h2><div id="annBox"><p class="muted">加载中…</p></div></div>
    <div class="grid cols-2">
      <div class="card">
        <h2>我的打卡</h2>
        ${av ? `
          <div class="statusline"><span class="dot"></span>在店打卡中</div>
          <div class="metric"><span class="label">在店时长</span><span class="val mono" id="mElapsed">${dur(av.elapsedSec)}</span></div>
          <button id="endBtn" class="btn btn-red btn-block" style="margin-top:16px">离店打卡</button>
          <small class="hint">管理员打卡不计费。</small>
        ` : `
          <p class="muted">进店打卡后，顾客可在"店内实况"看到你在店。</p>
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
      <h2>当前在店人员（可见全部姓名）</h2>
      ${people.length ? `<table><thead><tr><th>用户</th><th>身份</th><th>进店时间</th><th class="right">已在店</th>${canManage ? '<th class="right">操作</th>' : ''}</tr></thead><tbody>
        ${people.map((p) => `<tr>
          <td><div style="display:flex;align-items:center;gap:10px">${avatarHtml(p.avatar, p.initial || p.name, 'sz-32')}<span>${esc(p.name)}</span></div></td>
          <td>${p.isCustomer ? '<span class="badge user">顾客</span>' : roleBadge(p.role)}</td>
          <td class="mono">${new Date(p.startTime).toLocaleTimeString('zh-CN')}</td>
          <td class="right mono">${dur(p.elapsedSec)}</td>
          ${canManage ? `<td class="right"><button class="btn btn-sm btn-red endUserBtn" data-id="${p.id}" data-name="${esc(p.name)}">结束</button></td>` : ''}
        </tr>`).join('')}
      </tbody></table>` : '<p class="empty">当前没有人在店</p>'}
    </div>`;

  if (av) $('#endBtn').addEventListener('click', async () => {
    try { await api('/api/visit/end', { method: 'POST' }); toast('已离店打卡', 'ok'); await refreshNow(); } catch (e) { toast(e.message, 'err'); }
  });
  else $('#startBtn').addEventListener('click', async () => {
    try { await api('/api/visit/start', { method: 'POST' }); toast('已进店打卡', 'ok'); await refreshNow(); } catch (e) { toast(e.message, 'err'); }
  });
  if (canManage) body.querySelectorAll('.endUserBtn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`确定结束「${b.dataset.name}」的当前会话？`)) return;
    try { const r = await api('/api/admin/end-visit', { method: 'POST', body: JSON.stringify({ userId: Number(b.dataset.id) }) });
      toast(`已结束，时长 ${dur(r.durationSec)}，扣费 ${money(r.chargedYuan)}`, 'ok'); await refreshNow(); }
    catch (e) { toast(e.message, 'err'); }
  }));
  renderAnnouncements('annBox');
}

// ---------- 用户列表（合并） ----------
async function renderAdminUserList(body) {
  body.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  let data;
  try { data = await api('/api/admin/users'); } catch (e) { body.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p></div>`; return; }
  const isSuper = state.status.caps.isSuper;

  const rowHtml = (u) => `<tr>
      <td><div style="display:flex;align-items:center;gap:10px">${avatarHtml(u.avatar, u.displayName, 'sz-32')}
        <span><b>${esc(u.displayName)}</b>${u.nickname ? `<br><small class="muted">@${esc(u.username)}</small>` : ''}</span></div></td>
      <td class="muted">${esc(u.qq)}</td>
      <td>${roleBadge(u.role)}</td>
      <td class="right mono">${money(u.balanceYuan)}</td>
      <td>${u.inStore ? '<span class="pill in">在店</span>' : '<span class="pill out">离店</span>'}</td>
      <td class="right">${u.role === 'SUPER_ADMIN' ? '<span class="muted">—</span>' : `<button class="btn btn-sm editUserBtn" data-id="${u.id}">管理</button>`}</td>
    </tr>`;

  body.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h2 style="margin:0">用户列表</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${isSuper ? '<button id="opPwBtn" class="btn btn-ghost btn-sm">设置操作密码</button>' : ''}
          <button id="exportBtn" class="btn btn-ghost btn-sm">⬇ 导出Excel</button>
          <button id="addUserBtn" class="btn btn-sm">+ 新增用户</button>
        </div>
      </div>
      <input id="userSearch" class="search-box" placeholder="🔍 搜索 用户名 / 昵称 / QQ 号" value="${esc(state._userSearch || '')}" />
      <table><thead><tr><th>用户</th><th>QQ</th><th>身份</th><th class="right">余额</th><th>状态</th><th class="right">操作</th></tr></thead>
      <tbody id="userRows"></tbody></table>
      <small class="hint" style="display:block;margin-top:10px">修改 / 删除用户信息需输入操作密码。</small>
    </div>`;

  const paint = () => {
    const q = (state._userSearch || '').trim().toLowerCase();
    const list = !q ? data.users : data.users.filter((u) =>
      (u.username || '').toLowerCase().includes(q) ||
      (u.nickname || '').toLowerCase().includes(q) ||
      (u.qq || '').toLowerCase().includes(q));
    const tb = $('#userRows');
    tb.innerHTML = list.length ? list.map(rowHtml).join('') : '<tr><td colspan="6" class="empty">未找到匹配的用户</td></tr>';
    tb.querySelectorAll('.editUserBtn').forEach((b) => b.addEventListener('click', () => {
      const u = data.users.find((x) => x.id === Number(b.dataset.id));
      openUserEditModal(u, () => renderAdminUserList(body));
    }));
  };
  paint();

  $('#userSearch').addEventListener('input', (e) => { state._userSearch = e.target.value; paint(); });
  $('#exportBtn').addEventListener('click', () => { window.location.href = '/api/admin/users/export'; });
  $('#addUserBtn').addEventListener('click', () => openUserAddModal(() => renderAdminUserList(body)));
  if (isSuper) $('#opPwBtn').addEventListener('click', openOpPasswordModal);
}

function openUserAddModal(done) {
  openModal('新增用户', `
    <label>用户名</label><input id="auU" placeholder="登录用户名" />
    <label>昵称</label><input id="auN" placeholder="店内显示名（选填）" />
    <label>QQ 号</label><input id="auQ" placeholder="选填" />
    <label>初始密码</label><input id="auP" type="password" placeholder="至少 4 位" />
    <button id="auBtn" class="btn btn-block" style="margin-top:16px">创建用户</button>
  `, (close) => {
    $('#auBtn').addEventListener('click', () => {
      const payload = { username: $('#auU').value, nickname: $('#auN').value, qq: $('#auQ').value, password: $('#auP').value };
      if (!payload.username.trim()) return toast('请填写用户名', 'err');
      if ((payload.password || '').length < 4) return toast('密码至少 4 位', 'err');
      promptOpPassword(async (opPassword, closeOp) => {
        await api('/api/admin/users/create', { method: 'POST', body: JSON.stringify({ ...payload, opPassword }) });
        toast('用户已创建', 'ok'); closeOp(); close(); done();
      });
    });
  });
}

function openUserEditModal(u, done) {
  const isSuper = state.status.caps.isSuper;
  const allPerms = Object.keys(PERM_LABELS);
  openModal(`管理用户：${esc(u.displayName)}`, `
    <div class="avatar-edit">${avatarHtml(u.avatar, u.displayName, 'sz-96')}
      <div class="acts"><button id="euResetAvatar" class="btn btn-ghost btn-sm">恢复默认头像</button></div>
    </div>
    <label>用户名</label><input id="euU" value="${esc(u.username)}" />
    <label>昵称</label><input id="euN" value="${esc(u.nickname)}" placeholder="店内显示名（选填）" />
    <label>QQ 号</label><input id="euQ" value="${esc(u.qq)}" />
    <label>余额（元）</label><input id="euB" type="number" min="0" step="0.01" value="${u.balanceYuan}" />
    ${isSuper ? `
      <label>身份</label>
      <select id="euRole"><option value="USER" ${u.role === 'USER' ? 'selected' : ''}>用户</option>
        <option value="SUB_ADMIN" ${u.role === 'SUB_ADMIN' ? 'selected' : ''}>管理员</option></select>
      <div id="euPermWrap" style="${u.role === 'SUB_ADMIN' ? '' : 'display:none'}">
        <label>权限</label>
        <div class="perm-grid">${allPerms.map((p) => `<label><input type="checkbox" class="euPerm" value="${p}" ${u.permissions.includes(p) ? 'checked' : ''}>${PERM_LABELS[p]}</label>`).join('')}</div>
      </div>` : ''}
    <hr class="section-divider" />
    <div class="row" style="margin-top:4px">
      <button id="euSave" class="btn">保存修改</button>
      <button id="euDel" class="btn btn-red" style="flex:none">删除用户</button>
    </div>
    <small class="hint" style="display:block;margin-top:10px">保存 / 删除 / 重置头像时需输入操作密码。</small>
  `, (close) => {
    if (isSuper) {
      const roleSel = $('#euRole');
      roleSel.addEventListener('change', () => { $('#euPermWrap').style.display = roleSel.value === 'SUB_ADMIN' ? '' : 'none'; });
    }
    $('#euResetAvatar').addEventListener('click', () => {
      promptOpPassword(async (opPassword, closeOp) => {
        await api('/api/admin/users/reset-avatar', { method: 'POST', body: JSON.stringify({ userId: u.id, opPassword }) });
        toast('头像已恢复默认', 'ok'); closeOp(); close(); done();
      });
    });
    $('#euSave').addEventListener('click', () => {
      const payload = { userId: u.id, username: $('#euU').value, nickname: $('#euN').value, qq: $('#euQ').value, balanceYuan: $('#euB').value };
      const role = isSuper ? $('#euRole').value : null;
      const permissions = isSuper ? [...document.querySelectorAll('.euPerm:checked')].map((c) => c.value) : null;
      promptOpPassword(async (opPassword, closeOp) => {
        await api('/api/admin/users/update', { method: 'POST', body: JSON.stringify({ ...payload, opPassword }) });
        if (isSuper) {
          await api('/api/admin/set-role', { method: 'POST', body: JSON.stringify({ userId: u.id, role, opPassword }) });
          if (role === 'SUB_ADMIN') {
            await api('/api/admin/set-permissions', { method: 'POST', body: JSON.stringify({ userId: u.id, permissions, opPassword }) });
          }
        }
        toast('已保存', 'ok'); closeOp(); close(); done();
      });
    });
    $('#euDel').addEventListener('click', () => {
      if (!confirm(`确定删除用户「${u.displayName}」？该操作不可恢复。`)) return;
      promptOpPassword(async (opPassword, closeOp) => {
        await api('/api/admin/users/delete', { method: 'POST', body: JSON.stringify({ userId: u.id, opPassword }) });
        toast('用户已删除', 'ok'); closeOp(); close(); done();
      });
    });
  });
}

function openOpPasswordModal() {
  openModal('设置操作密码', `
    <p class="muted">操作密码用于修改 / 删除用户等敏感操作。</p>
    <label>原操作密码</label><input id="opOld" type="password" />
    <label>新操作密码</label><input id="opNew" type="password" placeholder="至少 4 位" />
    <label>确认新操作密码</label><input id="opNew2" type="password" />
    <button id="opBtn" class="btn btn-block" style="margin-top:16px">保存</button>
  `, (close) => {
    $('#opBtn').addEventListener('click', async () => {
      const newPassword = $('#opNew').value;
      if (newPassword !== $('#opNew2').value) return toast('两次新密码不一致', 'err');
      try { await api('/api/admin/op-password', { method: 'POST', body: JSON.stringify({ oldPassword: $('#opOld').value, newPassword }) });
        toast('操作密码已更新', 'ok'); close(); } catch (e) { toast(e.message, 'err'); }
    });
  });
}

// ---------- 营业管理（报表 / 定价 / 流水） ----------
function renderAdminBusiness(body) {
  const caps = state.status.caps;
  const subs = [];
  if (caps.VIEW_REPORTS) subs.push(['reports', '营业报表']);
  if (caps.MANAGE_PRICING) subs.push(['pricing', '营业定价']);
  if (caps.VIEW_REPORTS) subs.push(['txns', '流水明细']);
  if (!subs.find((s) => s[0] === state.bizTab)) state.bizTab = subs[0] ? subs[0][0] : 'reports';

  body.innerHTML = `<div class="adminnav sub">
      ${subs.map(([k, label]) => `<button data-sub="${k}" class="${state.bizTab === k ? 'active' : ''}">${label}</button>`).join('')}
    </div><div id="bizBody"></div>`;
  body.querySelectorAll('.adminnav.sub button').forEach((b) =>
    b.addEventListener('click', () => { state._bizAnim = true; state.bizTab = b.dataset.sub; renderAdminBusiness(body); }));

  const bb = $('#bizBody');
  if (state._bizAnim) { state._bizAnim = false; bb.classList.add('fx-in'); }
  if (state.bizTab === 'reports') renderAdminReports(bb);
  else if (state.bizTab === 'pricing') renderAdminPricing(bb);
  else renderAdminTxns(bb);
}

async function renderAdminReports(box) {
  box.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  if (!state._reportDate) state._reportDate = new Date().toISOString().slice(0, 10);
  let data;
  try { data = await api('/api/admin/reports?date=' + state._reportDate); }
  catch (e) { box.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p></div>`; return; }
  box.innerHTML = `
    <div class="card">
      <h2>营业报表</h2>
      <div class="row" style="margin-bottom:18px"><div style="flex:none"><label>选择日期</label><input id="repDate" type="date" value="${data.date}" /></div></div>
      <div class="metrics">
        <div class="metric"><span class="label">当日营业额</span><span class="bignum amber mono">${money(data.dayRevenueYuan)}</span></div>
        <div class="metric"><span class="label">当日顾客场次</span><span class="val">${data.customerVisits} 场</span></div>
      </div>
    </div>
    <div class="card"><h2>近 7 天营业额</h2>${weeklyChart(data.weekly)}</div>
    <div class="card"><h2>当日进出记录</h2>
      ${data.records.length ? `<table><thead><tr><th>用户</th><th>身份</th><th>进店</th><th>离店</th><th class="right">时长</th><th class="right">消费</th><th>状态</th></tr></thead><tbody>
        ${data.records.map((r) => `<tr><td>${esc(r.username)}</td>
          <td>${r.billable ? '<span class="badge user">顾客</span>' : '<span class="badge sub">管理员</span>'}</td>
          <td class="mono">${new Date(r.startTime).toLocaleTimeString('zh-CN')}</td>
          <td class="mono">${r.endTime ? new Date(r.endTime).toLocaleTimeString('zh-CN') : '<span class="pill in">在店中</span>'}</td>
          <td class="right mono">${dur(r.durationSec)}</td><td class="right mono">${money(r.chargedYuan)}</td>
          <td>${r.status === 'ACTIVE' ? '<span class="pill in">在店中</span>' : (r.endReason === 'NO_BALANCE' ? '<span class="pill out">余额耗尽</span>' : '<span class="pill out">正常离店</span>')}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">当日暂无记录</p>'}
    </div>`;
  $('#repDate').addEventListener('change', (e) => { state._reportDate = e.target.value; renderAdminReports(box); });
}

function weeklyChart(weekly) {
  const W = 720, H = 240, padL = 44, padB = 34, padT = 16, padR = 16;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(1, ...weekly.map((d) => d.revenueYuan));
  const niceMax = Math.ceil(max / 5) * 5 || 5;
  const n = weekly.length, slot = innerW / n, barW = Math.min(46, slot * 0.55);
  let bars = '', labels = '', vals = '';
  weekly.forEach((d, i) => {
    const h = (d.revenueYuan / niceMax) * innerH;
    const x = padL + slot * i + (slot - barW) / 2, y = padT + innerH - h;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="5" fill="#3b6fe0"></rect>`;
    if (d.revenueYuan > 0) vals += `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="11" fill="#e8920c">${d.revenueYuan.toFixed(0)}</text>`;
    labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#76819a">${d.date.slice(5)}</text>`;
  });
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const val = (niceMax / 4) * g, y = padT + innerH - (val / niceMax) * innerH;
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e2e7f0" stroke-width="1"></line>`;
    grid += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#76819a">${val.toFixed(0)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img">${grid}${bars}${vals}${labels}</svg>`;
}

async function renderAdminPricing(box) {
  box.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  let data;
  try { data = await api('/api/admin/pricing'); } catch (e) { box.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p></div>`; return; }
  const rowHtml = (r) => `<div class="rule-row">
      <select class="rStart">${hourOpts(r.startHour)}</select><span>:00 至</span>
      <select class="rEnd">${hourOpts(r.endHour)}</select><span>:00 =</span>
      <input class="rRate" type="number" min="0" step="0.01" value="${r.rateYuan}" /><span>元/小时</span>
      <button class="btn btn-ghost btn-sm rDel">删除</button></div>`;
  box.innerHTML = `
    <div class="card">
      <h2>营业定价（分时段）</h2>
      <p class="muted">设置不同时段每小时单价，进店按当前时段费率实时扣费。0–24 整点，时段不可重叠，未覆盖视为免费。</p>
      <div id="rules">${(data.rules.length ? data.rules : [{ startHour: 0, endHour: 24, rateYuan: 10 }]).map(rowHtml).join('')}</div>
      <div class="row" style="margin-top:6px">
        <button id="addRule" class="btn btn-ghost btn-sm" style="flex:none">+ 添加时段</button><div></div>
        <button id="savePricing" class="btn" style="flex:none">保存价格</button>
      </div>
    </div>`;
  const rulesBox = $('#rules');
  const wireDel = () => rulesBox.querySelectorAll('.rDel').forEach((b) => { b.onclick = () => b.closest('.rule-row').remove(); });
  wireDel();
  $('#addRule').addEventListener('click', () => {
    const div = document.createElement('div'); div.innerHTML = rowHtml({ startHour: 0, endHour: 24, rateYuan: 0 });
    const node = div.firstElementChild; rulesBox.appendChild(node); node.querySelector('.rDel').onclick = () => node.remove();
  });
  $('#savePricing').addEventListener('click', async () => {
    const rules = [...rulesBox.querySelectorAll('.rule-row')].map((row) => ({
      startHour: Number(row.querySelector('.rStart').value), endHour: Number(row.querySelector('.rEnd').value), rateYuan: Number(row.querySelector('.rRate').value),
    }));
    try { await api('/api/admin/pricing', { method: 'POST', body: JSON.stringify({ rules }) }); toast('价格已保存', 'ok'); await refreshNow(); renderAdminPricing(box); }
    catch (e) { toast(e.message, 'err'); }
  });
}
function hourOpts(sel) { let s = ''; for (let h = 0; h <= 24; h++) s += `<option value="${h}" ${h === sel ? 'selected' : ''}>${String(h).padStart(2, '0')}</option>`; return s; }

async function renderAdminTxns(box) {
  box.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  let users = [];
  try { users = (await api('/api/admin/users')).users; } catch (_) {}
  const load = async () => {
    const tb = $('#txBox'); tb.innerHTML = '<p class="muted">加载中…</p>';
    const q = [];
    if (state._txFilter.userId) q.push('userId=' + state._txFilter.userId);
    if (state._txFilter.type) q.push('type=' + state._txFilter.type);
    try { const data = await api('/api/admin/transactions' + (q.length ? '?' + q.join('&') : '')); tb.innerHTML = txTableHtml(data.items, true); }
    catch (e) { tb.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
  };
  box.innerHTML = `
    <div class="card">
      <h2>流水明细</h2>
      <div class="filters">
        <div><label>用户</label><select id="fUser"><option value="">全部用户</option>
          ${users.map((u) => `<option value="${u.id}" ${state._txFilter.userId == u.id ? 'selected' : ''}>${esc(u.displayName)}</option>`).join('')}</select></div>
        <div><label>类型</label><select id="fType">
          <option value="" ${state._txFilter.type === '' ? 'selected' : ''}>全部</option>
          <option value="RECHARGE" ${state._txFilter.type === 'RECHARGE' ? 'selected' : ''}>充值</option>
          <option value="CHARGE" ${state._txFilter.type === 'CHARGE' ? 'selected' : ''}>消费</option>
          <option value="ADJUST" ${state._txFilter.type === 'ADJUST' ? 'selected' : ''}>余额调整</option></select></div>
      </div>
      <div id="txBox"></div>
      <small class="hint" style="display:block;margin-top:10px">消费按每次进店聚合显示。</small>
    </div>`;
  $('#fUser').addEventListener('change', (e) => { state._txFilter.userId = e.target.value; load(); });
  $('#fType').addEventListener('change', (e) => { state._txFilter.type = e.target.value; load(); });
  load();
}

boot();
