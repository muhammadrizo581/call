// End-to-end smoke test of the signaling protocol: `npm test`
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

process.env.PORT = '18089';
process.env.DATA_FILE = path.join(os.tmpdir(), `yuzcall-test-${Date.now()}`, 'ids.json');
process.env.ADMIN_TOKEN = 'test-admin-token-0123456789';
const { server, wss } = await import('./index.js');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));

function client(name, id) {
  const ws = new WebSocket(`ws://localhost:${process.env.PORT}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const c = {
    ws,
    token: crypto.randomBytes(24).toString('hex'),
    send: (m) => ws.send(JSON.stringify(m)),
    next: (type) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve });
        setTimeout(() => reject(new Error(`${name}: timed out waiting for ${type}`)), 2000);
      });
    },
    async hello(reqId) {
      await new Promise((r) => (ws.readyState === 1 ? r() : ws.once('open', r)));
      c.send({ type: 'hello', token: c.token, name, id: reqId });
      const w = await c.next('welcome');
      c.id = w.id;
      return w;
    },
  };
  return c;
}

const a = client('Ali');
const b = client('Bek');
const wa = await a.hello();
const wb = await b.hello();
assert.match(wa.id, /^\d{6}$/);
assert.notEqual(wa.id, wb.id);
assert.ok(wa.iceServers.length > 0);

// Someone else cannot steal an id.
const thief = client('Thief');
const wt = await thief.hello(wa.id);
assert.notEqual(wt.id, wa.id);

// Full call flow.
a.send({ type: 'invite', to: b.id, callId: 'call_00000001' });
await a.next('ringing');
const inc = await b.next('incoming');
assert.equal(inc.from, a.id);
assert.equal(inc.name, 'Ali');

// Third party gets busy.
thief.send({ type: 'invite', to: b.id, callId: 'call_00000002' });
assert.equal((await thief.next('call-failed')).reason, 'busy');

b.send({ type: 'accept', callId: inc.callId });
await a.next('accepted');
a.send({ type: 'signal', callId: inc.callId, data: { sdp: { type: 'offer', sdp: 'x' } } });
assert.equal((await b.next('signal')).data.sdp.type, 'offer');
b.send({ type: 'signal', callId: inc.callId, data: { candidate: { candidate: 'c' } } });
assert.equal((await a.next('signal')).data.candidate.candidate, 'c');
b.send({ type: 'hangup', callId: inc.callId });
await a.next('hangup');

// Decline flow.
a.send({ type: 'invite', to: b.id, callId: 'call_00000003' });
await b.next('incoming');
b.send({ type: 'decline', callId: 'call_00000003' });
await a.next('declined');

// Offline target.
a.send({ type: 'invite', to: '999999', callId: 'call_00000004' });
assert.equal((await a.next('call-failed')).reason, 'offline');

// Reconnect keeps the same id with the same token.
const a2 = client('Ali');
a2.token = a.token;
const wa2 = await a2.hello(a.id);
assert.equal(wa2.id, a.id);

// Offensive display names are dropped.
const rude = client('fuck you');
await rude.hello();
rude.send({ type: 'invite', to: b.id, callId: 'call_00000005' });
assert.equal((await b.next('incoming')).name, '');
rude.send({ type: 'hangup', callId: 'call_00000005' });
await b.next('hangup');

// Blocking: the blocked caller sees the callee as offline, and an ongoing call ends.
const c = client('Cem');
await c.hello();
b.send({ type: 'block', id: c.id });
c.send({ type: 'invite', to: b.id, callId: 'call_00000006' });
assert.equal((await c.next('call-failed')).reason, 'offline');
b.send({ type: 'unblock', id: c.id });
c.send({ type: 'invite', to: b.id, callId: 'call_00000007' });
await b.next('incoming');
b.send({ type: 'accept', callId: 'call_00000007' });
await c.next('accepted');
b.send({ type: 'block', id: c.id });
await c.next('hangup');

// Block list sent on hello is enforced too.
const blocker = client('Eva');
await blocker.hello();
blocker.ws.close();
const blocker2 = client('Eva');
blocker2.token = blocker.token;
await new Promise((r) => blocker2.ws.once('open', r));
blocker2.send({ type: 'hello', token: blocker.token, id: blocker.id, name: 'Eva', blocked: [c.id] });
await blocker2.next('welcome');
c.send({ type: 'invite', to: blocker.id, callId: 'call_00000008' });
assert.equal((await c.next('call-failed')).reason, 'offline');

// Reports from 3 different users suspend the reported ID.
for (const r of [a2, b, thief]) {
  r.send({ type: 'report', id: c.id, reason: 'abuse' });
  await r.next('report-ok');
}
assert.equal((await c.next('error')).code, 'banned');
const cAgain = client('Cem');
cAgain.token = c.token;
await new Promise((r) => cAgain.ws.once('open', r));
cAgain.send({ type: 'hello', token: c.token, id: c.id, name: 'Cem' });
assert.equal((await cAgain.next('error')).code, 'banned');

// Admin API.
const base = `http://localhost:${process.env.PORT}`;
const auth = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
assert.equal((await fetch(`${base}/admin/reports`)).status, 401);
const list = await (await fetch(`${base}/admin/reports`, { headers: auth })).json();
assert.equal(list.reports.filter((r) => r.reported === c.id).length, 3);
assert.ok(list.bans[c.id]);
await fetch(`${base}/admin/unban?id=${c.id}`, { method: 'POST', headers: auth });
const cBack = client('Cem');
cBack.token = c.token;
assert.equal((await cBack.hello(c.id)).id, c.id);
await fetch(`${base}/admin/ban?id=${cBack.id}`, { method: 'POST', headers: auth });
assert.equal((await cBack.next('error')).code, 'banned');
assert.equal((await fetch(`${base}/terms`)).status, 200);

console.log('signaling tests passed');
for (const c of [a, b, thief, a2, rude, blocker2]) c.ws.close();
wss.close();
server.close();
process.exit(0);
