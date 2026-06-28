'use strict';

const $ = (sel) => document.querySelector(sel);
const content = $('#content');
const topbar = $('#topbar');

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(yuan) { return '¥' + Number(yuan || 0).toFixed(2); }
function dur(sec) { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; const p = (n) => String(n).padStart(2, '0'); return `${p(h)}:${p(m)}:${p(s)}`; }
function fmtHM(sec) { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`; }
function roleName(r) { return { SUPER_ADMIN: '超级管理员', SUB_ADMIN: '管理员', USER: '用户' }[r] || r; }
function roleBadge(r) { const cls = { SUPER_ADMIN: 'super', SUB_ADMIN: 'sub', USER: 'user' }[r] || 'user'; return `<span class="badge ${cls}">${roleName(r)}</span>`; }
function avatarHtml(url, label, sz = 'sz-40') { if (url) return `<span class="avatar ${sz}"><img src="${esc(url)}" alt=""></span>`; return `<span class="avatar ${sz}">${esc(([...String(label || '?')][0]) || '?')}</span>`; }

let toastTimer = null;
function toast(msg, type = '') { const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + type; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2800); }

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let data = {}; try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

const PERM_LABELS = { RECHARGE: '为用户充值', MANAGE_PRICING: '调整营业价格', VIEW_REPORTS: '查看营业报表', MANAGE_USERS: '管理用户', MANAGE_CARDS: '增删用户卡片', GRANT_FREE: '发放/调整免费额度' };

const state = {
  status: null, statusAt: 0, view: 'auth', adminTab: 'overview', bizTab: 'reports', authTab: 'login',
  _reportDate: null, _txFilter: { userId: '', type: '' }, _userSearch: '', _navAnim: false, _bizAnim: false,
  _openCust: false, _openAdm: false, _storeSig: '',
};
let pollTimer = null, uiTimer = null;

// ---------- 启动 / 顶栏 ----------
async function boot() { try { state.status = await api('/api/status'); state.statusAt = Date.now(); enterApp(); } catch (e) { showAuth(); } }

$('#userMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#userMenu').classList.toggle('hidden'); });
document.addEventListener('click', () => { const m = $('#userMenu'); if (m) m.classList.add('hidden'); });

function enterApp() { topbar.classList.remove('hidden'); renderTopbar(); state.view = state.status.caps.isAdmin ? 'admin' : 'user'; state._navAnim = true; fullRender(); startTimers(); }
function renderTopbar() {
  const u = state.status.user;
  $('#whoami').innerHTML = `${avatarHtml(u.avatar, u.displayName, 'sz-32')}<span>${esc(u.displayName)}</span> ${roleBadge(u.role)}`;
  $('#userMenu').innerHTML = `<div class="who">${esc(u.displayName)} · ${roleName(u.role)}</div><button id="miProfile">我的信息</button><button id="miLogout">退出登录</button>`;
  $('#miProfile').onclick = openProfile;
  $('#miLogout').onclick = async () => { try { await api('/api/logout', { method: 'POST' }); } catch (_) {} state.status = null; showAuth(); };
}
function startTimers() { stopTimers(); pollTimer = setInterval(pollTick, 3000); uiTimer = setInterval(uiTick, 1000); }
function stopTimers() { if (pollTimer) clearInterval(pollTimer); if (uiTimer) clearInterval(uiTimer); pollTimer = uiTimer = null; }

async function pollTick() {
  const prevActive = !!(state.status && state.status.activeVisit);
  const prevAdmin = state.status ? state.status.caps.isAdmin : false;
  try { state.status = await api('/api/status'); state.statusAt = Date.now(); } catch (e) { showAuth(); return; }
  if ((!!state.status.activeVisit) !== prevActive || state.status.caps.isAdmin !== prevAdmin) { renderTopbar(); fullRender(); return; }
  if (state.view === 'user' || (state.view === 'admin' && state.adminTab === 'overview')) patchHome();
}
function uiTick() {
  const st = state.status; if (!st) return;
  const av = st.activeVisit;
  if (st.caps.isAdmin && av) { const extra = (Date.now() - state.statusAt) / 1000; const e = $('#mElapsed'); if (e) e.textContent = dur(av.elapsedSec + extra); const mo = $('#acctMonthly'); if (mo) mo.textContent = fmtHM((st.monthlyDurationSec || 0) + extra); return; }
  if (!av) return;
  const extra = (Date.now() - state.statusAt) / 1000;
  const el = $('#mElapsed'); if (el) el.textContent = dur(av.elapsedSec + extra);
  if (av.billable) {
    const extraCost = (av.rateNowCents * extra) / 3600;
    const cEl = $('#mCost'); if (cEl) cEl.textContent = money((av.currentCostCents + extraCost) / 100);
    const fc = av.projectedFreeCents || 0, usedFree = Math.min(fc, extraCost), liveFree = fc - usedFree;
    const liveBal = (av.projectedBalanceCents || 0) - (extraCost - usedFree);
    const fEl = $('#acctFree'); if (fEl) fEl.textContent = money(liveFree / 100);
    const bEl = $('#acctBalance'); if (bEl) { bEl.textContent = money(liveBal / 100); bEl.classList.toggle('neg', liveBal < 0); bEl.classList.toggle('bal-deep', liveBal >= 0); }
  }
}
function fullRender() { if (state.view === 'user') renderUser(); else if (state.view === 'admin') renderAdmin(); }
function applyNavAnim() { if (!state._navAnim) return; state._navAnim = false; const r = content.firstElementChild; if (r) r.classList.add('fx-in'); }
async function refreshNow() { try { state.status = await api('/api/status'); state.statusAt = Date.now(); renderTopbar(); fullRender(); } catch (e) { showAuth(); } }

// ---------- 弹窗基础 ----------
function openModal(title, bodyHtml, onMount) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-overlay"><div class="modal"><div class="modal-head"><h2>${title}</h2><button class="modal-close">×</button></div><div class="modal-body">${bodyHtml}</div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.modal-close').addEventListener('click', close);
  root.querySelector('.modal-overlay').addEventListener('click', (e) => { if (e.target.classList.contains('modal-overlay')) close(); });
  if (onMount) onMount(close);
  return close;
}
function nestedModal(title, innerHtml, onMount) {
  const wrap = document.createElement('div'); wrap.className = 'modal-overlay'; wrap.style.zIndex = '250';
  wrap.innerHTML = `<div class="modal" style="max-width:400px"><div class="modal-head"><h2>${title}</h2><button class="modal-close">×</button></div><div class="modal-body">${innerHtml}</div></div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.modal-close').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  onMount(wrap, close);
  return close;
}
function promptField(title, label, type, key, onConfirm) {
  nestedModal(title, `<label>${label}</label><input id="pfin" type="${type}"><button id="pfok" class="btn btn-block" style="margin-top:14px">确认</button>`, (w, close) => {
    const go = async () => { const o = {}; o[key] = w.querySelector('#pfin').value; try { await onConfirm(o, close); } catch (e) { toast(e.message, 'err'); } };
    w.querySelector('#pfok').addEventListener('click', go);
    w.querySelector('#pfin').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    setTimeout(() => w.querySelector('#pfin').focus(), 50);
  });
}
const promptAdminPw = (onConfirm) => promptField('验证管理员密码', '管理员密码', 'password', 'adminPassword', onConfirm);
const promptLevel2 = (onConfirm) => promptField('验证二级统一密码', '二级统一密码', 'password', 'level2', onConfirm);
function authForTarget(role, onConfirm) { (role === 'USER' ? promptAdminPw : promptLevel2)(onConfirm); }
// 多方式验证：methods=[{key,label,type}], extra=[{key,label,type}]
function methodAuthModal(title, methods, extra, onConfirm) {
  const tabs = methods.map((m, i) => `<button data-k="${m.key}" class="${i === 0 ? 'active' : ''}">${m.label}</button>`).join('');
  const extraHtml = (extra || []).map((f) => `<label>${f.label}</label><input id="mf_${f.key}" type="${f.type || 'text'}">`).join('');
  nestedModal(title, `<div class="tabs">${tabs}</div><div id="maField"></div>${extraHtml}<button id="maOk" class="btn btn-block" style="margin-top:14px">确认</button>`, (w, close) => {
    let cur = methods[0];
    const render = () => { w.querySelector('#maField').innerHTML = `<label>${cur.label}</label><input id="maInput" type="${cur.type || 'text'}">`; };
    render();
    w.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { w.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active')); b.classList.add('active'); cur = methods.find((m) => m.key === b.dataset.k); render(); }));
    w.querySelector('#maOk').addEventListener('click', async () => {
      const obj = {}; obj[cur.key] = w.querySelector('#maInput').value;
      (extra || []).forEach((f) => { obj[f.key] = w.querySelector('#mf_' + f.key).value; });
      try { await onConfirm(obj, close); } catch (e) { toast(e.message, 'err'); }
    });
  });
}

function fileToAvatar(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const img = new Image(); img.onload = () => { const s = 128, c = document.createElement('canvas'); c.width = s; c.height = s; const ctx = c.getContext('2d'); const min = Math.min(img.width, img.height); ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, s, s); resolve(c.toDataURL('image/jpeg', 0.85)); }; img.onerror = reject; img.src = r.result; };
    r.onerror = reject; r.readAsDataURL(file);
  });
}

