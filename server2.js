'use strict';
/*
 * BLOODBET · çok oyunculu sunucu
 * Bağımlılık yok: sadece Node.js 18+ gerekir.   Çalıştır:  node server2.js
 *
 * Ortam değişkenleri:
 *   PORT             (varsayılan 3000)
 *   OWNER_CODE       OWNER yetki kodu   (verilmezse rastgele üretilir ve konsola yazılır)
 *   ADMIN_CODE       ADMIN yetki kodu   (verilmezse rastgele üretilir ve konsola yazılır)
 *   ALLOWED_ORIGINS  izinli site adresleri, virgülle ayır. Örn: https://siten.com,https://www.siten.com
 *                    (boşsa her yerden bağlanılabilir)
 *   MAX_PLAYERS      aynı anda en fazla oyuncu (varsayılan 75)
 *   MAX_PER_IP       aynı IP'den en fazla bağlantı (varsayılan 8)
 *   DATA_DIR         hesapların kaydedildiği klasör (varsayılan ./data). Kalıcı diske işaret etmeli!
 *   TRUST_PROXY=1    Cloudflare gibi herkese açık bir proxy arkasındaysan X-Forwarded-For kullan
 *                    (aynı makinedeki / özel ağdaki proxy otomatik tanınır)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 75;
const MAX_PER_IP = +process.env.MAX_PER_IP || 8;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAXMSG = 16 * 1024;
const TICK_MS = 66;

const genCode = () => crypto.randomBytes(9).toString('base64url');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
const CODES_FILE = path.join(DATA_DIR, 'codes.json');
let savedCodes = {};
try { savedCodes = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')) || {}; } catch (e) { }
const OWNER_CODE = process.env.OWNER_CODE || savedCodes.owner || genCode();
const ADMIN_CODE = process.env.ADMIN_CODE || savedCodes.admin || genCode();
if (savedCodes.owner !== OWNER_CODE || savedCodes.admin !== ADMIN_CODE) {   // yeniden başlatınca değişmesin
  try { fs.writeFileSync(CODES_FILE, JSON.stringify({ owner: OWNER_CODE, admin: ADMIN_CODE })); } catch (e) { }
}
const RANK = { '': 0, admin: 1, owner: 2 };

const STATES = new Set(['idle', 'walk', 'run', 'dance', 'up', 'down']);
const ZONES = new Set(['lobby', 'range', 'casino']);
const ID_RE = /^[a-z][0-9]{1,3}$/;

/* ---------- yardımcılar ---------- */
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function num(v, lo, hi, d) {
  v = Number(v);
  if (!Number.isFinite(v)) return d;
  return Math.max(lo, Math.min(hi, v));
}
function cleanText(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff<>]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanEq(e) {
  e = e && typeof e === 'object' ? e : {};
  const pick = (v, d) => (typeof v === 'string' && ID_RE.test(v) ? v : d);
  return { c: pick(e.c, 'c1'), h: pick(e.h, 'h1'), o: pick(e.o, 'o1'), d: pick(e.d, 'd1') };
}

/* ---------- WebSocket çerçeveleri ---------- */
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

