// node --test --experimental-strip-types shared/protocol.test.ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPairingUri,
  isValidId,
  kindFromMime,
  newFlickId,
  parsePairingUri,
} from './protocol.ts';

test('pairing URI round-trips', () => {
  const p = {
    hosts: ['192.168.1.20', '10.0.0.5'],
    port: 47821,
    token: '0123456789abcdef0123456789abcdef',
    name: 'Ayaz’s Laptop & Co',
  };
  const uri = buildPairingUri(p);
  assert.ok(uri.startsWith('flicksend://pair?v=1&'));
  assert.deepEqual(parsePairingUri(uri), p);
  assert.deepEqual(parsePairingUri(`  ${uri}\n`), p);
});

test('rejects junk and unsafe pairing codes', () => {
  assert.equal(parsePairingUri('https://example.com'), null);
  assert.equal(parsePairingUri('flicksend://pair?h=1.2.3.4&p=1&t=short'), null);
  assert.equal(parsePairingUri('flicksend://pair?h=1.2.3.4&p=99999&t=0123456789abcdef'), null);
  assert.equal(parsePairingUri('flicksend://pair?h=evil.com&p=80&t=0123456789abcdef'), null);
  assert.equal(parsePairingUri('flicksend://pair?h=%E0%A4%A&p=80&t=0123456789abcdef'), null);
  // Only IPv4 literals survive; hostnames are dropped.
  assert.deepEqual(
    parsePairingUri('flicksend://pair?h=evil.com,10.1.2.3&p=80&t=0123456789abcdef')?.hosts,
    ['10.1.2.3'],
  );
});

test('generated flick ids are unique and accepted by the server rules', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const id = newFlickId();
    // Same rule as flicksend::IsValidId in FlickServerCore.cpp.
    assert.ok(isValidId(id), id);
    assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 2000);
});

test('kindFromMime', () => {
  assert.equal(kindFromMime('video/mp4'), 'video');
  assert.equal(kindFromMime('image/heic'), 'image');
});
