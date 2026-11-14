// End-to-end tests for FlickServerCore over real sockets.
//   node --test native-tests/server.test.mjs   (expects CORE_HOST=path/to/core_host)
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, existsSync} from 'node:fs';
import {tmpdir, networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import {createInterface} from 'node:readline';

const HOST_BIN = process.env.CORE_HOST;
const TOKEN = 'test-token-0123456789abcdef';
let proc;
let port;
let saveDir;
const events = [];
const waiters = [];

function waitFor(pred, timeoutMs = 5000) {
  const found = events.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const w = {pred, resolve};
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) {
        waiters.splice(i, 1);
        reject(new Error('timed out waiting for event; got: ' + JSON.stringify(events)));
      }
    }, timeoutMs);
  });
}

before(async () => {
  assert.ok(HOST_BIN, 'set CORE_HOST to the compiled core_host binary');
  saveDir = mkdtempSync(join(tmpdir(), 'flicksend-'));
  proc = spawn(HOST_BIN, [saveDir, TOKEN], {stdio: ['pipe', 'pipe', 'inherit']});
  createInterface({input: proc.stdout}).on('line', line => {
    const ev = JSON.parse(line);
    events.push(ev);
    for (const w of [...waiters]) {
      if (w.pred(ev)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(ev);
      }
    }
  });
  const ready = await waitFor(e => e.event === 'ready');
  port = ready.port;
});

after(() => {
  proc.stdin.end();
});

function request({method = 'GET', path, headers = {}, body, host = '127.0.0.1'}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host, port, method, path, headers}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const auth = {'X-Flick-Token': TOKEN};
const json = r => JSON.parse(r.body.toString('utf8'));
// The Windows build (run under Wine) reports paths with backslashes.
const localPath = p => p.replace(/\\/g, '/');

test('hello requires the token', async () => {
  assert.equal((await request({path: '/hello'})).status, 401);
  assert.equal((await request({path: '/hello', headers: {'X-Flick-Token': 'nope'}})).status, 401);
  const ok = await request({path: '/hello', headers: auth});
  assert.equal(ok.status, 200);
  assert.deepEqual(json(ok), {app: 'flicksend', protocol: 1, name: 'Test "Laptop"'});
});

test('unknown route is 404, wrong method is 405', async () => {
  assert.equal((await request({path: '/nope', headers: auth})).status, 404);
  assert.equal((await request({method: 'POST', path: '/hello', headers: auth, body: ''})).status, 405);
});

test('POST /flick forwards metadata', async () => {
  const meta = {id: 'meta-test-0001', kind: 'image', mime: 'image/jpeg', name: 'a.jpg', size: 3, sentAt: 1};
  const body = JSON.stringify(meta);
  const r = await request({
    method: 'POST',
    path: '/flick',
    headers: {...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)},
    body,
  });
  assert.equal(r.status, 200);
  const ev = await waitFor(e => e.event === 'incoming' && e.meta.id === 'meta-test-0001');
  assert.deepEqual(ev.meta, meta);
});

test('POST /flick rejects non-JSON', async () => {
  const r = await request({method: 'POST', path: '/flick', headers: {...auth, 'Content-Length': 5}, body: 'hello'});
  assert.equal(r.status, 400);
});

test('PUT content streams a large file to disk and serves it back on loopback', async () => {
  const data = randomBytes(5 * 1024 * 1024 + 123);
  const id = 'upload-big-0001';
  const r = await request({
    method: 'PUT',
    path: `/flick/${id}/content`,
    headers: {
      ...auth,
      'Content-Type': 'video/mp4',
      'X-Flick-Name': encodeURIComponent('My Clip.mp4'),
      'Content-Length': data.length,
    },
    body: data,
  });
  assert.equal(r.status, 200, r.body.toString());
  const done = await waitFor(e => e.event === 'complete' && e.id === id);
  assert.match(done.path, /\d{8}-\d{6}-My_Clip\.mp4$/);
  assert.ok(readFileSync(localPath(done.path)).equals(data));
  const last = events.filter(e => e.event === 'progress' && e.id === id).at(-1);
  assert.equal(last.received, data.length);
  assert.equal(last.total, data.length);

  const media = await request({path: `/media/${id}`});
  assert.equal(media.status, 200);
  assert.equal(media.headers['content-type'], 'video/mp4');
  assert.ok(media.body.equals(data));
  assert.equal(readdirSync(saveDir).filter(f => f.endsWith('.part')).length, 0);
});

