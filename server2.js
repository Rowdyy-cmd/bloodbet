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
const PVP = { cx: 0, cz: 100, half: 20, hp: 100, dmg: 25, head: 50, cd: 190, range: 70, rad: 0.55, h: 1.85, respawn: 3000, reward: 20, sameVictimMs: 60000 };
const COVER = [[-9, 91, 1.1], [9, 91, 1.1], [-9, 109, 1.1], [9, 109, 1.1], [0, 100, 1.5], [-16, 100, 1.0], [16, 100, 1.0], [-15, 88, .9], [15, 88, .9], [-15, 112, .9], [15, 112, .9], [0, 90, .8], [0, 110, .8]];
const SPAWNS = [[-17, 83], [17, 83], [-17, 117], [17, 117], [0, 83], [0, 117]];
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
const WHEEL = [0, .5, 0, 2, 0, .5, 0, 1.5, 0, .5, 0, 3, 0, .5, 0, 2, 0, .5, 0, 1, 0, .5, 0, 9];   // 24 dilim, geri dönüş ≈ %89,6
const BET_KINDS = new Set(['n', 'red', 'black', 'odd', 'even', 'low', 'high', 'd1', 'd2', 'd3', 'c1', 'c2', 'c3']);
const MAX_BET = 1e12, MAX_TOTAL = 1e12, BET_GAP = 3500, BIG_WIN = 3000;     // bahis üst sınırı yok (yalnızca bakiye ve taşma koruması)
const RK = 0.95;                       // rulette ödemelerden %5 kasa payı düşülür (geri dönüş ≈ %92,4)
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
  return Math.floor(w * b.a * RK);
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

/* ---------- banlar (hesap adına göre, kalıcı) ---------- */
const BANS_FILE = path.join(DATA_DIR, 'bans.json');
let bans = {};
try { bans = JSON.parse(fs.readFileSync(BANS_FILE, 'utf8')) || {}; } catch (e) { bans = {}; }
function saveBans() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BANS_FILE, JSON.stringify(bans)); } catch (e) { } }
function banOf(key) {
  const b = bans[key];
  if (!b) return null;
  if (b.until && b.until < Date.now()) { delete bans[key]; saveBans(); return null; }
  return b;
}
function banList() { return Object.keys(bans).filter(k => banOf(k)).map(k => ({ n: bans[k].name || k, by: bans[k].by || '', until: bans[k].until || 0 })).slice(0, 100); }

