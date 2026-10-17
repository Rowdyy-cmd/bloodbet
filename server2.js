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
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *                    verilirse hesaplar ücretsiz Upstash veritabanında saklanır (güncelleme/yeniden başlatmada silinmez)
 *   ICE_SERVERS      sesli sohbet için TURN/STUN listesi (JSON). Örn: [{"urls":"turn:turn.siten.com:3478","username":"u","credential":"p"}]
 *                    boşsa sadece Google STUN kullanılır (çoğu ev ağında yeter; mobil veri / sıkı NAT için TURN gerekir)
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
const ZONES = new Set(['lobby', 'range', 'casino', 'pvp']);
const ID_RE = /^[a-z][0-9]{1,3}$/;

let ICE = null;
try { const j = JSON.parse(process.env.ICE_SERVERS || 'null'); if (Array.isArray(j) && j.length) ICE = j.slice(0, 6); } catch (e) { }

/* ---------- PVP arena ayarları (istemcideki PCOVER / PSPAWN ile aynı olmalı) ---------- */
const PVP = { cx: 0, cz: 100, half: 15, hp: 100, dmg: 25, head: 50, cd: 190, range: 70, rad: 0.55, h: 1.85, respawn: 3000, reward: 60, sameVictimMs: 30000 };
const COVER = [[-7, 93, 1.1], [7, 93, 1.1], [-7, 107, 1.1], [7, 107, 1.1], [0, 100, 1.4], [-12, 100, .9], [12, 100, .9]];
const SPAWNS = [[-12, 88], [12, 88], [-12, 112], [12, 112], [0, 88], [0, 112]];
function rayCircle(ox, oz, dx, dz, cx, cz, r) {      // XZ düzleminde ışın-daire kesişimi; en yakın t ya da -1
  const fx = ox - cx, fz = oz - cz, a = dx * dx + dz * dz;
  if (a < 1e-9) return -1;
  const b = fx * dx + fz * dz, c = fx * fx + fz * fz - r * r, disc = b * b - a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / a;
  if (t < 0) { t = (-b + sq) / a; if (t < 0) return -1; }
  return t;
}
function wallT(ox, oz, dx, dz) {                     // ışının arena duvarına varış mesafesi
  let t = 1e9;
  if (dx > 1e-6) t = Math.min(t, (PVP.cx + PVP.half - ox) / dx); else if (dx < -1e-6) t = Math.min(t, (PVP.cx - PVP.half - ox) / dx);
  if (dz > 1e-6) t = Math.min(t, (PVP.cz + PVP.half - oz) / dz); else if (dz < -1e-6) t = Math.min(t, (PVP.cz - PVP.half - oz) / dz);
  return Math.max(0, t);
}

