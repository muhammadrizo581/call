// YuzCall signaling server.
// Routes call setup messages (invite/accept/SDP/ICE) between devices.
// Media never touches this server: it flows peer-to-peer (or via TURN).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const DATA_FILE = process.env.DATA_FILE || path.resolve('data/ids.json');
const BANS_FILE = path.join(path.dirname(DATA_FILE), 'bans.json');
const REPORTS_FILE = path.join(path.dirname(DATA_FILE), 'reports.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'cnc196762@gmail.com';
const RING_TIMEOUT_MS = 45_000;
const RECONNECT_GRACE_MS = 20_000;
const HEARTBEAT_MS = 25_000;
const MAX_PAYLOAD = 64 * 1024;
const MAX_BLOCKED = 1000;
const MAX_REPORTS = 5000;
// Reports from this many different users suspend an ID until an admin reviews it.
const AUTO_BAN_REPORTERS = 3;

const ID_RE = /^\d{6}$/;
const CALL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const REPORT_REASONS = new Set(['sexual', 'abuse', 'spam', 'other']);

// ---------- Persistence ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const saveTimers = new Map();

/** Debounced atomic write; `getData` is called at write time so bursts collapse into one write. */
function saveJson(file, getData) {
  clearTimeout(saveTimers.get(file));
  saveTimers.set(
    file,
    setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(getData()));
      fs.renameSync(tmp, file);
    }, 500),
  );
}

// ---------- ID ownership (id -> sha256(token)), persisted ----------

const owners = new Map(Object.entries(readJson(DATA_FILE, {})));
const saveOwners = () => saveJson(DATA_FILE, () => Object.fromEntries(owners));

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function allocateId() {
  for (;;) {
    const id = String(crypto.randomInt(100000, 1000000));
    if (!owners.has(id)) return id;
  }
}

// ---------- Moderation: bans, reports, name filter ----------

/** id -> { at, reason } */
const bans = new Map(Object.entries(readJson(BANS_FILE, {})));
const saveBans = () => saveJson(BANS_FILE, () => Object.fromEntries(bans));

/** [{ at, reporter, reported, reportedName, reason, callId }] */
const reports = readJson(REPORTS_FILE, []);
const saveReports = () => saveJson(REPORTS_FILE, () => reports);

// Word roots matched against the start of each word of a display name (en / ru / uz).
const BAD_ROOTS = [
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'porn', 'sex', 'nude', 'naked', 'whore', 'slut',
  'rape', 'nigg', 'fag',
  'хуй', 'хуе', 'хуё', 'пизд', 'еба', 'ебл', 'ёб', 'бля', 'сука', 'шлюх', 'пидор', 'пидар', 'залуп',
  'мудак', 'порн', 'секс', 'член',
  'jalab', 'qanjiq', 'skay', 'sikay', 'sikish', 'dalbayob', 'dalbayop', 'haromi', 'qotoq', 'qo‘toq', "qo'toq",
  'xuy', 'pizd', 'blyat', 'suka',
];

function isOffensive(text) {
  const words = text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}'‘]+/u).filter(Boolean);
  return words.some((w) => BAD_ROOTS.some((root) => w.startsWith(root)));
}

/** Display names are shown to the person being called, so offensive ones are dropped. */
const cleanName = (name) => {
  const trimmed = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  return isOffensive(trimmed) ? '' : trimmed;
};

function banId(id, reason) {
  bans.set(id, { at: new Date().toISOString(), reason });
  saveBans();
  const ws = online.get(id);
  if (ws) {
    for (const [callId, c] of callsOf(id)) endCall(callId, [otherParty(c, id)], { type: 'hangup' });
    send(ws, { type: 'error', code: 'banned' });
    online.delete(id);
    ws.userId = null;
    ws.close(4003, 'banned');
  }
}

async function notifyAdmin(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error('telegram notify error:', err.message);
  }
}

// ---------- ICE servers (STUN + optional TURN) ----------

const DEFAULT_STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
let cfCache = { at: 0, servers: null };