class Conn {
  constructor(socket, ip, onMessage, onClose) {
    this.s = socket; this.ip = ip; this.onMessage = onMessage; this.onCloseCb = onClose;
    this.buf = Buffer.alloc(0); this.frag = []; this.fragLen = 0; this.fragOp = 0;
    this.closed = false; this.pong = Date.now(); this.p = null;
    this.rateN = 0; this.rateT = Date.now();
    socket.setNoDelay(true);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => { });
  }
  onData(d) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > MAXMSG * 2 + 64) return this.close(1009);
    for (; ;) {
      if (this.closed) return;
      const b = this.buf;
      if (b.length < 2) return;
      const b0 = b[0], b1 = b[1], fin = !!(b0 & 0x80), op = b0 & 0x0f;
      if (b0 & 0x70) return this.close(1002);
      if (!(b1 & 0x80)) return this.close(1002);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAXMSG)) return this.close(1009);
        len = Number(big); off = 10;
      }
      if (len > MAXMSG) return this.close(1009);
      if (op >= 8 && (len > 125 || !fin)) return this.close(1002);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (op === 8) return this.close(1000);
      if (op === 9) { this.raw(frame(10, payload)); continue; }
      if (op === 10) { this.pong = Date.now(); continue; }
      if (op === 1 || op === 2) {
        if (this.fragOp) return this.close(1002);
        if (fin) this.deliver(op, payload);
        else { this.fragOp = op; this.frag = [payload]; this.fragLen = len; }
      } else if (op === 0) {
        if (!this.fragOp) return this.close(1002);
        this.fragLen += len;
        if (this.fragLen > MAXMSG) return this.close(1009);
        this.frag.push(payload);
        if (fin) { const full = Buffer.concat(this.frag), o = this.fragOp; this.fragOp = 0; this.frag = []; this.deliver(o, full); }
      } else return this.close(1002);
    }
  }
  deliver(op, payload) {
    if (op !== 1) return;                       // ikili mesajlar yok sayılır
    const now = Date.now();                     // genel taşma koruması
    if (now - this.rateT > 1000) { this.rateT = now; this.rateN = 0; }
    if (++this.rateN > 120) return this.close(1008);
    this.onMessage(this, payload.toString('utf8'));
  }
  raw(buf) { if (!this.closed) this.s.write(buf); }
  sendFrame(buf, droppable) {
    if (this.closed) return;
    const w = this.s.writableLength;
    if (w > 4e6) return this.close(1013);
    if (droppable && w > 256 * 1024) return;
    this.s.write(buf);
  }
  send(obj, droppable) { this.sendFrame(frame(1, Buffer.from(JSON.stringify(obj))), droppable); }
  ping() { this.raw(frame(9, Buffer.alloc(0))); }
  close(code) {
    if (this.closed) return;
    this.closed = true;
    try { this.s.write(frame(8, Buffer.from([code >> 8, code & 255]))); this.s.end(); } catch (e) { }
    setTimeout(() => { try { this.s.destroy(); } catch (e) { } }, 1000).unref();
    this.finish();
  }
  finish() {
    if (this.done) return;
    this.done = true; this.closed = true;
    this.onCloseCb(this);
  }
}

/* ---------- hesaplar (kalıcı) ---------- */
const PRICE = new Map([["c1",0],["c2",150],["c3",200],["c4",200],["c5",320],["c6",320],["c7",350],["c8",700],["c9",750],["c10",1400],["o1",0],["o2",180],["o3",380],["o4",750],["o5",1500],["o6",3500],["h1",0],["h6",170],["h7",190],["h2",330],["h8",340],["h4",700],["h5",750],["h9",800],["h3",1400],["h10",1650],["d1",0],["d5",180],["d2",330],["d6",350],["d4",720],["d7",700],["d3",1400],["d8",1500],["d9",3200]]);
const DEFAULT_OWNED = ['c1', 'h1', 'o1', 'd1'];
const START_GOLD = 1000;
const BUD_RATE = 2, BUD_CAP = 6000, BUD_START = 4000;   // sunucunun izin verdiği en hızlı servet artışı (altın/sn, üst sınır)
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = Object.create(null);
try { Object.assign(users, JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || {}); } catch (e) { }
let saveT = null;
function writeUsers() {
  try { const tmp = USERS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(users)); fs.renameSync(tmp, USERS_FILE); }
  catch (e) { log('kayıt hatası:', e.message); }
}
function saveUsers(now) {
  if (now) { clearTimeout(saveT); saveT = null; return writeUsers(); }
  if (saveT) return;
  saveT = setTimeout(() => { saveT = null; writeUsers(); }, 3000);
}
const NAME_RE = /^[\p{L}\p{N}_.-]+(?: [\p{L}\p{N}_.-]+)*$/u;
const RESERVED = new Set(['admin', 'owner', 'system', 'sistem', 'lobi', 'mod', 'moderator', 'yönetici', 'yonetici', 'oyuncu']);
const validName = n => n.length >= 2 && n.length <= 14 && NAME_RE.test(n) && !RESERVED.has(n.toLowerCase());
const tokHash = t => crypto.createHash('sha256').update(String(t)).digest('base64url');
const wealthOf = (gold, owned) => gold + owned.reduce((s, id) => s + (PRICE.get(id) || 0), 0);
const pubPf = a => ({ gold: a.gold, owned: a.owned, eq: a.eq });
const loginTries = new Map();   // ip -> zaman damgaları
const regTries = new Map();

