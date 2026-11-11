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
 *   RESEND_API_KEY   e-posta doğrulama kodlarını göndermek için Resend (resend.com) API anahtarı
 *   MAIL_FROM        gönderen adres, örn: BloodBet <noreply@siten.com>  (Resend'de doğrulanmış alan adı olmalı)
 *                    ikisi de boşsa kodlar e-posta yerine konsola yazılır (sadece yerelde test için!)
 *   TURN_URLS        ICE_SERVERS yerine kısayol: turn:relay.ornek.com:80,turns:relay.ornek.com:443?transport=tcp  (+ TURN_USER, TURN_PASS)
 *   CF_TURN_ID / CF_TURN_TOKEN   Cloudflare Realtime TURN anahtarı (ücretsiz 1000 GB/ay); kimlik bilgisini sunucu otomatik üretir
 *   AFF_WAG_SHARE    affiliate: davetlinin bahislerindeki kasa avantajının davet edene giden payı (0-0.5, varsayılan 0.10)
 *   NOWPAY_API_KEY / NOWPAY_IPN_SECRET / PUBLIC_URL   NOWPayments ile kişiye özel adres + otomatik coin yatırma (isteğe bağlı; yoksa elle onay)
 *   NOWPAY_USDT      USDT ağı (varsayılan usdttrc20)
 *   LB_HIDE          leaderboard'dan gizlenecek hesap adları, virgülle (varsayılan: bloodbet,rowdyy,owner1). Yetki koduyla girenler zaten otomatik gizlenir
 *   NOWPAY_OUT       NOWPayments panelindeki ÇIKIŞ cüzdanı coin(ler)i, öncelik sırasıyla: trx  ya da  trx,ltc  (minimumları doğru hesaplamak için)
 *   PASSIVE_SEC      pasif gelir: kaç saniye aktif hareket = 1 coin (varsayılan 300); PASSIVE_WIN_MS ölçüm penceresi (varsayılan 60000)
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
const ZONES = new Set(['lobby', 'range', 'casino', 'pvp', 'pit']);
const ID_RE = /^[a-z][0-9]{1,3}$/;

let ICE = null;
try { const j = JSON.parse(process.env.ICE_SERVERS || 'null'); if (Array.isArray(j) && j.length) ICE = j.slice(0, 6); } catch (e) { }
if (!ICE && process.env.TURN_URLS) {   // kısayol: TURN_URLS (virgülle), TURN_USER, TURN_PASS
  const urls = process.env.TURN_URLS.split(',').map(x => x.trim()).filter(Boolean).slice(0, 6);
  if (urls.length) ICE = [{ urls: ['stun:stun.l.google.com:19302'] }, { urls, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' }];
}

/* ---------- Cloudflare TURN (isteğe bağlı): CF_TURN_ID + CF_TURN_TOKEN ---------- */
const CF_ID = process.env.CF_TURN_ID || '', CF_TOKEN = process.env.CF_TURN_TOKEN || '';
const CF_URL = (process.env.CF_TURN_URL || 'https://rtc.live.cloudflare.com').replace(/\/+$/, '');
async function refreshCfTurn() {       // kısa ömürlü TURN kimlik bilgisi üretir, 3 saatte bir yenilenir
  try {
    const r = await fetch(`${CF_URL}/v1/turn/keys/${encodeURIComponent(CF_ID)}/credentials/generate`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + CF_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) { log('Cloudflare TURN hatası:', r.status, (await r.text()).slice(0, 200)); return; }
    const j = await r.json();
    const list = [].concat(j.iceServers || []).filter(x => x && x.urls);
    if (list.length) { ICE = list.slice(0, 6); log('Cloudflare TURN kimlik bilgisi yenilendi'); }
    else log('Cloudflare TURN yanıtında iceServers yok');
  } catch (e) { log('Cloudflare TURN hatası:', e.message); }
}
if (CF_ID && CF_TOKEN && require.main === module) { refreshCfTurn(); setInterval(refreshCfTurn, 3 * 3600 * 1000).unref(); }

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
const WHEEL = [0, .5, 0, 2, 0, .5, 0, 1.5, 0, .5, 0, 3, 0, .5, 0, 2, 0, .5, 0, 1, 0, .5, 0, 10];   // 24 dilim, geri dönüş %93,75
// oyun başına bahis üst sınırları (coin)
const LIM = { bj: 100000, mn: 20000, tw: 20000, wof: 50000, rn: 5000, ro: 100000 };   // rn: rulette tek sayı, ro: rulette diğer alanlar (renk, tek/çift, düzine...)
function rouChk(bets) { const s = new Map(); for (const b of bets) { const id = b.k + '|' + b.v, t = (s.get(id) || 0) + b.a; if (t > (b.k === 'n' ? LIM.rn : LIM.ro)) return false; s.set(id, t); } return true; }
const BET_KINDS = new Set(['n', 'red', 'black', 'odd', 'even', 'low', 'high', 'd1', 'd2', 'd3', 'c1', 'c2', 'c3']);
const MIN_BET = 10, MAX_BET = 1e12, MAX_TOTAL = 1e12, BET_GAP = 3500, BIG_WIN = 3000;     // bahis üst sınırı yok (yalnızca bakiye ve taşma koruması)
const RK = 0.975;                      // Avrupa ruleti (tek sıfır) × 0,975 → geri dönüş ≈ %94,9
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
const BUD_RATE = 0.05, BUD_CAP = 6000, BUD_START = 3000;   // sunucunun izin verdiği en hızlı servet artışı (altın/sn, üst sınır)
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
  await loadDepsRemote(); await loadGwRemote(); await loadLogsRemote();
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
/* ---------- yönetim günlüğü: altın verme / alma, yatırımlar (son 1000 kayıt, kalıcı) ---------- */
const LOGS_FILE = path.join(DATA_DIR, 'logs.json'); let LOGS = [], logT = null;
try { LOGS = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8')) || []; } catch (e) { }
function logSave() {
  if (logT) return;
  logT = setTimeout(() => {
    logT = null;
    if (REMOTE) redis(['SET', 'bloodbet:logs', JSON.stringify(LOGS)]).catch(e => log('günlük kayıt hatası:', e.message));
    else { try { const tmp = LOGS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(LOGS)); fs.renameSync(tmp, LOGS_FILE); } catch (e) { log('günlük kayıt hatası:', e.message); } }
  }, 2000);
}
function logAdd(k, by, to, n, extra) {      // k: give | take | dep | reset
  LOGS.push(Object.assign({ t: Date.now(), k, by: String(by || ''), to: String(to || ''), n: Math.round((Number(n) || 0) * 100) / 100 }, extra || {}));
  if (LOGS.length > 1000) LOGS.splice(0, LOGS.length - 1000);
  logSave();
}
async function loadLogsRemote() { const r = await redis(['GET', 'bloodbet:logs']); if (r) { try { LOGS = JSON.parse(r) || []; } catch (e) { } } }
const NAME_RE = /^[\p{L}\p{N}_.-]+(?: [\p{L}\p{N}_.-]+)*$/u;
const RESERVED = new Set(['admin', 'owner', 'system', 'sistem', 'lobi', 'mod', 'moderator', 'yönetici', 'yonetici', 'oyuncu']);
const validName = n => n.length >= 2 && n.length <= 14 && NAME_RE.test(n) && !RESERVED.has(n.toLowerCase());
const tokHash = t => crypto.createHash('sha256').update(String(t)).digest('base64url');
const wealthOf = (gold) => gold;     // eşyalar artık satın alınmıyor: servet = coin
// Eşya -> gereken rank (tier). Değerliden değersize: en iyi eşyalar en yüksek rank'tan açılır (0 = herkeste)
const TRADE_ITEMS = false;   // eşya takası kapalı: eşyalar rank ile açılır, takasla rank atlanamaz (coin takası açık)
const REQ = {"c1":0,"c2":1,"c3":2,"c4":3,"c5":4,"c6":5,"c7":7,"c8":8,"c9":9,"c10":10,"o1":0,"o2":1,"o3":2,"o7":3,"o4":4,"o8":5,"o5":7,"o9":8,"o6":9,"o10":10,"h1":0,"h6":1,"h7":2,"h2":3,"h8":4,"h4":5,"h5":7,"h9":8,"h3":9,"h10":10,"d1":0,"d5":1,"d2":2,"d6":4,"d7":5,"d4":6,"d3":7,"d8":9,"d9":10};
/* ---------- RANK: toplam wager'a (oynanan bahis) göre tier ---------- */
const TIERS = [5000, 15000, 40000, 90000, 180000, 350000, 650000, 1100000, 1800000, 3000000];   // Tier 1..10 için gereken toplam wager
const tierOf = w => { let t = 0; while (t < TIERS.length && w >= TIERS[t]) t++; return t; };
const RB_RATES = [0.05, 0.052, 0.054, 0.056, 0.058, 0.06, 0.062, 0.064, 0.066, 0.068, 0.07];   // rank (-,I..X) -> kasa avantajından geri dönen pay
const EDGE = { roul: 0.051, mines: 0.07, wof: 0.0625, bj: 0.008, case: 0.04, towers: 0.06, dice: 0.05, cf: 0.02, cfp: 0.05 };   // gerçek kasa avantajları (rakeback / affiliate bunun üzerinden hesaplanır)                                    // oyun başına kasa avantajı
// Haftalık bonus her pazartesi 06:00'da (TSİ), aylık bonus her ayın 1'inde 00:00'da (TSİ) yenilenir
const BTZ = +process.env.DAY_TZ_H || 3, WK_HOUR = 6;
const wkIdx = t => Math.floor(((t + (BTZ - WK_HOUR) * 36e5) / 864e5 + 3) / 7);                     // 1970-01-01 perşembe -> pazartesi tabanlı hafta no
const wkNext = t => ((wkIdx(t) + 1) * 7 - 3) * 864e5 - (BTZ - WK_HOUR) * 36e5;
const moIdx = t => { const d = new Date(t + BTZ * 36e5); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const moNext = t => { const d = new Date(t + BTZ * 36e5); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - BTZ * 36e5; };
const WK_PCT = 0.0005, MO_PCT = 0.001, AFF_PCT = 0.03;   // AFF_PCT: davetlinin coin satın alımından anında verilen pay
// Affiliate: davet edilen oyuncunun her bahsinde, o bahsin kasa avantajının AFF_SHARE kadarı davet edene birikir (AFF_WAG_SHARE ile ayarlanır, varsayılan 0.10 = %10)
const AFF_SHARE = (process.env.AFF_WAG_SHARE || '') !== '' && Number.isFinite(+process.env.AFF_WAG_SHARE) ? Math.min(0.5, Math.max(0, +process.env.AFF_WAG_SHARE)) : 0.10;
function wagerAdd(a, n, g) {
  if (!(n > 0)) return;
  const old = a.wag || 0, nw = old + n, now = Date.now();
  a.wag = nw;
  a.rb = (a.rb || 0) + n * (EDGE[g] || 0.05) * RB_RATES[tierOf(nw)];
  a.wkW = (a.wkW || 0) + n; a.moW = (a.moW || 0) + n;
  const rf = a.ref && AFF_SHARE > 0 ? users[a.ref] : null;
  if (rf && rf !== a) { const c = n * (EDGE[g] || 0.05) * AFF_SHARE; rf.affPend = (rf.affPend || 0) + c; a.affW = (a.affW || 0) + n; a.affC = (a.affC || 0) + c; }
  const q = onlineAcct(a);
  if (q) q.conn.send({ t: 'wag', w: nw, tier: tierOf(nw), up: tierOf(nw) > tierOf(old) ? 1 : 0 });
  if (q && tierOf(nw) > tierOf(old)) broadcast({ t: 'rank', id: q.id, tr: tierOf(nw) }, q.id);
}
function rwInfo(a) {
  const now = Date.now(), tier = tierOf(a.wag || 0), key = a.name.toLowerCase();
  const per = (w, pct) => Math.floor((w || 0) * pct * (1 + 0.1 * tier));
  let n = 0, tw = 0; const lst = [];
  for (const u of Object.values(users)) if (u.ref === key) { n++; tw += u.affW || 0; lst.push({ n: u.name, w: Math.floor(u.affW || 0), c: Math.floor(u.affC || 0) }); }
  lst.sort((x, y) => y.c - x.c || y.w - x.w);
  return { t: 'rw', a: 'info', tier, wag: a.wag || 0, rates: RB_RATES.map(r => +(r * 100).toFixed(1)), rb: Math.floor(a.rb || 0), rbTot: a.rbTot || 0,
    wk: { amt: per(a.wkW, WK_PCT), left: a.wkP === wkIdx(now) ? Math.max(1, wkNext(now) - now) : 0, w: Math.floor(a.wkW || 0) },
    mo: { amt: per(a.moW, MO_PCT), left: a.moP === moIdx(now) ? Math.max(1, moNext(now) - now) : 0, w: Math.floor(a.moW || 0) },
    aff: { code: a.name, ref: a.ref && users[a.ref] ? users[a.ref].name : '', n, earned: a.affEarn || 0, pct: AFF_PCT * 100,
      wpct: +(AFF_SHARE * 100).toFixed(1), w: Math.floor(tw), pend: Math.floor(a.affPend || 0), list: lst.slice(0, 12) } };
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
    else if (k === 'af') { n = Math.floor(a.affPend || 0); if (n < 1) return err('min'); a.affPend -= n; a.affEarn = (a.affEarn || 0) + n; }
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
function ownedOf(a) {                  // eski satın alınanlar + rank'ın açtığı eşyalar
  const t = tierOf(a.wag || 0), set = new Set(DEFAULT_OWNED);
  for (const id of a.owned || []) if (PRICE.has(id)) set.add(id);
  for (const id in REQ) if (REQ[id] <= t) set.add(id);
  return [...set];
}
const pubPf = a => ({ gold: a.gold, owned: ownedOf(a), eq: a.eq, wag: a.wag || 0 });
const loginTries = new Map();   // ip -> zaman damgaları
const regTries = new Map();
const mailTries = new Map();    // ip -> e-posta gönderim zamanları
const mailTo = new Map();       // e-posta -> gönderim zamanları
const pend = new Map();         // 'reg:e-posta' | 'fp:e-posta' | 'add:hesap' -> bekleyen doğrulama kodu

/* ---------- e-posta doğrulama ---------- */
const MAIL_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const MAIL_API = process.env.MAIL_API_URL || 'https://api.resend.com/emails';
const MAIL_ON = !!(MAIL_KEY && MAIL_FROM);
const CODE_TTL = 10 * 60000, CODE_TRIES = 5, RESEND_MS = 45000, PW_MIN = 8;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
function cleanMail(s) {
  s = typeof s === 'string' ? s.trim().toLowerCase() : '';
  if (s.length > 254 || !EMAIL_RE.test(s) || s.split('@')[1].split('.').pop().length < 2) return '';
  return s;
}
function mailCanon(e) {          // a.b+x@gmail.com gibi takma adları tek adrese indirger (aynı kutuyla çok hesap açılmasın)
  let [l, d] = e.split('@');
  const base = l.split('+')[0]; if (base) l = base;
  if (d === 'googlemail.com') d = 'gmail.com';
  if (d === 'gmail.com') l = l.replace(/\./g, '');
  return l + '@' + d;
}
let mailIdx = null;               // kanonik e-posta -> hesap anahtarı (ilk kullanımda users'tan kurulur)
function mailUser(canon) {
  if (!mailIdx) { mailIdx = new Map(); for (const k in users) if (users[k].email) mailIdx.set(mailCanon(users[k].email), k); }
  const k = mailIdx.get(canon);
  return k && users[k] ? k : null;
}
function mailBind(canon, key) { mailUser(canon); mailIdx.set(canon, key); }
async function sendMail(to, subject, text) {
  if (!MAIL_ON) { log('[e-posta ayarlı değil, konsola yazıldı]', to, '|', subject); return true; }
  try {
    const r = await fetch(MAIL_API, {
      method: 'POST', headers: { Authorization: 'Bearer ' + MAIL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }), signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) { log('e-posta gönderilemedi:', r.status, (await r.text()).slice(0, 200)); return false; }
    return true;
  } catch (e) { log('e-posta hatası:', e.message); return false; }
}
function codeMail(lang, code, why) {
  const en = lang === 'en';
  const reason = { reg: en ? 'You are creating a BloodBet account.' : 'BloodBet hesabı oluşturuyorsun.',
    fp: en ? 'Someone asked to reset the password of your BloodBet account.' : 'BloodBet hesabının şifresini sıfırlama isteği yapıldı.',
    add: en ? 'You are adding this e-mail address to your BloodBet account.' : 'Bu e-posta adresini BloodBet hesabına ekliyorsun.' }[why];
  return en
    ? { s: 'BloodBet verification code: ' + code, t: `Your verification code: ${code}\n\n${reason}\nThe code is valid for 10 minutes. Do not share it with anyone. If this was not you, ignore this e-mail.` }
    : { s: 'BloodBet doğrulama kodu: ' + code, t: `Doğrulama kodun: ${code}\n\n${reason}\nKod 10 dakika geçerlidir. Kimseyle paylaşma. Bu işlemi sen yapmadıysan bu e-postayı yok sayabilirsin.` };
}
// kod üretir ve gönderir; hata kodu ya da null döner
async function issueCode(c, key, data, to, lang, why) {
  const now = Date.now(), old = pend.get(key);
  if (old && now < old.exp && now - old.sent < RESEND_MS) return 'wait';
  const il = (mailTries.get(c.ip) || []).filter(t => now - t < 3600000);
  const el = (mailTo.get(to) || []).filter(t => now - t < 3600000);
  if (il.length >= 8 || el.length >= 5) return 'mailrate';
  il.push(now); mailTries.set(c.ip, il); el.push(now); mailTo.set(to, el);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  pend.set(key, Object.assign({ code, exp: now + CODE_TTL, tries: 0, sent: now }, data));
  const mm = codeMail(lang, code, why);
  if (!MAIL_ON) log('DOĞRULAMA KODU', to, code);
  if (!(await sendMail(to, mm.s, mm.t))) { pend.delete(key); return 'mailfail'; }
  return null;
}
function checkCode(key, code) {    // { r: 'ok', p } | { r: 'bad' } | { r: 'exp' }; doğru kod tek kullanımlıktır
  const p = pend.get(key);
  if (!p || Date.now() > p.exp || ++p.tries > CODE_TRIES) { pend.delete(key); return { r: 'exp' }; }
  if (!safeEq(String(code == null ? '' : code).replace(/\D/g, '').slice(0, 6), p.code)) return { r: 'bad' };
  pend.delete(key);
  return { r: 'ok', p };
}

function newAccount(name, salt, hash, email, ref) {
  return Object.assign(ref ? { ref } : {}, { name, email: email || '', mailOk: !!email, salt: salt.toString('base64'), hash: hash.toString('base64'), toks: [], gold: START_GOLD, owned: DEFAULT_OWNED.slice(),
    eq: { c: 'c1', h: 'h1', o: 'o1', d: 'd1' }, bud: BUD_START, budT: Date.now(), created: Date.now() });
}
function authGate(c) {               // IP başına dakikada 12 giriş / kayıt / doğrulama işlemi
  const now = Date.now(), lt = (loginTries.get(c.ip) || []).filter(t => now - t < 60000);
  if (lt.length >= 12) return false;
  lt.push(now); loginTries.set(c.ip, lt);
  return true;
}
const langOf = m => (m.lang === 'en' ? 'en' : 'tr');

function doAuth(c, m) {
  const now = Date.now();
  if (!authGate(c)) return c.send({ t: 'autherr', c: 'rate' });
  if (c.authBusy || c.acct) return;
  const fail = code => c.send({ t: 'autherr', c: code });
  const idRaw = typeof m.name === 'string' ? m.name.trim().slice(0, 254) : '';
  const pw = typeof m.pass === 'string' ? m.pass.slice(0, 64) : '';
  if (m.t === 'reg') {                                   // 1. adım: bilgileri doğrula, e-postaya kod gönder
    const name = cleanText(idRaw, 14), key = name.toLowerCase(), email = cleanMail(m.email);
    if (banOf(key)) return fail('banned');
    if (!validName(name)) return fail('name');
    if (!email) return fail('email');
    if (pw.length < PW_MIN || pw.toLowerCase() === key) return fail('pw');
    const aff = typeof m.aff === 'string' ? cleanText(m.aff, 14).toLowerCase() : '';   // isteğe bağlı affiliate kodu = davet edenin kullanıcı adı
    if (aff && (aff === key || !users[aff])) return fail('affbad');
    const canon = mailCanon(email);
    if (users[key]) return fail('taken');
    if (mailUser(canon)) return fail('mailtaken');
    const rt = (regTries.get(c.ip) || []).filter(t => now - t < 3600000);
    if (rt.length >= 8) return fail('regrate');
    rt.push(now); regTries.set(c.ip, rt);
    c.authBusy = true;
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 32, (e, k) => {
      if (e || c.closed) { c.authBusy = false; return; }
      if (users[key] || mailUser(canon)) { c.authBusy = false; return fail(users[key] ? 'taken' : 'mailtaken'); }
      issueCode(c, 'reg:' + canon, { name, key, email, salt, hash: k, ref: aff }, email, langOf(m), 'reg').then(er => {
        c.authBusy = false;
        if (er) return fail(er);
        c.send({ t: 'authstep', s: 'code', k: 'reg', email });
      });
    });
    return;
  }
  let a, key;
  if (idRaw.includes('@')) {                             // e-posta ile giriş
    if (m.t === 'resume') return fail('bad');
    const em = cleanMail(idRaw), uk = em && mailUser(mailCanon(em));
    a = uk ? users[uk] : null; key = a ? a.name.toLowerCase() : '';
  } else { key = cleanText(idRaw, 14).toLowerCase(); a = users[key]; }
  if (key && banOf(key)) return fail('banned');
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
// 2. adım: e-postaya gelen kodu doğrula, hesabı oluştur
function doRegVerify(c, m) {
  if (!authGate(c)) return c.send({ t: 'autherr', c: 'rate' });
  if (c.authBusy || c.acct) return;
  const email = cleanMail(m.email);
  if (!email) return c.send({ t: 'autherr', c: 'email' });
  const canon = mailCanon(email), r = checkCode('reg:' + canon, m.code);
  if (r.r === 'exp') return c.send({ t: 'autherr', c: 'codeexp' });
  if (r.r === 'bad') return c.send({ t: 'authstep', s: 'err', c: 'codebad' });
  const p = r.p;
  if (banOf(p.key)) return c.send({ t: 'autherr', c: 'banned' });
  if (users[p.key]) return c.send({ t: 'autherr', c: 'taken' });
  if (mailUser(canon)) return c.send({ t: 'autherr', c: 'mailtaken' });
  const a = newAccount(p.name, p.salt, p.hash, p.email, p.ref && users[p.ref] ? p.ref : '');
  users[p.key] = a; mailBind(canon, p.key); saveUsers();
  log('yeni hesap', p.name, a.ref ? '(davet: ' + a.ref + ')' : '');
  authOk(c, a, true);
}
// şifremi unuttum: hesap var mı yok mu belli etmeden "kod gönderildi" der
function doForgot(c, m) {
  if (!authGate(c)) return c.send({ t: 'autherr', c: 'rate' });
  if (c.authBusy || c.acct) return;
  const email = cleanMail(m.email);
  if (!email) return c.send({ t: 'autherr', c: 'email' });
  const canon = mailCanon(email), uk = mailUser(canon), a = uk ? users[uk] : null;
  const ok = () => c.send({ t: 'authstep', s: 'code', k: 'fp', email });
  if (!a || !a.mailOk || banOf(uk)) return ok();
  c.authBusy = true;
  issueCode(c, 'fp:' + canon, { key: uk }, a.email, langOf(m), 'fp').then(er => {
    c.authBusy = false;
    if (er === 'wait') return ok();
    if (er) return c.send({ t: 'autherr', c: er });
    ok();
  });
}
function doReset(c, m) {
  if (!authGate(c)) return c.send({ t: 'autherr', c: 'rate' });
  if (c.authBusy || c.acct) return;
  const email = cleanMail(m.email), pw = typeof m.pass === 'string' ? m.pass.slice(0, 64) : '';
  if (!email) return c.send({ t: 'autherr', c: 'email' });
  if (pw.length < PW_MIN) return c.send({ t: 'authstep', s: 'err', c: 'pw' });   // zayıf şifre kodu yakmasın
  const canon = mailCanon(email), r = checkCode('fp:' + canon, m.code);
  if (r.r === 'exp') return c.send({ t: 'autherr', c: 'codeexp' });
  if (r.r === 'bad') return c.send({ t: 'authstep', s: 'err', c: 'codebad' });
  const a = users[r.p.key];
  if (!a || pw.toLowerCase() === a.name.toLowerCase()) return c.send({ t: 'autherr', c: 'bad' });
  c.authBusy = true;
  const salt = crypto.randomBytes(16);
  crypto.scrypt(pw, salt, 32, (e, k) => {
    c.authBusy = false;
    if (e) return c.send({ t: 'autherr', c: 'bad' });
    a.salt = salt.toString('base64'); a.hash = k.toString('base64'); a.toks = [];   // eski oturumlar kapanır
    saveUsers(true);
    log('şifre sıfırlandı', a.name);
    if (!c.closed) authOk(c, a, true);
  });
}
// e-postası olmayan eski hesaplar için: giriş yaptıktan sonra e-posta ekleme
function doMail(c, m) {
  const a = c.acct;
  if (!a || a.mailOk) return;
  const err = code => c.send({ t: 'mail', a: 'err', c: code }), key = 'add:' + a.name.toLowerCase();
  if (!authGate(c)) return err('rate');
  if (m.a === 'send') {
    const email = cleanMail(m.email);
    if (!email) return err('email');
    const canon = mailCanon(email);
    if (mailUser(canon)) return err('mailtaken');
    issueCode(c, key, { canon, email }, email, langOf(m), 'add').then(er => er ? err(er) : c.send({ t: 'mail', a: 'sent', email }));
  } else if (m.a === 'verify') {
    const r = checkCode(key, m.code);
    if (r.r === 'exp') return err('codeexp');
    if (r.r === 'bad') return err('codebad');
    if (mailUser(r.p.canon)) return err('mailtaken');
    a.email = r.p.email; a.mailOk = true; mailBind(r.p.canon, a.name.toLowerCase()); saveUsers(true);
    log('e-posta eklendi', a.name);
    c.send({ t: 'mail', a: 'ok' });
  }
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
  c.send({ t: 'authok', name: a.name, tok, pf: pubPf(a), nomail: a.mailOk ? 0 : 1 });
}
// istemcinin bildirdiği altın / eşya durumunu doğrular; hileli artışı reddeder
function applyPf(p, m, now) {
  const a = p.acct;
  const reject = () => p.conn.send({ t: 'pfx', pf: pubPf(a) });
  if (now < (p.pfLock || 0)) return;
  const owned = ownedOf(a), set = new Set(owned);        // istemcinin 'sahip olduğum' iddiası yok sayılır: sunucu rank'tan hesaplar
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
  a.gold = gold; a.eq = eq;   // a.owned yalnızca eski satın alınanları tutar; rank ile açılanlar her seferinde hesaplanır p.gold = gold; p.eq = eq;
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
  if (role && p.acct && p.acct.stf !== role) { p.acct.stf = role; saveUsers(); }     // yetkili hesap kalıcı işaretlenir: çevrimdışıyken de leaderboard'a girmez
  p.conn.send({ t: 'role', r: role });
  broadcast({ t: 'prole', id: p.id, r: role }, p.id);
}

function doJoin(c, m) {
  if (players.size >= MAX_PLAYERS) { c.send({ t: 'err', c: 'full' }); return c.close(1013); }
  if (!c.acct) return c.close(1008);
  const a = c.acct;
  for (const q of players.values()) if (q.acct === a) { q.conn.send({ t: 'err', c: 'dup' }); q.conn.close(1000); }
  if ((a.btEsc || 0) > 0 && !btHolds(a)) { a.gold += a.btEsc; log('battle emaneti iade', a.name, a.btEsc); a.btEsc = 0; saveUsers(); }   // sunucu yeniden başlarken yarım kalan battle emaneti
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



/* ---------- giriş sonrası HUB ekranı: liderlik tablosu · affiliate · kullanıcılar · sohbet ---------- */
const CHAT_LOG = [];                 // son sohbet mesajları (oyun içi + hub ortak)
const hubWatch = new Set();          // hub ekranında olan bağlantılar
function chatPush(name, role, msg) { CHAT_LOG.push({ n: name, r: role || '', m: msg, t: Date.now() }); if (CHAT_LOG.length > 60) CHAT_LOG.shift(); }
function hubCast(obj) { for (const c of hubWatch) { try { c.send(obj, true); } catch (e) { } } }
let hubCache = null, hubCacheT = 0;
const LB_HIDE = new Set((process.env.LB_HIDE !== undefined ? process.env.LB_HIDE : 'bloodbet,rowdyy,owner1').toLowerCase().split(/\s*,\s*/).filter(Boolean));   // leaderboard'da hiç görünmeyecek hesaplar (yönetim hesapları)
function hubBoards() {
  const now = Date.now();
  if (hubCache && now - hubCacheT < 8000) return hubCache;
  const all = Object.values(users), refs = Object.create(null), staffOn = new Set();
  for (const q of players.values()) if (q.role === 'admin' || q.role === 'owner') staffOn.add(q.acct);
  const isStaff = u => !!u && (!!u.stf || staffOn.has(u) || LB_HIDE.has(String(u.name || '').toLowerCase()));       // admin / owner leaderboard'a hiç girmez
  for (const u of all) if (u.ref) { const r = refs[u.ref] || (refs[u.ref] = { n: 0, w: 0, c: 0 }); r.n++; r.w += u.affW || 0; r.c += u.affC || 0; }
  const wag = all.filter(u => !isStaff(u) && (u.wag || 0) > 0).sort((a, b) => (b.wag || 0) - (a.wag || 0)).slice(0, 10).map(u => ({ n: u.name, w: Math.floor(u.wag || 0), tr: tierOf(u.wag || 0) }));
  const rich = all.filter(u => !isStaff(u) && (u.gold || 0) > 0).sort((a, b) => (b.gold || 0) - (a.gold || 0)).slice(0, 10).map(u => ({ n: u.name, g: Math.floor(u.gold || 0), tr: tierOf(u.wag || 0) }));
  const aff = Object.keys(refs).filter(k => users[k] && !isStaff(users[k])).sort((a, b) => refs[b].c - refs[a].c || refs[b].n - refs[a].n).slice(0, 10).map(k => ({ n: users[k].name, r: refs[k].n, w: Math.floor(refs[k].w), c: Math.floor(refs[k].c) }));
  hubCache = { wag, rich, aff, total: all.length }; hubCacheT = now;
  return hubCache;
}
function hubUsers() {
  const on = new Map();
  for (const q of players.values()) on.set(q.acct, { n: q.name, tr: tierOf(q.acct.wag || 0), g: 1 });
  for (const c of hubWatch) if (c.acct && !on.has(c.acct)) on.set(c.acct, { n: c.acct.name, tr: tierOf(c.acct.wag || 0), g: 0 });
  return [...on.values()].sort((a, b) => b.tr - a.tr || a.n.localeCompare(b.n)).slice(0, 60);
}
function doHub(c, m) {
  const a = c.acct; if (!a) return;
  const now = Date.now(), act = String(m.a || '');
  c.act = now;
  if (act === 'info') {
    if (now - (c.hubT || 0) < 1500) return; c.hubT = now;
    if (!c.p) hubWatch.add(c);
    const b = hubBoards();
    return c.send({ t: 'hub', a: 'info', me: { n: a.name, g: Math.floor(a.gold || 0), tr: tierOf(a.wag || 0), w: Math.floor(a.wag || 0) },
      wag: b.wag, rich: b.rich, aff: b.aff, total: b.total, on: hubUsers(), pn: players.size, chat: CHAT_LOG.slice(-40) });
  }
  if (act === 'leave') { hubWatch.delete(c); return; }
  if (act === 'chat') {
    const msg = cleanText(m.m, 160); if (!msg) return;
    c.chatTok = Math.min(4, (c.chatTok === undefined ? 4 : c.chatTok) + (now - (c.chatT || now)) / 1200); c.chatT = now;
    if (c.chatTok < 1) return c.send({ t: 'err', c: 'fast' });
    c.chatTok -= 1;
    const role = c.p ? c.p.role : '';
    chatPush(a.name, role, msg);
    hubCast({ t: 'hub', a: 'chat', n: a.name, r: role || '', m: msg });
    if (!c.p) broadcast({ t: 'chat', id: 0, name: a.name, role: role || '', m: msg });
    return;
  }
}

function onMsg(c, txt) {
  let m;
  try { m = JSON.parse(txt); } catch (e) { return; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
  c.act = Date.now();
  if (!c.p) {
    if (m.t === 'reg' || m.t === 'login' || m.t === 'resume') doAuth(c, m);
    else if (m.t === 'regv') doRegVerify(c, m);
    else if (m.t === 'forgot') doForgot(c, m);
    else if (m.t === 'reset') doReset(c, m);
    else if (m.t === 'mail') doMail(c, m);
    else if (m.t === 'hub') doHub(c, m);
    else if (m.t === 'join') { hubWatch.delete(c); doJoin(c, m); }
    return;
  }
  const p = c.p, now = Date.now();
  switch (m.t) {
    case 'st': {
      const a = m.a;
      if (!Array.isArray(a) || a.length < 8) return;
      if (a[6] === 'pvp' && p.st[6] !== 'pvp') { p.hp = PVP.hp; p.dead = 0; }
      const prevZone = p.st[6], ox = p.st[0], oz = p.st[2];
      p.st = [
        num(a[0], -130, 130, 0), num(a[1], -12, 12, 0), num(a[2], -130, 130, 0), num(a[3], -10, 10, 0),
        STATES.has(a[4]) ? a[4] : 'idle', typeof a[5] === 'string' && ID_RE.test(a[5]) ? a[5] : p.eq.d,
        ZONES.has(a[6]) ? a[6] : 'lobby', a[7] ? 1 : 0
      ];
      p.dirty = true; moveTrack(p, ox, oz);
      if (prevZone === 'pit' && p.st[6] !== 'pit') btLeave(p);
      else if (prevZone !== 'pit' && p.st[6] === 'pit') p.conn.send({ t: 'bts', a: [btView(BT[0], now), btView(BT[1], now)] });
      if (prevZone !== 'casino' && p.st[6] === 'casino') p.conn.send({ t: 'tbls', tb: tblSnap(), rr: rrView() });
      else if (prevZone === 'casino' && p.st[6] !== 'casino') { tblLeave(p); cfCancelAll(p); if (RR.ph === 'bet') { RR.bets.delete(p.id); rrInfo(now); } }
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
    case 'dw': return dwMsg(p, m, now);
    case 'gw': return gwMsg(p, m, now);
    case 'tr': return trMsg(p, m, now);
    case 'bj': return bjAct(p, m, now);
    case 'mn': return mnAct(p, m, now);
    case 'tw': return twAct(p, m, now);
    case 'hub': return doHub(p.conn, m);
    case 'cf': return cfMsg(p, m, now);
    case 'case': return caseMsg(p, m, now);
    case 'bt': return btMsg(p, m, now);
    case 'chat': {
      const msg = cleanText(m.m, 160);
      if (!msg) return;
      p.chatTok = Math.min(4, p.chatTok + (now - p.chatT) / 1200); p.chatT = now;
      if (p.chatTok < 1) return c.send({ t: 'err', c: 'fast' });
      if (p.muted) return c.send({ t: 'muted', v: 1 });
      p.chatTok -= 1;
      broadcast({ t: 'chat', id: p.id, name: p.name, role: p.role, m: msg });
      chatPush(p.name, p.role, msg); hubCast({ t: 'hub', a: 'chat', n: p.name, r: p.role || '', m: msg });
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
// kurallar: sonsuz deste · kasa tüm 17'lerde durur · blackjack 3:2 · bölme / sigorta yok · iki katlama ilk iki kartta serbest
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
      if (!(a >= MIN_BET && a <= MAX_BET) || (b.k === 'n' && !(vv >= 0 && vv <= 36))) continue;
      bets.push({ k: b.k, v: vv, a: Math.min(a, b.k === 'n' ? LIM.rn : LIM.ro) });
    }
    v = { bets };
  } else if (m.g === 'wof') {
    const a = Math.floor(Number(m.a));
    v = { a: a >= MIN_BET && a <= Math.min(MAX_BET, LIM.wof) ? a : 0 };
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

const bjCV = c => { const r = c % 13; return r === 0 ? 11 : r >= 9 ? 10 : r + 1; };      // kart değeri (As = 11)
const bjTotal = h => h.hands.reduce((s, x) => s + x.bet, 0);
function bjView(h, res, pay, gold) {
  const over = !!res, cur = h.hands[Math.min(h.cur, h.hands.length - 1)], hd = !over && cur.p.length === 2 && !cur.dd && !cur.done;
  return { t: 'bjs', st: over ? 'done' : 'play', hands: h.hands.map(x => ({ p: x.p.slice(), bet: x.bet, res: x.res || '', pay: x.pay || 0, done: !!x.done })), cur: h.cur,
    p: cur.p.slice(), d: over ? h.d.slice() : [h.d[0]], res: res || '', bet: bjTotal(h), pay: pay || 0, gold,
    dbl: hd, spl: hd && h.hands.length === 1 && bjCV(cur.p[0]) === bjCV(cur.p[1]) };
}
function bjFinish(p, now, res, pay) {
  const h = p.bj, a = p.acct, bet = bjTotal(h);
  a.gold += pay; p.gold = a.gold; p.rewT = now; p.holdUntil = now + 3000; p.bj = null; saveUsers();
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  if (pay - bet >= BIG_WIN) setTimeout(() => broadcast({ t: 'big', n: p.name, w: pay - bet, g: 'bj' }), 1200);
  return bjView(h, res, pay, a.gold);
}
function bjResolve(p, now) {            // tüm eller bitti (ya da bağlantı koptu): kasa oynar, eller sonuçlanır
  const h = p.bj;
  for (const x of h.hands) x.done = true;
  if (h.hands.some(x => bjVal(x.p).v <= 21)) for (; ;) { const dv = bjVal(h.d); if (dv.v < 17) h.d.push(bjDraw()); else break; }   // kasa tüm 17'lerde (yumuşak dahil) durur
  const dv = bjVal(h.d).v; let pay = 0;
  for (const x of h.hands) {
    const pv = bjVal(x.p).v;
    if (pv > 21) { x.res = 'bust'; x.pay = 0; }
    else if (dv > 21) { x.res = 'dbust'; x.pay = x.bet * 2; }
    else if (pv > dv) { x.res = 'win'; x.pay = x.bet * 2; }
    else if (pv < dv) { x.res = 'lose'; x.pay = 0; }
    else { x.res = 'push'; x.pay = x.bet; }
    pay += x.pay;
  }
  return bjFinish(p, now, h.hands.length > 1 ? 'split' : h.hands[0].res, pay);
}
const bjStand = bjResolve;
function bjAdvance(p, now) {
  const h = p.bj;
  while (h.cur < h.hands.length && h.hands[h.cur].done) h.cur++;
  if (h.cur >= h.hands.length) return bjResolve(p, now);
  return bjView(h, '', 0, p.acct.gold);
}
function bjStart(p, m, now) {
  const a = p.acct, c = p.conn, bet = Math.floor(Number(m.a));
  if (!(bet >= MIN_BET && bet <= MAX_BET)) return;
  if (bet > LIM.bj) return c.send({ t: 'berr', c: 'max', gold: a.gold });
  if (bet > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
  p.betT = now + BJ_GAP; p.holdUntil = now + 8000;
  a.gold -= bet; p.gold = a.gold; wagerAdd(a, bet, 'bj');
  const h = { hands: [{ p: [bjDraw(), bjDraw()], bet, dd: false, done: false }], d: [bjDraw(), bjDraw()], cur: 0 };
  p.bj = h; saveUsers();
  const x = h.hands[0], pn = bjVal(x.p).v === 21, dn = bjVal(h.d).v === 21;
  if (pn && dn) { x.res = 'push'; x.pay = bet; return tx(p, bjFinish(p, now, 'push', bet)); }
  if (pn) { x.res = 'bj'; x.pay = Math.floor(bet * 2.5); return tx(p, bjFinish(p, now, 'bj', x.pay)); }
  if (dn) { x.res = 'lose'; x.pay = 0; return tx(p, bjFinish(p, now, 'lose', 0)); }
  tx(p, bjView(h, '', 0, a.gold));
}
function bjAct(p, m, now) {
  const h = p.bj, c = p.conn, a = p.acct;
  if (!h) return c.send({ t: 'berr', c: 'nogame', gold: a.gold });
  p.holdUntil = now + 8000;
  const x = h.hands[h.cur], act = m.a;
  if (!x || x.done) return;
  if (act === 'hit') {
    x.p.push(bjDraw()); if (bjVal(x.p).v >= 21) x.done = true;               // 21 ya da batma: el biter
    return tx(p, bjAdvance(p, now));
  }
  if (act === 'stand') { x.done = true; return tx(p, bjAdvance(p, now)); }
  if (act === 'double') {
    if (x.p.length !== 2 || x.dd) return;
    if (x.bet > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
    a.gold -= x.bet; p.gold = a.gold; wagerAdd(a, x.bet, 'bj'); x.bet *= 2; x.dd = true; x.p.push(bjDraw()); x.done = true;
    return tx(p, bjAdvance(p, now));
  }
  if (act === 'split') {                                                      // aynı değerdeki iki kart, bir kez bölünebilir
    if (h.hands.length !== 1 || x.p.length !== 2 || x.dd || bjCV(x.p[0]) !== bjCV(x.p[1])) return;
    if (x.bet > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
    a.gold -= x.bet; p.gold = a.gold; wagerAdd(a, x.bet, 'bj');
    const aces = bjCV(x.p[0]) === 11, h1 = { p: [x.p[0], bjDraw()], bet: x.bet, dd: false, done: false }, h2 = { p: [x.p[1], bjDraw()], bet: x.bet, dd: false, done: false };
    h.hands = [h1, h2]; h.cur = 0;
    for (const q of [h1, h2]) if (aces || bjVal(q.p).v === 21) q.done = true;   // As bölünürse her ele tek kart; bölünmüş elde 21 blackjack sayılmaz
    return tx(p, bjAdvance(p, now));
  }
}

/* ---------- mines (sunucu hakemlidir) ---------- */
// 5x5 tahta · her güvenli karede çarpan artar · %5 kasa payı · en fazla x100
const MN_RTP = 0.93, MN_CAP = 1000, MN_N = 25;      // %93 geri dönüş, en fazla x1000
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
  if (!(bet >= MIN_BET && bet <= MAX_BET) || !(mc >= 1 && mc <= 24)) return;
  if (bet > LIM.mn) return c.send({ t: 'berr', c: 'max', gold: a.gold });
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

/* ---------- KASALAR: içinden coin çıkar, sonuç sunucuda belirlenir (RTP ~%93) ---------- */
const CASE_TBL = [{"p":230,"o":[70,25,5,0,0],"z":[[80,0],[134,0],[187,0],[241,1],[321,1],[401,1],[535,2],[937,2],[1338,2]],"w":[70,70,70,25,25,25,5,5,5]},{"p":450,"o":[45,35,17,3,0],"z":[[94,0],[165,0],[236,0],[283,1],[378,1],[496,1],[614,2],[850,2],[1133,2],[1416,3],[2361,3],[3777,3]],"w":[45,45,45,35,35,35,17,17,17,3,3,3]},{"p":750,"o":[20,40,30,9,1],"z":[[77,0],[128,0],[179,0],[204,1],[306,1],[434,1],[510,2],[765,2],[1020,2],[1275,3],[2040,3],[3060,3],[6120,4],[12751,4],[25502,4]],"w":[20,20,20,40,40,40,30,30,30,9,9,9,1,1,1]},{"p":1350,"o":[5,25,40,25,5],"z":[[64,0],[96,0],[129,0],[161,1],[257,1],[386,1],[450,2],[643,2],[900,2],[1157,3],[1799,3],[2892,3],[4499,4],[7712,4],[16066,4]],"w":[5,5,5,25,25,25,40,40,40,25,25,25,5,5,5]},{"p":2250,"o":[0,10,30,40,20],"z":[[129,1],[194,1],[290,1],[323,2],[484,2],[710,2],[904,3],[1420,3],[2259,3],[3227,4],[5809,4],[11618,4]],"w":[10,10,10,30,30,30,40,40,40,20,20,20]}];   // p: fiyat · o: bant yüzdeleri · z: [ödül, bant] · w: ağırlık
const CASE_GAP = 6000;
function caseMsg(p, m, now) {
  const a = p.acct, c = p.conn;
  if (m.a !== 'open') return;
  if (p.st[6] !== 'casino') return c.send({ t: 'berr', c: 'zone', gold: a.gold });
  if (now < (p.caseT || 0) || now < p.betT) return c.send({ t: 'berr', c: 'fast', gold: a.gold });
  if (p.bj || p.mn || p.tw) return c.send({ t: 'berr', c: 'busy', gold: a.gold });
  const i = Math.floor(Number(m.i)), cs = CASE_TBL[i];
  if (!cs) return;
  if (cs.p > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
  p.caseT = now + CASE_GAP; p.holdUntil = now + 8000;
  const tw = cs.w.reduce((s, x) => s + x, 0); let r = crypto.randomInt(tw), k = 0;
  while (r >= cs.w[k]) { r -= cs.w[k]; k++; }
  const amt = cs.z[k][0], rar = cs.z[k][1];
  a.gold += amt - cs.p; p.gold = a.gold; p.rewT = now; wagerAdd(a, cs.p, 'case'); saveUsers();
  c.send({ t: 'cres', i, a: amt, r: rar, bet: cs.p, gold: a.gold });
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  if (amt - cs.p >= BIG_WIN) setTimeout(() => broadcast({ t: 'big', n: p.name, w: amt - cs.p, g: 'case' }), 5400);
}

/* ---------- TOWERS: her katta güvenli kareyi seç, çarpan yüksel, istediğinde çek ---------- */
const TW_FL = 8, TW_RTP = 0.94, TW_CAP = 1000;      // %94 geri dönüş, en fazla x1000
const TW_MODES = { easy: [4, 1], medium: [3, 1], hard: [2, 1], extreme: [3, 2] };   // [kare sayısı, bomba sayısı]
function twMult(d, k) { if (k <= 0) return 1; const n = TW_MODES[d][0], b = TW_MODES[d][1]; return Math.min(TW_CAP, Math.floor(TW_RTP * Math.pow(n / (n - b), k) * 100) / 100); }
function twView(g, st, hit, pay, gold) {
  const k = g.picks.length, md = TW_MODES[g.d];
  return { t: 'tws', st, d: g.d, n: md[0], b: md[1], fl: TW_FL, bet: g.bet, picks: g.picks.slice(), mult: twMult(g.d, k), next: st === 'play' && k < TW_FL ? twMult(g.d, k + 1) : 0,
    hit: hit == null ? -1 : hit, bombs: st === 'play' ? null : g.bombs.map(s => [...s]), pay: pay || 0, gold };
}
function twFinish(p, now, st, hit) {
  const g = p.tw, a = p.acct;
  const pay = st === 'cash' ? Math.floor(g.bet * twMult(g.d, g.picks.length)) : 0;
  a.gold += pay; p.gold = a.gold; p.rewT = now; p.holdUntil = now + 3000; p.tw = null; saveUsers();
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  if (pay - g.bet >= BIG_WIN) setTimeout(() => broadcast({ t: 'big', n: p.name, w: pay - g.bet, g: 'towers' }), 1200);
  return twView(g, st, hit, pay, a.gold);
}
function twStart(p, m, now) {
  const a = p.acct, c = p.conn, bet = Math.floor(Number(m.a)), d = String(m.d);
  if (!(bet >= MIN_BET && bet <= MAX_BET) || !TW_MODES[d]) return;
  if (bet > LIM.tw) return c.send({ t: 'berr', c: 'max', gold: a.gold });
  if (bet > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
  p.betT = now + MN_GAP; p.holdUntil = now + 8000;
  a.gold -= bet; p.gold = a.gold; wagerAdd(a, bet, 'towers');
  const n = TW_MODES[d][0], b = TW_MODES[d][1], bombs = [];
  for (let f = 0; f < TW_FL; f++) {
    const idx = []; for (let i = 0; i < n; i++) idx.push(i);
    for (let i = n - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    bombs.push(new Set(idx.slice(0, b)));
  }
  p.tw = { bet, d, bombs, picks: [] };
  saveUsers();
  c.send(twView(p.tw, 'play', null, 0, a.gold));
}
function twAct(p, m, now) {
  const g = p.tw, c = p.conn, a = p.acct;
  if (!g) return c.send({ t: 'berr', c: 'nogame', gold: a.gold });
  p.holdUntil = now + 8000;
  if (m.a === 'cash') { if (!g.picks.length) return; return c.send(twFinish(p, now, 'cash')); }
  if (m.a !== 'pick') return;
  const i = Math.floor(Number(m.i)), n = TW_MODES[g.d][0];
  if (!(i >= 0 && i < n)) return;
  if (g.bombs[g.picks.length].has(i)) return c.send(twFinish(p, now, 'lost', i));
  g.picks.push(i);
  if (g.picks.length >= TW_FL || twMult(g.d, g.picks.length) >= TW_CAP) return c.send(twFinish(p, now, 'cash'));
  c.send(twView(g, 'play', null, 0, a.gold));
}

/* ---------- DICE: hedef şansı seç, üstü/altı, sonuç sunucuda ---------- */
const DICE_RTP = 95;                    // %95 geri dönüş, şans 0,01–94
function diceBet(p, m, now) {
  const a = p.acct, c = p.conn, bet = Math.floor(Number(m.a)), ch = Math.round(Number(m.c) * 100) / 100, o = m.o === 'over' ? 'over' : 'under';
  if (!(bet >= MIN_BET && bet <= MAX_BET) || !(ch >= 0.01 && ch <= 94)) return;
  if (bet > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
  p.betT = now + 1200; p.holdUntil = now + 3000;
  const roll = crypto.randomInt(0, 10000), cI = Math.round(ch * 100);
  const win = o === 'under' ? roll < cI : roll >= 10000 - cI;
  const mult = Math.floor(DICE_RTP / ch * 10000) / 10000, pay = win ? Math.floor(bet * mult) : 0;
  a.gold += pay - bet; p.gold = a.gold; p.rewT = now; wagerAdd(a, bet, 'dice'); saveUsers();
  c.send({ t: 'dres', roll: roll / 100, win, mult, bet, pay, gold: a.gold, o, c: ch });
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  if (pay - bet >= BIG_WIN) setTimeout(() => broadcast({ t: 'big', n: p.name, w: pay - bet, g: 'dice' }), 1500);
}

/* ---------- COINFLIP: kasaya karşı ya da oyuncular arasında ---------- */
const CF_HOUSE = 1.96, CF_FEE = 0.05, CF_MAX_OPEN = 3, CF_TTL = 15 * 60000;
function cfHouse(p, m, now) {
  const a = p.acct, c = p.conn, bet = Math.floor(Number(m.a)), side = m.s === 't' ? 't' : 'h';
  if (!(bet >= MIN_BET && bet <= MAX_BET)) return;
  if (bet > a.gold) return c.send({ t: 'berr', c: 'poor', gold: a.gold });
  p.betT = now + 1500; p.holdUntil = now + 3500;
  const res = crypto.randomInt(2) ? 't' : 'h', win = res === side, pay = win ? Math.floor(bet * CF_HOUSE) : 0;
  a.gold += pay - bet; p.gold = a.gold; p.rewT = now; wagerAdd(a, bet, 'cf'); saveUsers();
  c.send({ t: 'cfs', k: 'house', side, res, win, bet, pay, gold: a.gold });
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  if (pay - bet >= BIG_WIN) setTimeout(() => broadcast({ t: 'big', n: p.name, w: pay - bet, g: 'cf' }), 2200);
}
const CF = new Map();       // id -> { id, pid, key, name, bet, side, at }
let cfNext = 1;
const cfView = () => [...CF.values()].sort((x, y) => y.at - x.at).slice(0, 40).map(e => ({ id: e.id, n: e.name, bet: e.bet, side: e.side, at: e.at }));
function cfCast() { const msg = { t: 'cfl', list: cfView() }; for (const q of players.values()) if (q.st[6] === 'casino') q.conn.send(msg); }
function cfCancelAll(p, quiet) {
  let any = false;
  for (const e of [...CF.values()]) if (e.pid === p.id) { p.acct.gold += e.bet; p.gold = p.acct.gold; CF.delete(e.id); any = true; }
  if (any) { saveUsers(); if (!quiet) { cfCast(); p.conn.send({ t: 'cfl', list: cfView(), gold: p.acct.gold }); } }
}
function cfMsg(p, m, now) {
  const a = p.acct, c = p.conn;
  if (m.a === 'list') return c.send({ t: 'cfl', list: cfView(), gold: a.gold });
  if (p.st[6] !== 'casino') return c.send({ t: 'cferr', c: 'zone' });
  if (now < (p.cfT || 0)) return c.send({ t: 'cferr', c: 'fast' });
  p.cfT = now + 800;
  if (m.a === 'create') {
    const bet = Math.floor(Number(m.bet)), side = m.side === 't' ? 't' : 'h';
    if (!(bet >= MIN_BET && bet <= MAX_BET)) return;
    if (bet > a.gold) return c.send({ t: 'cferr', c: 'poor', gold: a.gold });
    if ([...CF.values()].filter(e => e.pid === p.id).length >= CF_MAX_OPEN || CF.size >= 60) return c.send({ t: 'cferr', c: 'many' });
    a.gold -= bet; p.gold = a.gold; p.holdUntil = now + 4000; saveUsers();                // bahis emanete alınır
    const id = 'f' + (cfNext++);
    CF.set(id, { id, pid: p.id, name: p.name, bet, side, at: now });
    broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
    cfCast(); return c.send({ t: 'cfl', list: cfView(), gold: a.gold });
  }
  if (m.a === 'cancel') {
    const e = CF.get(String(m.id));
    if (!e || e.pid !== p.id) return;
    a.gold += e.bet; p.gold = a.gold; p.holdUntil = now + 4000; saveUsers(); CF.delete(e.id);
    broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
    cfCast(); return c.send({ t: 'cfl', list: cfView(), gold: a.gold });
  }
  if (m.a === 'join') {
    const e = CF.get(String(m.id)), cr = e && players.get(e.pid);
    if (!e || !cr) return c.send({ t: 'cferr', c: 'gone' });
    if (e.pid === p.id) return c.send({ t: 'cferr', c: 'own' });
    if (e.bet > a.gold) return c.send({ t: 'cferr', c: 'poor', gold: a.gold });
    CF.delete(e.id);
    a.gold -= e.bet; wagerAdd(a, e.bet, 'cfp'); wagerAdd(cr.acct, e.bet, 'cfp');
    const res = crypto.randomInt(2) ? 't' : 'h', crWin = res === e.side, pot = e.bet * 2, fee = Math.floor(pot * CF_FEE), prize = pot - fee;
    const winner = crWin ? cr : p, loser = crWin ? p : cr;
    winner.acct.gold += prize; winner.gold = winner.acct.gold; loser.gold = loser.acct.gold; p.gold = a.gold;
    for (const q of [cr, p]) { q.holdUntil = now + 4000; q.rewT = now; }
    saveUsers();
    for (const q of [cr, p]) q.conn.send({ t: 'cfr', res, cname: cr.name, jname: p.name, cside: e.side, bet: e.bet, pot, fee, win: prize, winner: winner.name, you: q === winner ? 'win' : 'lose', gold: q.acct.gold });
    for (const q of [cr, p]) broadcast({ t: 'me', id: q.id, eq: q.eq, gold: q.gold }, q.id);
    cfCast();
    if (prize - e.bet >= BIG_WIN) setTimeout(() => broadcast({ t: 'big', n: winner.name, w: prize - e.bet, g: 'cf' }), 2500);
    return;
  }
}
setInterval(() => {            // süresi dolan ilanlar emanetle birlikte geri verilir
  const now = Date.now(); let any = false;
  for (const e of [...CF.values()]) if (now - e.at > CF_TTL) {
    const q = players.get(e.pid); CF.delete(e.id); any = true;
    if (q) { q.acct.gold += e.bet; q.gold = q.acct.gold; q.holdUntil = now + 3000; q.conn.send({ t: 'cfl', list: cfView(), gold: q.acct.gold }); }
  }
  if (any) { saveUsers(); cfCast(); }
}, 30000).unref();

/* ---------- KASA SAVAŞI (bodrum): 2 arena · 1v1 / 2v2 · rakip oyuncu ya da bot ·
   herkes kasaları aynı anda açar, kazanan takım tüm kasalardan çıkan değeri paylaşır (RTP kasalarla aynı ~%96) ---------- */
const BTK = Number(process.env.BT_FAST) || 1;          // yalnızca test için hızlandırma
const BT_START = 3500 / BTK, BT_ROUND = 8000 / BTK, BT_END = 7000 / BTK, BT_HOLD = 9000 / BTK, BT_MAXR = 6, BT_TTL = 5 * 60000;
const BT_BOTS = ['Kukla Ali', 'Kukla Ece', 'Kukla Mert', 'Kukla Defne', 'Kukla Can', 'Kukla Elif', 'Kukla Baran', 'Kukla Selin', 'Kukla Kaan', 'Kukla Naz'];
const BT_POS = [{ x: -33.2, z: -64.25 }, { x: 33.2, z: -64.25 }];
const BT = [null, null]; let btNext = 1;
const btSlots = b => (b.md === 2 ? [0, 2] : [0, 1, 2, 3]);
const btHumans = b => btSlots(b).map(s => b.sl[s]).filter(x => x && !x.bot);
const btHolds = a => BT.some(b => b && btHumans(b).some(x => x.a === a));
function btRoll(ci) {
  const cs = CASE_TBL[ci], tw = cs.w.reduce((s, x) => s + x, 0); let r = crypto.randomInt(tw), k = 0;
  while (r >= cs.w[k]) { r -= cs.w[k]; k++; }
  return [cs.z[k][0], cs.z[k][1]];
}
function btView(b, now) {
  if (!b) return null;
  const v = { id: b.id, md: b.md, cs: b.csAll || b.cs, fee: b.fee, st: b.st, own: b.own, tb: b.tb || 0, sl: [0, 1, 2, 3].map(s => { const x = b.sl[s]; return x ? { n: x.n, b: x.bot ? 1 : 0, i: x.pid || 0 } : null; }) };
  if (b.st !== 'open') { v.rd = b.rd; v.el = now - b.t0; if (b.st === 'done') { v.win = b.win; v.pay = b.pay; } }
  return v;
}
function btCast() {
  const now = Date.now(), msg = { t: 'bts', a: [btView(BT[0], now), btView(BT[1], now)] };
  for (const q of players.values()) if (q.st[6] === 'pit') q.conn.send(msg);
}
function btGold(p, now) { p.gold = p.acct.gold; p.holdUntil = Math.max(p.holdUntil || 0, now + 3000); p.rewT = now; p.conn.send({ t: 'btg', gold: p.acct.gold }); broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id); }
function btTake(p, b, now) { const a = p.acct; a.gold -= b.fee; a.btEsc = (a.btEsc || 0) + b.fee; btGold(p, now); }          // katılım ücreti emanete alınır
function btGive(x, b, now) {                                                                                                  // emanet iadesi
  x.a.gold += b.fee; x.a.btEsc = Math.max(0, (x.a.btEsc || 0) - b.fee);
  const q = players.get(x.pid); if (q && q.acct === x.a) { q.btAr = null; btGold(q, now); }
}
function btCancel(b) {
  const now = Date.now();
  for (const x of btHumans(b)) btGive(x, b, now);
  BT[b.ar] = null; saveUsers(); btCast();
}
function btLeave(p) {
  if (p.btAr == null) return;
  const b = BT[p.btAr];
  if (!b) { p.btAr = null; return; }
  if (b.st === 'done' || b.st === 'run') { if (b.st === 'done') p.btAr = null; return; }
  if (b.own === p.id) return btCancel(b);
  const s = btSlots(b).find(k => b.sl[k] && b.sl[k].pid === p.id);
  if (s != null) { btGive(b.sl[s], b, Date.now()); b.sl[s] = null; saveUsers(); btCast(); }
  p.btAr = null;
}
function btStart(b, now) {
  const sl = btSlots(b);
  b.st = 'run'; b.t0 = now; b.rd = []; b.csAll = b.cs.slice(); b.tb = 0;
  const roll = ci => { const r = [null, null, null, null]; for (const s of sl) r[s] = btRoll(ci); return r; };
  const tots = () => { const t = [0, 0]; for (const rr of b.rd) for (const s of sl) t[s >> 1] += rr[s][0]; return t; };
  for (const ci of b.cs) b.rd.push(roll(ci));
  const cheap = b.cs.reduce((m, c) => (CASE_TBL[c].p < CASE_TBL[m].p ? c : m), b.cs[0]);
  let t = tots();
  while (t[0] === t[1] && b.tb < 3) { b.csAll.push(cheap); b.rd.push(roll(cheap)); b.tb++; t = tots(); }
  const dur = BT_START + b.rd.length * BT_ROUND + BT_END; b.end = now + dur;
  for (const x of btHumans(b)) { wagerAdd(x.a, b.fee, 'case'); const q = players.get(x.pid); if (q) { q.holdUntil = b.end + 3000; q.pfLock = b.end + 2500; } }
  saveUsers(); btCast();
  setTimeout(() => btFinish(b), dur);
}
function btFinish(b) {
  const now = Date.now(), sl = btSlots(b), own = [0, 0, 0, 0], tt = [0, 0], ta = [0, 0], nb = b.cs.length;
  b.rd.forEach((rr, k) => { for (const s of sl) { ta[s >> 1] += rr[s][0]; if (k < nb) { own[s] += rr[s][0]; tt[s >> 1] += rr[s][0]; } } });   // ek (beraberlik) kasalar yalnızca kazananı belirler, ödül havuzuna girmez
  const V = tt[0] + tt[1], win = ta[0] > ta[1] ? 0 : ta[1] > ta[0] ? 1 : -1;
  const ws = win < 0 ? [] : sl.filter(s => (s >> 1) === win), per = ws.length ? Math.floor(V / ws.length) : 0;
  b.win = win; b.pay = win < 0 ? 0 : per; b.st = 'done';
  for (const s of sl) {
    const x = b.sl[s]; if (!x || x.bot) continue;
    const pay = win < 0 ? own[s] : (ws.includes(s) ? per : 0);
    x.a.btEsc = Math.max(0, (x.a.btEsc || 0) - b.fee); x.a.gold += pay;
    const q = players.get(x.pid);
    if (q && q.acct === x.a) {
      q.btAr = null; q.gold = x.a.gold; q.holdUntil = now + 3500; q.rewT = now;
      q.conn.send({ t: 'btr', ar: b.ar, res: win < 0 ? 'draw' : (ws.includes(s) ? 'win' : 'lose'), pay, fee: b.fee, gold: x.a.gold });
      broadcast({ t: 'me', id: q.id, eq: q.eq, gold: q.gold }, q.id);
    }
    if (pay - b.fee >= BIG_WIN) broadcast({ t: 'big', n: x.n, w: pay - b.fee, g: 'case' });
  }
  saveUsers(); btCast();
  setTimeout(() => { if (BT[b.ar] === b) { BT[b.ar] = null; btCast(); } }, BT_HOLD);
}
function btMsg(p, m, now) {
  const c = p.conn, a = p.acct;
  if (m.a === 'info') return c.send({ t: 'bts', a: [btView(BT[0], now), btView(BT[1], now)] });
  if (p.st[6] !== 'pit') return c.send({ t: 'bterr', c: 'zone' });
  if (now < (p.btT || 0)) return c.send({ t: 'bterr', c: 'fast' });
  p.btT = now + 350;
  const ar = Math.floor(Number(m.ar));
  if (!(ar === 0 || ar === 1)) return;
  if (Math.hypot(p.st[0] - BT_POS[ar].x, p.st[2] - BT_POS[ar].z) > 26) return c.send({ t: 'bterr', c: 'far' });
  const b = BT[ar], err = code => c.send({ t: 'bterr', c: code });
  if (m.a === 'new') {
    if (b) return err('busy');
    if (p.btAr != null && BT[p.btAr]) return err('own');
    const md = m.md === 4 ? 4 : m.md === 2 ? 2 : 0, cs = Array.isArray(m.cs) ? m.cs.map(x => Math.floor(Number(x))) : [];
    if (!md || cs.length < 1 || cs.length > BT_MAXR || cs.some(x => !CASE_TBL[x])) return err('bad');
    const fee = cs.reduce((s, x) => s + CASE_TBL[x].p, 0);
    if (fee > a.gold) return c.send({ t: 'bterr', c: 'poor', gold: a.gold });
    const nb = { id: btNext++, ar, md, cs, fee, own: p.id, st: 'open', sl: [null, null, null, null], at: now };
    nb.sl[0] = { pid: p.id, n: p.name, bot: 0, a };
    BT[ar] = nb; p.btAr = ar; btTake(p, nb, now); saveUsers(); return btCast();
  }
  if (!b) return err('none');
  if (m.a === 'join') {
    const s = Math.floor(Number(m.s));
    if (b.st !== 'open') return err('busy');
    if (!btSlots(b).includes(s) || b.sl[s]) return err('full');
    if (p.btAr != null && BT[p.btAr]) return err('own');
    if (b.fee > a.gold) return c.send({ t: 'bterr', c: 'poor', gold: a.gold });
    b.sl[s] = { pid: p.id, n: p.name, bot: 0, a }; p.btAr = ar; btTake(p, b, now); saveUsers(); return btCast();
  }
  if (m.a === 'leave') { if (b.st !== 'open') return; return btLeave(p); }
  if (b.own !== p.id || b.st !== 'open') return err('own2');
  if (m.a === 'cancel') return btCancel(b);
  if (m.a === 'bot') {
    const s = Math.floor(Number(m.s));
    if (!btSlots(b).includes(s) || b.sl[s]) return err('full');
    const used = new Set(b.sl.filter(x => x).map(x => x.n)), nm = BT_BOTS.filter(n => !used.has(n));
    b.sl[s] = { pid: 0, n: nm[crypto.randomInt(nm.length)], bot: 1 }; return btCast();
  }
  if (m.a === 'fill' || m.a === 'go') {
    const emp = btSlots(b).filter(s => !b.sl[s]);
    if (m.a === 'go' && emp.length) return err('notfull');
    const used = new Set(b.sl.filter(x => x).map(x => x.n)), nm = BT_BOTS.filter(n => !used.has(n));
    for (const s of emp) { const i = crypto.randomInt(nm.length); b.sl[s] = { pid: 0, n: nm[i], bot: 1 }; nm.splice(i, 1); }
    return btStart(b, now);
  }
}
setInterval(() => {            // uzun süre dolmayan battle iptal edilir, emanetler iade olur
  const now = Date.now();
  for (const b of BT) if (b && b.st === 'open' && now - b.at > BT_TTL) btCancel(b);
}, 20000).unref();

function gamesAbort(p) {            // oyuncu bağlantısı koptuysa açık eller sonuçlanır
  const now = Date.now();
  try {
    if (p.bj) bjStand(p, now);
    if (p.mn) { if (p.mn.rev.length) mnFinish(p, now, 'cash'); else { p.acct.gold += p.mn.bet; p.gold = p.acct.gold; p.mn = null; saveUsers(); } }
    if (p.tw) { if (p.tw.picks.length) twFinish(p, now, 'cash'); else { p.acct.gold += p.tw.bet; p.gold = p.acct.gold; p.tw = null; saveUsers(); } }
    cfCancelAll(p, true);
    btLeave(p);
  } catch (e) { }
}

function doBet(p, m, now) {
  const a = p.acct, c = p.conn;
  if (p.st[6] !== 'casino') return c.send({ t: 'berr', c: 'zone', gold: a.gold });
  if (now < p.betT) return c.send({ t: 'berr', c: 'fast', gold: a.gold });
  if (p.bj || p.mn || p.tw) return c.send({ t: 'berr', c: 'busy', gold: a.gold });
  if (m.g === 'towers') return twStart(p, m, now);
  if (m.g === 'dice') return diceBet(p, m, now);
  if (m.g === 'cf') return cfHouse(p, m, now);
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
      if (!(amt >= MIN_BET && amt <= MAX_BET)) return;
      const v = b.k === 'n' ? Math.floor(Number(b.v)) : 0;
      if (b.k === 'n' && !(v >= 0 && v <= 36)) return;
      bets.push({ k: b.k, v, a: amt }); total += amt;
    }
    if (total > MAX_TOTAL) return;
    if (!rouChk(bets)) return c.send({ t: 'berr', c: 'max', gold: a.gold });
  } else if (m.g === 'wof') {
    total = Math.floor(Number(m.a));
    if (!(total >= MIN_BET && total <= MAX_BET)) return;
    if (total > LIM.wof) return c.send({ t: 'berr', c: 'max', gold: a.gold });
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
function rrPl() {                                   // renklere göre bahisler: r=kırmızı, g=yeşil, b=siyah (düz sayı ve renk bahisleri)
  const o = { r: [], g: [], b: [], t: { r: 0, g: 0, b: 0 } };
  for (const e of RR.bets.values()) {
    const s = { r: 0, g: 0, b: 0 };
    for (const b of e.bets) {
      if (b.k === 'red') s.r += b.a; else if (b.k === 'black') s.b += b.a;
      else if (b.k === 'n') { if (b.v === 0) s.g += b.a; else if (RED.has(b.v)) s.r += b.a; else s.b += b.a; }
    }
    for (const k of ['r', 'g', 'b']) if (s[k] > 0) { o[k].push([e.p.name, s[k]]); o.t[k] += s[k]; }
  }
  for (const k of ['r', 'g', 'b']) { o[k].sort((a, b) => b[1] - a[1]); o[k] = o[k].slice(0, 5); }
  return o;
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
    if (!(amt >= MIN_BET && amt <= MAX_BET)) return;
    const v = b.k === 'n' ? Math.floor(Number(b.v)) : 0;
    if (b.k === 'n' && !(v >= 0 && v <= 36)) return;
    bets.push({ k: b.k, v, a: amt }); total += amt;
  }
  if (total > MAX_TOTAL) return;
  if (!rouChk(bets)) return p.conn.send({ t: 'berr', c: 'max', gold: p.acct.gold });
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
const CRYPTOS = [['TRX', 'TRON', 'TRON'], ['BTC', 'Bitcoin', 'Bitcoin'], ['ETH', 'Ethereum', 'ERC20'], ['BNB', 'BNB', 'BEP20'], ['USDT', 'Tether', 'ERC20'], ['USDTB', 'Tether', 'BEP20'], ['USDTS', 'Tether', 'Solana'], ['USDTP', 'Tether', 'Polygon'], ['LTC', 'Litecoin', 'Litecoin'], ['SOL', 'Solana', 'Solana'], ['XRP', 'XRP', 'XRP Ledger'], ['DOGE', 'Dogecoin', 'Dogecoin']];
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
/* ---------- NOWPayments (isteğe bağlı): her ödeme için kişiye özel adres + otomatik onay ----------
 * NOWPAY_API_KEY, NOWPAY_IPN_SECRET, PUBLIC_URL (https://siten.com) üçü de doluysa otomatik mod açılır; değilse eski elle onay sistemi çalışır.
 * NOWPAY_USDT: USDT ağı (varsayılan usdttrc20; usdterc20, usdtbsc ... da olabilir)
 * NOWPAY_OUT: (isteğe bağlı) NOWPayments panelinde çıkış cüzdanı olarak seçtiğin coin (trx, ltc, usdttrc20 ...); minimumlar bu çifte göre hesaplanır */
const NP_KEY = process.env.NOWPAY_API_KEY || '', NP_SECRET = process.env.NOWPAY_IPN_SECRET || '';
const NP_API = (process.env.NOWPAY_API_URL || 'https://api.nowpayments.io/v1').replace(/\/+$/, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const NP_ON = !!(NP_KEY && NP_SECRET && /^https?:\/\/[^\s/]+/.test(PUBLIC_URL));
const NP_USDT = (process.env.NOWPAY_USDT || 'usdttrc20').toLowerCase();
const NP_OUTS = (process.env.NOWPAY_OUT || '').toLowerCase().split(/[,\s]+/).map(x => x.replace(/[^a-z0-9]/g, '')).filter(Boolean), NP_OUT = NP_OUTS.join(',');   // NOWPayments panelindeki ÇIKIŞ cüzdanı coin(ler)i, öncelik sırasıyla (ör. trx veya trx,ltc): ödeme coini listedeyse takas yok, değilse ilk coine çevrilir
const NP_CUR = { TRX: ['trx', 'TRON'], BTC: ['btc', 'Bitcoin'], ETH: ['eth', 'ERC20'], BNB: ['bnbbsc', 'BEP20'],
  USDT: [NP_USDT, /erc20$/.test(NP_USDT) ? 'ERC20' : /bsc$|bep20$/.test(NP_USDT) ? 'BEP20' : 'TRC20'],
  USDTB: ['usdtbsc', 'BEP20'], USDTS: ['usdtsol', 'Solana'], USDTP: ['usdtmatic', 'Polygon'],
  LTC: ['ltc', 'Litecoin'], SOL: ['sol', 'Solana'], XRP: ['xrp', 'XRP Ledger'], DOGE: ['doge', 'Dogecoin'] };
async function npCall(method, p, body) {
  const r = await fetch(NP_API + p, { method, headers: { 'x-api-key': NP_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { }
  if (!r.ok) { const e = new Error('NOWPayments ' + r.status + ' ' + txt.slice(0, 200)); e.np = j && j.code; throw e; }
  return j;
}
const npRound = f => Math.ceil(f * 1.03 * 10) / 10;   // minimuma %3 pay, 0,1 dolara yukarı yuvarla (9,08 -> 9,4)
const NP_MIN = {};                       // coin -> minimum yatırım (USD), 1 saat geçerli
// bir coinin gerçek minimumu (USD): önce çıkış cüzdanı çiftiyle (NOWPAY_OUT), olmazsa çiftsiz, en son eski yöntemle
async function npMinOf(c) {
  const base = '/min-amount?currency_from=' + encodeURIComponent(c) + '&fiat_equivalent=usd';
  const tgt = NP_OUTS.includes(c) ? c : NP_OUTS[0];          // cüzdanı olan coine doğrudan, diğerlerine ilk (öncelikli) cüzdanın coinine takasla
  const tries = (tgt ? [base + '&currency_to=' + encodeURIComponent(tgt)] : []).concat([base, base + '&currency_to=usd']);
  let last = null;
  for (const u of tries) {
    try { const r = await npCall('GET', u); const f = Number(r && r.fiat_equivalent); if (f > 0) return f; last = new Error('fiat_equivalent yok'); }
    catch (e) { last = e; }
  }
  throw last || new Error('minimum alınamadı');
}
async function npMinRefresh() {          // her coinin güncel minimumunu öğren, oyuncuya butonda göster
  const seen = {};
  for (const [id, np] of Object.entries(NP_CUR)) {
    try { const f = await npMinOf(np[0]); NP_MIN[id] = { v: npRound(f), t: Date.now() }; seen[id] = NP_MIN[id].v; }
    catch (e) { log('minimum sorgusu başarısız', id, String(e.message).slice(0, 120)); }
  }
  log('NOWPayments minimumları (USD' + (NP_OUT ? ', çıkış: ' + NP_OUT : ', çıkış coini NOWPAY_OUT ayarlı değil') + '):', JSON.stringify(seen));
}
const sortKeys = o => Array.isArray(o) ? o.map(sortKeys) : (o && typeof o === 'object') ? Object.keys(o).sort().reduce((r, k) => (r[k] = sortKeys(o[k]), r), {}) : o;
const depCoinsOf = usdC => Math.floor(usdC * (1 - DEP_FEE));            // 1 cent = 1 coin
const depView = (d, full) => Object.assign({ id: d.id, coin: d.coin, net: d.net, addr: d.addr, usdC: d.usdC, coins: d.coins, fee: d.usdC - (d.coinsFull || d.coins), st: d.st, at: d.at, txid: d.txid || '',
  auto: d.auto ? 1 : 0, payAmt: d.payAmt || '', memo: d.memo || '', np: d.npSt || '' }, full ? { name: d.name } : {});
const depOList = () => Object.values(deps).filter(x => x.st === 'paid' || x.st === 'open').sort((x, y) => x.at - y.at).map(x => depView(x, true));
const ownersCast = obj => { for (const q of players.values()) if (q.role === 'owner') q.conn.send(obj); };
const onlineAcct = a => { for (const q of players.values()) if (q.acct === a) return q; return null; };
const depMineOf = key => Object.values(deps).filter(d => d.key === key).sort((x, y) => y.at - x.at).slice(0, 12).map(d => depView(d));
function depCredit(d, coins, by) {     // yatırımı hesaba işler (tek seferlik); true = yattı
  const t = users[d.key]; if (!t || d.st === 'ok' || !(coins >= 1)) return false;
  const full = d.coinsFull || d.coins;
  d.coinsFull = full; d.st = 'ok'; d.upd = Date.now(); d.by = by; d.coins = coins; depSave(d);      // önce durumu kaydet: iki kez yatmasın
  t.gold += coins; t.depC = (t.depC || 0) + Math.round(d.usdC * coins / full);
  const rf = t.ref && users[t.ref];
  if (rf) { const com = Math.floor(coins * AFF_PCT); if (com > 0) { rf.gold += com; rf.affEarn = (rf.affEarn || 0) + com; const rq = onlineAcct(rf); if (rq) { rq.gold = rf.gold; pfSync(rq, { m: 'aff', n: com, who: t.name }); } } }
  saveUsers(true);
  const q = onlineAcct(t);
  if (q) { q.gold = t.gold; pfSync(q, { m: 'depok', n: coins }); broadcast({ t: 'me', id: q.id, eq: q.eq, gold: q.gold }, q.id); q.conn.send({ t: 'dep', a: 'mine', list: depMineOf(d.key) }); }
  ownersCast({ t: 'dep', a: 'olist', list: depOList() });
  logAdd('dep', by, t.name, Math.round(d.usdC * coins / full) / 100, { c: coins, coin: d.coin });
  broadcast({ t: 'dpn', n: t.name, usd: Math.round(d.usdC * coins / full) / 100 });      // herkese: "X yatırım yaptı" bildirimi (sağ alt) + para sesi
  return true;
}
// NOWPayments'tan gelen (IPN ya da sorgu) ödeme durumunu işler
function npApply(d, j) {
  if (!d || !d.auto || String(j.payment_id) !== String(d.npId)) return;
  const stt = String(j.payment_status || '');
  if (d.npSt !== stt) { d.npSt = stt; d.upd = Date.now(); depSave(d); const q = onlineAcct(users[d.key] || {}); if (q) q.conn.send({ t: 'dep', a: 'mine', list: depMineOf(d.key) }); }
  if (d.st === 'ok') return;
  if (stt === 'finished' || stt === 'partially_paid') {
    if (d.st === 'no') return log('reddedilmiş yatırıma ödeme geldi, elle bak:', d.id, stt);
    if (j.price_amount != null && Math.abs(Number(j.price_amount) - d.usdC / 100) > 0.005) return log('IPN tutarı uyuşmuyor, atlandı:', d.id, j.price_amount);
    const paid = Number(j.actually_paid), want = Number(j.pay_amount || d.payAmt);
    const ratio = stt === 'finished' ? 1 : (want > 0 && paid > 0 ? Math.min(1, paid / want) : 0);
    const coins = Math.floor((d.coinsFull || d.coins) * ratio);
    if (depCredit(d, coins, 'auto')) log('otomatik yatırım', d.name, '+' + coins, 'coin', stt === 'finished' ? '' : '(kısmi %' + Math.round(ratio * 100) + ')', d.id);
  } else if ((stt === 'failed' || stt === 'expired' || stt === 'refunded') && (d.st === 'open' || d.st === 'paid')) {
    d.st = 'no'; d.upd = Date.now(); d.by = 'auto'; depSave(d);
    const q = onlineAcct(users[d.key] || {}); if (q) q.conn.send({ t: 'dep', a: 'mine', list: depMineOf(d.key) });
    ownersCast({ t: 'dep', a: 'olist', list: depOList() });
  }
}
function npIpn(req, res) {
  const end = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain', ...SEC }); res.end(msg || ''); };
  if (!NP_ON) return end(404, '404');
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 65536) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return end(400, 'bad'); }
    const exp = crypto.createHmac('sha512', NP_SECRET).update(JSON.stringify(sortKeys(j))).digest('hex');
    if (!safeEq(String(req.headers['x-nowpayments-sig'] || ''), exp)) { log('IPN imzası geçersiz'); return end(401, 'sig'); }
    try { npApply(deps[String(j.order_id || '')], j); } catch (e) { log('IPN işleme hatası:', e.message); return end(500, 'err'); }
    end(200, 'ok');
  });
}
if (NP_ON && require.main === module) { setTimeout(npMinRefresh, 3000); setInterval(npMinRefresh, 30 * 60000).unref(); }
// IPN kaçarsa / sunucu uyuyorsa: bekleyen otomatik ödemeleri düzenli sorgula
setInterval(async () => {
  if (!NP_ON) return;
  const now = Date.now(); let n = 0;
  for (const d of Object.values(deps)) {
    if (!d.auto || !d.npId || (d.st !== 'open' && d.st !== 'cx' && d.st !== 'paid') || now - d.at > 3 * 864e5) continue;
    if (d.st === 'open' && now - d.at > 864e5 && (!d.npSt || d.npSt === 'waiting')) { d.st = 'cx'; d.upd = now; depSave(d); continue; }
    if (now - (d.chk || 0) < (now - d.at < 36e5 ? 55e3 : 6e5) || n >= 8) continue;
    d.chk = now; n++;
    try { npApply(d, await npCall('GET', '/payment/' + encodeURIComponent(d.npId))); } catch (e) { log('ödeme sorgu hatası:', e.message); }
  }
}, 30000).unref();
function depMsg(p, m, now) {
  const a = p.acct, key = a.name.toLowerCase(), c = p.conn, act = String(m.a || '');
  const err = code => c.send({ t: 'dep', a: 'err', c: code });
  if (now - (p.depT || 0) < 600) return;
  p.depT = now;
  const mine = () => Object.values(deps).filter(d => d.key === key).sort((x, y) => y.at - x.at).slice(0, 12).map(d => depView(d));
  if (act === 'info') {
    return c.send({ t: 'dep', a: 'info', rate: COIN_RATE, fee: DEP_FEE * 100, min: DEP_MIN_C / 100, max: DEP_MAX_C / 100,
      auto: NP_ON ? 1 : 0,
      coins: CRYPTOS.filter(([id]) => NP_ON || !/^USDT[BSP]$/.test(id)).map(([id, name, net]) => NP_ON ? ({ id, sym: id.startsWith('USDT') ? 'USDT' : id, name, net: NP_CUR[id] ? NP_CUR[id][1] : net, on: !!NP_CUR[id], min: NP_MIN[id] && Date.now() - NP_MIN[id].t < 36e5 ? NP_MIN[id].v : 0 }) : ({ id, name, net: (WALLETS[id] && WALLETS[id].net) || net, on: !!(WALLETS[id] && WALLETS[id].addr) })), list: mine() });
  }
  if (act === 'req') {
    if (!m.age) return err('age');
    const cr = CRYPTOS.find(x => x[0] === m.coin), w = cr && WALLETS[cr[0]];
    if (!cr || (NP_ON ? !NP_CUR[cr[0]] : (!w || !w.addr))) return err('coin');
    const usdC = Math.round(Number(m.usd) * 100);
    if (!(usdC >= DEP_MIN_C && usdC <= DEP_MAX_C)) return c.send({ t: 'dep', a: 'err', c: 'amt', mn: DEP_MIN_C / 100, mx: DEP_MAX_C / 100 });
    const open = Object.values(deps).filter(d => d.key === key && (d.st === 'open' || d.st === 'paid'));
    if (open.length >= 3) return err('many');
    const day = Object.values(deps).filter(d => d.key === key && d.st !== 'no' && d.st !== 'cx' && now - d.at < 864e5).reduce((t, d) => t + d.usdC, 0);
    if (day + usdC > DEP_DAY_C) return err('day');
    if (NP_ON) {                                     // otomatik mod: bu ödeme için kişiye özel adres iste
      if (p.depBusy) return; p.depBusy = true;
      const np = NP_CUR[cr[0]], km = NP_MIN[cr[0]];
      if (km && now - km.t < 36e5 && usdC / 100 < km.v) { p.depBusy = false; return c.send({ t: 'dep', a: 'err', c: 'min', v: km.v }); }
      const nd = { id: 'd' + now.toString(36) + crypto.randomBytes(3).toString('hex'), key, name: a.name, usdC, coins: depCoinsOf(usdC), coin: cr[0], net: np[1], addr: '', st: 'open', at: now, auto: 1 };
      npCall('POST', '/payment', { price_amount: usdC / 100, price_currency: 'usd', pay_currency: np[0], order_id: nd.id, order_description: 'BloodBet coin', ipn_callback_url: PUBLIC_URL + '/ipn/nowpayments' })
        .then(j => {
          if (!j || !j.pay_address || j.payment_id == null) throw new Error('adres/ID yok: ' + JSON.stringify(j).slice(0, 160));
          nd.addr = String(j.pay_address); nd.payAmt = String(j.pay_amount); nd.npId = String(j.payment_id); nd.npSt = String(j.payment_status || 'waiting');
          if (j.payin_extra_id) nd.memo = String(j.payin_extra_id);
          deps[nd.id] = nd; depSave(nd);
          ownersCast({ t: 'dep', a: 'new', d: depView(nd, true) });
          log('otomatik yatırım adresi açıldı', a.name, '$' + usdC / 100, cr[0], nd.id, 'np#' + nd.npId);
          c.send({ t: 'dep', a: 'made', d: depView(nd), list: mine() });
        })
        .catch(async e => {
          log('NOWPayments hatası:', e.message);
          if (e.np !== 'AMOUNT_MINIMAL_ERROR') return c.send({ t: 'dep', a: 'err', c: 'gw', m: String(e.message).slice(0, 160) });
          let v = 0;                                   // gerçek minimumu (USD) öğrenip oyuncuya göster
          try { v = npRound(await npMinOf(np[0])) || 0; } catch (x) { log('minimum sorgusu başarısız:', x.message); }
          if (v > usdC / 100) NP_MIN[cr[0]] = { v, t: Date.now() };
          c.send({ t: 'dep', a: 'err', c: 'min', v: v > usdC / 100 ? v : 0 });
        })
        .finally(() => { p.depBusy = false; });
      return;
    }
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
    if (d.st !== 'open' || d.auto) return err('state');
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
      if (!users[d.key] || !depCredit(d, d.coins, p.name)) return err('none');
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
const DW_R = [2, 10, 4, 20, 6, 50, 12, 30], DW_W = { 2: 25, 4: 22, 6: 16, 10: 14, 12: 9, 20: 7, 30: 4, 50: 3 };   // dilim sırası istemcidekiyle aynı
const DW_MIN_TIER = 1, DW_MS = 864e5;
function dwMsg(p, m, now) {                          // günlük çark: en az Tier 1, 24 saatte bir; sonucu sunucu belirler
  const a = p.acct, c = p.conn, act = String(m.a || '');
  if (now - (p.dwRt || 0) < 400) return; p.dwRt = now;
  const tier = tierOf(a.wag || 0), left = Math.max(0, DW_MS - (now - (a.dwT || 0)));
  if (act === 'info') return c.send({ t: 'dw', a: 'info', tier, left: a.dwT ? left : 0, min: DW_MIN_TIER });
  if (act === 'reset') { if (p.role !== 'owner') return; a.dwT = 0; saveUsers(); return c.send({ t: 'dw', a: 'info', tier, left: 0, min: DW_MIN_TIER }); }
  if (act !== 'spin') return;
  if (tier < DW_MIN_TIER) return c.send({ t: 'dw', a: 'tier', tier, min: DW_MIN_TIER });
  if (a.dwT && left > 0) return c.send({ t: 'dw', a: 'wait', left, tier, min: DW_MIN_TIER });
  let x = crypto.randomInt(0, DW_R.reduce((t, v) => t + DW_W[v], 0)), idx = 0;
  for (let i = 0; i < DW_R.length; i++) { x -= DW_W[DW_R[i]]; if (x < 0) { idx = i; break; } }
  const g = DW_R[idx];
  a.dwT = now; a.gold += g; p.gold = a.gold; p.holdUntil = Math.max(p.holdUntil || 0, now + 6000); saveUsers();
  c.send({ t: 'dw', a: 'res', i: idx, g, left: DW_MS, tier, min: DW_MIN_TIER });
  setTimeout(() => { if (players.get(p.id) === p) { pfSync(p, { m: 'dw', n: g }); broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id); } }, 4800);   // çark dönerken bakiye değişmesin
  log('günlük çark', p.name, '+' + g);
}
const RNG_MIN_DEP_C = +process.env.RNG_MIN_DEP_USD * 100 || 500;   // hedef poligonu için en az toplam yatırım ($5)
function rngMsg(p, m, now) {
  const a = p.acct, c = p.conn, act = String(m.a || '');
  if (now - (p.rngT || 0) < 400) return; p.rngT = now;
  const day = dayKeyOf(now);
  if (act === 'start') {
    if ((a.depC || 0) < RNG_MIN_DEP_C) return c.send({ t: 'rng', a: 'dep', need: RNG_MIN_DEP_C / 100, have: Math.floor(a.depC || 0) / 100 });
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
/* Pasif gelir: sadece gerçekten hareket edince, çok az. 5 dk aktif hareket = 1 coin (PASSIVE_SEC) */
const PASSIVE_WIN = +process.env.PASSIVE_WIN_MS || 60000, PASSIVE_SEC = +process.env.PASSIVE_SEC || 300;
function moveTrack(p, ox, oz) {
  const d = Math.hypot(p.st[0] - ox, p.st[2] - oz);
  if (!(d > 0.02 && d < 8)) return;
  if (!p.pA) p.pA = { x: ox, z: oz };
  p.pPath = (p.pPath || 0) + d;
  p.pMax = Math.max(p.pMax || 0, Math.hypot(p.st[0] - p.pA.x, p.st[2] - p.pA.z));
}
function passiveTick() {
  const w = PASSIVE_WIN / 1000;
  for (const p of players.values()) {
    const active = (p.pPath || 0) >= 0.5 * w && (p.pMax || 0) >= 0.1 * w;     // pencere başına yeterli yol + gerçekten yer değiştirme (yerinde zıplama/titreme sayılmaz)
    p.pPath = 0; p.pMax = 0; p.pA = { x: p.st[0], z: p.st[2] };
    if (!active) continue;
    p.pAct = (p.pAct || 0) + w;
    while (p.pAct >= PASSIVE_SEC) {
      p.pAct -= PASSIVE_SEC;
      const a = p.acct; a.gold += 1; p.gold = a.gold; saveUsers();
      pfSync(p, {}); broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
    }
  }
}
setInterval(passiveTick, PASSIVE_WIN).unref();
function pfSync(p, msg) { p.pfLock = Date.now() + 3000; p.conn.send(Object.assign({ t: 'pfu', pf: pubPf(p.acct) }, msg || {})); }
const TIP_NEAR = +process.env.TIP_NEAR || 15;      // "yakındakilere tip" yarıçapı (metre)
function doTipMulti(p, m, now) {                   // herkese / yakındakilere: tutar KİŞİ BAŞINADIR; alıcıları sunucu belirler
  const near = m.k === 'near', n = Math.floor(Number(m.a));
  if (!(n >= 1) || n > 1000000) return;
  if (now - (p.tipT || 0) < 1000) return;
  if (p.tr) return p.conn.send({ t: 'tr', a: 'msg', c: 'intrade' });
  const rec = [];
  for (const q of players.values()) {
    if (q === p) continue;
    if (near && (Math.hypot(q.st[0] - p.st[0], q.st[2] - p.st[2]) > TIP_NEAR || Math.abs(q.st[1] - p.st[1]) > 4)) continue;
    rec.push(q);
  }
  if (!rec.length) return p.conn.send({ t: 'tr', a: 'msg', c: near ? 'nonear' : 'noone' });
  const tot = n * rec.length, free = p.role === 'owner';
  if (tot > p.acct.gold) return p.conn.send({ t: 'berr', c: 'poor', gold: p.acct.gold });
  if (!free && (n > TIP_MAX || !xferTake(p.acct, tot))) return p.conn.send({ t: 'tr', a: 'msg', c: 'xfcap', g: TIP_MAX, d: XFER_DAY });
  p.tipT = now;
  p.acct.gold -= tot; p.gold = p.acct.gold;
  for (const q of rec) { q.acct.gold += n; q.gold = q.acct.gold; }
  saveUsers();
  pfSync(p, { m: 'tipmany', n, c: rec.length, tot, k: near ? 'near' : 'all' });
  broadcast({ t: 'me', id: p.id, eq: p.eq, gold: p.gold }, p.id);
  for (const q of rec) { pfSync(q, { m: 'tipin', n, who: p.name }); broadcast({ t: 'me', id: q.id, eq: q.eq, gold: q.gold }, q.id); }
  log('tip', near ? 'yakındakilere' : 'herkese', p.name, rec.length + ' kişi × ' + n);
}
function doTip(p, m, now) {
  if (m.k === 'all' || m.k === 'near') return doTipMulti(p, m, now);
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
    if (!TRADE_ITEMS && o.items.length) return false;
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
    if (TRADE_ITEMS && Array.isArray(m.items)) for (const id of m.items.slice(0, 12)) {
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
  if (a === 'logs') return me >= 2 ? p.conn.send({ t: 'logs', l: LOGS.slice(-300).reverse() }) : p.conn.send({ t: 'err', c: 'perm' });
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
    log('give', p.name, '->', gt.name, amt); logAdd('give', p.name, gt.name, amt);
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
    if (!r && target.acct) { delete target.acct.stf; saveUsers(); }           // adminlik alınınca leaderboard'a dönebilir
    return broadcast({ t: 'evt', e: r ? 'prom' : 'dem', n: target.name });
  }
  if (me <= tr) return p.conn.send({ t: 'err', c: 'rank' });
  if (a === 'take') {                              // altın al: kendinden düşük yetkili/oyuncudan, verme sınırıyla aynı tavan
    const cap = me >= 2 ? 5000000 : 50000, n = Math.floor(Number(m.n));
    if (!(n >= 1)) return;
    const amt = Math.min(n, cap, Math.floor(target.acct.gold));
    if (!(amt >= 1)) return p.conn.send({ t: 'tr', a: 'msg', c: 'tookzero', n: target.name });
    target.acct.gold -= amt; target.gold = target.acct.gold; saveUsers();
    pfSync(target, { m: 'taken', n: amt, who: p.name });
    broadcast({ t: 'me', id: target.id, eq: target.eq, gold: target.gold }, target.id);
    log('take', p.name, '<-', target.name, amt); logAdd('take', p.name, target.name, amt);
    return p.conn.send({ t: 'tr', a: 'msg', c: 'took', n: target.name, g: amt });
  }
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
  conns.delete(c); hubWatch.delete(c);
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

const LOGO_FILE = 'bloodbet-logo.png';   // server2.js ile aynı klasörde olmalı; favicon / uygulama ikonu / paylaşım önizlemesi için
const LOGO_PATHS = new Set(['/bloodbet-logo.png', '/favicon.ico', '/apple-touch-icon.png']);
function originOf(req) {                // paylaşım önizlemesi (og:image) için mutlak adres
  const h = String(req.headers.host || '').toLowerCase();
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(h)) return '';
  const pr = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return (pr === 'http' || (!pr && /^(localhost|127\.)/.test(h)) ? 'http' : 'https') + '://' + h;
}
const server = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && u === '/ipn/nowpayments') return npIpn(req, res);
  if (LOGO_PATHS.has(u)) {
    return fs.readFile(path.join(__dirname, LOGO_FILE), (e, b) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SEC }); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', ...SEC });
      res.end(b);
    });
  }
  if (u === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', ...SEC }); return res.end('ok ' + players.size + (REMOTE ? ' db' : ' dosya')); }
  if (u === '/' || u === '/index.html') {
    const body = loadHtml();
    if (!body) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SEC }); return res.end('index.html bulunamadı (oyun dosyasını index.html adıyla server2.js ile aynı klasöre koy).'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC });
    return res.end(body.toString('utf8').replace(/__ORIGIN__/g, originOf(req)));
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
  c.act = Date.now();
  const idleT = setInterval(() => { if (c.p) return clearInterval(idleT); if (Date.now() - c.act > 90000) { clearInterval(idleT); c.close(1008); } }, 15000); idleT.unref();   // 90 sn hiç mesaj atmayan (giriş yapmamış / hub'da bile durmayan) atılır
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
  for (const [k, p] of pend) if (now > p.exp) pend.delete(k);
  for (const mp of [mailTries, mailTo]) for (const [k, l] of mp) { const f = l.filter(t => now - t < 3600000); if (f.length) mp.set(k, f); else mp.delete(k); }
  for (const [ip, l] of authTries) { const f = l.filter(t => now - t < 60000); if (f.length) authTries.set(ip, f); else authTries.delete(ip); }
}, 15000).unref();

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

/* ---------- tek seferlik bakiye sıfırlama: herkesin bakiyesi GOLD_RESET_TO (100) coin olur ----------
 * GOLD_RESET_ID değişmedikçe bir daha çalışmaz (işaret dosyada / veritabanında tutulur). Çalışmadan önce yedek alınır.
 * NO_GOLD_RESET=1 ile tamamen kapatılabilir. */
const GOLD_RESET_ID = 'reset-2026-11-11', GOLD_RESET_TO = 100;
async function goldResetOnce() {
  if (process.env.NO_GOLD_RESET === '1') return log('Bakiye sıfırlama kapalı (NO_GOLD_RESET=1)');
  const META = path.join(DATA_DIR, 'meta.json');
  let done = {};
  try { done = REMOTE ? (JSON.parse(await redis(['GET', 'bloodbet:resets']) || '{}') || {}) : (JSON.parse(fs.readFileSync(META, 'utf8')) || {}); } catch (e) { if (REMOTE) throw e; }
  if (done[GOLD_RESET_ID]) return;
  const bak = {}; let before = 0, n = 0;
  for (const k in users) { const u = users[k]; bak[k] = { gold: u.gold || 0, btEsc: u.btEsc || 0, rb: u.rb || 0 }; before += (u.gold || 0) + (u.btEsc || 0); n++; }
  try { fs.writeFileSync(path.join(DATA_DIR, 'yedek-' + GOLD_RESET_ID + '.json'), JSON.stringify(bak)); } catch (e) { log('yedek dosyası yazılamadı:', e.message); }
  if (REMOTE) await redis(['SET', 'bloodbet:backup:' + GOLD_RESET_ID, JSON.stringify(bak)]);
  const now = Date.now();
  for (const k in users) { const u = users[k]; u.gold = GOLD_RESET_TO; u.btEsc = 0; u.rb = 0; u.bud = 0; u.budT = now; }
  for (const id of Object.keys(gws)) delete gws[id];            // emanetteki çekilişler iade etmesin: hepsi iptal
  gwSave();
  if (REMOTE) await flushRemote(); else { writeUsers(); }
  done[GOLD_RESET_ID] = now;
  if (REMOTE) await redis(['SET', 'bloodbet:resets', JSON.stringify(done)]); else fs.writeFileSync(META, JSON.stringify(done));
  logAdd('reset', 'sistem', '', n, { c: GOLD_RESET_TO });
  log(`BAKİYE SIFIRLANDI: ${n} hesap → ${GOLD_RESET_TO} coin (önceki toplam ${Math.round(before)} coin; yedek: yedek-${GOLD_RESET_ID}.json)`);
}

if (require.main === module) {
  const start = () => server.listen(PORT, HOST, () => {
    log(`BloodBet sunucusu http://localhost:${PORT} adresinde (WebSocket: /ws)`);
    log(REMOTE ? 'Hesaplar: Upstash veritabanı (kalıcı)' : 'Hesaplar: yerel dosya ' + USERS_FILE + ' (barındırma diski kalıcı değilse güncellemede silinir!)');
    log((CF_ID && CF_TOKEN) ? 'Sesli sohbet: Cloudflare TURN kullanılacak' : ICE && ICE.some(x => [].concat(x.urls).some(u => /^turns?:/.test(u))) ? 'Sesli sohbet: TURN sunucusu ayarlı' : 'Sesli sohbet: TURN yok (farklı ağlardaki oyuncular birbirini duyamayabilir)');
    log(NP_ON ? 'Coin satın alma: NOWPayments otomatik mod (IPN: ' + PUBLIC_URL + '/ipn/nowpayments)' : 'Coin satın alma: elle onay modu (NOWPAY_* ayarlı değil)');
    log(MAIL_ON ? 'E-posta doğrulama: Resend ile gönderiliyor' : 'UYARI: RESEND_API_KEY / MAIL_FROM yok, doğrulama kodları e-posta yerine bu konsola yazılır (sadece test için!)');
    if (!process.env.OWNER_CODE) log('OWNER_CODE verilmedi, bu oturum için üretildi:', OWNER_CODE);
    if (!process.env.ADMIN_CODE) log('ADMIN_CODE verilmedi, bu oturum için üretildi:', ADMIN_CODE);
    if (!ALLOWED.length) log('Uyarı: ALLOWED_ORIGINS boş, her siteden bağlanılabilir.');
  });
  if (REMOTE) {            // hesaplar yüklenmeden kimse alınmaz (yoksa var olan isimler yeniden kaydedilebilir)
    (async () => {
      for (let i = 1; ; i++) {
        try { await loadRemote(); await goldResetOnce(); return start(); }
        catch (e) {
          log(`veritabanına bağlanılamadı (${i}/5):`, e.message);
          if (i >= 5) { log('UPSTASH_REDIS_REST_URL ve UPSTASH_REDIS_REST_TOKEN değerlerini kontrol et.'); process.exit(1); }
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    })();
  } else { goldResetOnce().catch(e => { log('bakiye sıfırlama hatası:', e.message); process.exit(1); }).then(start); }
  const stop = () => {
    setTimeout(() => process.exit(0), 8000).unref();
    saveUsers(true).finally(() => { for (const c of conns) c.close(1001); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = { server, OWNER_CODE, ADMIN_CODE, players };
