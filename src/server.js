'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { db } = require('./db');
const api = require('./api');
const billing = require('./billing');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function buildSetCookie(name, value, opts = {}) {
  let str = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge != null) str += `; Max-Age=${opts.maxAge}`;
  str += `; Path=${opts.path || '/'}`;
  if (opts.httpOnly) str += '; HttpOnly';
  str += `; SameSite=${opts.sameSite || 'Lax'}`;
  return str;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4e6) req.destroy(); // 限制 4MB（含头像上传）
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function getUserFromReq(cookies) {
  const token = cookies.sid;
  if (!token) return { user: null, token: null };
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token = ?').get(token);
  if (!row) return { user: null, token: null };
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  return { user: user || null, token };
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel);
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // SPA 回退到 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// 路由表: "METHOD /path" -> handler
const routes = {
  'POST /api/register': api.register,
  'POST /api/login': api.login,
  'POST /api/logout': api.logout,
  'GET /api/check-username': api.checkUsername,
  'GET /api/status': api.status,
  'POST /api/visit/start': api.visitStart,
  'POST /api/visit/end': api.visitEnd,
  'POST /api/change-password': api.changePassword,
  'POST /api/profile/update': api.profileUpdate,
  'POST /api/profile/avatar': api.profileAvatar,
  'POST /api/profile/avatar/reset': api.profileAvatarReset,
  'GET /api/transactions': api.myTransactions,
  'GET /api/recharge/methods': api.rechargeMethods,
  'POST /api/recharge/create': api.rechargeCreate,
  'POST /api/recharge/confirm': api.rechargeConfirm,
  'GET /api/recharge/status': api.rechargeStatus,
  'GET /api/admin/users': api.adminUsers,
  'POST /api/admin/users/create': api.usersCreate,
  'POST /api/admin/users/update': api.usersUpdate,
  'POST /api/admin/users/delete': api.usersDelete,
  'POST /api/admin/users/reset-avatar': api.usersResetAvatar,
  'POST /api/admin/end-visit': api.adminEndVisit,
  'GET /api/admin/transactions': api.adminTransactions,
  'GET /api/admin/pricing': api.adminGetPricing,
  'POST /api/admin/pricing': api.adminSetPricing,
  'GET /api/admin/reports': api.adminReports,
  'POST /api/admin/set-role': api.setRole,
  'POST /api/admin/set-permissions': api.setPermissions,
  'POST /api/admin/op-password': api.opPasswordSet,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const cookies = parseCookies(req);
  const { user, token } = getUserFromReq(cookies);
  const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
  const query = Object.fromEntries(url.searchParams.entries());

  const setCookieHeaders = [];
  const ctx = {
    req, res, body, query, user, token,
    setCookie(name, value, opts) { setCookieHeaders.push(buildSetCookie(name, value, opts)); },
    json(obj, statusCode = 200) {
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (setCookieHeaders.length) headers['Set-Cookie'] = setCookieHeaders;
      res.writeHead(statusCode, headers);
      res.end(JSON.stringify(obj));
    },
    fail(message, statusCode = 400) {
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (setCookieHeaders.length) headers['Set-Cookie'] = setCookieHeaders;
      res.writeHead(statusCode, headers);
      res.end(JSON.stringify({ error: message }));
    },
  };

  const handler = routes[`${req.method} ${pathname}`];
  if (!handler) return ctx.fail('接口不存在', 404);

  try {
    await handler(ctx);
  } catch (e) {
    console.error('[api error]', pathname, e);
    if (!res.headersSent) ctx.fail('服务器内部错误', 500);
  }
});

// 实时扣费定时器：每 60 秒结算所有在店计费用户
const TICK_MS = Number(process.env.TICK_MS || 60000);
setInterval(() => {
  try { billing.tickAll(Date.now()); } catch (e) { console.error('[tick]', e.message); }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`店内计时收费系统已启动: http://localhost:${PORT}`);
  console.log(`实时扣费间隔: ${TICK_MS / 1000} 秒`);
});

module.exports = { server };