function newAccount(name, salt, hash) {
  return { name, salt: salt.toString('base64'), hash: hash.toString('base64'), toks: [], gold: START_GOLD, owned: DEFAULT_OWNED.slice(),
    eq: { c: 'c1', h: 'h1', o: 'o1', d: 'd1' }, bud: BUD_START, budT: Date.now(), created: Date.now() };
}
function doAuth(c, m) {
  const now = Date.now();
  const lt = (loginTries.get(c.ip) || []).filter(t => now - t < 60000);
  if (lt.length >= 12) return c.send({ t: 'autherr', c: 'rate' });
  lt.push(now); loginTries.set(c.ip, lt);
  if (c.authBusy || c.acct) return;
  const name = cleanText(m.name, 14), key = name.toLowerCase();
  const pw = typeof m.pass === 'string' ? m.pass.slice(0, 64) : '';
  const fail = code => c.send({ t: 'autherr', c: code });
  if (m.t === 'reg') {
    if (!validName(name)) return fail('name');
    if (pw.length < 6) return fail('pw');
    if (users[key]) return fail('taken');
    const rt = (regTries.get(c.ip) || []).filter(t => now - t < 3600000);
    if (rt.length >= 5) return fail('regrate');
    rt.push(now); regTries.set(c.ip, rt);
    c.authBusy = true;
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 32, (e, k) => {
      c.authBusy = false;
      if (e || c.closed) return;
      if (users[key]) return fail('taken');
      const a = newAccount(name, salt, k);
      users[key] = a; saveUsers();
      log('yeni hesap', name);
      authOk(c, a, true);
    });
    return;
  }
  const a = users[key];
  if (m.t === 'resume') {
    const th = tokHash(m.tok || '');
    if (!a || !a.toks.includes(th)) return fail('bad');
    return authOk(c, a, false, String(m.tok));
  }
  if (!a) return fail('bad');
  c.authBusy = true;
  crypto.scrypt(pw, Buffer.from(a.salt, 'base64'), 32, (e, k) => {
    c.authBusy = false;
    if (e || c.closed) return;
    const good = Buffer.from(a.hash, 'base64');
    if (k.length !== good.length || !crypto.timingSafeEqual(k, good)) return fail('bad');
    authOk(c, a, true);
  });
}
function authOk(c, a, mint, tok) {
  let online = null;
  for (const q of players.values()) if (q.acct === a) online = q;
  if (!online && players.size >= MAX_PLAYERS) return c.send({ t: 'autherr', c: 'full' });
  if (mint) {
    tok = crypto.randomBytes(24).toString('base64url');
    a.toks.push(tokHash(tok)); if (a.toks.length > 5) a.toks.shift();
    saveUsers();
  }
  c.acct = a;
  if (online && online.conn !== c) {             // aynı hesap ikinci yerden girdi: eski oturum kapanır
    online.conn.send({ t: 'err', c: 'dup' });
    online.conn.close(1000);
  }
  c.send({ t: 'authok', name: a.name, tok, pf: pubPf(a) });
}
// istemcinin bildirdiği altın / eşya durumunu doğrular; hileli artışı reddeder
function applyPf(p, m, now) {
  const a = p.acct;
  const reject = () => p.conn.send({ t: 'pfx', pf: pubPf(a) });
  if (!Array.isArray(m.owned) || m.owned.length > 120) return reject();
  const set = new Set(a.owned);
  for (const id of m.owned) if (typeof id === 'string' && PRICE.has(id)) set.add(id);
  for (const id of DEFAULT_OWNED) set.add(id);
  const owned = [...set];
  const gold = Math.floor(num(m.gold, 0, 1e9, a.gold));
  const eq = cleanEq(m.eq);
  for (const k of ['c', 'h', 'o', 'd']) if (!set.has(eq[k])) eq[k] = a.eq[k];
  const dW = wealthOf(gold, owned) - wealthOf(a.gold, a.owned);
  a.bud = Math.min(BUD_CAP, a.bud + (now - a.budT) * BUD_RATE / 1000); a.budT = now;
  if (dW > 0 && p.role !== 'owner') {
    if (dW > a.bud) { log('reddedildi', a.name, '+' + dW); return reject(); }
    a.bud -= dW;
  }
  a.gold = gold; a.owned = owned; a.eq = eq; p.gold = gold; p.eq = eq;
  saveUsers();
  broadcast({ t: 'me', id: p.id, eq, gold }, p.id);
}