async function iceServersFor(id) {
  // 1) Cloudflare Realtime TURN (managed, recommended)
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) {
    if (cfCache.servers && Date.now() - cfCache.at < 3600_000) return cfCache.servers;
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: 86400 }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const servers = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
      cfCache = { at: Date.now(), servers };
      return servers;
    } catch (err) {
      console.error('cloudflare turn error:', err.message);
    }
  }

  const urls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!urls.length) return DEFAULT_STUN;

  // 2) coturn with use-auth-secret (ephemeral REST credentials)
  if (process.env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + 86400}:${id}`;
    const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
    return [...DEFAULT_STUN, { urls, username, credential }];
  }

  // 3) Static TURN credentials (Metered, Twilio, etc.)
  return [
    ...DEFAULT_STUN,
    { urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL },
  ];
}

// ---------- Presence & calls ----------

/** id -> ws */
const online = new Map();
/** id -> timeout handle that ends that user's calls if they don't come back */
const graceTimers = new Map();
/** callId -> { caller, callee, state: 'ringing' | 'active', ringTimer } */
const calls = new Map();

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const sendTo = (id, msg) => send(online.get(id), msg);

function callsOf(id) {
  const out = [];
  for (const [callId, c] of calls) if (c.caller === id || c.callee === id) out.push([callId, c]);
  return out;
}

function endCall(callId, notifyIds, msg) {
  const c = calls.get(callId);
  if (!c) return;
  clearTimeout(c.ringTimer);
  calls.delete(callId);
  for (const id of notifyIds) sendTo(id, { ...msg, callId });
}

const otherParty = (c, id) => (c.caller === id ? c.callee : c.caller);

// ---------- Message handling ----------

async function onHello(ws, msg) {
  const token = typeof msg.token === 'string' && msg.token.length >= 32 ? msg.token : null;
  if (!token) return send(ws, { type: 'error', code: 'bad_token' });
  const name = cleanName(msg.name);
  const h = hashToken(token);

  let id = typeof msg.id === 'string' && ID_RE.test(msg.id) ? msg.id : null;
  if (id && owners.has(id) && owners.get(id) !== h) id = null; // someone else owns it
  if (id && bans.has(id)) {
    send(ws, { type: 'error', code: 'banned' });
    return ws.close(4003, 'banned');
  }
  if (!id) id = allocateId();
  if (owners.get(id) !== h) {
    owners.set(id, h);
    saveOwners();
  }

  // Replace a previous connection of the same user (e.g. after network switch).
  const prev = online.get(id);
  if (prev && prev !== ws) {
    prev.userId = null;
    prev.close(4000, 'replaced');
  }
  clearTimeout(graceTimers.get(id));
  graceTimers.delete(id);

  ws.userId = id;
  ws.name = name;
  // The client keeps its block list and re-sends it on every connect, so the server needs no storage for it.
  ws.blocked = new Set(
    (Array.isArray(msg.blocked) ? msg.blocked : []).filter((b) => ID_RE.test(b)).slice(0, MAX_BLOCKED),
  );
  online.set(id, ws);

  send(ws, { type: 'welcome', id, iceServers: await iceServersFor(id) });

  // Re-deliver a call that started ringing while this device was reconnecting.
  for (const [callId, c] of callsOf(id)) {
    if (c.callee === id && c.state === 'ringing') {
      send(ws, { type: 'incoming', callId, from: c.caller, name: c.callerName });
    }
  }
}

function onInvite(ws, msg) {
  const from = ws.userId;
  const { to, callId } = msg;
  if (!ID_RE.test(to || '') || !CALL_ID_RE.test(callId || '') || calls.has(callId)) {
    return send(ws, { type: 'call-failed', callId, reason: 'invalid' });
  }
  if (to === from) return send(ws, { type: 'call-failed', callId, reason: 'invalid' });
  // A blocked caller just sees the callee as offline.
  if (!online.has(to) || online.get(to).blocked?.has(from)) {
    return send(ws, { type: 'call-failed', callId, reason: 'offline' });
  }
  if (callsOf(to).length) return send(ws, { type: 'call-failed', callId, reason: 'busy' });

  // A user can only be in one call: drop any stale call of the caller.
  for (const [staleId, c] of callsOf(from)) endCall(staleId, [otherParty(c, from)], { type: 'hangup' });

  const callerName = ws.name || '';
  const ringTimer = setTimeout(() => {
    endCall(callId, [from], { type: 'call-failed', reason: 'no-answer' });
    sendTo(to, { type: 'hangup', callId });
  }, RING_TIMEOUT_MS);
  calls.set(callId, { caller: from, callee: to, callerName, state: 'ringing', ringTimer });
  sendTo(to, { type: 'incoming', callId, from, name: callerName });
  send(ws, { type: 'ringing', callId });
}

function onCallMessage(ws, msg) {
  const id = ws.userId;
  const c = calls.get(msg.callId);
  if (!c || (c.caller !== id && c.callee !== id)) {
    // Unknown call: tell the sender so its UI doesn't hang.
    if (msg.type !== 'hangup' && msg.type !== 'decline') send(ws, { type: 'hangup', callId: msg.callId });
    return;
  }
  const peer = otherParty(c, id);

  switch (msg.type) {
    case 'accept':
      if (id !== c.callee || c.state !== 'ringing') return;
      clearTimeout(c.ringTimer);
      c.state = 'active';
      sendTo(peer, { type: 'accepted', callId: msg.callId });
      return;
    case 'decline':
      endCall(msg.callId, [peer], { type: 'declined' });
      return;
    case 'hangup':
      endCall(msg.callId, [peer], { type: 'hangup' });
      return;
    case 'signal':
      if (msg.data && typeof msg.data === 'object') {
        sendTo(peer, { type: 'signal', callId: msg.callId, data: msg.data });
      }
      return;
  }
}

function onBlock(ws, msg) {
  const id = ws.userId;
  const target = msg.id;
  if (!ID_RE.test(target || '') || target === id) return;
  if (msg.type === 'unblock') return void ws.blocked.delete(target);
  if (ws.blocked.size < MAX_BLOCKED) ws.blocked.add(target);
  // Blocking cuts off any call with that person right away.
  for (const [callId, c] of callsOf(id)) {
    if (otherParty(c, id) === target) endCall(callId, [target], { type: 'hangup' });
  }
}

function onReport(ws, msg) {
  const reporter = ws.userId;
  const reported = msg.id;
  if (!ID_RE.test(reported || '') || reported === reporter) return;
  const reason = REPORT_REASONS.has(msg.reason) ? msg.reason : 'other';
  // One report per reporter/reported pair is enough; repeats only add noise.
  if (reports.some((r) => r.reporter === reporter && r.reported === reported)) {
    return send(ws, { type: 'report-ok', id: reported });
  }

  const report = {
    at: new Date().toISOString(),
    reporter,
    reported,
    reportedName: online.get(reported)?.name || '',
    reason,
    callId: CALL_ID_RE.test(msg.callId || '') ? msg.callId : null,
  };
  reports.push(report);
  if (reports.length > MAX_REPORTS) reports.shift();
  saveReports();
  send(ws, { type: 'report-ok', id: reported });
  console.log('report', JSON.stringify(report));

  const reporters = new Set(reports.filter((r) => r.reported === reported).map((r) => r.reporter));
  const autoBanned = reporters.size >= AUTO_BAN_REPORTERS && !bans.has(reported);
  if (autoBanned) banId(reported, `auto: ${reporters.size} reports`);
  notifyAdmin(
    `YuzCall report: ${reported}${report.reportedName ? ` (${report.reportedName})` : ''} — ${reason}, ` +
      `from ${reporter}. Total reporters: ${reporters.size}.${autoBanned ? ' AUTO-BANNED.' : ''}`,
  );
}

function onClose(ws) {
  const id = ws.userId;
  if (!id || online.get(id) !== ws) return;
  online.delete(id);
  // Media is P2P and survives a signaling blip, so give the device time to reconnect
  // before tearing down its calls.
  graceTimers.set(
    id,
    setTimeout(() => {
      graceTimers.delete(id);
      if (online.has(id)) return;
      for (const [callId, c] of callsOf(id)) endCall(callId, [otherParty(c, id)], { type: 'hangup' });
    }, RECONNECT_GRACE_MS),
  );
}

// ---------- Server ----------

const page = (file) =>
  fs.readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('{{SUPPORT_EMAIL}}', SUPPORT_EMAIL);
const PAGES = { '/privacy': page('./privacy.html'), '/terms': page('./terms.html') };

function isAdmin(req) {
  const given = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${ADMIN_TOKEN}`);
  return ADMIN_TOKEN.length >= 16 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Moderation API for acting on reports (Bearer ADMIN_TOKEN):
