import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { detectGenerated } from '../src/provenance.js';
import { createApp } from '../src/server.js';

const SOURCE = 'http://cv.iptc.org/newscodes/digitalsourcetype/';
const xmp = type => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="${SOURCE}${type}"/></rdf:RDF></x:xmpmeta>`;
const plainJpeg = () => sharp({ create: { width: 16, height: 16, channels: 3, background: '#4a6b5a' } }).jpeg().toBuffer();
const plainPng = () => sharp({ create: { width: 16, height: 16, channels: 3, background: '#4a6b5a' } }).png().toBuffer();

// Inserts an APPn segment right after the JPEG SOI marker.
function withSegment(jpeg, marker, payload) {
  const length = Buffer.alloc(2); length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, marker]), length, payload, jpeg.subarray(2)]);
}
const withXmp = (jpeg, type) => withSegment(jpeg, 0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xmp(type))]));

// Inserts a valid PNG chunk right after IHDR.
function withChunk(png, type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([png.subarray(0, 33), head, data, crc, png.subarray(33)]);
}

test('IPTCのDigitalSourceTypeから生成AI・AI合成を判定する', async () => {
  const jpeg = await plainJpeg();
  assert.equal(detectGenerated(withXmp(jpeg, 'trainedAlgorithmicMedia')).status, 'generated');
  assert.equal(detectGenerated(withXmp(jpeg, 'compositeWithTrainedAlgorithmicMedia')).status, 'ai_edited');
  assert.equal(detectGenerated(withXmp(jpeg, 'digitalCapture')).status, 'not_found');
});

test('C2PAの来歴情報を検出し、その中の生成AIの記録を読む', async () => {
  const jumbf = Buffer.concat([Buffer.from('JP\0\0\0\0\0\x01'), Buffer.from('\0\0\0\x20jumb\0\0\0\x18jumd'), Buffer.alloc(16), Buffer.from('c2pa\0'), Buffer.from(`digitalSourceType${SOURCE}trainedAlgorithmicMedia claim_generator ChatGPT`)]);
  const result = detectGenerated(withSegment(await plainJpeg(), 0xeb, jumbf));
  assert.equal(result.status, 'generated');
  assert.equal(result.c2pa, true);
  assert.ok(result.signals.some(s => s.includes('ChatGPT')));
});

test('EXIFのSoftwareにある生成AIツール名は「ツールの記録」として扱う', async () => {
  const image = await sharp(await plainJpeg()).withExif({ IFD0: { Software: 'Midjourney v6' } }).jpeg().toBuffer();
  const result = detectGenerated(image);
  assert.equal(result.status, 'ai_tool');
  assert.ok(result.signals[0].includes('Midjourney'));
  const edited = await sharp(await plainJpeg()).withExif({ IFD0: { Software: 'Photo Editor' } }).jpeg().toBuffer();
  assert.equal(detectGenerated(edited).status, 'not_found');
});

test('PNGのStable Diffusion設定チャンク（圧縮iTXtを含む）を検出する', async () => {
  const png = await plainPng();
  const sd = withChunk(png, 'tEXt', Buffer.from('parameters\0a flooded street\nSteps: 20, Sampler: Euler a, CFG scale: 7'));
  assert.equal(detectGenerated(sd).status, 'generated');
  const itxt = withChunk(png, 'iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\x01\0\0\0'), deflateSync(xmp('trainedAlgorithmicMedia'))]));
  assert.equal(detectGenerated(itxt).status, 'generated');
  // An ordinary caption named "parameters" is not a generator record.
  assert.equal(detectGenerated(withChunk(png, 'tEXt', Buffer.from('parameters\0iso 100'))).status, 'not_found');
});

test('AI生成の記録もカメラの記録もないときだけ注意を付け、判定は変えない', async () => {
  const jpeg = await plainJpeg();
  const none = detectGenerated(jpeg);
  assert.equal(none.status, 'not_found');
  assert.equal(none.camera, false);
  assert.ok(none.camera_note);
  assert.equal(detectGenerated(jpeg, { camera: true }).camera_note, null);
  assert.equal(detectGenerated(withXmp(jpeg, 'trainedAlgorithmicMedia')).camera_note, null);
});

test('画像データ部分の文字列や壊れたファイルでは誤検出・例外を起こさない', async () => {
  const jpeg = await plainJpeg();
  const trailing = Buffer.concat([jpeg, Buffer.from(`${SOURCE}trainedAlgorithmicMedia Midjourney`)]);
  assert.equal(detectGenerated(trailing).status, 'not_found');
  for (const broken of [Buffer.alloc(0), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff]), (await plainPng()).subarray(0, 40), Buffer.from('RIFF\0\0\0\0WEBPXMP \xff\xff\xff\x7f')])
    assert.doesNotThrow(() => detectGenerated(broken));
});

test('投稿時に判定結果を保存し、公開画像からは記録を除去する', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'provenance-test-'));
  const app = await createApp(dir, undefined, undefined, async () => null, { deferAnalysis: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const submit = async image => {
    const response = await fetch(base + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      latitude: 35.68, longitude: 139.76, description: '生成画像のテスト', samples: [], image: `data:image/jpeg;base64,${image.toString('base64')}`, ai_consent: false
    }) });
    assert.equal(response.status, 201);
    return (await response.json()).post;
  };
  try {
    const photo = await submit(await sharp(await plainJpeg()).withExif({ IFD0: { Make: 'TestCamera', Model: 'X1' } }).jpeg().toBuffer());
    assert.equal(photo.provenance.camera, true);
    assert.equal(photo.provenance.camera_note, null);
    assert.ok((await submit(await plainJpeg())).provenance.camera_note);
    const post = await submit(withXmp(await plainJpeg(), 'trainedAlgorithmicMedia'));
    assert.equal(post.provenance.status, 'generated');
    assert.equal((await (await fetch(`${base}/api/posts/${post.id}`)).json()).post.provenance.label, '生成AIで作成された記録あり');
    const published = Buffer.from(await (await fetch(base + post.image_url)).arrayBuffer());
    assert.equal(detectGenerated(published).status, 'not_found');
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
