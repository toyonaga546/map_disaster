import { readFile } from 'node:fs/promises';
import { Context, Reader } from '@contentauth/c2pa-node';
import { inspectOpenAIProvenance } from './provenance-api.js';

const generated = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
const editedTypes = new Set([
  'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia',
  'http://cv.iptc.org/newscodes/digitalsourcetype/compositedWithTrainedAlgorithmicMedia'
]);
// Official C2PA trust list bundled on 2026-11-24 from c2pa-org/conformance-public/trust-list/C2PA-TRUST-LIST.pem.
let contextPromise;

function validationContext() {
  contextPromise ??= readFile(new URL('./c2pa-trust.pem', import.meta.url), 'utf8').then(trustAnchors =>
    new Context({
      trust:{trustAnchors},
      verify:{verifyTrust:true,verifyAfterReading:true,remoteManifestFetch:false,ocspFetch:false}
    })).catch(error => { contextPromise = undefined; throw error; });
  return contextPromise;
}

function sourceTypes(manifest) {
  return (manifest?.assertions || [])
    .filter(assertion => /^c2pa.actions(?:\.v\d+)?$/.test(assertion.label))
    .flatMap(assertion => (assertion.data?.actions || []).map(action => action.digitalSourceType));
}

export function summarizeProvenance(store) {
  if (!store) return {status:'not_present',reason:'画像内にC2PA識別情報が見つかりませんでした。'};
  const active = store.manifests?.[store.active_manifest];
  const validation = store.validation_state;
  if (validation === 'Invalid') return {status:'invalid',reason:'署名や画像との整合性を検証できませんでした。'};
  if (!active || !['Trusted','Valid'].includes(validation)) {
    return {status:'unavailable',reason:'識別情報の検証結果を取得できませんでした。'};
  }
  if (validation !== 'Trusted') {
    return {status:'untrusted',reason:'識別情報はありますが、発行元の信頼性を確認できませんでした。'};
  }
  const types = sourceTypes(active);
  const visited = new Set([store.active_manifest]);
  const pending = (active.ingredients || []).map(ingredient => ingredient.active_manifest).filter(Boolean);
  let ancestorGenerated = false;
  while (pending.length) {
    const label = pending.pop();
    if (visited.has(label)) continue;
    visited.add(label);
    const manifest = store.manifests[label];
    if (!manifest) continue;
    ancestorGenerated ||= sourceTypes(manifest).some(type => type === generated || editedTypes.has(type));
    pending.push(...(manifest.ingredients || []).map(ingredient => ingredient.active_manifest).filter(Boolean));
  }
  const status = types.includes(generated) ? 'ai_generated'
    : types.some(type => editedTypes.has(type)) || ancestorGenerated ? 'ai_edited' : 'verified';
  const issuer = active.signature_info?.issuer;
  return {
    status, validation:'trusted',
    issuer:typeof issuer === 'string' ? issuer.slice(0,200) : '',
    reason:({
      ai_generated:'信頼できる署名付きの来歴に、AI生成の記録があります。',
      ai_edited:'信頼できる署名付きの来歴に、AI編集またはAI生成素材の使用記録があります。',
      verified:'署名付きの来歴を検証しました。確認した来歴にAI生成・編集の記録はありません。'
    })[status]
  };
}

export async function inspectProvenance(buffer, mimeType) {
  const checked_at = new Date().toISOString();
  try {
    const reader = await Reader.fromAsset({buffer,mimeType}, await validationContext());
    return {...summarizeProvenance(reader?.json()),checked_at};
  } catch {
    return {status:'unavailable',checked_at,reason:'C2PAの検証処理に失敗しました。'};
  }
}

export function combineProvenance(local, remote, checked_at=new Date().toISOString()) {
  const positive = result => ['ai_generated','ai_edited'].includes(result?.status);
  // An invalid local manifest is not promoted to verified by a conflicting
  // remote result. SynthID is evaluated independently from the signature.
  const c2pa = !positive(local) && local?.status!=='invalid' && remote?.c2pa?.status==='ai_generated'
    ? remote.c2pa : {...local,source:'local'};
  const synthid = remote.synthid;
  const status = positive(c2pa) ? c2pa.status : synthid.status==='detected' ? 'ai_signal' : 'unknown';
  const reason = positive(c2pa) ? c2pa.reason : status==='ai_signal' ? synthid.reason
    : 'AI生成・編集を示す検証済みの情報を確認できませんでした。実写であることを示す結果ではありません。';
  return {status,reason,checked_at,c2pa,synthid};
}

export async function inspectImageProvenance(buffer,mimeType,options={}) {
  const [local,remote]=await Promise.all([
    inspectProvenance(buffer,mimeType),
    inspectOpenAIProvenance(buffer,mimeType,options)
  ]);
  return combineProvenance(local,remote);
}
