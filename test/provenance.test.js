import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { inspectProvenance, summarizeProvenance } from '../src/provenance.js';

const source = 'http://cv.iptc.org/newscodes/digitalsourcetype/';
function manifest(type) {
  return {signature_info:{issuer:'Test issuer'},
    assertions:[{label:'c2pa.actions.v2',data:{actions:[{digitalSourceType:source+type}]}}]};
}
test('署名検証状態に基づいて生成記録・編集記録・発行元未確認を区別する', () => {
  const store={active_manifest:'current',validation_state:'Trusted',manifests:{current:manifest('trainedAlgorithmicMedia')}};
  assert.equal(summarizeProvenance(store).status,'ai_generated');
  assert.equal(summarizeProvenance(store).issuer,'Test issuer');
  assert.equal(summarizeProvenance({...store,validation_state:'Valid'}).status,'untrusted');
  assert.equal(summarizeProvenance({...store,validation_state:'Invalid'}).status,'invalid');
  assert.equal(summarizeProvenance({...store,validation_state:undefined}).status,'unavailable');
  store.manifests.current=manifest('compositeWithTrainedAlgorithmicMedia');
  assert.equal(summarizeProvenance(store).status,'ai_edited');
  store.manifests.current=manifest('digitalCapture');
  assert.equal(summarizeProvenance(store).status,'verified');
  store.manifests.ancestor=manifest('trainedAlgorithmicMedia');
  assert.equal(summarizeProvenance(store).status,'verified');
  store.manifests.current.ingredients=[{active_manifest:'ancestor'}];
  assert.equal(summarizeProvenance(store).status,'ai_edited');
  store.manifests.ancestor.ingredients=[{active_manifest:'current'}];
  assert.equal(summarizeProvenance(store).status,'ai_edited');
  assert.equal(summarizeProvenance(null).status,'not_present');
});
test('実際の検証ライブラリで識別情報のないJPEG・PNG・WebPと壊れた入力を処理する', async () => {
  for (const format of ['jpeg','png','webp']) {
    const photo=await sharp({create:{width:16,height:16,channels:3,background:'#456'}})[format]().toBuffer();
    const result=await inspectProvenance(photo,'image/'+format);
    assert.equal(result.status,'not_present');
    assert.ok(Number.isFinite(Date.parse(result.checked_at)));
  }
  assert.equal((await inspectProvenance(Buffer.from('broken'),'image/jpeg')).status,'unavailable');
});
