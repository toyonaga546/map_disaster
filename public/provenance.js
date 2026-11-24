const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {ai_generated:'AI生成の記録あり',ai_edited:'AI編集・生成素材の使用記録あり',ai_signal:'AI生成・編集のシグナルあり'};

export function provenanceHTML(post) {
  const result=post.provenance;
  // Existing posts have only a C2PA summary. Missing fields and a verified
  // non-AI action must both remain inconclusive, never "real photo".
  const c2pa=result?.c2pa || result;
  const synthid=result?.synthid;
  const checked=Date.parse(result?.checked_at);
  const when=Number.isFinite(checked)?new Date(checked).toLocaleString('ja-JP'):'';
  const c2paLabel=labels[c2pa?.status] || '判定不可';
  const synthidLabel=synthid?.status==='detected'?'OpenAI由来の透かしを検出':'判定不可';
  return '<section class="verification-block" id="image-provenance"><strong>AI生成画像の確認 · '+
    (labels[result?.status] || '判定不可')+'</strong><p>'+escape(result?.reason || 'この投稿は元画像による検証結果が保存されていないため、判定不可です。')+'</p>'+
    '<p><strong>C2PA · '+c2paLabel+'</strong><br>'+escape(c2pa?.reason || '検証結果がありません。')+'</p>'+
    (c2pa?.issuer?'<p>署名の発行元 '+escape(c2pa.issuer)+'</p>':'')+
    '<p><strong>SynthID · '+synthidLabel+'</strong><br>'+escape(synthid?.reason || 'この投稿では透かしを検証していません。')+'</p>'+
    (when?'<small>投稿時の元画像を検証 · '+escape(when)+'</small><br>':'')+
    '<small>判定不可は実写の証明ではありません。透かし検証はOpenAI由来の対応シグナルが対象です。撮影場所・日時や投稿内容の真偽は、現地情報と合わせて確認してください。</small></section>';
}