/* ---------- oyun durumu ---------- */
const players = new Map();      // id -> player
const conns = new Set();
const ipCount = new Map();
const authTries = new Map();    // ip -> [zaman damgaları]
let nextId = 1;

const info = p => ({ id: p.id, name: p.name, eq: p.eq, gold: p.gold, role: p.role, m: p.muted ? 1 : 0, st: p.st });

function broadcast(obj, exceptId, droppable) {
  const fr = frame(1, Buffer.from(JSON.stringify(obj)));
  for (const p of players.values()) if (p.id !== exceptId) p.conn.sendFrame(fr, droppable);
}
function uniqueName(base) {
  const taken = new Set([...players.values()].map(p => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const sfx = '_' + n, nm = base.slice(0, 14 - sfx.length) + sfx;
    if (!taken.has(nm.toLowerCase())) return nm;
  }
  return base.slice(0, 8) + '_' + crypto.randomInt(1000, 9999);
}
function setRole(p, role) {
  p.role = role;
  p.conn.send({ t: 'role', r: role });
  broadcast({ t: 'prole', id: p.id, r: role }, p.id);
}

function doJoin(c, m) {
  if (players.size >= MAX_PLAYERS) { c.send({ t: 'err', c: 'full' }); return c.close(1013); }
  if (!c.acct) return c.close(1008);
  const a = c.acct;
  for (const q of players.values()) if (q.acct === a) { q.conn.send({ t: 'err', c: 'dup' }); q.conn.close(1000); }
  const name = a.name;
  const p = {
    id: nextId++, name, acct: a, eq: a.eq, gold: a.gold, role: '', muted: false,
    st: [0, 0, 12, 0, 'idle', 'd1', 'lobby', 0], dirty: false, conn: c, chatTok: 4, chatT: Date.now(), admT: Date.now(), admN: 0
  };
  p.st[5] = p.eq.d;
  a.budT = a.budT || Date.now();
  c.p = p; players.set(p.id, p);
  c.send({ t: 'welcome', id: p.id, name: p.name, v: 1, n: players.size, players: [...players.values()].filter(x => x !== p).map(info) });
  broadcast({ t: 'join', p: info(p) }, p.id);
  log('+', p.name, `(${players.size})`);
}

function onMsg(c, txt) {
  let m;
  try { m = JSON.parse(txt); } catch (e) { return; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
  if (!c.p) {
    if (m.t === 'reg' || m.t === 'login' || m.t === 'resume') doAuth(c, m);
    else if (m.t === 'join') doJoin(c, m);
    return;
  }
  const p = c.p, now = Date.now();
  switch (m.t) {
    case 'st': {
      const a = m.a;
      if (!Array.isArray(a) || a.length < 8) return;
      p.st = [
        num(a[0], -130, 130, 0), num(a[1], 0, 12, 0), num(a[2], -130, 130, 0), num(a[3], -10, 10, 0),
        STATES.has(a[4]) ? a[4] : 'idle', typeof a[5] === 'string' && ID_RE.test(a[5]) ? a[5] : p.eq.d,
        ZONES.has(a[6]) ? a[6] : 'lobby', a[7] ? 1 : 0
      ];
      p.dirty = true;
      return;
    }
    case 'pf': return applyPf(p, m, now);
    case 'chat': {
      const msg = cleanText(m.m, 160);
      if (!msg) return;
      p.chatTok = Math.min(4, p.chatTok + (now - p.chatT) / 1200); p.chatT = now;
      if (p.chatTok < 1) return c.send({ t: 'err', c: 'fast' });
      if (p.muted) return c.send({ t: 'muted', v: 1 });
      p.chatTok -= 1;
      broadcast({ t: 'chat', id: p.id, name: p.name, role: p.role, m: msg });
      return;
    }
    case 'auth': {
      const list = (authTries.get(c.ip) || []).filter(t => now - t < 60000);
      if (list.length >= 8) return c.send({ t: 'err', c: 'rate' });
      const code = String(m.code || '').slice(0, 80);
      if (safeEq(code, OWNER_CODE)) { setRole(p, 'owner'); log('owner girişi', p.name); return; }
      if (safeEq(code, ADMIN_CODE)) { setRole(p, 'admin'); log('admin girişi', p.name); return; }
      list.push(now); authTries.set(c.ip, list);
      return c.send({ t: 'err', c: 'bad' });
    }
    case 'logout': { if (p.role) setRole(p, ''); return; }
    case 'adm': return adminAction(p, m, now);
  }
}

function adminAction(p, m, now) {
  const me = RANK[p.role] || 0;
  if (me < 1) return p.conn.send({ t: 'err', c: 'perm' });
  p.admN = Math.max(0, p.admN - (now - p.admT) / 500) + 1; p.admT = now;
  if (p.admN > 8) return;
  const a = String(m.a || '');
  if (a === 'ann') {
    const text = cleanText(m.m, 140);
    if (text) broadcast({ t: 'ann', m: text, by: p.name });
    return;
  }
  if (a === 'clear') return broadcast({ t: 'clear' });
  const target = players.get(Number(m.id));
  if (!target || target === p) return;
  const tr = RANK[target.role] || 0;
  if (a === 'role') {
    if (me < 2 || tr >= 2) return;
    const r = m.r === 'admin' ? 'admin' : '';
    if (r === target.role) return;
    setRole(target, r);
    return broadcast({ t: 'evt', e: r ? 'prom' : 'dem', n: target.name });
  }
  if (me <= tr) return p.conn.send({ t: 'err', c: 'rank' });
  if (a === 'mute' || a === 'unmute') {
    target.muted = a === 'mute';
    target.conn.send({ t: 'muted', v: target.muted ? 1 : 0 });
    broadcast({ t: 'pmute', id: target.id, v: target.muted ? 1 : 0 });
    return broadcast({ t: 'evt', e: a, n: target.name });
  }
  if (a === 'kick') {
    broadcast({ t: 'evt', e: 'kick', n: target.name });
    target.conn.send({ t: 'kick' });
    log('kick', target.name, 'by', p.name);
    return target.conn.close(1008);
  }
}

function onClose(c) {
  conns.delete(c);
  const n = (ipCount.get(c.ip) || 1) - 1;
  if (n > 0) ipCount.set(c.ip, n); else ipCount.delete(c.ip);
  const p = c.p;
  if (p && players.get(p.id) === p) {
    players.delete(p.id);
    broadcast({ t: 'leave', id: p.id });
    saveUsers();
    log('-', p.name, `(${players.size})`);
  }
}

/* ---------- HTTP + upgrade ---------- */
const FILES = ['index.html', 'BloodBet.html'];
function findHtml() {          // index.html yoksa klasördeki "lobi" geçen ilk .html dosyası (en yeni sürüm)
  try {
    const l = fs.readdirSync(__dirname).filter(f => /(lobi|bloodbet).*\.html$/i.test(f)).sort();
    return l.length ? l[l.length - 1] : null;
  } catch (e) { return null; }
}
let cache = { file: '', mtime: 0, body: null };
function loadHtml() {
  const alt = findHtml();
  for (const f of alt ? [...FILES, alt] : FILES) {
    const fp = path.join(__dirname, f);
    try {
      const st = fs.statSync(fp);
      if (cache.file !== fp || cache.mtime !== st.mtimeMs) cache = { file: fp, mtime: st.mtimeMs, body: fs.readFileSync(fp) };
      return cache.body;
    } catch (e) { }
  }
  return null;
}
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

const server = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (u === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', ...SEC }); return res.end('ok ' + players.size); }
  if (u === '/' || u === '/index.html') {
    const body = loadHtml();
    if (!body) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SEC }); return res.end('index.html bulunamadı (oyun dosyasını index.html adıyla server2.js ile aynı klasöre koy).'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC });
    return res.end(body);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain', ...SEC });
  res.end('404');
});

