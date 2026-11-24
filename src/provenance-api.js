const API = 'https://api.openai.com/v1/content_provenance_checks';

function unavailable(reason, code) {
  return { c2pa:{status:'unavailable',reason,code}, synthid:{status:'unavailable',reason,code,provider:'openai'} };
}
const text = value => typeof value === 'string' ? value.slice(0,200) : '';

// An API response is evidence only when its documented signal and validation
// fields agree. A missing signal is never interpreted as a human-made image.
export function summarizeOpenAIProvenance(body) {
  if(body?.object !== 'content_provenance_check' || !Array.isArray(body.results)) {
    return unavailable('検証サービスから正しい形式の結果を取得できませんでした。','invalid_response');
  }
  const one = type => {
    const matches=body.results.filter(result=>result?.type===type);
    return matches.length===1 ? matches[0] : null;
  };
  const signed=one('c2pa'), watermark=one('synthid');
  const c2pa = signed?.outcome==='detected' && ['trusted','valid'].includes(signed.validation_state) && /^OpenAI\b/i.test(text(signed.issuer))
    ? {status:'ai_generated',validation:signed.validation_state,issuer:text(signed.issuer),model:text(signed.model),source:'openai',reason:'OpenAIの検証サービスで、OpenAIによるAI生成の来歴情報を確認しました。'}
    : {status:'not_detected',source:'openai',reason:'OpenAIによるAI生成の来歴情報を確認できませんでした。'};
  let synthid;
  if(watermark?.outcome==='detected') {
    synthid={status:'detected',provider:'openai',model:text(watermark.model),reason:'OpenAI由来のSynthID透かしを検出しました。AIで生成・編集された内容を含む可能性を示します。'};
  }else if(watermark?.outcome==='not_detected') {
    synthid={status:'not_detected',provider:'openai',reason:'対応するOpenAI由来の透かしは検出されませんでした。他社のAI画像や、情報が失われた画像を実写と判断する結果ではありません。'};
  }else{
    synthid={status:'unavailable',provider:'openai',code:'invalid_response',reason:'透かし検証の結果を取得できませんでした。'};
  }
  return {c2pa,synthid};
}

export async function inspectOpenAIProvenance(buffer,mimeType,{consent=false,request=fetch,apiKey=process.env.OPENAI_API_KEY,timeoutMs=8000}={}) {
  if(consent!==true)return unavailable('元画像の外部送信に同意されていないため、透かしは検証していません。','no_consent');
  if(!apiKey)return unavailable('透かしの検証サービスが設定されていません。','not_configured');
  const extension={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[mimeType];
  if(!extension || !Buffer.isBuffer(buffer) || !buffer.length || buffer.length>8_000_000) {
    return unavailable('対応する画像ファイルを取得できませんでした。','unsupported_image');
  }
  try {
    const form=new FormData();
    // Keep the original bytes, including C2PA. Do not upload the public JPEG.
    // The original filename and local filesystem path are not sent.
    form.append('file',new Blob([buffer],{type:mimeType}),`image.${extension}`);
    const response=await request(API,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form,signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok) {
      const code = response.status===404 ? 'access_unavailable' : response.status===429 ? 'rate_limited' : 'service_error';
      return unavailable(response.status===429?'検証サービスが混み合っているため、透かしを検証できませんでした。':'透かしの検証サービスを利用できませんでした。',code);
    }
    return summarizeOpenAIProvenance(await response.json());
  } catch {
    return unavailable('通信または検証処理に失敗したため、透かしを確認できませんでした。','request_failed');
  }
}