test('chunked upload works', async () => {
  const id = 'upload-chunked-01';
  const parts = [randomBytes(1000), randomBytes(70000), randomBytes(5)];
  const r = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: `/flick/${id}/content`,
        headers: {...auth, 'Content-Type': 'image/png', 'X-Flick-Name': 'shot.png', 'Transfer-Encoding': 'chunked'},
      },
      res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    for (const p of parts) req.write(p);
    req.end();
  });
  assert.equal(r, 200);
  const done = await waitFor(e => e.event === 'complete' && e.id === id);
  assert.ok(readFileSync(localPath(done.path)).equals(Buffer.concat(parts)));
});

test('Expect: 100-continue is honoured', async () => {
  const id = 'upload-expect-01';
  const data = randomBytes(2048);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'PUT',
      path: `/flick/${id}/content`,
      headers: {...auth, 'Content-Type': 'image/jpeg', 'Content-Length': data.length, Expect: '100-continue'},
    });
    req.on('continue', () => req.end(data));
    req.on('response', res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(status, 200);
  const done = await waitFor(e => e.event === 'complete' && e.id === id);
  assert.match(done.path, /flick\.jpg$/);
});

test('rejects bad ids and path traversal', async () => {
  for (const id of ['short', '..%2F..%2Fetc', '....-....-....']) {
    const r = await request({method: 'PUT', path: `/flick/${id}/content`, headers: {...auth, 'Content-Length': 1}, body: 'x'});
    assert.ok(r.status === 400 || r.status === 404, `${id} -> ${r.status}`);
  }
});

test('upload without a token is rejected and writes nothing', async () => {
  const before = readdirSync(saveDir).length;
  const r = await request({method: 'PUT', path: '/flick/no-token-0001/content', headers: {'Content-Length': 3}, body: 'abc'});
  assert.equal(r.status, 401);
  assert.equal(readdirSync(saveDir).length, before);
});

test('oversized upload is refused up front', async () => {
  const r = await request({
    method: 'PUT',
    path: '/flick/too-big-00001/content',
    headers: {...auth, 'Content-Length': String(65 * 1024 * 1024)},
  });
  assert.equal(r.status, 413);
});

test('truncated upload reports an error and leaves no partial file', async () => {
  const id = 'truncated-0001';
  await new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(
        `PUT /flick/${id}/content HTTP/1.1\r\nHost: x\r\nX-Flick-Token: ${TOKEN}\r\nContent-Length: 100000\r\n\r\n`,
      );
      s.write(randomBytes(500));
      setTimeout(() => s.destroy(), 100);
    });
    s.on('close', resolve);
    s.on('error', () => {});
  });
  const ev = await waitFor(e => e.event === 'error' && e.id === id);
  assert.equal(ev.error, 'upload interrupted');
  assert.equal(readdirSync(saveDir).filter(f => f.endsWith('.part')).length, 0);
});

test('media is not served to other machines', async t => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find(i => i && i.family === 'IPv4' && !i.internal);
  if (!lan) {
    t.skip('no non-loopback interface');
    return;
  }
  const r = await request({host: lan.address, path: '/media/upload-big-0001'});
  assert.equal(r.status, 403);
});

test('unknown media id is 404', async () => {
  assert.equal((await request({path: '/media/doesnotexist1'})).status, 404);
  assert.ok(!existsSync(join(saveDir, 'doesnotexist1')));
});

test('garbage request line gets a 4xx', async () => {
  const reply = await new Promise(resolve => {
    let buf = '';
    const s = net.connect(port, '127.0.0.1', () => s.write('HELLO\r\n\r\n'));
    s.on('data', d => (buf += d));
    s.on('close', () => resolve(buf));
    s.on('error', () => resolve(buf));
  });
  assert.match(reply, /^HTTP\/1\.1 4\d\d /);
});
