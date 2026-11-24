import { postLifecycle } from './lifecycle.js';
import { groupIncidents, incidentTimeline, distanceMeters } from './incidents.js';

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

function reachesVoteThreshold(count, total) {
  return total > 0 && count * 4 >= total;
}

function photoVoteSummary(votes = {}) {
  const genuine = votes.genuine || 0;
  const fake = votes.false || 0;
  const total = genuine + fake;
  if (!total) return '投票はまだありません。';
  const percent = count => (100 * count / total).toLocaleString('ja-JP', { maximumFractionDigits: 2 }) + '％';
  const labels = [];
  if (reachesVoteThreshold(genuine, total)) labels.push('<strong>この画像は「真」との判定あり（25％以上）</strong>');
  if (reachesVoteThreshold(fake, total)) labels.push('<strong>この画像は「偽」との判定あり（25％以上）</strong>');
  return (labels.length === 2 ? '<strong>真偽の判断が分かれています</strong><br>' : '') + labels.join('<br>') + '<br>真 ' + percent(genuine) + '（' + genuine +
    '票） · 偽 ' + percent(fake) + '（' + fake + '票）';
}

function photoVoteSection(post) {
  return '<section class="verification-block" id="photo-vote"><strong>投稿写真の真偽投票</strong>' +
    '<p id="photo-vote-summary" aria-live="polite">' + photoVoteSummary(post.photo_votes) + '</p>' +
    '<p>現地を確認した方は、写真が投稿時点の現地の状況を伝えているか投票できます。</p>' +
    '<label class="consent"><input type="checkbox" id="photo-vote-witness"><span>現地の状況を実際に確認しました</span></label>' +
    '<div class="field-row"><button type="button" class="secondary" data-photo-vote="genuine">真と判断</button>' +
    '<button type="button" class="secondary" data-photo-vote="false">偽と判断</button></div>' +
    '<small>現地を確認したという自己申告に基づく集計です。同じブラウザから投票し直すと前の票を置き換えます。</small></section>';
}

async function submitPhotoVote(choice, panel, id) {
  if (!panel.querySelector('#photo-vote-witness').checked) {
    toast('現地を確認したことにチェックを入れてください。');
    return;
  }
  const buttons = panel.querySelectorAll('[data-photo-vote]');
  buttons.forEach(button => button.disabled = true);
  try {
    const key = 'disaster-map-voter';
    let voter = localStorage.getItem(key);
    if (!voter) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      voter = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(key, voter);
    }
    const votes = await api('/api/posts/' + id + '/vote', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter, choice })
    });
    panel.querySelector('#photo-vote-summary').innerHTML = photoVoteSummary(votes);
    const post = posts.find(post => post.id === id);
    if (post) {
      post.photo_votes = votes;
      renderFeed();
    }
    toast('投票を保存しました。');
  } catch (error) {
    toast(error.message || '投票を保存できませんでした。');
  } finally {
    buttons.forEach(button => button.disabled = false);
  }
}

function synthidReviewHTML(post) {
  const review = post.synthid_review;
  const labels = {detected:'電子透かしを検出との報告',not_detected:'電子透かし未検出との報告',inconclusive:'判断できずとの報告'};
  return '<section class="verification-block"><strong>SynthIDの手動確認 · ' +
    (labels[review?.result] || '未確認') + '</strong>' +
    (review ? '<p>投稿者による確認結果の記録 · ' +
      (review.tool === 'detector' ? 'SynthID Detector' : 'Gemini') + '<br>確認画像 ' +
      (review.image_source === 'original' ? '投稿前の元画像' : '公開用の変換済み画像') +
      '<br>記録日時 ' + date(review.recorded_at) + '</p><p>' + escape(review.note) + '</p>' : '') +
    '<p><a href="https://synthid.com/" target="_blank" rel="noopener noreferrer">Google公式のSynthID Detectorを開く ↗</a></p>' +
    '<small>投稿者が公式ツールで確認し、管理リンクから記録する機能です。透かしが検出されても、生成したサービスは公式ツールの結果で確認してください。未検出でもAI生成の可能性はあります。</small></section>';
}

function fillSynthidReview(post) {
  const review = post.synthid_review;
  $('synthid-result').value = review?.result || '';
  $('synthid-tool').value = review?.tool || 'detector';
  $('synthid-source').value = review?.image_source || 'original';
  $('synthid-note').value = review?.note || '';
  $('synthid-confirmed').checked = false;
  $('synthid-photo').href = post.image_url;
}

