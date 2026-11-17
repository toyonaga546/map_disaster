const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => new Date(value).toLocaleString('ja-JP',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
let posts=[], composing=false, picking=false, watch=null, gpsTimer=null, samples=[], imageData=null, previewURL=null, pickingPin=null, currentPin=null, activeDetail=null;
let manualPoint=false;
function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('toast').hidden=true,5500); }
async function api(url, options={}) { const response=await fetch(url,options); const value=await response.json(); if(!response.ok) throw new Error(value.error || '通信に失敗しました。'); return value; }
const map=L.map('map',{zoomControl:false}).setView([35.6812,139.7671],14);
L.control.zoom({position:'topright'}).addTo(map);
const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
let tileErrorShown=false;
tiles.on('tileerror',()=>{if(!tileErrorShown){toast('背景地図を取得できません。ネット接続を確認してください。');tileErrorShown=true;}});
const markers=L.layerGroup().addTo(map);
const hazardTypes = new Map([
  ['flood', ['水', '浸水']], ['landslide', ['土', '土砂災害']], ['fire', ['火', '火災']],
  ['road', ['道', '道路障害']], ['building', ['建', '建物被害']], ['utility', ['停', 'ライフライン被害']],
  ['other', ['他', 'その他の被害']]
]);
const hazardLevels = new Map([['high','危険度：高'], ['caution','注意'], ['unknown','判断困難']]);

function hazardDisplay(post) {
  const hazard = post.hazard;
  if (hazard?.status === 'complete') {
    const [symbol, type] = hazardTypes.get(hazard.category) || ['？', '種類不明'];
    const level = hazardLevels.has(hazard.level) ? hazard.level : 'unknown';
    return { symbol, level, label: type + ' · ' + hazardLevels.get(level), reason: hazard.reason };
  }
  const pending = hazard?.status === 'pending' && Date.now() - Date.parse(hazard.started_at) < 120000;
  const label = pending ? '解析中' : hazard ? '判定できません' : '未解析';
  return { symbol:'？', level:'unknown', label, reason:hazard?.reason };
}