//   GET  /admin/reports           newest reports + current bans
//   POST /admin/ban?id=123456     suspend an ID and drop it from any call
//   POST /admin/unban?id=123456   lift a ban and clear that ID's reports
function onAdmin(req, res, url) {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!isAdmin(req)) return json(401, { error: 'unauthorized' });

  if (req.method === 'GET' && url.pathname === '/admin/reports') {
    return json(200, { bans: Object.fromEntries(bans), reports: reports.slice(-200).reverse() });
  }
  const id = url.searchParams.get('id') || '';
  if (req.method !== 'POST' || !ID_RE.test(id)) return json(400, { error: 'bad_request' });
  if (url.pathname === '/admin/ban') {
    banId(id, url.searchParams.get('reason') || 'admin');
    return json(200, { ok: true, banned: id });
  }
  if (url.pathname === '/admin/unban') {
    bans.delete(id);
    saveBans();
    for (let i = reports.length - 1; i >= 0; i--) if (reports[i].reported === id) reports.splice(i, 1);
    saveReports();
    return json(200, { ok: true, unbanned: id });
  }
  return json(404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/admin/')) return onAdmin(req, res, url);
  if (PAGES[url.pathname]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGES[url.pathname]);
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, online: online.size, calls: calls.size }));
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.bucket = { tokens: 200, at: Date.now() };
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    // Token bucket: 50 msg/s sustained, bursts of 200 (ICE candidate floods).
    const now = Date.now();
    const b = ws.bucket;
    b.tokens = Math.min(200, b.tokens + ((now - b.at) / 1000) * 50);
    b.at = now;
    if (b.tokens < 1) return;
    b.tokens -= 1;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hello') return void onHello(ws, msg).catch((e) => console.error(e));
    if (msg.type === 'ping') return send(ws, { type: 'pong' });
    if (!ws.userId) return send(ws, { type: 'error', code: 'not_registered' });
    if (msg.type === 'invite') return onInvite(ws, msg);
    if (['accept', 'decline', 'hangup', 'signal'].includes(msg.type)) return onCallMessage(ws, msg);
    if (msg.type === 'block' || msg.type === 'unblock') return onBlock(ws, msg);
    if (msg.type === 'report') return onReport(ws, msg);
  });

  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => console.log(`signaling listening on :${PORT}`));

export { server, wss };