$('synthid-review-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('save-synthid');
  button.disabled = true;
  try {
    await api('/api/posts/' + manager.id + '/synthid-review', {
      method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer ' + manager.token},
      body:JSON.stringify({result:$('synthid-result').value,tool:$('synthid-tool').value,
        image_source:$('synthid-source').value,note:$('synthid-note').value,confirmed:$('synthid-confirmed').checked})
    });
    toast('SynthIDの手動確認結果を保存しました。');
    await refresh();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
};

function provenanceHTML(post) {
  const result = post.provenance;
  const labels = {
    ai_generated:'AI生成の記録あり',ai_edited:'AI編集・生成素材の使用記録あり',
    verified:'生成・編集情報を確認',not_present:'識別情報なし',
    invalid:'検証できず（整合性エラー）',untrusted:'発行元未確認',unavailable:'確認失敗'
  };
  return '<section class="verification-block"><strong>画像の生成元 · ' +
    (labels[result?.status] || '未検証') + '</strong><p>' +
    escape(result?.reason || 'この投稿は生成元の検証に対応する前に保存されています。') + '</p>' +
    (result?.issuer ? '<p>署名の発行元 ' + escape(result.issuer) + '</p>' : '') +
    (result?.checked_at ? '<small>投稿時の元画像を検証 · ' + date(result.checked_at) + '</small><br>' : '') +
    '<small>識別情報がなくてもAI生成の可能性はあります。撮影場所・日時や投稿内容の真偽は、現地情報と合わせて確認してください。</small></section>';
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
function showIncident(group) {
  const latest = group.posts.reduce((a,b) =>
    postLifecycle(a).confirmed_at > postLifecycle(b).confirmed_at ? a : b);
  const type = hazardTypes.get(group.category)?.[1] || '種類不明';
  $('incident-title').textContent = type + 'の報告 · ' + group.posts.length + '件';
  $('incident-content').innerHTML = '<p class="muted">最終確認 ' +
    date(postLifecycle(latest).confirmed_at) +
    ' · 現在表示中 ' + group.active.length + '件</p>' +
    '<p class="muted">点線は報告地点が集まる目安です。被害の境界や通行可能な範囲を示すものではありません。</p>' +
    '<ol class="incident-timeline">' + incidentTimeline(group).map(event =>
      '<li><time>' + date(event.time) + '</time><h3>' + event.label + '</h3>' +
      (event.image ? '<img src="' + escape(event.image) + '" alt="現地の報告写真" loading="lazy">' : '') +
      '<p>' + escape(event.note) + '</p><button class="secondary" data-timeline-post="' +
      event.post.id + '">投稿の詳細を開く</button></li>').join('') + '</ol>';
  if (!$('incident').open) $('incident').showModal();
}

$('incident-content').onclick = event => {
  const button = event.target.closest('[data-timeline-post]');
  if (!button) return;
  $('incident').close();
  void showDetail(button.dataset.timelinePost);
};

function renderIncidentAreas(visible, groups) {
  const ids = new Set(visible.map(post => post.id));
  for (const group of groups) {
    const members = group.active.filter(post => ids.has(post.id));
    if (members.length < 2) continue;
    const center = {
      latitude:members.reduce((sum,post) => sum + post.latitude, 0) / members.length,
      longitude:members.reduce((sum,post) => sum + post.longitude, 0) / members.length
    };
    const radius = Math.max(...members.map(post => distanceMeters(center, post))) + 30;
    const type = hazardTypes.get(group.category)?.[1] || '種類不明';
    const latest = members.reduce((a,b) => postLifecycle(a).confirmed_at > postLifecycle(b).confirmed_at ? a : b);
    const label = type + ' · ' + members.length + '件 · 最終確認 ' + date(postLifecycle(latest).confirmed_at);
    L.circle([center.latitude,center.longitude], {
      radius, color:'#476b80', weight:2, dashArray:'6 5', fillOpacity:0.1
    }).bindTooltip(label, {permanent:true,direction:'top',className:'incident-label'})
      .on('click', () => showIncident(group)).addTo(markers);
  }
}

function renderFeed() {
  const query=$('search').value.trim().toLowerCase();
  const archive = $('post-view').value === 'archive';
  const groups = groupIncidents(posts);
  const visibleGroups = groups.filter(group =>
    (group.active.length === 0) === archive &&
    group.posts.some(post => post.description.toLowerCase().includes(query)));
  const visible = visibleGroups.flatMap(group => group.active);
  $('count').textContent = visibleGroups.length;
  $('feed').innerHTML = visibleGroups.length ? visibleGroups.map(group => {
    const latest = group.posts[group.posts.length - 1];
    const label = hazardTypes.get(group.category)?.[1] || '種類不明';
    return '<button class="report-card" data-post="' + latest.id + '"><img src="' +
      escape(latest.image_url) + '" alt="最新の投稿写真" loading="lazy"><time>' +
      date(latest.created_at) + '</time><p>' + escape(latest.description.slice(0,85)) +
      '</p><div class="tags"><span class="tag">' + label + ' · 投稿' + group.posts.length +
      '件</span><span class="tag unknown">' + (archive ? '履歴' : '表示中') +
      '</span></div></button>';
  }).join('') : '<div class="empty"><h3>該当する投稿がありません</h3></div>';
  markers.clearLayers();

  renderIncidentAreas(visible, groups);
  for (const p of visible.filter(p => postLifecycle(p).status === 'active')) {
    const group = groups.find(group => group.posts.some(post => post.id === p.id));
    if (group?.active.length >= 2 && group.active[0].id !== p.id) continue;
    const { symbol, level, label } = hazardDisplay(p);
    const { genuine = 0, false: fake = 0 } = p.photo_votes || {};
    const flagged = group?.active.some(post => {
      const votes = post.photo_votes || {};
      return reachesVoteThreshold(votes.false || 0, (votes.genuine || 0) + (votes.false || 0));
    }) || reachesVoteThreshold(fake, genuine + fake);
    const markerLabel = flagged ? label + ' · 偽と判断した票が25％以上' : label;
    const icon = L.divIcon({
      className: 'hazard-marker hazard-' + level + (flagged ? ' hazard-marker-flagged' : ''),
      html: '<span aria-hidden="true">' + symbol + '</span>',
      iconSize: [32, 32], iconAnchor: [16, 32], tooltipAnchor: [0, -28]
    });
    const members = group?.active || [p];
    const point = [members.reduce((sum,post) => sum + post.latitude,0) / members.length,
      members.reduce((sum,post) => sum + post.longitude,0) / members.length];
    L.marker(point, { icon, title: markerLabel })
      .bindTooltip(markerLabel, { direction:'top' })
      .on('click', () => group && group.posts.length > 1 ? showIncident(group) : showDetail(p.id)).addTo(markers);
  }
}
async function refresh() {posts=await api('/api/posts');renderFeed();}
$('refresh').onclick=()=>refresh().then(()=>toast('最新の投稿を取得しました。')).catch(e=>toast(e.message));
$('search').oninput=renderFeed;
$('post-view').onchange=renderFeed;
setInterval(renderFeed, 30000);
$('feed').onclick = event => {
  const card = event.target.closest('[data-post]');
  if (!card) return;
  const group = groupIncidents(posts).find(group => group.posts.some(post => post.id === card.dataset.post));
  if (group?.posts.length > 1) showIncident(group);
  else void showDetail(card.dataset.post);
};
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
let mapMovedByUser=false;
map.on('dragstart',()=>{mapMovedByUser=true;});
// ユーザの位置情報を取得して地図の中心に表示する。初回は地図を移動させるが、ユーザがすでに地図を動かした場合や投稿フォームを開いた場合は移動させない
// silent=trueの場合はエラーをトースト表示しない
function showCurrentLocation(silent=false){
  if(!navigator.geolocation){if(!silent)toast('位置情報を利用できません。');return;}
  navigator.geolocation.getCurrentPosition(p=>{
    const point=[p.coords.latitude,p.coords.longitude];
    if(currentPin)map.removeLayer(currentPin);
    currentPin=L.circleMarker(point,{radius:8,color:'#fff',weight:3,fillColor:'#548aba',fillOpacity:1}).addTo(map);
    if(!silent||(!mapMovedByUser&&!composing))map.setView(point,16);
  },()=>{if(!silent)toast('現在地を取得できません。ブラウザの位置情報設定をご確認ください。');},{enableHighAccuracy:true,timeout:10000});
}
$('locate').onclick=()=>{
  showCurrentLocation();
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
//詳細画面
async function showDetail(id){
  try{
    const {post:p,history,priority}=await api(`/api/posts/${id}`);activeDetail=id;
    const preferred=history.filter(p=>priority.includes(p.id)), others=history.filter(p=>!priority.includes(p.id));
    const historyHTML=list=>list.map(h=>`<button class="history-item" data-history="${h.id}"><img src="${h.image_url}" alt="過去の投稿写真" loading="lazy"><span>${date(h.created_at)}${h.id===id?' · 表示中':''}<br>${escape(h.description.slice(0,65))}</span></button>`).join('');
    $('detail-content').innerHTML=`<img class="detail-photo" src="${p.image_url}" alt="現地の投稿写真">${photoVoteSection(p)}<p class="detail-date">${date(p.created_at)} 投稿${p.updated_at?` / ${date(p.updated_at)} 編集`:''}<br>投稿地点 ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}</p><p class="detail-description">${escape(p.description)}</p>${hazardDetails(p)}${provenanceHTML(p)}${synthidReviewHTML(p)}<section class="verification-block"><strong>⌖ GPS · ${escape(p.gps.label)}</strong><p>${p.gps.distance!==undefined?`投稿地点との距離：約${p.gps.distance}m / 精度：約${p.gps.accuracy}m<br>`:''}${escape(p.gps.reason)}</p></section><section class="verification-block"><strong>◇ ${aiLabel(p)}</strong><p>${escape(p.ai.reason)}</p><small>AIは画像の整合性の参考情報です。投稿内容の真偽を保証しません。</small></section>${streetviewHTML(p)}<section class="verification-block"><strong>写真メタデータ · ${escape(p.metadata.status)}</strong><p>撮影日時：${p.metadata.taken_at?date(p.metadata.taken_at):'確認できない'}<br>カメラ：${escape(p.metadata.camera || '確認できない')}<br>編集ソフト：${escape(p.metadata.software || '確認できない')}<br>写真の位置情報：${escape(p.metadata.location || '確認できない')}</p>${p.metadata.warnings.map(w=>`<p>${escape(w)}</p>`).join('')}<small>メタデータがないことは、写真が未編集である証明にはなりません。公開画像からメタデータを除去しています。</small></section><a class="secondary" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.latitude},${p.longitude}" target="_blank" rel="noopener noreferrer">Googleで周辺のストリートビューを確認 ↗</a><p class="muted">外部サイトを開きます。撮影時期が現在と異なる場合や、画像が存在しない場合があります。</p><h2>同じ場所の投稿 <small>半径100m・${history.length}件</small></h2><p class="muted">最新3件と整合性の補助スコア上位3件を重複なく表示</p>${historyHTML(preferred)}${others.length?`<details><summary>その他の過去投稿 ${others.length}件</summary>${historyHTML(others)}</details>`:''}`;
    if(!$('detail').open)$('detail').showModal();
  }catch(e){toast(e.message);}
}
$('detail-content').onclick = event => {
  const vote = event.target.closest('[data-photo-vote]');
  if (vote) {
    void submitPhotoVote(vote.dataset.photoVote, vote.closest('#photo-vote'), activeDetail);
    return;
  }
  const item = event.target.closest('[data-history]');
  if (item) showDetail(item.dataset.history, true);
};
//管理リンクと起動
$('refresh-detail').onclick=()=>{if($('detail-content').querySelector('.management-link')&&!confirm('管理リンクは再表示できません。保管済みの場合はOKを押して評価を更新してください。'))return;if(activeDetail)showDetail(activeDetail);};
let manager=null;
async function management(){
  const match=location.hash.match(/^#manage=([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/);
  if(!match)return;
  manager={id:match[1],token:match[2]};
  try{const {post}=await api(`/api/posts/${manager.id}`);$('edit-description').value=post.description;fillSynthidReview(post);if($('detail').open)$('detail').close();if(!$('manage').open)$('manage').showModal();}catch(e){toast(e.message);}
}
$('manage-form').onsubmit=async e=>{e.preventDefault();try{await api(`/api/posts/${manager.id}`,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${manager.token}`},body:JSON.stringify({description:$('edit-description').value})});toast('変更を保存しました。');$('manage').close();await refresh();}catch(e){toast(e.message);}};
$('delete-post').onclick=async()=>{if(!confirm('この投稿と写真を削除しますか？'))return;try{await api(`/api/posts/${manager.id}`,{method:'DELETE',headers:{'Content-Type':'application/json',Authorization:`Bearer ${manager.token}`}});$('manage').close();history.replaceState(null,'','/');await refresh();toast('投稿を削除しました。');}catch(e){toast(e.message);}};
window.addEventListener('hashchange',management);
window.addEventListener('pagehide',stopGPS);
showCurrentLocation(true);
await refresh().catch(e=>toast(e.message));await management();
setInterval(async()=>{if(!document.hidden&&!composing){try{await refresh();}catch{/* Keep the last successful list during transient failures. */}}},15000);