/* ---------- şans oyunları (sunucu hakemlidir) ---------- */
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const WHEEL = [0, .5, 0, 2, 0, .5, 0, 1.5, 0, .5, 0, 3, 0, .5, 0, 2, 0, .5, 0, 1.5, 0, .5, 0, 10];   // 24 dilim, geri dönüş ≈ %95,8
const BET_KINDS = new Set(['n', 'red', 'black', 'odd', 'even', 'low', 'high', 'd1', 'd2', 'd3', 'c1', 'c2', 'c3']);
const MAX_BET = 5000, MAX_TOTAL = 20000, BET_GAP = 3500, BIG_WIN = 5000;
function roulettePay(b, n) {
  let w = 0;
  if (b.k === 'n') w = b.v === n ? 36 : 0;
  else if (n === 0) w = 0;
  else switch (b.k) {
    case 'red': w = RED.has(n) ? 2 : 0; break;
    case 'black': w = RED.has(n) ? 0 : 2; break;
    case 'odd': w = n % 2 ? 2 : 0; break;
    case 'even': w = n % 2 ? 0 : 2; break;
    case 'low': w = n <= 18 ? 2 : 0; break;
    case 'high': w = n >= 19 ? 2 : 0; break;
    case 'd1': w = n <= 12 ? 3 : 0; break;
    case 'd2': w = n > 12 && n <= 24 ? 3 : 0; break;
    case 'd3': w = n > 24 ? 3 : 0; break;
    case 'c1': w = n % 3 === 1 ? 3 : 0; break;
    case 'c2': w = n % 3 === 2 ? 3 : 0; break;
    case 'c3': w = n % 3 === 0 ? 3 : 0; break;
  }
  return w * b.a;
}

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
let saveT = null, savingP = null;
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE = !!(UP_URL && UP_TOKEN);
const lastSaved = Object.create(null);     // hesap -> en son veritabanına yazılan metin
async function redis(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function loadRemote() {
  const res = (await redis(['HGETALL', 'bloodbet:users'])) || [];
  for (let i = 0; i + 1 < res.length; i += 2) {
    try { users[res[i]] = JSON.parse(res[i + 1]); lastSaved[res[i]] = res[i + 1]; } catch (e) { }
  }
  log('veritabanından', Object.keys(users).length, 'hesap yüklendi');
}
async function flushRemote() {              // sadece değişen hesapları yazar
  const args = ['HSET', 'bloodbet:users'], upd = [];
  for (const k in users) { const t = JSON.stringify(users[k]); if (lastSaved[k] !== t) { args.push(k, t); upd.push([k, t]); } }
  if (!upd.length) return;
  await redis(args);
  for (const [k, t] of upd) lastSaved[k] = t;
}
function writeUsers() {
  if (REMOTE) {
    savingP = (savingP || Promise.resolve()).then(flushRemote).catch(e => log('veritabanı kayıt hatası:', e.message));
    return savingP;
  }
  try { const tmp = USERS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(users)); fs.renameSync(tmp, USERS_FILE); }
  catch (e) { log('kayıt hatası:', e.message); }
  return Promise.resolve();
}
function saveUsers(now) {
  if (now) { clearTimeout(saveT); saveT = null; return writeUsers(); }
  if (saveT) return;
  saveT = setTimeout(() => { saveT = null; writeUsers(); }, REMOTE ? 15000 : 3000);
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
  let gold = Math.floor(num(m.gold, 0, 1e9, a.gold));
  if (now < (p.holdUntil || 0)) gold = a.gold;                          // bahis sonucu istemciye ulaşana kadar sunucu altını geçerli
  else if (now - (p.rewT || 0) < 4000) gold = Math.max(gold, a.gold);   // yeni verilen ödül ezilmesin
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
    st: [0, 0, 12, 0, 'idle', 'd1', 'lobby', 0], dirty: false, conn: c, chatTok: 4, chatT: Date.now(), admT: Date.now(), admN: 0,
    hp: PVP.hp, dead: 0, shotT: 0, kills: new Map(), betT: 0, holdUntil: 0, rewT: 0, rtcN: 0, rtcT: Date.now()
  };
  p.st[5] = p.eq.d;
  a.budT = a.budT || Date.now();
  c.p = p; players.set(p.id, p);
  c.send({ t: 'welcome', id: p.id, name: p.name, v: 1, n: players.size, ice: ICE, players: [...players.values()].filter(x => x !== p).map(info) });
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
      if (a[6] === 'pvp' && p.st[6] !== 'pvp') { p.hp = PVP.hp; p.dead = 0; }
      p.st = [
        num(a[0], -130, 130, 0), num(a[1], 0, 12, 0), num(a[2], -130, 130, 0), num(a[3], -10, 10, 0),
        STATES.has(a[4]) ? a[4] : 'idle', typeof a[5] === 'string' && ID_RE.test(a[5]) ? a[5] : p.eq.d,
        ZONES.has(a[6]) ? a[6] : 'lobby', a[7] ? 1 : 0
      ];
      p.dirty = true;
      return;
    }
    case 'pf': return applyPf(p, m, now);
    case 'rtc': {                                    // sesli sohbet sinyalleşmesi (WebRTC offer/answer/ICE), ses sunucudan geçmez
      if (p.muted) return;
      p.rtcN = Math.max(0, p.rtcN - (now - p.rtcT) / 25) + 1; p.rtcT = now;
      if (p.rtcN > 60) return;
      const q = players.get(Number(m.to));
      if (!q || q === p || !m.d || typeof m.d !== 'object') return;
      let sz = 0; try { sz = JSON.stringify(m.d).length; } catch (e) { return; }
      if (sz > 6000) return;
      q.conn.send({ t: 'rtc', from: p.id, d: m.d });
      return;
    }
    case 'shot': return doShot(p, m, now);
    case 'bet': return doBet(p, m, now);
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

