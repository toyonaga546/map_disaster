import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fetchStreetView } from '../src/streetview.js';
import { compareImages } from '../src/ai.js';
import { createApp } from '../src/server.js';

const point = { latitude: 35.68, longitude: 139.76 };
const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#335577' } }).jpeg().toBuffer();
const withKey = async run => {
  const old = process.env.GOOGLE_MAPS_API_KEY; process.env.GOOGLE_MAPS_API_KEY = 'test-only';
  try { return await run(); } finally { if (old) process.env.GOOGLE_MAPS_API_KEY = old; else delete process.env.GOOGLE_MAPS_API_KEY; }
};
const imageResponse = (type = 'image/jpeg', body = jpeg) => ({ ok: true, headers: { get: () => type }, arrayBuffer: async () => body });
const metaResponse = value => ({ ok: true, json: async () => value });

test('ストリートビュー取得：成功時は東西南北の4方向を取得する', async () => {
  const urls = [];
  const result = await withKey(() => fetchStreetView(point, async url => {
    urls.push(new URL(url));
    return urls.length === 1 ? metaResponse({ status: 'OK', pano_id: 'pano1', date: '2023-05', location: { lat: 35.68, lng: 139.7595 }, copyright: '© Google' }) : imageResponse();
  }));
  assert.equal(result.info.status, 'available');
  assert.equal(result.info.captured, '2023-05');
  assert.deepEqual(result.images.map(i => i.heading), [0, 90, 180, 270]);
  assert.ok(result.images.every(i => i.bytes.length === jpeg.length));
  assert.ok(result.info.distance > 30 && result.info.distance < 60);
  assert.equal(urls[0].pathname.endsWith('/metadata'), true);
  assert.equal(urls.length, 5);
  assert.deepEqual(urls.slice(1).map(u => u.searchParams.get('heading')).sort(), ['0', '180', '270', '90']);
  assert.ok(urls.slice(1).every(u => u.searchParams.get('pano') === 'pano1' && u.searchParams.get('fov') === '90' && u.searchParams.get('return_error_code') === 'true'));
});

test('ストリートビュー取得：キー未設定・画像なし・API失敗・画像でない応答は取得不可になり例外を出さない', async () => {
  assert.equal((await fetchStreetView(point, async () => { throw new Error('must not be called'); })).info.status, 'unavailable');
  await withKey(async () => {
    const none = await fetchStreetView(point, async () => metaResponse({ status: 'ZERO_RESULTS' }));
    assert.equal(none.info.status, 'unavailable'); assert.match(none.info.reason, /50m以内/);
    assert.equal((await fetchStreetView(point, async () => metaResponse({ status: 'REQUEST_DENIED' }))).info.status, 'unavailable');
    assert.equal((await fetchStreetView(point, async () => { throw new Error('timeout'); })).info.status, 'unavailable');
    let calls = 0;
    const notImage = await fetchStreetView(point, async () => ++calls === 1 ? metaResponse({ status: 'OK', pano_id: 'p', location: { lat: 35.68, lng: 139.76 } }) : imageResponse('text/html'));
    assert.equal(notImage.info.status, 'unavailable'); assert.equal(notImage.images, null);
  });
});

test('AI比較：ストリートビュー4方向だけでも送信し、過去写真があれば合わせて送る', async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-only';
  try {
    const sent = [];
    const request = async (url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ result: 'consistent', reason: 'ストリートビューと建物が共通しています。' }) } }] }) }; };
    const views = [0, 90, 180, 270].map(heading => ({ heading, bytes: jpeg }));
    assert.equal((await compareImages(jpeg, null, request, views.slice(0, 1))).result, 'consistent');
    assert.equal(sent[0].messages[1].content.length, 2);
    assert.match(sent[0].messages[0].content, /Street View/);
    await compareImages(jpeg, jpeg, request, views);
    assert.equal(sent[1].messages[1].content.length, 6);
    assert.match(sent[1].messages[0].content, /facing north.*facing east.*facing south.*facing west/);
    assert.equal((await compareImages(jpeg, null, request, [])).status, 'unavailable');
  } finally { if (old) process.env.OPENAI_API_KEY = old; else delete process.env.OPENAI_API_KEY; }
});

test('投稿にストリートビュー画像を保存・配信し、削除時に消す', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'disaster-streetview-'));
  let view = { info: { status: 'available', captured: '2023-05', distance: 12, copyright: '© Google' }, images: [0, 90, 180, 270].map(heading => ({ heading, bytes: jpeg })) };
  const app = await createApp(dir, undefined, undefined, async () => { if (view instanceof Error) throw view; return view; });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async () => {
    const response = await fetch(base + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...point, description: '現地の状況です。', samples: [], image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, ai_consent: false }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const created = await post();
    assert.equal(created.status, 201);
    const { post: p, management_token: token } = created.body;
    assert.equal(p.streetview.status, 'available');
    assert.deepEqual(p.streetview.images.map(i => i.heading), [0, 90, 180, 270]);
    for (const { heading, image_url } of p.streetview.images) {
      assert.equal(image_url, `/images/${p.id}.streetview-${heading}.jpg`);
      const image = await fetch(base + image_url);
      assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    }
    assert.equal((await fetch(base + `/images/${p.id}.streetview-45.jpg`)).status, 404);
    assert.equal((await fetch(base + `/api/posts/${p.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })).status, 200);
    for (const { image_url } of p.streetview.images) assert.equal((await fetch(base + image_url)).status, 404);
    assert.equal((await fetch(base + p.image_url)).status, 404);

    view = { info: { status: 'unavailable', reason: '投稿地点の50m以内にストリートビューがありません。' }, images: null };
    const none = (await post()).body.post;
    assert.equal(none.streetview.status, 'unavailable');
    assert.equal((await fetch(base + `/images/${none.id}.streetview-0.jpg`)).status, 404);

    view = new Error('boom');
    const failed = await post();
    assert.equal(failed.status, 201); assert.equal(failed.body.post.streetview.status, 'unavailable');
  } finally {
    await new Promise(resolve => app.server.close(resolve)); app.db.close(); await rm(dir, { recursive: true, force: true });
  }
});