function hazardDetails(post) {
  const { label, reason } = hazardDisplay(post);
  return '<section class="verification-block"><strong>被災状況のAI推定 · ' + label + '</strong>' +
    (reason ? '<p>' + escape(reason) + '</p>' : '') +
    '<br><small>投稿時点の情報です。避難などの判断には自治体の公式情報を確認してください。</small></section>';
}
function gpsLabel(p) {return p.gps.status==='consistent'?'GPS：矛盾なし':p.gps.status==='attention'?'GPS：注意が必要':'GPS：判定不可';}
function aiLabel(p) {return p.ai.status==='pending'?'AI：未検証':p.ai.status!=='complete'?'AI：判定不可':({consistent:'AI：一致の可能性が高い',inconsistent:'AI：不一致の可能性が高い',unknown:'AI：判断困難'}[p.ai.result]);}
const DIRECTIONS={0:'北',90:'東',180:'南',270:'西'};
function streetviewHTML(p) {
  const s=p.streetview;
  if(!s)return '<section class="verification-block"><strong>ストリートビュー · 未保存</strong><p>この投稿にはストリートビュー画像を保存していません。下のリンクから確認できます。</p></section>';
  if(s.status!=='available')return `<section class="verification-block"><strong>ストリートビュー · 取得できませんでした</strong><p>${escape(s.reason)}</p></section>`;
  const copyright=escape(s.copyright||'© Google');
  if(s.images?.length)return `<section class="verification-block"><strong>◫ ストリートビュー（東西南北の4方向）</strong><p class="muted">上の投稿写真と同じ建物・道路・看板がないか、4方向から探してください。</p><div class="compare">${s.images.map(v=>`<figure><a href="${v.image_url}" target="_blank" rel="noopener noreferrer"><img src="${v.image_url}" alt="ストリートビュー（${DIRECTIONS[v.heading]}向き）" loading="lazy"></a><figcaption>${DIRECTIONS[v.heading]}向き</figcaption></figure>`).join('')}</div><small>${copyright} · ${escape(s.captured||'撮影時期不明')}頃 · 約${Number(s.distance)}m離れた地点から撮影 · 画像をタップすると拡大します。撮影時期が古い場合や、災害で景色が変わっている場合があります。AIが判断できなくても、ご自身の目で見比べてください。</small></section>`;
  // Posts saved before the four-direction capture have a single image.
  return `<section class="verification-block"><strong>◫ 投稿写真とストリートビューの見比べ</strong><div class="compare"><figure><a href="${p.image_url}" target="_blank" rel="noopener noreferrer"><img src="${p.image_url}" alt="投稿写真" loading="lazy"></a><figcaption>投稿写真</figcaption></figure><figure><a href="${s.image_url}" target="_blank" rel="noopener noreferrer"><img src="${s.image_url}" alt="投稿地点周辺のストリートビュー" loading="lazy"></a><figcaption>ストリートビュー<br>${escape(s.captured||'撮影時期不明')}頃 · 約${Number(s.distance)}m離れた地点から投稿地点の方向</figcaption></figure></div><small>${copyright} · 画像をタップすると拡大します。撮影時期が古い場合や、災害で景色が変わっている場合があります。AIが判断できなくても、建物・道路・看板などをご自身の目で見比べてください。</small></section>`;
}
function renderFeed() {
  const query=$('search').value.trim().toLowerCase();
  const visible=posts.filter(p=>p.description.toLowerCase().includes(query));
  $('count').textContent=posts.length;
  $('feed').innerHTML=visible.length?visible.map(p=>`<button class="report-card" data-post="${p.id}"><img src="${p.image_url}" alt="投稿写真" loading="lazy"><time>${date(p.created_at)}</time><p>${escape(p.description.slice(0,85))}</p><div class="tags"><span class="tag unknown">${hazardDisplay(p).label}</span><span class="tag ${p.gps.status}">${gpsLabel(p)}</span><span class="tag unknown">${aiLabel(p)}</span></div></button>`).join(''):`<div class="empty"><div class="empty-icon">⌖</div><h3>${query?'該当する投稿がありません':'まだ投稿がありません'}</h3><p>${query?'検索する言葉を変更してください。':'あなたの確認した状況が、<br>地域の情報につながります。'}</p></div>`;
  markers.clearLayers();
  for (const p of visible) {
    const { symbol, level, label } = hazardDisplay(p);
    const icon = L.divIcon({
      className: 'hazard-marker hazard-' + level,
      html: '<span aria-hidden="true">' + symbol + '</span>',
      iconSize: [32, 32], iconAnchor: [16, 32], tooltipAnchor: [0, -28]
    });
    L.marker([p.latitude, p.longitude], { icon, title: label })
      .bindTooltip(label, { direction:'top' })
      .on('click', () => showDetail(p.id)).addTo(markers);
  }
}
async function refresh() {posts=await api('/api/posts');renderFeed();}
$('refresh').onclick=()=>refresh().then(()=>toast('最新の投稿を取得しました。')).catch(e=>toast(e.message));
$('search').oninput=renderFeed;
$('feed').onclick=e=>{const card=e.target.closest('[data-post]');if(card)showDetail(card.dataset.post);};
function setPoint(lat,lng){$('latitude').value=lat.toFixed(6);$('longitude').value=lng.toFixed(6);if(pickingPin)map.removeLayer(pickingPin);pickingPin=L.circleMarker([lat,lng],{radius:12,color:'#245748',weight:3,fillOpacity:.25}).addTo(map);}
function stopGPS(){if(watch!==null)navigator.geolocation.clearWatch(watch);watch=null;clearTimeout(gpsTimer);}
function startGPS(){
  stopGPS(); samples=[];
  if(!navigator.geolocation){$('gps-state').textContent='このブラウザはGPSを利用できません。場所は手動で指定できます。';return;}
  $('gps-state').textContent='取得許可を確認中…（最大30秒）';
  watch=navigator.geolocation.watchPosition(position=>{
    samples.push({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy,recorded_at:position.timestamp});samples=samples.slice(-120);
    if(samples.length===1&&!manualPoint){setPoint(position.coords.latitude,position.coords.longitude);map.setView([position.coords.latitude,position.coords.longitude],16);}
    $('gps-state').textContent=`取得中：${samples.length}件 / 測位精度 約${Math.round(position.coords.accuracy)}m`;
  },error=>{stopGPS();$('gps-state').textContent=error.code===1?'位置情報は許可されていません。判定不可として投稿できます。':'位置情報を取得できません。場所は手動で指定できます。';},{enableHighAccuracy:true,maximumAge:0,timeout:10000});
  gpsTimer=setTimeout(()=>{stopGPS();$('gps-state').textContent=samples.length?`取得完了：${samples.length}件（30秒）`:'取得できませんでした。場所は手動で指定できます。';},30000);
}
$('new-post').onclick=()=>{
  composing=true;manualPoint=false;imageData=null;$('post-form').reset();$('preview').hidden=true;
  if(previewURL)URL.revokeObjectURL(previewURL);
  const center=map.getCenter();setPoint(center.lat,center.lng);$('compose').showModal();startGPS();
};
function cleanupCompose(){composing=false;picking=false;stopGPS();$('return-compose').hidden=true;if(pickingPin){map.removeLayer(pickingPin);pickingPin=null;}}
$('compose').addEventListener('close',()=>{if(!picking)cleanupCompose();});
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('pick-location').onclick=()=>{picking=true;$('compose').close();$('return-compose').hidden=false;toast('地図をクリックして投稿場所を選んでください。');};
map.on('click',e=>{if(picking){manualPoint=true;setPoint(e.latlng.lat,e.latlng.lng);}});
[$('latitude'),$('longitude')].forEach(input=>input.oninput=()=>manualPoint=true);
$('return-compose').onclick=()=>{picking=false;$('return-compose').hidden=true;$('compose').showModal();};
$('photo').onchange=()=>{
  imageData=null;const file=$('photo').files[0];
  if(!file)return;
  if(file.size>8_000_000){$('photo').value='';$('preview').hidden=true;toast('写真は8MB以下にしてください。');return;}
  if(previewURL)URL.revokeObjectURL(previewURL);
  previewURL=URL.createObjectURL(file);$('preview').src=previewURL;$('preview').hidden=false;
};
$('locate').onclick=()=>{
  if(!navigator.geolocation)return toast('位置情報を利用できません。');
  navigator.geolocation.getCurrentPosition(p=>{map.setView([p.coords.latitude,p.coords.longitude],16);if(currentPin)map.removeLayer(currentPin);currentPin=L.circleMarker([p.coords.latitude,p.coords.longitude],{radius:8,color:'#fff',weight:3,fillColor:'#548aba',fillOpacity:1}).addTo(map);},()=>toast('現在地を取得できません。ブラウザの位置情報設定をご確認ください。'),{enableHighAccuracy:true,timeout:10000});
};
$('post-form').onsubmit=async event=>{
  event.preventDefault();const button=$('submit-post');button.disabled=true;button.textContent='投稿を保存中…';
  try{
    const file=$('photo').files[0];if(!file)throw new Error('写真を選択してください。');
    imageData=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('写真を読み込めません。'));reader.readAsDataURL(file);});
    stopGPS();
    const freshSamples=samples.filter(s=>Date.now()-s.recorded_at<=120000);
    const result=await api('/api/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:$('description').value,latitude:Number($('latitude').value),longitude:Number($('longitude').value),samples:freshSamples,image:imageData,ai_consent:true,hazard_consent:true})});
    const link=`${location.origin}/#manage=${result.post.id}.${result.management_token}`;
    $('compose').close();posts.unshift(result.post);renderFeed();await showDetail(result.post.id);
    if(!$('detail').open){$('detail-content').textContent='投稿は保存されました。詳細は後ほど開き直してください。';$('detail').showModal();}
    const box=document.createElement('section');box.className='verification-block';const title=document.createElement('strong');title.textContent='投稿を保存しました。専用の管理リンク';const anchor=document.createElement('a');anchor.href=link;anchor.className='management-link';anchor.textContent=link;const note=document.createElement('p');note.textContent='このリンクは今回のみ表示します。コピーして保管してください。リンクを知る人は編集・削除できます。';box.append(title,anchor,note);$('detail-content').prepend(box);map.setView([result.post.latitude,result.post.longitude],16);
  }catch(e){toast(e.message);}finally{button.disabled=false;button.textContent='この場所の状況を投稿する →';}
};
async function showDetail(id){
  try{
    const {post:p,history,priority}=await api(`/api/posts/${id}`);activeDetail=id;
    const preferred=history.filter(p=>priority.includes(p.id)), others=history.filter(p=>!priority.includes(p.id));
    const historyHTML=list=>list.map(h=>`<button class="history-item" data-history="${h.id}"><img src="${h.image_url}" alt="過去の投稿写真" loading="lazy"><span>${date(h.created_at)}${h.id===id?' · 表示中':''}<br>${escape(h.description.slice(0,65))}</span></button>`).join('');
    $('detail-content').innerHTML=`<img class="detail-photo" src="${p.image_url}" alt="現地の投稿写真"><p class="detail-date">${date(p.created_at)} 投稿${p.updated_at?` / ${date(p.updated_at)} 編集`:''}<br>投稿地点 ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}</p><p class="detail-description">${escape(p.description)}</p>${hazardDetails(p)}<section class="verification-block"><strong>⌖ GPS · ${escape(p.gps.label)}</strong><p>${p.gps.distance!==undefined?`投稿地点との距離：約${p.gps.distance}m / 精度：約${p.gps.accuracy}m<br>`:''}${escape(p.gps.reason)}</p></section><section class="verification-block"><strong>◇ ${aiLabel(p)}</strong><p>${escape(p.ai.reason)}</p><small>AIは画像の整合性の参考情報です。投稿内容の真偽を保証しません。</small></section>${streetviewHTML(p)}<section class="verification-block"><strong>写真メタデータ · ${escape(p.metadata.status)}</strong><p>撮影日時：${p.metadata.taken_at?date(p.metadata.taken_at):'確認できない'}<br>カメラ：${escape(p.metadata.camera || '確認できない')}<br>編集ソフト：${escape(p.metadata.software || '確認できない')}<br>写真の位置情報：${escape(p.metadata.location || '確認できない')}</p>${p.metadata.warnings.map(w=>`<p>${escape(w)}</p>`).join('')}<small>メタデータがないことは、写真が未編集である証明にはなりません。公開画像からメタデータを除去しています。</small></section><a class="secondary" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.latitude},${p.longitude}" target="_blank" rel="noopener noreferrer">Googleで周辺のストリートビューを確認 ↗</a><p class="muted">外部サイトを開きます。撮影時期が現在と異なる場合や、画像が存在しない場合があります。</p><h2>同じ場所の投稿 <small>半径100m・${history.length}件</small></h2><p class="muted">最新3件と整合性の補助スコア上位3件を重複なく表示</p>${historyHTML(preferred)}${others.length?`<details><summary>その他の過去投稿 ${others.length}件</summary>${historyHTML(others)}</details>`:''}`;
    if(!$('detail').open)$('detail').showModal();
  }catch(e){toast(e.message);}
}
$('detail-content').onclick=e=>{const item=e.target.closest('[data-history]');if(item)showDetail(item.dataset.history,true);};
$('refresh-detail').onclick=()=>{if($('detail-content').querySelector('.management-link')&&!confirm('管理リンクは再表示できません。保管済みの場合はOKを押して評価を更新してください。'))return;if(activeDetail)showDetail(activeDetail);};
let manager=null;
async function management(){
  const match=location.hash.match(/^#manage=([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/);
  if(!match)return;
  manager={id:match[1],token:match[2]};
  try{const {post}=await api(`/api/posts/${manager.id}`);$('edit-description').value=post.description;if($('detail').open)$('detail').close();if(!$('manage').open)$('manage').showModal();}catch(e){toast(e.message);}
}
$('manage-form').onsubmit=async e=>{e.preventDefault();try{await api(`/api/posts/${manager.id}`,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${manager.token}`},body:JSON.stringify({description:$('edit-description').value})});toast('変更を保存しました。');$('manage').close();await refresh();}catch(e){toast(e.message);}};
$('delete-post').onclick=async()=>{if(!confirm('この投稿と写真を削除しますか？'))return;try{await api(`/api/posts/${manager.id}`,{method:'DELETE',headers:{'Content-Type':'application/json',Authorization:`Bearer ${manager.token}`}});$('manage').close();history.replaceState(null,'','/');await refresh();toast('投稿を削除しました。');}catch(e){toast(e.message);}};
window.addEventListener('hashchange',management);
window.addEventListener('pagehide',stopGPS);
await refresh().catch(e=>toast(e.message));await management();
setInterval(async()=>{if(!document.hidden&&!composing){try{await refresh();}catch{/* Keep the last successful list during transient failures. */}}},15000);