function pvpSend(obj, except) {
  for (const q of players.values()) if (q !== except && q.st[6] === 'pvp') q.conn.send(obj, true);
}
function doShot(p, m, now) {
  if (p.st[6] !== 'pvp' || p.dead || now - p.shotT < PVP.cd) return;
  const o = m.o, d = m.d;
  if (!Array.isArray(o) || !Array.isArray(d) || o.length < 3 || d.length < 3) return;
  const ox = num(o[0], -130, 130, 0), oy = num(o[1], 0, 14, 1.6), oz = num(o[2], -130, 130, 0);
  let dx = num(d[0], -1, 1, 0), dy = num(d[1], -1, 1, 0), dz = num(d[2], -1, 1, 0);
  const len = Math.hypot(dx, dy, dz);
  if (len < .5) return;
  dx /= len; dy /= len; dz /= len;
  if (Math.hypot(ox - p.st[0], oz - p.st[2]) > 6) return;            // ateş noktası oyuncunun yakınında olmalı
  p.shotT = now;
  let tMax = Math.min(PVP.range, wallT(ox, oz, dx, dz));
  for (const c of COVER) {                                            // siperler mermiyi durdurur (4 birim yüksek)
    const t = rayCircle(ox, oz, dx, dz, c[0], c[1], c[2]);
    if (t >= 0 && t < tMax && oy + dy * t <= 4) tMax = t;
  }
  let best = null, bt = tMax, head = false;
  for (const q of players.values()) {
    if (q === p || q.st[6] !== 'pvp' || q.dead) continue;
    const t = rayCircle(ox, oz, dx, dz, q.st[0], q.st[2], PVP.rad);
    if (t < 0 || t >= bt) continue;
    const y = oy + dy * t, y0 = q.st[1];
    if (y < y0 || y > y0 + PVP.h) continue;
    best = q; bt = t; head = y > y0 + 1.5;
  }
  pvpSend({ t: 'sfx', id: p.id, o: [ox, oy, oz].map(v => +v.toFixed(2)), e: [ox + dx * bt, oy + dy * bt, oz + dz * bt].map(v => +v.toFixed(2)) }, p);
  if (!best) return;
  best.hp = Math.max(0, best.hp - (head ? PVP.head : PVP.dmg));
  const killed = best.hp <= 0;
  p.conn.send({ t: 'hm', h: head ? 1 : 0, k: killed ? 1 : 0 });
  best.conn.send({ t: 'hp', hp: best.hp, by: p.name, ms: PVP.respawn });
  if (!killed) return;
  best.dead = now + PVP.respawn;
  pvpSend({ t: 'kf', k: p.name, v: best.name, h: head ? 1 : 0 });
  const last = p.kills.get(best.id) || 0;                             // aynı kişiyi art arda öldürerek altın basmayı engelle
  if (p.acct !== best.acct && now - last > PVP.sameVictimMs) {
    p.kills.set(best.id, now);
    const a = p.acct;
    a.gold += PVP.reward; p.gold = a.gold; p.rewT = now; saveUsers();
    p.conn.send({ t: 'gold', g: a.gold, d: PVP.reward });
    broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  }
  const v = best;
  setTimeout(() => {
    if (players.get(v.id) !== v) return;
    v.hp = PVP.hp; v.dead = 0;
    if (v.st[6] === 'pvp') { const sp = SPAWNS[crypto.randomInt(SPAWNS.length)]; v.conn.send({ t: 'resp', x: sp[0], z: sp[1] }); }
  }, PVP.respawn);
}

