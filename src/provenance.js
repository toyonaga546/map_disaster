import { inflateSync } from 'node:zlib';

// Looks for records that image generators embed in the file: IPTC
// DigitalSourceType (XMP or C2PA), C2PA manifests, generator names and
// Stable Diffusion style PNG text chunks. Only metadata segments are scanned,
// never pixel data. Signatures are not verified, and a missing record proves
// nothing because re-saving or screenshots strip metadata.

const MAX_TEXT = 1_000_000;
const GENERATED = /newscodes\/digitalsourcetype\/trainedAlgorithmicMedia/;
const AI_EDITED = /newscodes\/digitalsourcetype\/compositeWithTrainedAlgorithmicMedia/;
const C2PA = /jumd[\s\S]{0,40}?c2pa/;
const GENERATORS = [
  ['Midjourney', /midjourney/i],
  ['DALL·E', /dall[\s·._-]?e\b/i],
  ['ChatGPT / OpenAI', /chatgpt|openai|gpt-?image/i],
  ['Adobe Firefly', /firefly/i],
  ['Google Imagen / Gemini', /\bimagen\b|gemini/i],
  ['Stable Diffusion', /stable[\s_-]?diffusion|automatic1111|comfyui|invokeai/i],
  ['NovelAI', /novelai/i],
  ['Leonardo.Ai', /leonardo\.ai/i],
  ['Ideogram', /ideogram/i],
  ['Bing Image Creator', /bing image creator|image creator from microsoft/i]
];
const SD_KEYS = new Set(['parameters', 'prompt', 'workflow', 'dream', 'sd-metadata', 'invokeai_metadata']);

function inflate(bytes) {
  try { return inflateSync(bytes, { maxOutputLength: MAX_TEXT }); } catch { return Buffer.alloc(0); }
}

function jpegSegments(raw) {
  const parts = [];
  let i = 2;
  while (i + 4 <= raw.length && raw[i] === 0xff) {
    const marker = raw[i + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    const length = raw.readUInt16BE(i + 2);
    if (length < 2) break;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) parts.push(raw.subarray(i + 4, i + 2 + length));
    i += 2 + length;
  }
  return { parts, texts: [] };
}

function pngChunks(raw) {
  const parts = [], texts = [];
  let i = 8;
  while (i + 12 <= raw.length) {
    const length = raw.readUInt32BE(i), type = raw.toString('latin1', i + 4, i + 8);
    const data = raw.subarray(i + 8, Math.min(raw.length, i + 8 + length));
    if (type === 'IEND') break;
    if (type !== 'IDAT') {
      const nul = data.indexOf(0);
      const key = nul >= 0 ? data.toString('latin1', 0, nul) : '';
      let text = null;
      if (type === 'tEXt' && nul >= 0) text = data.subarray(nul + 1);
      if (type === 'zTXt' && nul >= 0) text = inflate(data.subarray(nul + 2));
      if (type === 'iTXt' && nul >= 0) {
        const compressed = data[nul + 1] === 1;
        let j = nul + 3;
        for (let n = 0; n < 2 && j < data.length; n++) j = data.indexOf(0, j) + 1 || data.length;
        text = compressed ? inflate(data.subarray(j)) : data.subarray(j);
      }
      if (text) { texts.push({ key, text: text.toString('utf8') }); parts.push(text); }
      else parts.push(data);
    }
    i += 12 + length;
  }
  return { parts, texts };
}

function webpChunks(raw) {
  const parts = [];
  let i = 12;
  while (i + 8 <= raw.length) {
    const type = raw.toString('latin1', i, i + 4), length = raw.readUInt32LE(i + 4);
    if (!['VP8 ', 'VP8L', 'ALPH', 'ANMF'].includes(type)) parts.push(raw.subarray(i + 8, Math.min(raw.length, i + 8 + length)));
    i += 8 + length + (length % 2);
  }
  return { parts, texts: [] };
}

function metadataOf(raw) {
  if (raw[0] === 0xff && raw[1] === 0xd8) return jpegSegments(raw);
  if (raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return pngChunks(raw);
  if (raw.toString('latin1', 0, 4) === 'RIFF' && raw.toString('latin1', 8, 12) === 'WEBP') return webpChunks(raw);
  return { parts: [], texts: [] };
}

// camera: whether EXIF names the device (Make/Model). Generated images and
// screenshots usually lack it, but browsers and apps also strip it, so its
// absence is only a weak hint and never changes the status.
export function detectGenerated(raw, { camera = false } = {}) {
  let meta;
  try { meta = metadataOf(raw); } catch { meta = { parts: [], texts: [] }; }
  const text = Buffer.concat(meta.parts).toString('latin1');
  const signals = [];
  let status = 'not_found';
  if (GENERATED.test(text)) { status = 'generated'; signals.push('IPTCの記録「生成AIで作成（trainedAlgorithmicMedia）」'); }
  else if (AI_EDITED.test(text)) { status = 'ai_edited'; signals.push('IPTCの記録「生成AIを使った合成（compositeWithTrainedAlgorithmicMedia）」'); }
  const sd = meta.texts.find(({ key, text }) => SD_KEYS.has(key.toLowerCase()) && (key.toLowerCase() !== 'parameters' || /steps:\s*\d+/i.test(text)));
  if (sd) { status = 'generated'; signals.push(`画像生成ツールの設定情報（PNGの「${sd.key}」）`); }
  const names = GENERATORS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  // A tool name alone does not tell whether the image was generated or only edited.
  if (names.length) { if (status === 'not_found') status = 'ai_tool'; signals.push(`生成AIツール名の記録：${names.join('、')}`); }
  const c2pa = C2PA.test(text);
  if (c2pa) signals.push('C2PA（Content Credentials）の来歴情報あり');
  const label = { generated: '生成AIで作成された記録あり', ai_edited: 'AIで編集・合成された記録あり', ai_tool: '生成AIツールの記録あり', not_found: 'AI生成の記録なし' }[status];
  const reason = status === 'not_found'
    ? 'AI生成を示す記録は見つかりませんでした。記録は再保存やスクリーンショットで消えるため、AI生成でないことの証明にはなりません。'
    : '写真のメタデータに生成AIを示す記録があります。署名は検証していないため、記録が書き換えられている可能性もあります。';
  const camera_note = status === 'not_found' && !camera
    ? '撮影したカメラの記録（機種名）もありません。AI生成画像・スクリーンショット・SNSから保存した画像でよく見られますが、ブラウザやアプリが自動で削除することも多く、それだけで問題があるとは言えません。'
    : null;
  return { status, label, signals, c2pa, camera, camera_note, reason };
}
