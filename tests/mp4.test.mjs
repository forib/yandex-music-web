// tagM4a: ilst create/replace, stco shifts, 4CC encoding. No network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend, concat, mp4box, mp4stco, META } from './helpers.mjs';

const { tagM4a, mp4children, mp4u32 } = loadFrontend();
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts']);

function chainsToEOF(buf) {
  let p = 0;
  while (p < buf.length) {
    const s = mp4u32(buf, p);
    if (s < 8 || p + s > buf.length) return false;
    p += s;
  }
  return p === buf.length;
}
function walk(buf, s, e, cb) {
  for (const c of mp4children(buf, s, e)) {
    cb(c);
    if (c.type === 'meta') walk(buf, c.start + c.header + 4, c.start + c.size, cb);
    else if (CONTAINERS.has(c.type)) walk(buf, c.start + c.header, c.start + c.size, cb);
  }
}
function ilsts(buf) {
  const out = [];
  walk(buf, 0, buf.length, (c) => { if (c.type === 'ilst') out.push(c); });
  return out;
}
function stcos(buf) {
  const moov = mp4children(buf, 0, buf.length).find((c) => c.type === 'moov');
  const out = [];
  walk(buf, moov.start + 8, moov.start + moov.size, (c) => {
    if (c.type !== 'stco') return;
    const n = mp4u32(buf, c.start + 12);
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(mp4u32(buf, c.start + 16 + i * 4));
    out.push(arr);
  });
  return out;
}

describe('tagM4a: create path (no udta, mdat after moov)', () => {
  const ftyp = mp4box('ftyp', Buffer.from('isom'), new Uint8Array(8));
  const moov = mp4box('moov', mp4box('mvhd', new Uint8Array(100)),
    mp4box('trak', mp4box('mdia', mp4box('minf', mp4box('stbl', mp4stco([1000, 2000]))))));
  const inp = concat(ftyp, moov, mp4box('mdat', new Uint8Array(100)));
  const out = tagM4a(inp, META, new Uint8Array([0xFF, 0xD8, 0xFF, 0x00]), 'image/jpeg');
  const s = Buffer.from(out).toString('latin1');

  it('chains to EOF', () => assert.ok(chainsToEOF(out)));
  it('creates exactly one ilst', () => assert.equal(ilsts(out).length, 1));
  it('exact 4-byte item codes', () => {
    const ilst = ilsts(out)[0];
    const names = mp4children(out, ilst.start + 8, ilst.start + ilst.size).map((c) => c.type);
    for (const n of ['©nam', '©alb', '©ART', 'aART', '©day', 'trkn', 'disk', '©gen', '©lyr', '©cmt', 'covr']) {
      assert.ok(names.includes(n), `missing ${n} in [${names}]`);
    }
    assert.ok(names.every((n) => [...n].length === 4));
  });
  it('artists joined with "; "', () => assert.ok(s.includes('A1; A2')));
  it('shifts stco by delta', () => {
    const delta = out.length - inp.length;
    assert.deepEqual(stcos(out), [[1000 + delta, 2000 + delta]]);
  });
  it('trkn layout (reserved, num, total=0)', () => {
    const at = s.indexOf('trkn');
    assert.equal(out[at + 22], 0);
    assert.equal(out[at + 23], 5);
  });
});

describe('tagM4a: replace path (existing ilst, mdat first)', () => {
  const oldIlst = mp4box('ilst', mp4box('©nam',
    mp4box('data', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from('OLD'))));
  const moov = mp4box('moov', mp4box('mvhd', new Uint8Array(100)),
    mp4box('trak', mp4box('mdia', mp4box('minf', mp4box('stbl', mp4stco([5000]))))),
    mp4box('udta', mp4box('meta', new Uint8Array([0, 0, 0, 0]), mp4box('hdlr', new Uint8Array(20)), oldIlst)));
  const inp = concat(mp4box('ftyp', Buffer.from('isom'), new Uint8Array(8)), mp4box('mdat', new Uint8Array(50)), moov);
  const out = tagM4a(inp, META, null, null);
  const s = Buffer.from(out).toString('latin1');

  it('chains to EOF', () => assert.ok(chainsToEOF(out)));
  it('old title gone, single ilst', () => {
    assert.ok(!s.includes('OLD'));
    assert.equal(ilsts(out).length, 1);
  });
  it('stco untouched (mdat before moov)', () => assert.deepEqual(stcos(out), [[5000]]));
  it('hdlr kept', () => assert.ok(s.includes('hdlr')));
});