// ---------- 我的信息 ----------
function openProfile() {
  const u = state.status.user, isAdmin = state.status.caps.isAdmin, isSuper = state.status.caps.isSuper;
  openModal('我的信息', `
    <div class="avatar-edit"><span id="pfAvatar">${avatarHtml(u.avatar, u.displayName, 'sz-96')}</span>
      <div class="acts"><button id="pfUpload" class="btn btn-sm">上传头像</button><button id="pfReset" class="btn btn-ghost btn-sm">恢复默认</button><input id="pfFile" type="file" accept="image/*" class="hidden" /></div></div>
    <small class="hint">默认头像为用户名首字。</small>
    <label>用户名</label><input id="pfUsername" value="${esc(u.username)}" />
    <label>昵称</label><input id="pfNickname" value="${esc(u.nickname)}" placeholder="店内显示名（选填）" />
    <button id="pfSave" class="btn btn-block" style="margin-top:16px">保存资料</button>
    <hr class="section-divider" />
    <h3>我的卡片</h3>
    <div id="myCardsBox"><p class="muted">加载中…</p></div>
    ${isAdmin ? '<div class="row" style="margin-top:6px"><div><input id="selfCardNo" placeholder="刷卡或输入卡号"></div><div style="flex:none;align-self:flex-end"><button id="selfCardAdd" class="btn btn-sm">添加卡片</button></div></div>' : '<small class="hint">卡片由管理员发放，你可删除但不能新增；每人至多 3 张。</small>'}
    <hr class="section-divider" />
    <h3>修改登录密码</h3>
    <label>原密码</label><input id="pfOld" type="password" />
    <label>新密码</label><input id="pfNew" type="password" placeholder="至少 4 位" />
    <label>确认新密码</label><input id="pfNew2" type="password" />
    <button id="pfPwBtn" class="btn btn-block" style="margin-top:12px">修改登录密码</button>
    ${isAdmin ? `<hr class="section-divider" /><h3>管理与安全</h3>
      <div class="row"><button id="pfAdminPw" class="btn btn-ghost btn-sm">修改我的管理员密码</button>
        <button id="pfLevel2" class="btn btn-ghost btn-sm">修改二级统一密码</button>
        ${isSuper ? '<button id="pfSuperQr" class="btn btn-ghost btn-sm">生成授权二维码</button>' : ''}</div>` : ''}
  `, (close) => {
    $('#pfUpload').addEventListener('click', () => $('#pfFile').click());
    $('#pfFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; try { const d = await fileToAvatar(f); await api('/api/profile/avatar', { method: 'POST', body: JSON.stringify({ avatar: d }) }); toast('头像已更新', 'ok'); await refreshNow(); $('#pfAvatar').innerHTML = avatarHtml(state.status.user.avatar, state.status.user.displayName, 'sz-96'); } catch (err) { toast(err.message, 'err'); } });
    $('#pfReset').addEventListener('click', async () => { try { await api('/api/profile/avatar/reset', { method: 'POST' }); toast('已恢复默认头像', 'ok'); await refreshNow(); $('#pfAvatar').innerHTML = avatarHtml(null, state.status.user.displayName, 'sz-96'); } catch (err) { toast(err.message, 'err'); } });
    $('#pfSave').addEventListener('click', async () => { try { await api('/api/profile/update', { method: 'POST', body: JSON.stringify({ username: $('#pfUsername').value, nickname: $('#pfNickname').value }) }); toast('资料已保存', 'ok'); await refreshNow(); } catch (err) { toast(err.message, 'err'); } });
    $('#pfPwBtn').addEventListener('click', async () => { const oldPassword = $('#pfOld').value, newPassword = $('#pfNew').value; if (newPassword !== $('#pfNew2').value) return toast('两次新密码不一致', 'err'); if (newPassword.length < 4) return toast('新密码至少 4 位', 'err'); try { await api('/api/change-password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) }); toast('登录密码已修改', 'ok'); close(); } catch (err) { toast(err.message, 'err'); } });
    if (isAdmin) {
      const sa = $('#selfCardAdd'); if (sa) sa.addEventListener('click', async () => { const no = $('#selfCardNo').value.trim(); if (!no) return toast('请输入卡号', 'err'); try { await api('/api/cards/add', { method: 'POST', body: JSON.stringify({ cardNo: no }) }); toast('已添加', 'ok'); $('#selfCardNo').value = ''; loadMyCards(true); } catch (e) { toast(e.message, 'err'); } });
      $('#pfAdminPw').addEventListener('click', () => methodAuthModal('修改我的管理员密码',
        [{ key: 'oldAdminPassword', label: '原管理员密码', type: 'password' }, { key: 'level2', label: '二级统一密码', type: 'password' }, { key: 'superQr', label: '超管授权码', type: 'text' }],
        [{ key: 'newPassword', label: '新管理员密码', type: 'password' }],
        async (obj, c) => { await api('/api/admin/my-admin-password', { method: 'POST', body: JSON.stringify(obj) }); toast('管理员密码已修改', 'ok'); c(); }));
      $('#pfLevel2').addEventListener('click', () => methodAuthModal('修改二级统一密码',
        [{ key: 'superPw', label: '超管账户密码', type: 'password' }, { key: 'superQr', label: '超管授权码', type: 'text' }, { key: 'superCard', label: '超管卡号', type: 'text' }],
        [{ key: 'newPassword', label: '新二级统一密码', type: 'password' }],
        async (obj, c) => { await api('/api/admin/level2-password', { method: 'POST', body: JSON.stringify(obj) }); toast('二级统一密码已修改', 'ok'); c(); }));
      const sq = $('#pfSuperQr'); if (sq) sq.addEventListener('click', () => openCodeQr('授权二维码', '/api/admin/super-auth-code', '其他管理员扫描此码可完成超管授权。', 30000));
    }
    loadMyCards(isAdmin);
  });
}
async function loadMyCards(canAdd) {
  const box = $('#myCardsBox'); if (!box) return;
  try {
    const data = await api('/api/my-cards');
    box.innerHTML = data.cards.length ? `<div class="card-list">${data.cards.map((c) => `<div class="card-item"><span class="cno">${esc(c.cardNo)}</span><button class="btn btn-red btn-sm myCardDel" data-id="${c.id}">删除</button></div>`).join('')}</div>` : '<p class="muted">暂无卡片</p>';
    box.querySelectorAll('.myCardDel').forEach((b) => b.addEventListener('click', async () => { if (!confirm('确定删除该卡片？')) return; try { await api('/api/cards/delete', { method: 'POST', body: JSON.stringify({ cardId: Number(b.dataset.id) }) }); toast('已删除', 'ok'); loadMyCards(canAdd); } catch (e) { toast(e.message, 'err'); } }));
  } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

// 通用：展示一个每隔若干秒刷新的二维码（充值码 / 授权码）
function openCodeQr(title, endpoint, tip, intervalMs) {
  openModal(title, `<div class="qr-wrap"><div id="qrBox" style="min-height:220px;display:flex;align-items:center;justify-content:center">生成中…</div><div class="qr-code-text" id="qrText"></div><p class="qr-tip">${esc(tip)}</p></div>`, () => {});
  let timer = null;
  async function refresh() { const box = document.getElementById('qrBox'); if (!box) { if (timer) clearInterval(timer); return; } try { const r = await api(endpoint); const b = document.getElementById('qrBox'); if (!b) return; if (window.QRCode) QRCode.render(b, r.code, 220); else b.textContent = r.code; const t = document.getElementById('qrText'); if (t) t.textContent = r.code; } catch (_) {} }
  refresh(); timer = setInterval(refresh, intervalMs || 10000);
}

// ---------- 鉴权页 ----------
function showAuth() { stopTimers(); state.view = 'auth'; topbar.classList.add('hidden'); renderAuth(); }
function renderAuth() {
  const t = state.authTab;
  content.innerHTML = `<div class="auth-wrap"><div class="auth-title">🎮 店内计时收费系统</div><div class="auth-sub">按进店时长计费 · 充值畅玩</div>
    <div class="card"><div class="tabs"><button data-tab="login" class="${t === 'login' ? 'active' : ''}">登录</button><button data-tab="register" class="${t === 'register' ? 'active' : ''}">注册</button></div>
    ${t === 'login' ? `<label>用户名</label><input id="lu" placeholder="请输入用户名" /><label>密码</label><input id="lp" type="password" placeholder="请输入密码" /><button id="loginBtn" class="btn btn-block" style="margin-top:18px">登录</button>`
      : `<label>用户名</label><input id="ru" placeholder="设置用户名" /><div id="ruHint" class="uname-hint"></div><label>QQ 号</label><input id="rq" placeholder="请输入 QQ 号" inputmode="numeric" /><label>密码</label><input id="rp" type="password" placeholder="至少 4 位" /><button id="regBtn" class="btn btn-block" style="margin-top:18px">注册并登录</button>`}
    </div></div>`;
  content.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { state.authTab = b.dataset.tab; renderAuth(); }));
  if (t === 'login') { const submit = async () => { try { await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#lu').value, password: $('#lp').value }) }); await boot(); } catch (e) { toast(e.message, 'err'); } }; $('#loginBtn').addEventListener('click', submit); $('#lp').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }); }
  else {
    let timer = null; const ruEl = $('#ru'), hintEl = $('#ruHint');
    ruEl.addEventListener('input', () => { const v = ruEl.value.trim(); clearTimeout(timer); if (!v) { hintEl.textContent = ''; hintEl.className = 'uname-hint'; return; } hintEl.textContent = '检测中…'; hintEl.className = 'uname-hint'; timer = setTimeout(async () => { try { const r = await api('/api/check-username?username=' + encodeURIComponent(v)); if (r.available) { hintEl.textContent = '✓ 用户名可用'; hintEl.className = 'uname-hint ok'; } else { hintEl.textContent = '✗ 用户名已被占用'; hintEl.className = 'uname-hint err'; } } catch (_) {} }, 400); });
    $('#regBtn').addEventListener('click', async () => { try { await api('/api/register', { method: 'POST', body: JSON.stringify({ username: $('#ru').value, qq: $('#rq').value, password: $('#rp').value }) }); await boot(); toast('注册成功，欢迎！', 'ok'); } catch (e) { toast(e.message, 'err'); } });
  }
}

// ---------- 账户卡 / 计费卡 / 在店 ----------
function availableYuan(st) { return st.user.balanceYuan + st.user.freeYuan; }
function accountCardHtml(st) {
  const isAdmin = st.caps.isAdmin, av = st.activeVisit, playing = !!av;
  if (isAdmin) {
    return `<div class="card"><div class="acct-head"><h2>我的账户</h2></div>
      <div class="metric"><span class="label">本月在店时长</span><span class="bignum mono bal-deep" id="acctMonthly">${fmtHM(st.monthlyDurationSec || 0)}</span></div></div>`;
  }
  const bal = playing ? av.projectedBalanceYuan : st.user.balanceYuan;
  const free = playing ? av.projectedFreeYuan : st.user.freeYuan;
  return `<div class="card"><div class="acct-head"><h2>我的账户</h2><button id="qrBtn" class="qr-btn" title="充值二维码">▦</button></div>
    <div class="acct-metrics">
      <div class="metric"><span class="label">账户余额</span><span class="bignum mono ${bal < 0 ? 'neg' : 'bal-deep'}" id="acctBalance">${money(bal)}</span></div>
      <div class="metric"><span class="label">免费额度</span><span class="bignum mono free-mid" id="acctFree">${money(free)}</span></div>
    </div>${bal < 0 ? '<p class="muted" style="margin-top:8px"><span style="color:var(--red)">余额为负，请尽快充值。</span></p>' : ''}</div>`;
}
function priceSlotsHtml(st) {
  const rules = [...(st.pricing || [])].sort((a, b) => a.startHour - b.startHour);
  const hour = new Date().getHours();
  let curIdx = rules.findIndex((r) => hour >= r.startHour && hour < r.endHour);
  const slots = [];
  if (curIdx >= 0) { for (let i = 0; i < 3 && curIdx + i < rules.length; i++) slots.push({ r: rules[curIdx + i], now: i === 0 }); }
  else { rules.filter((r) => r.startHour > hour).slice(0, 3).forEach((r) => slots.push({ r, now: false })); }
  let rows = slots.map((s) => `<div class="slot-row ${s.now ? 'now' : ''}"><span>${String(s.r.startHour).padStart(2, '0')}:00-${String(s.r.endHour).padStart(2, '0')}:00 ${s.now ? '（当前）' : ''}</span><span class="sp">${s.r.rateYuan > 0 ? money(s.r.rateYuan) + '/时' : '免费'}</span></div>`).join('');
  if (!rows) rows = '<div class="slot-row"><span>当前时段免费</span></div>';
  const bf = st.baseFeeYuan > 0 ? `<div class="slot-row"><span>起步费（进店一次性）</span><span class="sp">${money(st.baseFeeYuan)}</span></div>` : '';
  return `<div class="slot-list">${rows}${bf}</div>`;
}
function playCardHtml(st) {
  const isAdmin = st.caps.isAdmin, av = st.activeVisit, playing = !!av;
  if (playing) {
    if (isAdmin || !av.billable) {
      return `<div class="card"><h2>在店中</h2><div class="metric" style="margin-bottom:16px"><span class="label">本次在店时长</span><span class="val mono" id="mElapsed">${dur(av.elapsedSec)}</span></div><button id="endBtn" class="btn btn-red btn-block">离店</button><small class="hint">管理员不计费，仅记录在店时长。</small></div>`;
    }
    return `<div class="card"><h2>游玩中</h2><div class="metrics" style="margin-bottom:18px">
      <div class="metric"><span class="label">已用时长</span><span class="val mono" id="mElapsed">${dur(av.elapsedSec)}</span></div>
      <div class="metric"><span class="label">本次费用</span><span class="val mono amber" id="mCost">${money(av.currentCostYuan)}</span></div>
      <div class="metric"><span class="label">当前时价</span><span class="val mono">${money(av.rateNowYuan)}/时</span></div>
    </div><button id="endBtn" class="btn btn-red btn-block">离店</button></div>`;
  }
  const disabled = !isAdmin && availableYuan(st) <= 0;
  return `<div class="card"><h2>进店</h2>
    <button id="startBtn" class="btn btn-enter btn-block" ${disabled ? 'disabled' : ''}>进店</button>
    ${disabled ? '<small class="hint" style="color:var(--red)">可用额度不足（余额+免费额度），请先充值。</small>' : ''}
    <h3 style="margin:16px 0 6px">价格（当前及后续时段）</h3>${priceSlotsHtml(st)}</div>`;
}
function wirePlayAccount() {
  const qb = $('#qrBtn'); if (qb) qb.addEventListener('click', () => openCodeQr('我的充值二维码', '/api/recharge-code', '请管理员扫描此码为你充值，二维码每 10 秒刷新。', 10000));
  const eb = $('#endBtn'); if (eb) eb.addEventListener('click', async () => { try { const r = await api('/api/visit/end', { method: 'POST' }); toast(`已离店，时长 ${dur(r.durationSec)}${r.chargedYuan ? '，消费 ' + money(r.chargedYuan) : ''}`, 'ok'); await refreshNow(); } catch (e) { toast(e.message, 'err'); } });
  const sb = $('#startBtn'); if (sb) sb.addEventListener('click', async () => { try { await api('/api/visit/start', { method: 'POST' }); toast('进店成功！', 'ok'); await refreshNow(); } catch (e) { toast(e.message, 'err'); } });
}

function personRowsHtml(list, canManage) {
  if (!list.length) return '<p class="muted" style="padding:8px 0">暂无</p>';
  return list.map((p) => `<div class="person-row">${avatarHtml(p.avatar, p.initial || p.name, 'sz-32')}<div class="pinfo"><div class="pname">${esc(p.name)} ${p.isCustomer ? '<span class="badge user">顾客</span>' : roleBadge(p.role)}</div><div class="pmeta">进店 ${new Date(p.startTime).toLocaleTimeString('zh-CN')}</div></div>${canManage ? `<button class="btn btn-red btn-sm endUserBtn" data-id="${p.id}" data-name="${esc(p.name)}">结束</button>` : ''}</div>`).join('');
}
function storeSig(st) { return JSON.stringify({ c: st.store.customers.map((p) => [p.id, p.name, !!p.avatar]), a: st.store.admins.map((p) => [p.id, p.name, !!p.avatar]) }); }
function storeBoxHtml(st) {
  const cm = st.caps.MANAGE_USERS;
  return `<div class="collapse ${state._openCust ? 'open' : ''}" data-grp="cust"><div class="collapse-head"><span>在店顾客 <span class="cnt">${st.store.userCount}</span> 人</span><span class="chev">▶</span></div><div class="collapse-body">${personRowsHtml(st.store.customers, cm)}</div></div>
    <div class="collapse ${state._openAdm ? 'open' : ''}" data-grp="adm"><div class="collapse-head"><span>在店管理员 <span class="cnt">${st.store.adminCount}</span> 人</span><span class="chev">▶</span></div><div class="collapse-body">${personRowsHtml(st.store.admins, cm)}</div></div>`;
}
function buildStore(st) {
  const box = $('#storeBox'); if (!box) return;
  box.innerHTML = storeBoxHtml(st);
  box.querySelectorAll('.collapse').forEach((col) => { col.querySelector('.collapse-head').addEventListener('click', () => { col.classList.toggle('open'); const open = col.classList.contains('open'); if (col.dataset.grp === 'cust') state._openCust = open; else state._openAdm = open; }); });
  if (st.caps.MANAGE_USERS) box.querySelectorAll('.endUserBtn').forEach((b) => b.addEventListener('click', async (e) => { e.stopPropagation(); if (!confirm(`确定结束「${b.dataset.name}」的会话？`)) return; try { const r = await api('/api/admin/end-visit', { method: 'POST', body: JSON.stringify({ userId: Number(b.dataset.id) }) }); toast(`已结束，时长 ${dur(r.durationSec)}`, 'ok'); await refreshNow(); } catch (err) { toast(err.message, 'err'); } }));
  state._storeSig = storeSig(st);
}
function patchStore() { if (storeSig(state.status) !== state._storeSig) buildStore(state.status); }
function patchHome() {
  const st = state.status;
  if (st.caps.isAdmin) { const mo = $('#acctMonthly'); if (mo && !st.activeVisit) mo.textContent = fmtHM(st.monthlyDurationSec || 0); }
  else if (!st.activeVisit) {
    const bEl = $('#acctBalance'); if (bEl) { bEl.textContent = money(st.user.balanceYuan); bEl.classList.toggle('neg', st.user.balanceYuan < 0); bEl.classList.toggle('bal-deep', st.user.balanceYuan >= 0); }
    const fEl = $('#acctFree'); if (fEl) fEl.textContent = money(st.user.freeYuan);
  }
  patchStore();
}

// ---------- 用户视图 ----------
function renderUser() {
  const st = state.status;
  content.innerHTML = `<div class="view-root"><div class="grid cols-2">
    <div>${accountCardHtml(st)}${playCardHtml(st)}<div class="card"><h2>📢 店内公告</h2><div id="annBox"><p class="muted">加载中…</p></div></div></div>
    <div><div class="card"><h2>店内实况</h2><div id="storeBox"></div></div>
      <div class="card"><h2>我的明细（充值 / 消费）</h2><div id="myTxBox"><p class="muted">加载中…</p></div></div></div>
  </div></div>`;
  wirePlayAccount(); buildStore(st); renderAnnouncements('annBox'); loadMyTransactions(); applyNavAnim();
}
async function loadMyTransactions() { const box = $('#myTxBox'); if (!box) return; try { const data = await api('/api/transactions'); box.innerHTML = txTableHtml(data.items, false); } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; } }
function txTableHtml(items, showUser) {
  if (!items || !items.length) return '<p class="empty">暂无记录</p>';
  return `<table><thead><tr>${showUser ? '<th>用户</th>' : ''}<th>类型</th><th>说明</th><th>时间</th><th class="right">金额</th></tr></thead><tbody>
    ${items.map((it) => { let cls, sign, label; if (it.type === 'RECHARGE') { cls = 'tx-in'; sign = '+'; label = '<span class="pill in">充值</span>'; } else if (it.type === 'CHARGE') { cls = 'tx-out'; sign = '-'; label = '<span class="pill out">消费</span>'; } else if (it.type === 'FREE_USE') { cls = 'muted'; sign = '-'; label = '<span class="pill out">免费抵扣</span>'; } else { const pos = it.amountYuan >= 0; cls = pos ? 'tx-in' : 'tx-out'; sign = pos ? '+' : '-'; label = '<span class="pill out">余额调整</span>'; } return `<tr>${showUser ? `<td>${esc(it.username)}</td>` : ''}<td>${label}</td><td class="muted">${esc(it.note || '')}</td><td class="mono muted">${new Date(it.time).toLocaleString('zh-CN')}</td><td class="right mono ${cls}">${sign}${money(Math.abs(it.amountYuan))}</td></tr>`; }).join('')}
  </tbody></table>`;
}

// ---------- 公告 ----------
async function renderAnnouncements(boxId) {
  const box = document.getElementById(boxId); if (!box) return;
  let data; try { data = await api('/api/announcements'); } catch (_) { box.innerHTML = '<p class="muted">公告加载失败</p>'; return; }
  const items = data.items || [];
  const list = items.length ? `<div class="ann-list">${items.map((a) => `<div class="ann-item ${a.pinned ? 'pinned' : ''}"><div class="ann-top">${a.pinned ? '<span class="ann-tag">📌 置顶</span>' : ''}${a.title ? `<span class="ann-title">${esc(a.title)}</span>` : ''}</div><div class="ann-content">${esc(a.content)}</div><div class="ann-meta"><span>${esc(a.authorName || '管理员')}</span><span>${new Date(a.createdAt).toLocaleString('zh-CN')}</span>${data.canManage ? `<span class="ann-acts"><button class="btn btn-ghost annPin" data-id="${a.id}" data-p="${a.pinned ? 0 : 1}">${a.pinned ? '取消置顶' : '置顶'}</button><button class="btn btn-red annDel" data-id="${a.id}">删除</button></span>` : ''}</div></div>`).join('')}</div>` : '<p class="empty">暂无公告</p>';
  box.innerHTML = (data.canManage ? '<div style="margin-bottom:12px"><button id="annAdd" class="btn btn-sm">+ 发布公告</button></div>' : '') + list;
  if (data.canManage) {
    const add = document.getElementById('annAdd'); if (add) add.addEventListener('click', () => openAnnounceModal(boxId));
    box.querySelectorAll('.annPin').forEach((b) => b.addEventListener('click', async () => { try { await api('/api/admin/announcements/pin', { method: 'POST', body: JSON.stringify({ id: Number(b.dataset.id), pinned: Number(b.dataset.p) }) }); renderAnnouncements(boxId); } catch (e) { toast(e.message, 'err'); } }));
    box.querySelectorAll('.annDel').forEach((b) => b.addEventListener('click', async () => { if (!confirm('确定删除该公告？')) return; try { await api('/api/admin/announcements/delete', { method: 'POST', body: JSON.stringify({ id: Number(b.dataset.id) }) }); renderAnnouncements(boxId); } catch (e) { toast(e.message, 'err'); } }));
  }
}
function openAnnounceModal(boxId) {
  openModal('发布公告', `<label>标题（选填）</label><input id="anT" placeholder="公告标题" /><label>内容</label><textarea id="anC" rows="4" placeholder="请输入公告内容" style="width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--text);font-size:14px;font-family:inherit;resize:vertical"></textarea><label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input id="anP" type="checkbox" style="width:auto"> 置顶此公告</label><button id="anBtn" class="btn btn-block" style="margin-top:14px">发布</button>`, (close) => {
    $('#anBtn').addEventListener('click', async () => { try { await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify({ title: $('#anT').value, content: $('#anC').value, pinned: $('#anP').checked }) }); toast('公告已发布', 'ok'); close(); renderAnnouncements(boxId); } catch (e) { toast(e.message, 'err'); } });
  });
}

// ---------- 管理员视图 ----------
function renderAdmin() {
  const caps = state.status.caps;
  const tabs = [['overview', '店内总览']];
  if (caps.MANAGE_USERS || caps.MANAGE_CARDS || caps.GRANT_FREE) tabs.push(['users', '用户列表']);
  if (caps.VIEW_REPORTS || caps.MANAGE_PRICING) tabs.push(['business', '营业管理']);
  if (!tabs.find((t) => t[0] === state.adminTab)) state.adminTab = 'overview';
  content.innerHTML = `<div class="adminnav">${tabs.map(([k, label]) => `<button data-tab="${k}" class="${state.adminTab === k ? 'active' : ''}">${label}</button>`).join('')}</div><div id="adminBody"></div>`;
  content.querySelectorAll('.adminnav button').forEach((b) => b.addEventListener('click', () => { state._navAnim = true; state.adminTab = b.dataset.tab; renderAdmin(); }));
  const body = $('#adminBody');
  if (state._navAnim) { state._navAnim = false; body.classList.add('fx-in'); }
  if (state.adminTab === 'overview') renderAdminOverview(body);
  else if (state.adminTab === 'users') renderAdminUserList(body);
  else if (state.adminTab === 'business') renderAdminBusiness(body);
}
function renderAdminOverview(body) {
  const st = state.status;
  body.innerHTML = `<div class="grid cols-2">
    <div>${accountCardHtml(st)}${playCardHtml(st)}
      ${st.caps.RECHARGE ? `<div class="card"><h2>用户充值（扫码 / 刷卡）</h2><p class="muted">用扫码枪扫描顾客二维码，或刷卡读取卡号（也可手动粘贴），再输入金额。</p><label>二维码内容 / 卡号</label><input id="scCode" placeholder="扫码或刷卡后自动填入" /><div class="row"><div><label>充值金额（元）</label><input id="scAmt" type="number" min="0" step="0.01" /></div><div style="flex:none;align-self:flex-end"><button id="scBtn" class="btn btn-green">确认充值</button></div></div></div>` : ''}</div>
    <div><div class="card"><h2>店内实况</h2><div id="storeBox"></div></div><div class="card"><h2>📢 店内公告</h2><div id="annBox"><p class="muted">加载中…</p></div></div></div>
  </div>`;
  wirePlayAccount(); buildStore(st); renderAnnouncements('annBox');
  if (st.caps.RECHARGE) {
    const code = $('#scCode');
    $('#scBtn').addEventListener('click', async () => { const v = code.value.trim(), amt = Number($('#scAmt').value); if (!v) return toast('请扫码或刷卡', 'err'); if (!(amt > 0)) return toast('请输入有效金额', 'err'); try { const r = await api('/api/admin/recharge-by-input', { method: 'POST', body: JSON.stringify({ value: v, amountYuan: amt }) }); toast(`已为 ${r.username} ${r.via === 'card' ? '刷卡' : '扫码'}充值，余额 ${money(r.balanceYuan)}`, 'ok'); code.value = ''; $('#scAmt').value = ''; } catch (e) { toast(e.message, 'err'); } });
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#scAmt').focus(); } });
  }
  applyNavAnim();
}

// ---------- 用户列表 ----------
async function renderAdminUserList(body) {
  body.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  let data; try { data = await api('/api/admin/users'); } catch (e) { body.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p></div>`; return; }
  const caps = state.status.caps;
  const rowHtml = (u) => `<tr><td><div style="display:flex;align-items:center;gap:10px">${avatarHtml(u.avatar, u.displayName, 'sz-32')}<span><b>${esc(u.displayName)}</b>${u.nickname ? `<br><small class="muted">@${esc(u.username)}</small>` : ''}</span></div></td><td class="muted">${esc(u.qq)}</td><td>${roleBadge(u.role)}</td><td class="right mono">${money(u.balanceYuan)}</td><td class="right mono free-mid">${money(u.freeYuan)}</td><td>${u.inStore ? '<span class="pill in">在店</span>' : '<span class="pill out">离店</span>'}</td><td class="right"><button class="btn btn-sm editUserBtn" data-id="${u.id}">管理</button></td></tr>`;
  body.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px"><h2 style="margin:0">用户列表</h2><div style="display:flex;gap:8px;flex-wrap:wrap">
      ${caps.GRANT_FREE ? '<button id="grantFreeBtn" class="btn btn-ghost btn-sm">发放免费额度</button>' : ''}
      ${caps.MANAGE_USERS ? '<button id="exportBtn" class="btn btn-ghost btn-sm">⬇ 导出Excel</button><button id="addUserBtn" class="btn btn-sm">+ 新增用户</button>' : ''}</div></div>
    <input id="userSearch" class="search-box" placeholder="🔍 搜索 用户名 / 昵称 / QQ 号" value="${esc(state._userSearch || '')}" />
    <table><thead><tr><th>用户</th><th>QQ</th><th>身份</th><th class="right">余额</th><th class="right">免费额度</th><th>状态</th><th class="right">操作</th></tr></thead><tbody id="userRows"></tbody></table></div>`;
  const paint = () => {
    const q = (state._userSearch || '').trim().toLowerCase();
    const list = !q ? data.users : data.users.filter((u) => (u.username || '').toLowerCase().includes(q) || (u.nickname || '').toLowerCase().includes(q) || (u.qq || '').toLowerCase().includes(q));
    const tb = $('#userRows');
    tb.innerHTML = list.length ? list.map(rowHtml).join('') : '<tr><td colspan="7" class="empty">未找到匹配的用户</td></tr>';
    tb.querySelectorAll('.editUserBtn').forEach((b) => b.addEventListener('click', () => openUserEditModal(data.users.find((x) => x.id === Number(b.dataset.id)), () => renderAdminUserList(body))));
  };
  paint();
  $('#userSearch').addEventListener('input', (e) => { state._userSearch = e.target.value; paint(); });
  if (caps.MANAGE_USERS) { $('#exportBtn').addEventListener('click', () => { window.location.href = '/api/admin/users/export'; }); $('#addUserBtn').addEventListener('click', () => openUserAddModal(() => renderAdminUserList(body))); }
  if (caps.GRANT_FREE) $('#grantFreeBtn').addEventListener('click', () => openGrantFreeModal(data.users.filter((u) => u.role === 'USER'), () => renderAdminUserList(body)));
}
function openGrantFreeModal(users, done) {
  openModal('发放免费额度', `<p class="muted">勾选要发放的顾客（不选=全部顾客），每位追加指定金额。</p>
    <label>每位追加（元）</label><input id="gfAmt" type="number" min="0" step="0.01" placeholder="如 5" />
    <label style="display:flex;align-items:center;gap:8px;margin-top:8px"><input id="gfAll" type="checkbox" checked style="width:auto"> 全部顾客</label>
    <div id="gfPickWrap" class="hidden"><div class="user-pick">${users.map((u) => `<label><input type="checkbox" class="gfPick" value="${u.id}">${esc(u.displayName)}（余额 ${money(u.balanceYuan)} / 免费 ${money(u.freeYuan)}）</label>`).join('') || '<p class="muted">暂无顾客</p>'}</div></div>
    <button id="gfBtn" class="btn btn-block" style="margin-top:14px">发放</button>`, (close) => {
    $('#gfAll').addEventListener('change', (e) => { $('#gfPickWrap').classList.toggle('hidden', e.target.checked); });
    $('#gfBtn').addEventListener('click', () => {
      const amt = Number($('#gfAmt').value); if (!(amt > 0)) return toast('请输入有效金额', 'err');
      const all = $('#gfAll').checked;
      const ids = all ? null : [...document.querySelectorAll('.gfPick:checked')].map((c) => Number(c.value));
      if (!all && (!ids || !ids.length)) return toast('请至少选择一位顾客', 'err');
      promptAdminPw(async (authObj, closeAuth) => { const r = await api('/api/admin/grant-free', { method: 'POST', body: JSON.stringify({ amountYuan: amt, userIds: ids, ...authObj }) }); toast(`已为 ${r.count} 位顾客发放`, 'ok'); closeAuth(); close(); done(); });
    });
  });
}
function openUserAddModal(done) {
  openModal('新增用户', `<label>用户名</label><input id="auU" placeholder="登录用户名" /><label>昵称</label><input id="auN" placeholder="店内显示名（选填）" /><label>QQ 号</label><input id="auQ" placeholder="选填" /><label>初始密码</label><input id="auP" type="password" placeholder="至少 4 位" /><button id="auBtn" class="btn btn-block" style="margin-top:16px">创建用户</button>`, (close) => {
    $('#auBtn').addEventListener('click', () => {
      const payload = { username: $('#auU').value, nickname: $('#auN').value, qq: $('#auQ').value, password: $('#auP').value };
      if (!payload.username.trim()) return toast('请填写用户名', 'err');
      if ((payload.password || '').length < 4) return toast('密码至少 4 位', 'err');
      promptAdminPw(async (authObj, closeAuth) => { await api('/api/admin/users/create', { method: 'POST', body: JSON.stringify({ ...payload, ...authObj }) }); toast('用户已创建', 'ok'); closeAuth(); close(); done(); });
    });
  });
}
function openUserEditModal(u, done) {
  const caps = state.status.caps, isSuper = caps.isSuper, allPerms = Object.keys(PERM_LABELS);
  const targetAdmin = (u.role === 'SUPER_ADMIN' || u.role === 'SUB_ADMIN');
  openModal(`管理用户：${esc(u.displayName)}`, `
    <div class="avatar-edit">${avatarHtml(u.avatar, u.displayName, 'sz-96')}<div class="acts"><button id="euResetAvatar" class="btn btn-ghost btn-sm">恢复默认头像</button></div></div>
    <label>用户名</label><input id="euU" value="${esc(u.username)}" /><label>昵称</label><input id="euN" value="${esc(u.nickname)}" /><label>QQ 号</label><input id="euQ" value="${esc(u.qq)}" />
    <div class="row"><div><label>余额（元）</label><input id="euB" type="number" step="0.01" value="${u.balanceYuan}" /></div><div><label>免费额度（元）</label><input id="euF" type="number" min="0" step="0.01" value="${u.freeYuan}" /></div></div>
    ${isSuper && u.role !== 'SUPER_ADMIN' ? `<label>身份</label><select id="euRole"><option value="USER" ${u.role === 'USER' ? 'selected' : ''}>用户</option><option value="SUB_ADMIN" ${u.role === 'SUB_ADMIN' ? 'selected' : ''}>管理员</option></select>
      <div id="euPermWrap" style="${u.role === 'SUB_ADMIN' ? '' : 'display:none'}"><label style="display:flex;justify-content:space-between;align-items:center">权限<button id="euPermAll" class="btn btn-ghost btn-sm" type="button">全选/全不选</button></label><div class="perm-grid">${allPerms.map((p) => `<label><input type="checkbox" class="euPerm" value="${p}" ${u.permissions.includes(p) ? 'checked' : ''}>${PERM_LABELS[p]}</label>`).join('')}</div></div>` : ''}
    ${caps.MANAGE_CARDS ? `<hr class="section-divider" /><h3>卡片（最多 3 张）</h3><div id="euCards"><p class="muted">加载中…</p></div><div class="row" style="margin-top:6px"><div><input id="euCardNo" placeholder="刷卡或输入卡号" /></div><div style="flex:none;align-self:flex-end"><button id="euCardAdd" class="btn btn-sm">添加卡片</button></div></div>` : ''}
    ${isSuper && targetAdmin ? '<hr class="section-divider" /><button id="euResetPw" class="btn btn-ghost btn-sm">重置其管理员密码</button>' : ''}
    <hr class="section-divider" />
    <div class="row" style="margin-top:4px"><button id="euSave" class="btn">保存修改</button>${u.role !== 'SUPER_ADMIN' && u.id !== state.status.user.id ? '<button id="euDel" class="btn btn-red" style="flex:none">删除用户</button>' : ''}</div>
    <small class="hint" style="display:block;margin-top:10px">${targetAdmin ? '该用户为管理员，修改需<b>二级统一密码</b>。' : '修改普通用户需<b>管理员密码</b>。'}</small>
  `, (close) => {
    if (isSuper && u.role !== 'SUPER_ADMIN') {
      const rs = $('#euRole'); rs.addEventListener('change', () => { $('#euPermWrap').style.display = rs.value === 'SUB_ADMIN' ? '' : 'none'; });
      $('#euPermAll').addEventListener('click', () => { const boxes = [...document.querySelectorAll('.euPerm')]; const allOn = boxes.every((c) => c.checked); boxes.forEach((c) => { c.checked = !allOn; }); });
    }
    if (caps.MANAGE_CARDS) {
      const loadCards = async () => { const box = $('#euCards'); try { const d = await api('/api/admin/user-cards?userId=' + u.id); box.innerHTML = d.cards.length ? `<div class="card-list">${d.cards.map((c) => `<div class="card-item"><span class="cno">${esc(c.cardNo)}</span><button class="btn btn-red btn-sm euCardDel" data-id="${c.id}">删除</button></div>`).join('')}</div>` : '<p class="muted">暂无卡片</p>'; box.querySelectorAll('.euCardDel').forEach((b) => b.addEventListener('click', () => authForTarget(u.role, async (a, c) => { await api('/api/admin/cards/delete', { method: 'POST', body: JSON.stringify({ cardId: Number(b.dataset.id), ...a }) }); toast('已删除', 'ok'); c(); loadCards(); }))); } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; } };
      loadCards();
      $('#euCardAdd').addEventListener('click', () => { const no = $('#euCardNo').value.trim(); if (!no) return toast('请输入卡号', 'err'); authForTarget(u.role, async (a, c) => { await api('/api/admin/cards/add', { method: 'POST', body: JSON.stringify({ userId: u.id, cardNo: no, ...a }) }); toast('已添加', 'ok'); c(); $('#euCardNo').value = ''; loadCards(); }); });
    }
    if (isSuper && targetAdmin) $('#euResetPw').addEventListener('click', () => methodAuthModal('重置其管理员密码', [{ key: 'level2', label: '二级统一密码', type: 'password' }, { key: 'superQr', label: '超管授权码', type: 'text' }], [{ key: 'newPassword', label: '新管理员密码', type: 'password' }], async (obj, c) => { await api('/api/admin/reset-admin-password', { method: 'POST', body: JSON.stringify({ userId: u.id, ...obj }) }); toast('已重置', 'ok'); c(); }));
    $('#euResetAvatar').addEventListener('click', () => authForTarget(u.role, async (a, c) => { await api('/api/admin/users/reset-avatar', { method: 'POST', body: JSON.stringify({ userId: u.id, ...a }) }); toast('头像已恢复默认', 'ok'); c(); close(); done(); }));
    $('#euSave').addEventListener('click', () => {
      const payload = { userId: u.id, username: $('#euU').value, nickname: $('#euN').value, qq: $('#euQ').value, balanceYuan: $('#euB').value, freeYuan: $('#euF').value };
      const newRole = (isSuper && u.role !== 'SUPER_ADMIN') ? $('#euRole').value : null;
      const newPerms = (isSuper && newRole === 'SUB_ADMIN') ? [...document.querySelectorAll('.euPerm:checked')].map((c) => c.value) : null;
      const roleChanged = newRole && newRole !== u.role;
      const important = targetAdmin || roleChanged || (newRole === 'SUB_ADMIN');
      const run = async (authObj, closeAuth) => {
        await api('/api/admin/users/update', { method: 'POST', body: JSON.stringify({ ...payload, ...authObj }) });
        if (roleChanged) await api('/api/admin/set-role', { method: 'POST', body: JSON.stringify({ userId: u.id, role: newRole, ...authObj }) });
        if (newRole === 'SUB_ADMIN') await api('/api/admin/set-permissions', { method: 'POST', body: JSON.stringify({ userId: u.id, permissions: newPerms, ...authObj }) });
        toast('已保存', 'ok'); closeAuth(); close(); done();
      };
      if (important) promptLevel2(run); else promptAdminPw(run);
    });
    const del = $('#euDel'); if (del) del.addEventListener('click', () => { if (!confirm(`确定删除用户「${u.displayName}」？不可恢复。`)) return; authForTarget(u.role, async (a, c) => { await api('/api/admin/users/delete', { method: 'POST', body: JSON.stringify({ userId: u.id, ...a }) }); toast('用户已删除', 'ok'); c(); close(); done(); }); });
  });
}

// ---------- 营业管理 ----------
function renderAdminBusiness(body) {
  const caps = state.status.caps; const subs = [];
  if (caps.VIEW_REPORTS) subs.push(['reports', '营业报表']);
  if (caps.MANAGE_PRICING) subs.push(['pricing', '营业定价']);
  if (caps.VIEW_REPORTS) subs.push(['txns', '流水明细']);
  if (!subs.find((s) => s[0] === state.bizTab)) state.bizTab = subs[0] ? subs[0][0] : 'reports';
  body.innerHTML = `<div class="adminnav sub">${subs.map(([k, label]) => `<button data-sub="${k}" class="${state.bizTab === k ? 'active' : ''}">${label}</button>`).join('')}</div><div id="bizBody"></div>`;
  body.querySelectorAll('.adminnav.sub button').forEach((b) => b.addEventListener('click', () => { state._bizAnim = true; state.bizTab = b.dataset.sub; renderAdminBusiness(body); }));
  const bb = $('#bizBody'); if (state._bizAnim) { state._bizAnim = false; bb.classList.add('fx-in'); }
  if (state.bizTab === 'reports') renderAdminReports(bb); else if (state.bizTab === 'pricing') renderAdminPricing(bb); else renderAdminTxns(bb);
}
async function renderAdminReports(box) {
  box.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  if (!state._reportDate) state._reportDate = new Date().toISOString().slice(0, 10);
  let data; try { data = await api('/api/admin/reports?date=' + state._reportDate); } catch (e) { box.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p></div>`; return; }
  box.innerHTML = `<div class="card"><h2>营业报表</h2><div class="row" style="margin-bottom:18px"><div style="flex:none"><label>选择日期</label><input id="repDate" type="date" value="${data.date}" /></div></div><div class="metrics"><div class="metric"><span class="label">当日营业额</span><span class="bignum amber mono">${money(data.dayRevenueYuan)}</span></div><div class="metric"><span class="label">当日顾客场次</span><span class="val">${data.customerVisits} 场</span></div></div></div>
    <div class="card"><h2>近 7 天营业额</h2>${weeklyChart(data.weekly)}</div>
    <div class="card"><h2>当日进出记录</h2>${data.records.length ? `<table><thead><tr><th>用户</th><th>身份</th><th>进店</th><th>离店</th><th class="right">时长</th><th class="right">消费</th></tr></thead><tbody>${data.records.map((r) => `<tr><td>${esc(r.username)}</td><td>${r.billable ? '<span class="badge user">顾客</span>' : '<span class="badge sub">管理员</span>'}</td><td class="mono">${new Date(r.startTime).toLocaleTimeString('zh-CN')}</td><td class="mono">${r.endTime ? new Date(r.endTime).toLocaleTimeString('zh-CN') : '<span class="pill in">在店中</span>'}</td><td class="right mono">${dur(r.durationSec)}</td><td class="right mono">${money(r.chargedYuan)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">当日暂无记录</p>'}</div>`;
  $('#repDate').addEventListener('change', (e) => { state._reportDate = e.target.value; renderAdminReports(box); });
}
function weeklyChart(weekly) {
  const W = 720, H = 240, padL = 44, padT = 16, innerW = W - padL - 16, innerH = H - padT - 34;
  const max = Math.max(1, ...weekly.map((d) => d.revenueYuan)), niceMax = Math.ceil(max / 5) * 5 || 5;
  const n = weekly.length, slot = innerW / n, barW = Math.min(46, slot * 0.55);
  let bars = '', labels = '', vals = '';
  weekly.forEach((d, i) => { const h = (d.revenueYuan / niceMax) * innerH, x = padL + slot * i + (slot - barW) / 2, y = padT + innerH - h; bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="5" fill="#5aa9e6"></rect>`; if (d.revenueYuan > 0) vals += `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="11" fill="#e8920c">${d.revenueYuan.toFixed(0)}</text>`; labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#6b7c91">${d.date.slice(5)}</text>`; });
  let grid = '';
  for (let g = 0; g <= 4; g++) { const val = (niceMax / 4) * g, y = padT + innerH - (val / niceMax) * innerH; grid += `<line x1="${padL}" y1="${y}" x2="${W - 16}" y2="${y}" stroke="#d6e8f5"></line><text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#6b7c91">${val.toFixed(0)}</text>`; }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${grid}${bars}${vals}${labels}</svg>`;
}
async function renderAdminPricing(box) {
  box.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  let data; try { data = await api('/api/admin/pricing'); } catch (e) { box.innerHTML = `<div class="card"><p class="empty">${esc(e.message)}</p></div>`; return; }
  const rowHtml = (r) => `<div class="rule-row"><select class="rStart">${hourOpts(r.startHour)}</select><span>:00 至</span><select class="rEnd">${hourOpts(r.endHour)}</select><span>:00 =</span><input class="rRate" type="number" min="0" step="0.01" value="${r.rateYuan}" /><span>元/小时</span><button class="btn btn-ghost btn-sm rDel">删除</button></div>`;
  box.innerHTML = `<div class="card"><h2>营业定价（分时段）</h2><p class="muted">不同时段每小时单价，0–24 整点，不可重叠，未覆盖视为免费。</p>
    <div id="rules">${(data.rules.length ? data.rules : [{ startHour: 0, endHour: 24, rateYuan: 10 }]).map(rowHtml).join('')}</div>
    <div class="row" style="margin-top:6px"><button id="addRule" class="btn btn-ghost btn-sm" style="flex:none">+ 添加时段</button><div></div><button id="savePricing" class="btn" style="flex:none">保存</button></div>
    <hr class="section-divider" /><label>起步费（进店一次性，元）</label><input id="baseFee" type="number" min="0" step="0.01" value="${data.baseFeeYuan || 0}" /></div>`;
  const rulesBox = $('#rules');
  const wireDel = () => rulesBox.querySelectorAll('.rDel').forEach((b) => { b.onclick = () => b.closest('.rule-row').remove(); }); wireDel();
  $('#addRule').addEventListener('click', () => { const div = document.createElement('div'); div.innerHTML = rowHtml({ startHour: 0, endHour: 24, rateYuan: 0 }); const node = div.firstElementChild; rulesBox.appendChild(node); node.querySelector('.rDel').onclick = () => node.remove(); });
  $('#savePricing').addEventListener('click', async () => { const rules = [...rulesBox.querySelectorAll('.rule-row')].map((row) => ({ startHour: Number(row.querySelector('.rStart').value), endHour: Number(row.querySelector('.rEnd').value), rateYuan: Number(row.querySelector('.rRate').value) })); try { await api('/api/admin/pricing', { method: 'POST', body: JSON.stringify({ rules, baseFeeYuan: $('#baseFee').value }) }); toast('已保存', 'ok'); renderAdminPricing(box); } catch (e) { toast(e.message, 'err'); } });
}
function hourOpts(sel) { let s = ''; for (let h = 0; h <= 24; h++) s += `<option value="${h}" ${h === sel ? 'selected' : ''}>${String(h).padStart(2, '0')}</option>`; return s; }
async function renderAdminTxns(box) {
  box.innerHTML = '<div class="card"><p class="muted">加载中…</p></div>';
  let users = []; try { users = (await api('/api/admin/users')).users; } catch (_) {}
  const load = async () => { const tb = $('#txBox'); tb.innerHTML = '<p class="muted">加载中…</p>'; const q = []; if (state._txFilter.userId) q.push('userId=' + state._txFilter.userId); if (state._txFilter.type) q.push('type=' + state._txFilter.type); try { const data = await api('/api/admin/transactions' + (q.length ? '?' + q.join('&') : '')); tb.innerHTML = txTableHtml(data.items, true); } catch (e) { tb.innerHTML = `<p class="empty">${esc(e.message)}</p>`; } };
  box.innerHTML = `<div class="card"><h2>流水明细</h2><div class="filters"><div><label>用户</label><select id="fUser"><option value="">全部用户</option>${users.map((u) => `<option value="${u.id}" ${state._txFilter.userId == u.id ? 'selected' : ''}>${esc(u.displayName)}</option>`).join('')}</select></div><div><label>类型</label><select id="fType"><option value="" ${state._txFilter.type === '' ? 'selected' : ''}>全部</option><option value="RECHARGE" ${state._txFilter.type === 'RECHARGE' ? 'selected' : ''}>充值</option><option value="CHARGE" ${state._txFilter.type === 'CHARGE' ? 'selected' : ''}>消费</option><option value="FREE_USE" ${state._txFilter.type === 'FREE_USE' ? 'selected' : ''}>免费抵扣</option><option value="ADJUST" ${state._txFilter.type === 'ADJUST' ? 'selected' : ''}>余额调整</option></select></div></div><div id="txBox"></div></div>`;
  $('#fUser').addEventListener('change', (e) => { state._txFilter.userId = e.target.value; load(); });
  $('#fType').addEventListener('change', (e) => { state._txFilter.type = e.target.value; load(); });
  load();
}

boot();