server.on('upgrade', (req, socket) => {
  const deny = (code, msg) => { try { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); } catch (e) { } socket.destroy(); };
  const url = (req.url || '').split('?')[0];
  if (url !== '/ws') return deny(404, 'Not Found');
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return deny(400, 'Bad Request');
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers['sec-websocket-version'] !== '13') return deny(400, 'Bad Request');
  if (ALLOWED.length && !ALLOWED.includes(req.headers.origin || '')) return deny(403, 'Forbidden');
  const ra = req.socket.remoteAddress || '';
  const viaProxy = TRUST_PROXY || /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|^(::1|f[cd][0-9a-f]{2}:)/i.test(ra);
  const fwd = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = viaProxy && fwd ? fwd : ra;
  if ((ipCount.get(ip) || 0) >= MAX_PER_IP) return deny(429, 'Too Many Requests');
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  const c = new Conn(socket, ip, onMsg, onClose);
  conns.add(c);
  setTimeout(() => { if (!c.p) c.close(1008); }, 60000).unref();   // 60 sn içinde katılmayan atılır
});

/* ---------- döngüler ---------- */
setInterval(() => {
  const entries = [];
  for (const p of players.values()) if (p.dirty) { p.dirty = false; entries.push([p.id, ...p.st]); }
  if (entries.length) broadcast({ t: 'snap', p: entries }, 0, true);
}, TICK_MS);

setInterval(() => {
  const now = Date.now();
  for (const c of [...conns]) {
    if (now - c.pong > 45000) { try { c.s.destroy(); } catch (e) { } c.finish(); }
    else c.ping();
  }
  for (const mp of [loginTries, regTries]) for (const [ip, l] of mp) { const f = l.filter(t => now - t < 3600000); if (f.length) mp.set(ip, f); else mp.delete(ip); }
  for (const [ip, l] of authTries) { const f = l.filter(t => now - t < 60000); if (f.length) authTries.set(ip, f); else authTries.delete(ip); }
}, 15000).unref();

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    log(`BloodBet sunucusu http://localhost:${PORT} adresinde (WebSocket: /ws)`);
    if (!process.env.OWNER_CODE) log('OWNER_CODE verilmedi, bu oturum için üretildi:', OWNER_CODE);
    if (!process.env.ADMIN_CODE) log('ADMIN_CODE verilmedi, bu oturum için üretildi:', ADMIN_CODE);
    if (!ALLOWED.length) log('Uyarı: ALLOWED_ORIGINS boş, her siteden bağlanılabilir.');
  });
  const stop = () => { saveUsers(true); for (const c of conns) c.close(1001); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = { server, OWNER_CODE, ADMIN_CODE, players };