function doBet(p, m, now) {
  const a = p.acct, c = p.conn;
  if (p.st[6] !== 'casino') return c.send({ t: 'berr', c: 'zone', gold: a.gold });
  if (now < p.betT) return c.send({ t: 'berr', c: 'fast', gold: a.gold });
  let total = 0, bets = null;
  if (m.g === 'roul') {
    if (!Array.isArray(m.bets) || !m.bets.length || m.bets.length > 24) return;
    bets = [];
    for (const b of m.bets) {
      if (!b || typeof b.k !== 'string' || !BET_KINDS.has(b.k)) return;
      const amt = Math.floor(Number(b.a));
      if (!(amt >= 1 && amt <= MAX_BET)) return;
      const v = b.k === 'n' ? Math.floor(Number(b.v)) : 0;
      if (b.k === 'n' && !(v >= 0 && v <= 36)) return;
      bets.push({ k: b.k, v, a: amt }); total += amt;
    }
    if (total > MAX_TOTAL) return;
  } else if (m.g === 'wof') {
    total = Math.floor(Number(m.a));
    if (!(total >= 1 && total <= MAX_BET)) return;
  } else return;
  if (total > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
  p.betT = now + BET_GAP; p.holdUntil = now + 6000;
  let res;
  if (m.g === 'roul') {
    const n = crypto.randomInt(0, 37);
    let pay = 0; for (const b of bets) pay += roulettePay(b, n);
    a.gold += pay - total; res = { t: 'bres', g: 'roul', n, bet: total, pay, gold: a.gold };
  } else {
    const seg = crypto.randomInt(0, WHEEL.length), mult = WHEEL[seg], pay = Math.floor(total * mult);
    a.gold += pay - total; res = { t: 'bres', g: 'wof', seg, mult, bet: total, pay, gold: a.gold };
  }
  p.gold = a.gold; saveUsers();
  c.send(res);
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  if (res.pay - total >= BIG_WIN) setTimeout(() => broadcast({ t: 'big', n: p.name, w: res.pay - total, g: res.g }), 5200);
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
  if (u === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', ...SEC }); return res.end('ok ' + players.size + (REMOTE ? ' db' : ' dosya')); }
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
  const start = () => server.listen(PORT, HOST, () => {
    log(`BloodBet sunucusu http://localhost:${PORT} adresinde (WebSocket: /ws)`);
    log(REMOTE ? 'Hesaplar: Upstash veritabanı (kalıcı)' : 'Hesaplar: yerel dosya ' + USERS_FILE + ' (barındırma diski kalıcı değilse güncellemede silinir!)');
    if (!process.env.OWNER_CODE) log('OWNER_CODE verilmedi, bu oturum için üretildi:', OWNER_CODE);
    if (!process.env.ADMIN_CODE) log('ADMIN_CODE verilmedi, bu oturum için üretildi:', ADMIN_CODE);
    if (!ALLOWED.length) log('Uyarı: ALLOWED_ORIGINS boş, her siteden bağlanılabilir.');
  });
  if (REMOTE) {            // hesaplar yüklenmeden kimse alınmaz (yoksa var olan isimler yeniden kaydedilebilir)
    (async () => {
      for (let i = 1; ; i++) {
        try { await loadRemote(); return start(); }
        catch (e) {
          log(`veritabanına bağlanılamadı (${i}/5):`, e.message);
          if (i >= 5) { log('UPSTASH_REDIS_REST_URL ve UPSTASH_REDIS_REST_TOKEN değerlerini kontrol et.'); process.exit(1); }
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    })();
  } else start();
  const stop = () => {
    setTimeout(() => process.exit(0), 8000).unref();
    saveUsers(true).finally(() => { for (const c of conns) c.close(1001); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = { server, OWNER_CODE, ADMIN_CODE, players };