/* ---------- hesaplar (kalıcı) ---------- */
const PS = v => Math.round(v * 1.5 / 10) * 10;   // istemcideki PS ile aynı: tüm eşya / kasa fiyatları x1,5
const PRICE = new Map([["c1",0],["c2",150],["c3",200],["c4",200],["c5",320],["c6",320],["c7",350],["c8",700],["c9",750],["c10",1400],["o1",0],["o2",180],["o3",380],["o4",750],["o5",1500],["o6",3500],["o7",480],["o8",900],["o9",1600],["o10",4200],["h1",0],["h6",170],["h7",190],["h2",330],["h8",340],["h4",700],["h5",750],["h9",800],["h3",1400],["h10",1650],["d1",0],["d5",180],["d2",330],["d6",350],["d4",720],["d7",700],["d3",1400],["d8",1500],["d9",3200]].map(([k, v]) => [k, PS(v)]));
const DEFAULT_OWNED = ['c1', 'h1', 'o1', 'd1'];
const START_GOLD = +process.env.START_GOLD || 100;   // 1$ = 100 coin, yeni hesaba 1$ değerinde başlangıç
const BUD_RATE = 0.6, BUD_CAP = 6000, BUD_START = 3000;   // sunucunun izin verdiği en hızlı servet artışı (altın/sn, üst sınır)
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
  await loadDepsRemote(); await loadGwRemote();
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
/* ---------- RANK: toplam wager'a (oynanan bahis) göre tier ---------- */
const TIERS = [30000, 80000, 150000, 250000, 400000, 650000, 1000000, 1600000, 2500000, 4000000];   // Tier 1..10 için gereken toplam wager
const tierOf = w => { let t = 0; while (t < TIERS.length && w >= TIERS[t]) t++; return t; };
const RB_RATES = [0.05, 0.052, 0.054, 0.056, 0.058, 0.06, 0.062, 0.064, 0.066, 0.068, 0.07];   // rank (-,I..X) -> kasa avantajından geri dönen pay
const EDGE = { roul: 0.076, mines: 0.05, wof: 0.104, bj: 0.02 };                                    // oyun başına kasa avantajı
// Haftalık bonus her pazartesi 06:00'da (TSİ), aylık bonus her ayın 1'inde 00:00'da (TSİ) yenilenir
const BTZ = +process.env.DAY_TZ_H || 3, WK_HOUR = 6;
const wkIdx = t => Math.floor(((t + (BTZ - WK_HOUR) * 36e5) / 864e5 + 3) / 7);                     // 1970-01-01 perşembe -> pazartesi tabanlı hafta no
const wkNext = t => ((wkIdx(t) + 1) * 7 - 3) * 864e5 - (BTZ - WK_HOUR) * 36e5;
const moIdx = t => { const d = new Date(t + BTZ * 36e5); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const moNext = t => { const d = new Date(t + BTZ * 36e5); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - BTZ * 36e5; };
const WK_PCT = 0.0005, MO_PCT = 0.001, AFF_PCT = 0.03;
function wagerAdd(a, n, g) {
  if (!(n > 0)) return;
  const old = a.wag || 0, nw = old + n, now = Date.now();
  a.wag = nw;
  a.rb = (a.rb || 0) + n * (EDGE[g] || 0.05) * RB_RATES[tierOf(nw)];
  a.wkW = (a.wkW || 0) + n; a.moW = (a.moW || 0) + n;
  const q = onlineAcct(a);
  if (q) q.conn.send({ t: 'wag', w: nw, tier: tierOf(nw), up: tierOf(nw) > tierOf(old) ? 1 : 0 });
  if (q && tierOf(nw) > tierOf(old)) broadcast({ t: 'rank', id: q.id, tr: tierOf(nw) }, q.id);
}
function rwInfo(a) {
  const now = Date.now(), tier = tierOf(a.wag || 0), key = a.name.toLowerCase();
  const per = (w, pct) => Math.floor((w || 0) * pct * (1 + 0.1 * tier));
  let n = 0; for (const u of Object.values(users)) if (u.ref === key) n++;
  return { t: 'rw', a: 'info', tier, wag: a.wag || 0, rates: RB_RATES.map(r => +(r * 100).toFixed(1)), rb: Math.floor(a.rb || 0), rbTot: a.rbTot || 0,
    wk: { amt: per(a.wkW, WK_PCT), left: a.wkP === wkIdx(now) ? Math.max(1, wkNext(now) - now) : 0, w: Math.floor(a.wkW || 0) },
    mo: { amt: per(a.moW, MO_PCT), left: a.moP === moIdx(now) ? Math.max(1, moNext(now) - now) : 0, w: Math.floor(a.moW || 0) },
    aff: { code: a.name, ref: a.ref && users[a.ref] ? users[a.ref].name : '', n, earned: a.affEarn || 0, pct: AFF_PCT * 100 } };
}
function rwMsg(p, m, now) {
  const a = p.acct, c = p.conn, act = String(m.a || ''), key = a.name.toLowerCase();
  const err = code => c.send({ t: 'rw', a: 'err', c: code });
  if (now - (p.rwT || 0) < 500) return; p.rwT = now;
  if (act === 'info') return c.send(rwInfo(a));
  if (act === 'ref') {
    const tk = String(m.code || '').trim().toLowerCase(), t = users[tk];
    if (!t) return err('none'); if (tk === key) return err('self'); if (a.ref) return err('has');
    if ((a.depC || 0) > 0 || t.ref === key) return err('late');
    a.ref = tk; saveUsers(); return c.send(rwInfo(a));
  }
  if (act === 'claim') {
    const info = rwInfo(a); let n = 0, k = String(m.k || '');
    if (k === 'rb') { n = Math.floor(a.rb || 0); if (n < 1) return err('min'); a.rb -= n; a.rbTot = (a.rbTot || 0) + n; }
    else if (k === 'wk') { if (info.wk.left > 0) return err('wait'); n = info.wk.amt; if (n < 1) return err('min'); a.wkW = 0; a.wkP = wkIdx(now); }
    else if (k === 'mo') { if (info.mo.left > 0) return err('wait'); n = info.mo.amt; if (n < 1) return err('min'); a.moW = 0; a.moP = moIdx(now); }
    else return;
    a.gold += n; p.gold = a.gold; saveUsers();
    pfSync(p, { m: 'rw', n, k });
    broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
    log('ödül', a.name, k, '+' + n);
    return c.send(rwInfo(a));
  }
}
const pubPf = a => ({ gold: a.gold, owned: a.owned, eq: a.eq, wag: a.wag || 0 });
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
  if (banOf(key)) return c.send({ t: 'autherr', c: 'banned' });
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
  if (now < (p.pfLock || 0)) return;
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

const info = p => ({ id: p.id, name: p.name, eq: p.eq, gold: p.gold, role: p.role, tr: tierOf(p.acct.wag || 0), m: p.muted ? 1 : 0, st: p.st });

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
    hp: PVP.hp, dead: 0, shotT: 0, kills: new Map(), betT: 0, holdUntil: 0, rewT: 0, rtcN: 0, rtcT: Date.now(), bj: null, mn: null
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
      const prevZone = p.st[6];
      p.st = [
        num(a[0], -130, 130, 0), num(a[1], 0, 12, 0), num(a[2], -130, 130, 0), num(a[3], -10, 10, 0),
        STATES.has(a[4]) ? a[4] : 'idle', typeof a[5] === 'string' && ID_RE.test(a[5]) ? a[5] : p.eq.d,
        ZONES.has(a[6]) ? a[6] : 'lobby', a[7] ? 1 : 0
      ];
      p.dirty = true;
      if (prevZone !== 'casino' && p.st[6] === 'casino') p.conn.send({ t: 'tbls', tb: tblSnap(), rr: rrView() });
      else if (prevZone === 'casino' && p.st[6] !== 'casino') { tblLeave(p); if (RR.ph === 'bet') { RR.bets.delete(p.id); rrInfo(now); } }
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
    case 'tb': return tblMsg(p, m, now);
    case 'rb': return rrBets(p, m, now);
    case 'tip': return doTip(p, m, now);
    case 'dep': return depMsg(p, m, now);
    case 'rw': return rwMsg(p, m, now);
    case 'rng': return rngMsg(p, m, now);
    case 'gw': return gwMsg(p, m, now);
    case 'tr': return trMsg(p, m, now);
    case 'bj': return bjAct(p, m, now);
    case 'mn': return mnAct(p, m, now);
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

/* ---------- blackjack (sunucu hakemlidir) ---------- */
// kurallar: sonsuz deste · kasa yumuşak 17'de çeker · blackjack 3:2 · bölme / sigorta yok · iki katlama ilk iki kartta serbest
const BJ_GAP = 1800, MN_GAP = 1500;
const bjDraw = () => crypto.randomInt(52);
function bjVal(cs) {
  let t = 0, a = 0;
  for (const c of cs) { const r = c % 13; if (r === 0) { a++; t += 11; } else t += r >= 9 ? 10 : r + 1; }
  while (t > 21 && a) { t -= 10; a--; }
  return { v: t, soft: a > 0 };
}
/* ---------- canlı masa izleme (diğer oyuncular dışarıdan görür) ---------- */
// Sunucu hakemdir; izleyicilere sadece herkese açık bilgi gider (altın yok, kasanın kapalı kartı yok, mayın yerleri oyun bitene kadar yok).
const TB_G = new Set(['roul', 'wof', 'bj', 'mines']);
const TBL = { roul: null, wof: null, bj: null, mines: null };   // masa -> { id, n, v }
function casinoCast(obj, exceptId) {
  const fr = frame(1, Buffer.from(JSON.stringify(obj)));
  for (const q of players.values()) if (q.id !== exceptId && q.st[6] === 'casino') q.conn.sendFrame(fr);
}
function tblSnap() {
  const o = {};
  for (const g of TB_G) o[g] = TBL[g] ? { id: TBL[g].id, n: TBL[g].n, v: TBL[g].v } : null;
  return o;
}
function tblPub(v) {
  const w = Object.assign({}, v);
  delete w.gold; delete w.t; delete w.dbl;
  return w;
}
function tblSet(p, g, v) {
  if (!TB_G.has(g)) return;
  p.tbg = g;
  TBL[g] = { id: p.id, n: p.name, v: tblPub(v) };
  casinoCast({ t: 'tbl', g, id: p.id, n: p.name, o: 1, v: TBL[g].v }, p.id);
}
function tblLeave(p) {
  const g = p.tbg;
  if (!g) return;
  p.tbg = null;
  if (!TBL[g] || TBL[g].id !== p.id) return;
  let next = null;                                   // aynı masada oynayan başka biri varsa onu öne çıkar
  for (const q of players.values()) if (q !== p && q.tbg === g && q.st[6] === 'casino' && q.tbv) next = q;
  if (next) { TBL[g] = { id: next.id, n: next.name, v: next.tbv }; casinoCast({ t: 'tbl', g, id: next.id, n: next.name, o: 1, v: next.tbv }); }
  else { TBL[g] = null; casinoCast({ t: 'tbl', g, id: p.id, o: 0 }); }
}
function tblMsg(p, m, now) {                          // istemci: masaya oturdu / kalktı / bahis fişlerini değiştirdi
  if (p.st[6] !== 'casino' || !TB_G.has(m.g) || m.g === 'roul') return;
  const tok = Math.min(10, (p.tbTok == null ? 10 : p.tbTok) + (now - (p.tbT || now)) / 150);   // saniyede ~6 mesaj, 10'luk patlama
  if (tok < 1) return;
  p.tbTok = tok - 1; p.tbT = now;
  if (!m.o) { if (p.tbg === m.g) tblLeave(p); return; }
  if (p.tbg && p.tbg !== m.g) tblLeave(p);
  let v = {};
  if (m.g === 'roul') {
    const bets = [];
    if (Array.isArray(m.bets)) for (const b of m.bets.slice(0, 24)) {
      if (!b || typeof b.k !== 'string' || !BET_KINDS.has(b.k)) continue;
      const a = Math.floor(Number(b.a)), vv = b.k === 'n' ? Math.floor(Number(b.v)) : 0;
      if (!(a >= 1 && a <= MAX_BET) || (b.k === 'n' && !(vv >= 0 && vv <= 36))) continue;
      bets.push({ k: b.k, v: vv, a });
    }
    v = { bets };
  } else if (m.g === 'wof') {
    const a = Math.floor(Number(m.a));
    v = { a: a >= 1 && a <= MAX_BET ? a : 0 };
  } else if (TBL[m.g] && TBL[m.g].id === p.id) return;   // bj / mines: durumu zaten sunucu gönderiyor
  p.tbg = m.g; p.tbv = v;
  tblSet(p, m.g, v);
}
function tx(p, o) {                                   // oyuncuya gönder + masa izleyicilerine yayınla
  p.conn.send(o);
  if (o && o.t === 'bjs') { p.tbv = tblPub(o); tblSet(p, 'bj', o); }
  else if (o && o.t === 'mns') { p.tbv = tblPub(o); tblSet(p, 'mines', o); }
  return o;
}

function bjView(h, res, pay, gold) {
  const over = !!res;
  return { t: 'bjs', st: over ? 'done' : 'play', p: h.p.slice(), d: over ? h.d.slice() : [h.d[0]], res: res || '', bet: h.bet, pay: pay || 0, gold, dbl: !over && h.p.length === 2 && !h.dd };
}
function bjFinish(p, now, res, pay) {
  const h = p.bj, a = p.acct;
  a.gold += pay; p.gold = a.gold; p.rewT = now; p.holdUntil = now + 3000; p.bj = null; saveUsers();
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  if (pay - h.bet >= BIG_WIN) setTimeout(() => broadcast({ t: 'big', n: p.name, w: pay - h.bet, g: 'bj' }), 1200);
  return bjView(h, res, pay, a.gold);
}
function bjStand(p, now) {
  const h = p.bj, pv = bjVal(h.p).v;
  for (; ;) { const dv = bjVal(h.d); if (dv.v < 17 || (dv.v === 17 && dv.soft)) h.d.push(bjDraw()); else break; }
  const dv = bjVal(h.d).v;
  if (dv > 21) return bjFinish(p, now, 'dbust', h.bet * 2);
  if (pv > dv) return bjFinish(p, now, 'win', h.bet * 2);
  if (pv < dv) return bjFinish(p, now, 'lose', 0);
  return bjFinish(p, now, 'push', h.bet);
}
function bjStart(p, m, now) {
  const a = p.acct, c = p.conn, bet = Math.floor(Number(m.a));
  if (!(bet >= 1 && bet <= MAX_BET)) return;
  if (bet > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
  p.betT = now + BJ_GAP; p.holdUntil = now + 8000;
  a.gold -= bet; p.gold = a.gold; wagerAdd(a, bet, 'bj');
  const h = { bet, p: [bjDraw(), bjDraw()], d: [bjDraw(), bjDraw()], dd: false };
  p.bj = h; saveUsers();
  const pn = bjVal(h.p).v === 21, dn = bjVal(h.d).v === 21;
  if (pn && dn) return tx(p, bjFinish(p, now, 'push', bet));
  if (pn) return tx(p, bjFinish(p, now, 'bj', Math.floor(bet * 2.5)));
  if (dn) return tx(p, bjFinish(p, now, 'lose', 0));
  tx(p, bjView(h, '', 0, a.gold));
}
function bjAct(p, m, now) {
  const h = p.bj, c = p.conn, a = p.acct;
  if (!h) return c.send({ t: 'berr', c: 'nogame', gold: a.gold });
  p.holdUntil = now + 8000;
  const act = m.a;
  if (act === 'hit') {
    h.p.push(bjDraw()); const v = bjVal(h.p).v;
    if (v > 21) return tx(p, bjFinish(p, now, 'bust', 0));
    if (v === 21) return tx(p, bjStand(p, now));
    return tx(p, bjView(h, '', 0, a.gold));
  }
  if (act === 'double') {
    if (h.p.length !== 2 || h.dd) return;
    if (h.bet > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
    a.gold -= h.bet; p.gold = a.gold; wagerAdd(a, h.bet, 'bj'); h.bet *= 2; h.dd = true; h.p.push(bjDraw());
    if (bjVal(h.p).v > 21) return tx(p, bjFinish(p, now, 'bust', 0));
    return tx(p, bjStand(p, now));
  }
  if (act === 'stand') return tx(p, bjStand(p, now));
}

/* ---------- mines (sunucu hakemlidir) ---------- */
// 5x5 tahta · her güvenli karede çarpan artar · %5 kasa payı · en fazla x100
const MN_RTP = 0.95, MN_CAP = 100, MN_N = 25;
function mnMult(m, k) {
  if (k <= 0) return 1;
  let x = MN_RTP;
  for (let i = 0; i < k; i++) x *= (MN_N - i) / (MN_N - m - i);
  return Math.min(MN_CAP, Math.floor(x * 100) / 100);
}
function mnView(g, st, hit, pay, gold) {
  const k = g.rev.length;
  return { t: 'mns', st, m: g.m, bet: g.bet, rev: g.rev.slice(), mult: mnMult(g.m, k), next: st === 'play' ? mnMult(g.m, k + 1) : 0, hit: hit == null ? -1 : hit, mines: st === 'play' ? [] : [...g.mines], pay: pay || 0, gold };
}
function mnFinish(p, now, st, hit) {
  const g = p.mn, a = p.acct;
  const pay = st === 'cash' ? Math.floor(g.bet * mnMult(g.m, g.rev.length)) : 0;
  a.gold += pay; p.gold = a.gold; p.rewT = now; p.holdUntil = now + 3000; p.mn = null; saveUsers();
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  if (pay - g.bet >= BIG_WIN) setTimeout(() => broadcast({ t: 'big', n: p.name, w: pay - g.bet, g: 'mines' }), 1200);
  return mnView(g, st, hit, pay, a.gold);
}
function mnStart(p, m, now) {
  const a = p.acct, c = p.conn, bet = Math.floor(Number(m.a)), mc = Math.floor(Number(m.m));
  if (!(bet >= 1 && bet <= MAX_BET) || !(mc >= 1 && mc <= 24)) return;
  if (bet > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
  p.betT = now + MN_GAP; p.holdUntil = now + 8000;
  a.gold -= bet; p.gold = a.gold; wagerAdd(a, bet, 'mines');
  const idx = []; for (let i = 0; i < MN_N; i++) idx.push(i);
  for (let i = MN_N - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  p.mn = { bet, m: mc, mines: new Set(idx.slice(0, mc)), rev: [] };
  saveUsers();
  tx(p, mnView(p.mn, 'play', null, 0, a.gold));
}
function mnAct(p, m, now) {
  const g = p.mn, c = p.conn, a = p.acct;
  if (!g) return c.send({ t: 'berr', c: 'nogame', gold: a.gold });
  p.holdUntil = now + 8000;
  if (m.a === 'cash') { if (!g.rev.length) return; return tx(p, mnFinish(p, now, 'cash')); }
  if (m.a !== 'pick') return;
  const i = Math.floor(Number(m.i));
  if (!(i >= 0 && i < MN_N) || g.rev.includes(i)) return;
  if (g.mines.has(i)) return tx(p, mnFinish(p, now, 'lost', i));
  g.rev.push(i);
  if (g.rev.length >= MN_N - g.m || mnMult(g.m, g.rev.length) >= MN_CAP) return tx(p, mnFinish(p, now, 'cash'));
  tx(p, mnView(g, 'play', null, 0, a.gold));
}
function gamesAbort(p) {            // oyuncu bağlantısı koptuysa açık eller sonuçlanır
  const now = Date.now();
  try {
    if (p.bj) bjStand(p, now);
    if (p.mn) { if (p.mn.rev.length) mnFinish(p, now, 'cash'); else { p.acct.gold += p.mn.bet; p.gold = p.acct.gold; p.mn = null; saveUsers(); } }
  } catch (e) { }
}

function doBet(p, m, now) {
  const a = p.acct, c = p.conn;
  if (p.st[6] !== 'casino') return c.send({ t: 'berr', c: 'zone', gold: a.gold });
  if (now < p.betT) return c.send({ t: 'berr', c: 'fast', gold: a.gold });
  if (p.bj || p.mn) return c.send({ t: 'berr', c: 'busy', gold: a.gold });
  if (m.g === 'roul') return c.send({ t: 'berr', c: 'round', gold: a.gold });
  if (m.g === 'bj') return bjStart(p, m, now);
  if (m.g === 'mines') return mnStart(p, m, now);
  let total = 0, bets = null;
  if (m.g === 'roul') {
    if (!Array.isArray(m.bets) || !m.bets.length || m.bets.length > 64) return;
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
  wagerAdd(a, total, 'wof');
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
  if (m.g === 'roul') { const v = { bets, num: res.n, bet: res.bet, pay: res.pay }; p.tbv = { bets }; tblSet(p, 'roul', v); }
  else { const v = { a: total, seg: res.seg, mult: res.mult, bet: res.bet, pay: res.pay }; p.tbv = { a: total }; tblSet(p, 'wof', v); }
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  if (res.pay - total >= BIG_WIN) setTimeout(() => broadcast({ t: 'big', n: p.name, w: res.pay - total, g: res.g }), 5200);
}

/* ---------- ORTAK RULET: herkes aynı tura bahis koyar, süre bitince tek çark döner ---------- */
const RR_BET = +process.env.RR_BET_MS || 25000, RR_SPIN = 5300;
const RR = { ph: 'bet', end: Date.now() + RR_BET, id: 1, n: null, hist: [], bets: new Map(), infoT: 0 };
function rrPl() {
  const l = [];
  for (const e of RR.bets.values()) l.push([e.p.name, e.total]);
  l.sort((a, b) => b[1] - a[1]);
  return l.slice(0, 6);
}
function rrView() { return { t: 'rr', ph: RR.ph, left: Math.max(0, RR.end - Date.now()), id: RR.id, n: RR.ph === 'spin' ? RR.n : null, hist: RR.hist.slice(0, 12), pl: rrPl(), cnt: RR.bets.size }; }
function rrCast() { casinoCast(rrView()); }
function rrInfo(now) { if (now - RR.infoT < 400) { if (!RR.infoQ) { RR.infoQ = setTimeout(() => { RR.infoQ = 0; RR.infoT = Date.now(); rrCast(); }, 450); } return; } RR.infoT = now; rrCast(); }
function rrBets(p, m, now) {
  if (p.st[6] !== 'casino' || RR.ph !== 'bet') return p.conn.send({ t: 'berr', c: 'closed', gold: p.acct.gold });
  const tok = Math.min(10, (p.rbTok == null ? 10 : p.rbTok) + (now - (p.rbT || now)) / 150);
  if (tok < 1) return;
  p.rbTok = tok - 1; p.rbT = now;
  if (!Array.isArray(m.bets) || m.bets.length > 64) return;
  const bets = []; let total = 0;
  for (const b of m.bets) {
    if (!b || typeof b.k !== 'string' || !BET_KINDS.has(b.k)) return;
    const amt = Math.floor(Number(b.a));
    if (!(amt >= 1 && amt <= MAX_BET)) return;
    const v = b.k === 'n' ? Math.floor(Number(b.v)) : 0;
    if (b.k === 'n' && !(v >= 0 && v <= 36)) return;
    bets.push({ k: b.k, v, a: amt }); total += amt;
  }
  if (total > MAX_TOTAL) return;
  if (total > p.acct.gold) return p.conn.send({ t: 'berr', c: 'poor', gold: p.acct.gold });
  if (!bets.length) RR.bets.delete(p.id); else RR.bets.set(p.id, { p, acct: p.acct, bets, total, void: false });
  rrInfo(now);
}
function rrLock(now) {
  const n = crypto.randomInt(0, 37);
  RR.n = n; RR.ph = 'spin'; RR.end = now + RR_SPIN;
  for (const e of RR.bets.values()) {
    if (e.total > e.acct.gold) { e.void = true; if (players.get(e.p.id) === e.p) e.p.conn.send({ t: 'rl', v: 1, gold: e.acct.gold }); continue; }
    e.acct.gold -= e.total; wagerAdd(e.acct, e.total, 'roul'); e.p.gold = e.acct.gold; e.p.holdUntil = now + RR_SPIN + 3000; e.p.pfLock = now + RR_SPIN + 3000;
    if (players.get(e.p.id) === e.p) e.p.conn.send({ t: 'rl', v: 0, bet: e.total, gold: e.acct.gold });
  }
  saveUsers();
  rrCast();
}
function rrSettle(now) {
  const n = RR.n;
  for (const e of RR.bets.values()) {
    if (e.void) continue;
    let pay = 0; for (const b of e.bets) pay += roulettePay(b, n);
    e.acct.gold += pay; e.p.gold = e.acct.gold; e.p.rewT = now; e.p.holdUntil = 0;
    if (players.get(e.p.id) === e.p) e.p.conn.send({ t: 'rres', n, bet: e.total, pay, gold: e.acct.gold });
    broadcast({ t: 'me', id: e.p.id, eq: e.p.eq, gold: e.p.gold }, e.p.id);
    if (pay - e.total >= BIG_WIN) broadcast({ t: 'big', n: e.p.name, w: pay - e.total, g: 'roul' });
  }
  saveUsers();
  RR.hist.unshift(n); RR.hist = RR.hist.slice(0, 12);
  RR.bets.clear(); RR.id++; RR.ph = 'bet'; RR.end = now + RR_BET; RR.n = null;
  rrCast();
}
setInterval(() => { const now = Date.now(); if (now < RR.end) return; if (RR.ph === 'bet') rrLock(now); else rrSettle(now); }, 250);

/* ---------- COIN SATIN ALMA (elle onaylı kripto) ----------
 * 1$ = 100 coin · her yatırımdan %2 komisyon · çekim YOK, coin gerçek para değildir.
 * Cüzdan adresleri: data/wallets.json  ya da  PAY_WALLETS ortam değişkeni (JSON).
 *   {"USDT":{"net":"TRC20","addr":"T..."},"BTC":{"net":"Bitcoin","addr":"bc1..."}, ...}
 * Akış: oyuncu tutar+coin seçer (open) -> adrese gönderir, işlem numarasını (TXID) yazar (paid) -> owner kontrol edip onaylar (ok) -> coin yatar.
 */
const COIN_RATE = 100, DEP_FEE = 0.02, DEP_MIN_C = +process.env.DEP_MIN_USD * 100 || 200, DEP_MAX_C = +process.env.DEP_MAX_USD * 100 || 50000, DEP_DAY_C = +process.env.DEP_DAY_USD * 100 || 100000;
const CRYPTOS = [['TRX', 'TRON', 'TRON'], ['BTC', 'Bitcoin', 'Bitcoin'], ['ETH', 'Ethereum', 'ERC20'], ['BNB', 'BNB', 'BEP20'], ['USDT', 'Tether', 'ERC20'], ['LTC', 'Litecoin', 'Litecoin'], ['SOL', 'Solana', 'Solana'], ['XRP', 'XRP', 'XRP Ledger'], ['DOGE', 'Dogecoin', 'Dogecoin']];
let WALLETS = {                      // varsayılan cüzdanlar (data/wallets.json ve PAY_WALLETS bunların üstüne yazar)
  TRX: { net: 'TRC20', addr: 'TVfEF8C74tL7DKqZxSTHjzqdrqS2Aumg9H' },
  BTC: { net: 'Bitcoin', addr: 'bc1q6nkysggv7zpaz0p7fydwdagu8kens29h9uagkj' },
  ETH: { net: 'ERC20', addr: '0x38a1B80E71BCB6860D5A3A355399A2935364051E' },
  USDT: { net: 'ERC20', addr: '0x38a1B80E71BCB6860D5A3A355399A2935364051E' },
  BNB: { net: 'BEP20', addr: '0x38a1B80E71BCB6860D5A3A355399A2935364051E' },
  LTC: { net: 'Litecoin', addr: 'LWwse7f2Jre7XKwfhAhc2wukipSS6XvfGs' },
  SOL: { net: 'Solana', addr: 'ANx1Ev78FNm9kki9djJdadRV4UeoSSun28pT2ShpWD5q' },
  XRP: { net: 'XRP Ledger', addr: 'ryNawmBuHPMgkzovV829J2XNMGKmVQjio' },
  DOGE: { net: 'Dogecoin', addr: 'DM6n14EQGenypfgEPzh4vwzacqt8WxMtib' }
};
try { Object.assign(WALLETS, JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'wallets.json'), 'utf8')) || {}); } catch (e) { }
try { const j = JSON.parse(process.env.PAY_WALLETS || 'null'); if (j && typeof j === 'object') WALLETS = Object.assign(WALLETS, j); } catch (e) { }
const deps = Object.create(null);
const DEPS_FILE = path.join(DATA_DIR, 'deposits.json');
try { Object.assign(deps, JSON.parse(fs.readFileSync(DEPS_FILE, 'utf8')) || {}); } catch (e) { }
function depSave(d) {
  if (REMOTE) { redis(['HSET', 'bloodbet:deps', d.id, JSON.stringify(d)]).catch(e => log('dep kayıt hatası:', e.message)); return; }
  try { const tmp = DEPS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(deps)); fs.renameSync(tmp, DEPS_FILE); } catch (e) { log('dep kayıt hatası:', e.message); }
}
async function loadDepsRemote() {
  const res = (await redis(['HGETALL', 'bloodbet:deps'])) || [];
  for (let i = 0; i + 1 < res.length; i += 2) { try { deps[res[i]] = JSON.parse(res[i + 1]); } catch (e) { } }
}
const depCoinsOf = usdC => Math.floor(usdC * (1 - DEP_FEE));            // 1 cent = 1 coin
const depView = (d, full) => Object.assign({ id: d.id, coin: d.coin, net: d.net, addr: d.addr, usdC: d.usdC, coins: d.coins, fee: d.usdC - d.coins, st: d.st, at: d.at, txid: d.txid || '' }, full ? { name: d.name } : {});
const depOList = () => Object.values(deps).filter(x => x.st === 'paid' || x.st === 'open').sort((x, y) => x.at - y.at).map(x => depView(x, true));
const ownersCast = obj => { for (const q of players.values()) if (q.role === 'owner') q.conn.send(obj); };
const onlineAcct = a => { for (const q of players.values()) if (q.acct === a) return q; return null; };
function depMsg(p, m, now) {
  const a = p.acct, key = a.name.toLowerCase(), c = p.conn, act = String(m.a || '');
  const err = code => c.send({ t: 'dep', a: 'err', c: code });
  if (now - (p.depT || 0) < 600) return;
  p.depT = now;
  const mine = () => Object.values(deps).filter(d => d.key === key).sort((x, y) => y.at - x.at).slice(0, 12).map(d => depView(d));
  if (act === 'info') {
    return c.send({ t: 'dep', a: 'info', rate: COIN_RATE, fee: DEP_FEE * 100, min: DEP_MIN_C / 100, max: DEP_MAX_C / 100,
      coins: CRYPTOS.map(([id, name, net]) => ({ id, name, net: (WALLETS[id] && WALLETS[id].net) || net, on: !!(WALLETS[id] && WALLETS[id].addr) })), list: mine() });
  }
  if (act === 'req') {
    if (!m.age) return err('age');
    const cr = CRYPTOS.find(x => x[0] === m.coin), w = cr && WALLETS[cr[0]];
    if (!cr || !w || !w.addr) return err('coin');
    const usdC = Math.round(Number(m.usd) * 100);
    if (!(usdC >= DEP_MIN_C && usdC <= DEP_MAX_C)) return err('amt');
    const open = Object.values(deps).filter(d => d.key === key && (d.st === 'open' || d.st === 'paid'));
    if (open.length >= 3) return err('many');
    const day = Object.values(deps).filter(d => d.key === key && d.st !== 'no' && d.st !== 'cx' && now - d.at < 864e5).reduce((t, d) => t + d.usdC, 0);
    if (day + usdC > DEP_DAY_C) return err('day');
    const d = { id: 'd' + now.toString(36) + crypto.randomBytes(3).toString('hex'), key, name: a.name, usdC, coins: depCoinsOf(usdC), coin: cr[0], net: w.net || cr[2], addr: String(w.addr), st: 'open', at: now };
    deps[d.id] = d; depSave(d);
    ownersCast({ t: 'dep', a: 'new', d: depView(d, true) });
    log('yatırım talebi açıldı', a.name, '$' + usdC / 100, cr[0], d.id);
    return c.send({ t: 'dep', a: 'made', d: depView(d), list: mine() });
  }
  const d = deps[String(m.id || '')];
  if (act === 'paid' || act === 'cx') {
    if (!d || d.key !== key) return err('none');
    if (act === 'cx') { if (d.st !== 'open' && d.st !== 'paid') return err('state'); d.st = 'cx'; d.upd = now; depSave(d); ownersCast({ t: 'dep', a: 'olist', list: depOList() }); return c.send({ t: 'dep', a: 'mine', list: mine() }); }
    if (d.st !== 'open') return err('state');
    const txid = String(m.txid || '').trim().replace(/\s+/g, '').slice(0, 120);
    if (!/^[A-Za-z0-9:_\-.]{12,120}$/.test(txid)) return err('txid');
    const low = txid.toLowerCase();
    if (Object.values(deps).some(x => x.txid && x.txid.toLowerCase() === low && x.st !== 'no' && x.st !== 'cx')) return err('dup');
    d.txid = txid; d.st = 'paid'; d.upd = now; depSave(d);
    ownersCast({ t: 'dep', a: 'new', d: depView(d, true) });
    log('ödeme bildirildi', a.name, '$' + d.usdC / 100, d.coin, d.txid);
    return c.send({ t: 'dep', a: 'mine', list: mine() });
  }
  // --- sadece owner ---
  if (p.role !== 'owner') return err('perm');
  if (act === 'olist') return c.send({ t: 'dep', a: 'olist', list: depOList() });
  if (act === 'ok' || act === 'no') {
    if (!d || (act === 'ok' ? d.st !== 'paid' : (d.st !== 'paid' && d.st !== 'open'))) return err('state');
    if (act === 'no') { d.st = 'no'; d.upd = now; d.by = p.name; depSave(d); log('yatırım reddedildi', d.name, d.id); }
    else {
      const t = users[d.key]; if (!t) return err('none');
      d.st = 'ok'; d.upd = now; d.by = p.name; depSave(d);       // önce durumu kaydet: iki kez yatmasın
      t.gold += d.coins; t.depC = (t.depC || 0) + d.usdC;
      const rf = t.ref && users[t.ref];
      if (rf) { const com = Math.floor(d.coins * AFF_PCT); if (com > 0) { rf.gold += com; rf.affEarn = (rf.affEarn || 0) + com; const rq = onlineAcct(rf); if (rq) { rq.gold = rf.gold; pfSync(rq, { m: 'aff', n: com, who: t.name }); } } }
      saveUsers(true);
      const q = onlineAcct(t);
      if (q) { q.gold = t.gold; pfSync(q, { m: 'depok', n: d.coins }); broadcast({ t: 'me', id: q.id, eq: q.eq, gold: q.gold }, q.id); }
      log('yatırım onaylandı', d.name, '+' + d.coins, 'coin ($' + d.usdC / 100 + ') by', p.name);
    }
    const q2 = onlineAcct(users[d.key] || {}); if (q2) q2.conn.send({ t: 'dep', a: 'mine', list: Object.values(deps).filter(x => x.key === d.key).sort((x, y) => y.at - x.at).slice(0, 12).map(x => depView(x)) });
    return ownersCast({ t: 'dep', a: 'olist', list: depOList() });
  }
}

/* ---------- HEDEF POLİGONU: günde 1 kez, skora göre coin ---------- */
const RNG_TZ = +process.env.DAY_TZ_H || 3, RNG_MAX = +process.env.RNG_MAX_SCORE || 800;     // gün sıfırlaması: UTC+3 gece yarısı
const dayKeyOf = t => new Date(t + RNG_TZ * 36e5).toISOString().slice(0, 10);
const dayLeft = t => 864e5 - ((t + RNG_TZ * 36e5) % 864e5);
const rngReward = sc => sc >= 150 ? 100 : sc >= 100 ? 50 : 20;
function rngMsg(p, m, now) {
  const a = p.acct, c = p.conn, act = String(m.a || '');
  if (now - (p.rngT || 0) < 400) return; p.rngT = now;
  const day = dayKeyOf(now);
  if (act === 'start') {
    if (a.rngDay === day) return c.send({ t: 'rng', a: 'no', left: dayLeft(now) });
    a.rngDay = day; a.rngOn = now; saveUsers();                    // hak başta düşer: yenileyerek tekrar denenemez
    return c.send({ t: 'rng', a: 'go' });
  }
  if (act === 'end') {
    if (!a.rngOn) return;
    const el = now - a.rngOn, sc = Math.floor(Number(m.s)); a.rngOn = 0;
    if (!(sc >= 0 && sc <= RNG_MAX) || el < 25000 || el > 180000) return c.send({ t: 'rng', a: 'bad' });
    const g = rngReward(sc); a.gold += g; p.gold = a.gold; saveUsers();
    pfSync(p, { m: 'rng', n: g, s: sc });
    broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  }
}

/* ---------- GIVEAWAY (sürpriz kutusu): ücretsiz katılım, ödül host'un coini ----------
 * Herkes başlatabilir: ödül başlatırken host'un bakiyesinden düşer (owner için coin bedava). Süre, kazanan sayısı ve minimum tier ayarlanır.
 * Süre dolunca kazananlar sunucu tarafından rastgele seçilir; ödül eşit bölünür, artan/katılımcısız kısım host'a iade edilir.
 */
const GW_MAX_ACTIVE = 8, GW_MIN_S = +process.env.GW_MIN_S || 30, GW_MAX_S = 7 * 86400, GW_MAX_WIN = 50;
const gws = Object.create(null), GW_FILE = path.join(DATA_DIR, 'giveaways.json');
try { Object.assign(gws, JSON.parse(fs.readFileSync(GW_FILE, 'utf8')) || {}); } catch (e) { }
function gwSave() {
  if (REMOTE) { redis(['SET', 'bloodbet:gws', JSON.stringify(gws)]).catch(e => log('giveaway kayıt hatası:', e.message)); return; }
  try { const tmp = GW_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(gws)); fs.renameSync(tmp, GW_FILE); } catch (e) { log('giveaway kayıt hatası:', e.message); }
}
async function loadGwRemote() { const r = await redis(['GET', 'bloodbet:gws']); if (r) { try { Object.assign(gws, JSON.parse(r)); } catch (e) { } } }
const gwView = (g, key) => ({ id: g.id, host: g.hostName, prize: g.prize, win: g.win, tier: g.tier, left: Math.max(0, g.end - Date.now()), tot: Math.max(1, g.end - (g.at || g.end)), n: g.ent.length, me: key && g.ent.includes(key) ? 1 : 0, mine: key === g.hk ? 1 : 0, own: g.own ? 1 : 0 });
const gwList = key => Object.values(gws).sort((x, y) => x.end - y.end).map(g => gwView(g, key));
function gwCredit(key, n, msg) {
  const a = users[key]; if (!a || !(n > 0)) return;
  a.gold += n; const q = onlineAcct(a);
  if (q) { q.gold = a.gold; pfSync(q, msg); broadcast({ t: 'me', id: q.id, eq: q.eq, gold: q.gold }, q.id); }
}
function gwMsg(p, m, now) {
  const a = p.acct, c = p.conn, act = String(m.a || ''), key = a.name.toLowerCase();
  const err = code => c.send({ t: 'gw', a: 'err', c: code });
  if (now - (p.gwT || 0) < 500) return; p.gwT = now;
  if (act === 'list') return c.send({ t: 'gw', a: 'list', list: gwList(key), bal: a.gold });
  if (act === 'new') {
    const prize = Math.floor(Number(m.prize)), win = Math.floor(Number(m.win)), secs = Math.floor(Number(m.secs)), tier = Math.floor(Number(m.tier) || 0);
    if (!(prize >= 1 && prize <= 1e12)) return err('prize');
    if (!(win >= 1 && win <= GW_MAX_WIN) || prize < win) return err('win');
    if (!(secs >= GW_MIN_S && secs <= GW_MAX_S)) return err('time');
    if (!(tier >= 0 && tier <= TIERS.length)) return err('tier');
    const act2 = Object.values(gws);
    if (act2.length >= GW_MAX_ACTIVE) return err('full');
    if (act2.some(g => g.hk === key)) return err('mine');
    const owner = p.role === 'owner';
    if (!owner) {
      if (prize > a.gold) return err('poor');
      if (!xferTake(a, prize)) return err('cap');           // başkalarına coin dağıtmak da günlük aktarım limitine sayılır
      a.gold -= prize; p.gold = a.gold;
    }
    const g = { id: 'g' + now.toString(36) + crypto.randomBytes(2).toString('hex'), hk: key, hostName: a.name, own: owner ? 1 : 0, prize, win, tier, at: now, end: now + secs * 1000, ent: [] };
    gws[g.id] = g; gwSave(); saveUsers();
    pfSync(p);
    broadcast({ t: 'gw', a: 'new', g: gwView(g, '') }, p.id);
    log('giveaway', a.name, prize, 'coin /', win, 'kazanan /', secs + 's / tier', tier);
    return c.send({ t: 'gw', a: 'list', list: gwList(key), bal: a.gold, made: g.id });
  }
  const g = gws[String(m.id || '')];
  if (!g) return err('none');
  if (act === 'join') {
    if (now >= g.end) return err('over');
    if (g.hk === key) return err('host');
    if (g.ent.includes(key)) return err('in');
    if (tierOf(a.wag || 0) < g.tier) return err('rank');
    g.ent.push(key); gwSave();
    return c.send({ t: 'gw', a: 'list', list: gwList(key), bal: a.gold });
  }
  if (act === 'cancel') {
    if (g.hk !== key && p.role !== 'owner') return err('perm');
    delete gws[g.id]; gwSave();
    if (!g.own) { gwCredit(g.hk, g.prize, { m: 'gwback', n: g.prize }); saveUsers(); }
    broadcast({ t: 'gw', a: 'gone', id: g.id, host: g.hostName, why: 'cancel' });
    return;
  }
}
function gwTick() {
  const now = Date.now();
  for (const g of Object.values(gws)) {
    if (now < g.end) continue;
    delete gws[g.id];
    const pool = g.ent.filter(k => users[k]), picked = [];
    while (pool.length && picked.length < g.win) picked.push(pool.splice(crypto.randomInt(0, pool.length), 1)[0]);
    const each = Math.floor(g.prize / g.win);
    for (const k of picked) gwCredit(k, each, { m: 'gww', n: each, h: g.hostName });
    const back = g.prize - each * picked.length;
    if (!g.own && back > 0) gwCredit(g.hk, back, { m: 'gwback', n: back });
    gwSave(); saveUsers();
    broadcast({ t: 'gw', a: 'end', id: g.id, host: g.hostName, each, n: g.ent.length, win: picked.map(k => users[k].name) });
    log('giveaway bitti', g.hostName, 'kazananlar:', picked.map(k => users[k].name).join(',') || '-', 'x' + each);
  }
}
setInterval(gwTick, 1000);

/* ---------- TİP ve TAKAS ---------- */
// coin yatırma açık olduğu için oyuncular arası aktarımlar sınırlı: tek tipte ve günlük toplamda üst sınır (coin satışıyla "çekim" yapılmasını zorlaştırır)
const TIP_MAX = +process.env.TIP_MAX || 2000, XFER_DAY = +process.env.XFER_DAY || 10000;
function xferTake(a, n, dry, free) {
  if (free) return true;                       // owner ile yapılan aktarımlarda limit yok
  const d = new Date().toISOString().slice(0, 10);
  if (!a.xf || a.xf.d !== d) a.xf = { d, n: 0 };
  if (a.xf.n + n > XFER_DAY) return false;
  if (!dry) a.xf.n += n;
  return true;
}
const TRADE_DEF = new Set(DEFAULT_OWNED);
const trades = new Map();     // sid -> { a, b, o:{[id]:{items,gold,ok}}, t }
let nextSid = 1;
function pfSync(p, msg) { p.pfLock = Date.now() + 3000; p.conn.send(Object.assign({ t: 'pfu', pf: pubPf(p.acct) }, msg || {})); }
function doTip(p, m, now) {
  const t = players.get(Number(m.id)), n = Math.floor(Number(m.a));
  if (!t || t === p || !(n >= 1) || n > 1000000) return;
  if (now - (p.tipT || 0) < 1000) return;
  if (p.tr) return p.conn.send({ t: 'tr', a: 'msg', c: 'intrade' });
  const free = p.role === 'owner' || t.role === 'owner';
  if (!free && (n > TIP_MAX || !xferTake(p.acct, n))) return p.conn.send({ t: 'tr', a: 'msg', c: 'xfcap', g: TIP_MAX, d: XFER_DAY });
  if (n > p.acct.gold) return p.conn.send({ t: 'berr', c: 'poor', gold: p.acct.gold });
  p.tipT = now;
  p.acct.gold -= n; t.acct.gold += n; p.gold = p.acct.gold; t.gold = t.acct.gold; saveUsers();
  pfSync(p, { m: 'tipout', n, who: t.name }); pfSync(t, { m: 'tipin', n, who: p.name });
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id); broadcast({ t: 'me', id: t.id, eq: t.eq, gold: t.gold }, t.id);
  log('tip', p.name, '->', t.name, n);
}
function trView(s, p) {
  const me = s.o[p.id], q = s.a === p ? s.b : s.a, th = s.o[q.id];
  return { t: 'tr', a: 'st', who: q.name, me: { items: me.items, gold: me.gold, ok: me.ok }, they: { items: th.items, gold: th.gold, ok: th.ok } };
}
function trSend(s) { for (const p of [s.a, s.b]) if (players.get(p.id) === p) p.conn.send(trView(s, p)); }
function trEnd(s, why) {
  if (!trades.delete(s.sid)) return;
  clearTimeout(s.to);
  for (const p of [s.a, s.b]) { if (p.tr === s.sid) p.tr = 0; if (players.get(p.id) === p) p.conn.send({ t: 'tr', a: 'end', why: why || 'cancel' }); }
}
function trValid(s) {
  for (const p of [s.a, s.b]) {
    const q = p === s.a ? s.b : s.a, o = s.o[p.id];
    if (o.gold > p.acct.gold) return false;
    for (const id of o.items) if (!p.acct.owned.includes(id) || q.acct.owned.includes(id) || TRADE_DEF.has(id) || !(PRICE.get(id) > 0)) return false;
  }
  return true;
}
function trExec(s) {
  if (!trValid(s)) return trEnd(s, 'fail');
  const pairs = [[s.a, s.b], [s.b, s.a]];
  const fr = s.a.role === 'owner' || s.b.role === 'owner';
  if (pairs.some(([g]) => s.o[g.id].gold > 0 && !xferTake(g.acct, s.o[g.id].gold, true, fr))) return trEnd(s, 'fail');
  for (const [g] of pairs) if (s.o[g.id].gold > 0) xferTake(g.acct, s.o[g.id].gold, false, fr);
  for (const [g, r] of pairs) {
    const o = s.o[g.id];
    g.acct.gold -= o.gold; r.acct.gold += o.gold;
    for (const id of o.items) {
      g.acct.owned = g.acct.owned.filter(x => x !== id); r.acct.owned.push(id);
      for (const k of ['c', 'h', 'o', 'd']) if (g.acct.eq[k] === id) g.acct.eq[k] = { c: 'c1', h: 'h1', o: 'o1', d: 'd1' }[k];
    }
  }
  for (const p of [s.a, s.b]) { p.gold = p.acct.gold; p.eq = p.acct.eq; }
  saveUsers();
  trades.delete(s.sid); clearTimeout(s.to);
  for (const p of [s.a, s.b]) { p.tr = 0; pfSync(p, { m: 'trade' }); p.conn.send({ t: 'tr', a: 'end', why: 'done' }); broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id); }
  log('takas', s.a.name, '<->', s.b.name);
}
function trMsg(p, m, now) {
  const a = String(m.a || '');
  if (a === 'req') {
    const t = players.get(Number(m.id));
    if (!t || t === p || p.tr || t.tr || p.bj || p.mn || t.bj || t.mn) return p.conn.send({ t: 'tr', a: 'msg', c: 'busy' });
    if (now - (p.trReqT || 0) < 3000) return;
    p.trReqT = now; t.trReq = { from: p.id, t: now };
    t.conn.send({ t: 'tr', a: 'req', id: p.id, n: p.name });
    return p.conn.send({ t: 'tr', a: 'msg', c: 'sent', n: t.name });
  }
  if (a === 'acc' || a === 'dec') {
    const f = players.get(Number(m.id));
    if (!f || !p.trReq || p.trReq.from !== f.id || now - p.trReq.t > 30000) return;
    p.trReq = null;
    if (a === 'dec') return f.conn.send({ t: 'tr', a: 'msg', c: 'declined', n: p.name });
    if (p.tr || f.tr || p.bj || p.mn || f.bj || f.mn) return;
    const s = { sid: nextSid++, a: f, b: p, o: {}, to: 0 };
    s.o[f.id] = { items: [], gold: 0, ok: false }; s.o[p.id] = { items: [], gold: 0, ok: false };
    s.to = setTimeout(() => trEnd(s, 'timeout'), 300000);
    trades.set(s.sid, s); f.tr = s.sid; p.tr = s.sid;
    f.conn.send({ t: 'tr', a: 'open' }); p.conn.send({ t: 'tr', a: 'open' });
    return trSend(s);
  }
  const s = trades.get(p.tr);
  if (!s) return;
  if (a === 'cancel') return trEnd(s, 'cancel');
  const o = s.o[p.id], q = s.a === p ? s.b : s.a;
  if (a === 'offer') {
    if (now - (p.trT || 0) < 120) return;
    p.trT = now;
    const items = [];
    if (Array.isArray(m.items)) for (const id of m.items.slice(0, 12)) {
      if (typeof id === 'string' && !items.includes(id) && p.acct.owned.includes(id) && !q.acct.owned.includes(id) && !TRADE_DEF.has(id) && PRICE.get(id) > 0) items.push(id);
    }
    let g = Math.floor(Number(m.gold)); if (!(g >= 0)) g = 0; g = Math.min(g, p.acct.gold);
    o.items = items; o.gold = g; s.o[p.id].ok = false; s.o[q.id].ok = false;
    return trSend(s);
  }
  if (a === 'ok') {
    if (!trValid(s)) return trEnd(s, 'fail');
    o.ok = !o.ok;
    if (s.o[s.a.id].ok && s.o[s.b.id].ok) return trExec(s);
    return trSend(s);
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
  if (a === 'bans') return p.conn.send({ t: 'bans', l: banList() });
  if (a === 'unban') {
    const key = cleanText(m.n, 14).toLowerCase();
    if (bans[key]) { delete bans[key]; saveBans(); log('unban', key, 'by', p.name); }
    return p.conn.send({ t: 'bans', l: banList() });
  }
  if (a === 'give') {
    const gt = players.get(Number(m.id)), cap = me >= 2 ? 5000000 : 50000, n = Math.floor(Number(m.n));
    if (!gt || !(n >= 1)) return;
    const amt = Math.min(n, cap);
    gt.acct.gold += amt; gt.gold = gt.acct.gold; saveUsers();
    pfSync(gt, { m: 'gift', n: amt, who: p.name });
    broadcast({ t: 'me', id: gt.id, eq: gt.eq, gold: gt.gold }, gt.id);
    log('give', p.name, '->', gt.name, amt);
    return p.conn.send({ t: 'tr', a: 'msg', c: 'gave', n: gt.name, g: amt });
  }
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
  if (a === 'ban') {
    const mins = Math.max(0, Math.min(525600, Math.floor(Number(m.min)) || 0));
    bans[target.name.toLowerCase()] = { name: target.name, by: p.name, at: now, until: mins ? now + mins * 60000 : 0 };
    saveBans();
    broadcast({ t: 'evt', e: 'ban', n: target.name });
    target.conn.send({ t: 'banned' });
    log('ban', target.name, 'by', p.name, mins || 'kalıcı');
    return target.conn.close(1008);
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
    gamesAbort(p);
    tblLeave(p);
    if (RR.ph === 'bet') RR.bets.delete(p.id);
    if (p.tr && trades.get(p.tr)) trEnd(trades.get(p.tr), 'left');
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
