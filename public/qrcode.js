/* 零依赖二维码生成器：字节模式，版本 1-4，纠错级别 L，单数据块，掩码 0。
   足够编码店内的短充值令牌（<=78 字节）。可在浏览器渲染到 canvas，也可在 Node 测试。*/
(function (global) {
  'use strict';

  var EC_CW = { 1: 7, 2: 10, 3: 15, 4: 20 };     // 每版纠错码字数(L级)
  var DATA_CW = { 1: 19, 2: 34, 3: 55, 4: 80 };  // 每版数据码字数(L级)
  var ALIGN = { 2: 18, 3: 22, 4: 26 };           // 对齐图形中心(单个)

  // GF(256) 乘法 (本原多项式 0x11d)
  function gmul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gmul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gmul(root, 2);
    }
    return result;
  }
  function rsRemainder(data, degree) {
    var divisor = rsDivisor(degree);
    var result = new Array(degree).fill(0);
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ result.shift();
      result.push(0);
      for (var i = 0; i < divisor.length; i++) result[i] ^= gmul(divisor[i], factor);
    }
    return result;
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    var out = []; for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
      else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
    }
    return out;
  }

  function capacity(v) { return DATA_CW[v] - 2; }

  function encode(text) {
    var bytes = utf8Bytes(text);
    var version = 0;
    for (var v = 1; v <= 4; v++) { if (bytes.length <= capacity(v)) { version = v; break; } }
    if (!version) throw new Error('二维码数据过长');
    var dcw = DATA_CW[version];
    var bs = [];
    function pushBits(val, len) { for (var i = len - 1; i >= 0; i--) bs.push((val >> i) & 1); }
    pushBits(0x4, 4);            // 字节模式
    pushBits(bytes.length, 8);   // 计数(版本1-9字节模式为8位)
    for (var i = 0; i < bytes.length; i++) pushBits(bytes[i], 8);
    var cap = dcw * 8;
    var term = Math.min(4, cap - bs.length);
    for (var i = 0; i < term; i++) bs.push(0);
    while (bs.length % 8 !== 0) bs.push(0);
    var dataBytes = [];
    for (var i = 0; i < bs.length; i += 8) { var b = 0; for (var j = 0; j < 8; j++) b = (b << 1) | bs[i + j]; dataBytes.push(b); }
    var pad = [0xEC, 0x11], pi = 0;
    while (dataBytes.length < dcw) { dataBytes.push(pad[pi % 2]); pi++; }
    var ec = rsRemainder(dataBytes, EC_CW[version]);
    var all = dataBytes.concat(ec);
    var bits = [];
    for (var i = 0; i < all.length; i++) for (var j = 7; j >= 0; j--) bits.push((all[i] >> j) & 1);
    return { version: version, bits: bits };
  }

  function formatCoords(N) {
    var c1 = [], c2 = [];
    for (var i = 0; i <= 5; i++) c1.push([8, i]);
    c1.push([8, 7]); c1.push([8, 8]); c1.push([7, 8]);
    for (var i = 9; i <= 14; i++) c1.push([14 - i, 8]);
    for (var i = 0; i <= 6; i++) c2.push([N - 1 - i, 8]);
    for (var i = 7; i <= 14; i++) c2.push([8, N - 8 + (i - 7)]);
    return [c1, c2];
  }

  function buildMatrix(version, bits) {
    var N = 17 + 4 * version;
    var mod = [], func = [];
    for (var i = 0; i < N; i++) { mod.push(new Array(N).fill(0)); func.push(new Array(N).fill(false)); }
    function setF(r, c, v) { if (r < 0 || c < 0 || r >= N || c >= N) return; mod[r][c] = v ? 1 : 0; func[r][c] = true; }

    function finder(r, c) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
        var inCenter = (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
        setF(r + dr, c + dc, inRing || inCenter ? 1 : 0);
      }
    }
    finder(0, 0); finder(0, N - 7); finder(N - 7, 0);

    for (var i = 8; i < N - 8; i++) { setF(6, i, i % 2 === 0 ? 1 : 0); setF(i, 6, i % 2 === 0 ? 1 : 0); }
    setF(N - 8, 8, 1); // 固定黑模块

    if (version >= 2) {
      var ac = ALIGN[version];
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        setF(ac + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
      }
    }

    // 预留格式信息区域
    var fc = formatCoords(N);
    fc[0].concat(fc[1]).forEach(function (p) { func[p[0]][p[1]] = true; });

    // 放置数据位（之字形，跳过第6列计时）
    var idx = 0, upward = true;
    for (var col = N - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (var t = 0; t < N; t++) {
        for (var j = 0; j < 2; j++) {
          var c = col - j;
          var r = upward ? (N - 1 - t) : t;
          if (!func[r][c]) { mod[r][c] = idx < bits.length ? bits[idx] : 0; idx++; }
        }
      }
      upward = !upward;
    }

    // 掩码 0：(r+c)%2==0
    for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) { if (!func[r][c] && ((r + c) % 2 === 0)) mod[r][c] ^= 1; }

    // 格式信息（L级=01，掩码0）
    var data5 = (0x01 << 3) | 0;
    var rem = data5;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    var fbits = ((data5 << 10) | rem) ^ 0x5412;
    for (var i = 0; i < 15; i++) {
      var bit = (fbits >> i) & 1;
      mod[fc[0][i][0]][fc[0][i][1]] = bit;
      mod[fc[1][i][0]][fc[1][i][1]] = bit;
    }
    return { size: N, modules: mod };
  }

  function generate(text) { var e = encode(text); return buildMatrix(e.version, e.bits); }

  function ascii(text) {
    var m = generate(text), s = '';
    for (var r = 0; r < m.size; r++) { for (var c = 0; c < m.size; c++) s += m.modules[r][c] ? '██' : '  '; s += '\n'; }
    return s;
  }

  function render(container, text, px) {
    var m = generate(text);
    var quiet = 4, total = m.size + quiet * 2;
    px = px || 220;
    var scale = Math.max(1, Math.floor(px / total));
    var dim = total * scale;
    var canvas = document.createElement('canvas');
    canvas.width = dim; canvas.height = dim;
    canvas.style.width = dim + 'px'; canvas.style.height = dim + 'px';
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000';
    for (var r = 0; r < m.size; r++) for (var c = 0; c < m.size; c++) {
      if (m.modules[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
    container.innerHTML = '';
    container.appendChild(canvas);
  }

  var QRCode = { generate: generate, render: render, ascii: ascii };
  if (typeof module !== 'undefined' && module.exports) module.exports = QRCode;
  global.QRCode = QRCode;
})(typeof window !== 'undefined' ? window : globalThis);
