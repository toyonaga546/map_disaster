const MAX_ACCURACY_METERS = 1000;
const BASE_ALLOWANCE_METERS = 300;
// 異常ジャンプとみなす移動速度の上限（約162km/h）
const MAX_SPEED_MPS = 45;
const JUMP_BUFFER_METERS = 100;
const MIN_WEIGHT_ACCURACY = 5;
const GPS_DISCLAIMER = 'GPSは写真の撮影場所や真偽を証明しません。';

export function distance(a, b) {
  const rad = n => n * Math.PI / 180;
  const x = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, x)));
}
export function validPoint(p) {
  return p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
}

// 数値配列の中央値を返す
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// 取得時刻がある場合は昇順で並べ替え、ない場合は元の順序を保持する
function sortChronologically(samples) {
  return samples
    .map((sample, index) => ({ sample, index }))
    .sort((a, b) => {
      const hasTimeA = Number.isFinite(a.sample.recorded_at);
      const hasTimeB = Number.isFinite(b.sample.recorded_at);
      if (hasTimeA && hasTimeB && a.sample.recorded_at !== b.sample.recorded_at) {
        return a.sample.recorded_at - b.sample.recorded_at;
      }
      return a.index - b.index;
    })
    .map(item => item.sample);
}

// 2点間の距離と経過時間から物理的に不自然なジャンプかどうかを判定する
function isSpeedJump(prev, curr) {
  if (!Number.isFinite(prev.recorded_at) || !Number.isFinite(curr.recorded_at)) return false;
  const dt = Math.max((curr.recorded_at - prev.recorded_at) / 1000, 0.5);
  const allowed = MAX_SPEED_MPS * dt + prev.accuracy + curr.accuracy + JUMP_BUFFER_METERS;
  return distance(prev, curr) > allowed;
}

// 時系列データから単発の異常スパイクを除外し、残存する不自然なジャンプ数を返す
function analyzeTimeSeries(sorted) {
  if (sorted.length < 3) {
    const remainingJumps = sorted.length === 2 && isSpeedJump(sorted[0], sorted[1]) ? 1 : 0;
    return { clean: sorted, spikeCount: 0, remainingJumps };
  }
  const medPoint = {
    latitude: median(sorted.map(s => s.latitude)),
    longitude: median(sorted.map(s => s.longitude))
  };
  const medAccuracy = median(sorted.map(s => s.accuracy));
  const isSpike = new Array(sorted.length).fill(false);

  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && i < sorted.length - 1) {
      // 前後との遷移がともに異常で、前後同士は自然につながっている場合は単発スパイクとみなす
      if (isSpeedJump(sorted[i - 1], sorted[i]) && isSpeedJump(sorted[i], sorted[i + 1]) && !isSpeedJump(sorted[i - 1], sorted[i + 1])) {
        isSpike[i] = true;
      }
    } else {
      // 先頭または末尾の点が隣接点からジャンプし、かつ中央値群から大きく外れている場合はスパイクとみなす
      const neighbor = i === 0 ? sorted[1] : sorted[sorted.length - 2];
      const farFromMedian = distance(sorted[i], medPoint) > sorted[i].accuracy + medAccuracy + 500;
      if (isSpeedJump(i === 0 ? sorted[i] : neighbor, i === 0 ? neighbor : sorted[i]) && farFromMedian) {
        isSpike[i] = true;
      }
    }
  }

  const clean = sorted.filter((_, idx) => !isSpike[idx]);
  const spikeCount = sorted.length - clean.length;
  let remainingJumps = 0;
  for (let i = 1; i < clean.length; i++) {
    if (isSpeedJump(clean[i - 1], clean[i])) remainingJumps++;
  }
  return { clean, spikeCount, remainingJumps };
}

// 測位精度の逆二乗を重みとして代表座標と代表精度を算出する
function weightedCenter(samples) {
  let weightSum = 0;
  let latSum = 0;
  let lngSum = 0;
  let accSum = 0;
  for (const s of samples) {
    const w = 1 / Math.max(s.accuracy, MIN_WEIGHT_ACCURACY) ** 2;
    weightSum += w;
    latSum += s.latitude * w;
    lngSum += s.longitude * w;
    accSum += s.accuracy * w;
  }
  return {
    latitude: latSum / weightSum,
    longitude: lngSum / weightSum,
    accuracy: accSum / weightSum
  };
}

export function gpsResult(point, samples) {
  const list = Array.isArray(samples) ? samples : [];
  const usable = list.filter(s => validPoint(s) && Number.isFinite(s.accuracy) && s.accuracy >= 0 && s.accuracy <= MAX_ACCURACY_METERS);
  if (!usable.length) return { status: 'unknown', label: '判定不可', reason: 'GPSを取得できないか、測位精度が不足しています。' };

  if (usable.length === 1) {
    const single = usable[0];
    const meters = Math.round(distance(point, single));
    const ok = meters <= BASE_ALLOWANCE_METERS + single.accuracy;
    return {
      status: ok ? 'consistent' : 'attention',
      label: ok ? '位置情報に大きな矛盾なし' : '位置情報に注意が必要',
      distance: meters,
      accuracy: Math.round(single.accuracy),
      count: list.length,
      reason: `1件の測位データから判定。${GPS_DISCLAIMER}`
    };
  }

  const sorted = sortChronologically(usable);
  const { clean, spikeCount, remainingJumps } = analyzeTimeSeries(sorted);
  // 除外後も不自然なジャンプが残る場合や、正常点より外れ値が多い場合は異常とみなす
  const excessiveJumps = remainingJumps > 0 || spikeCount >= clean.length;
  const active = clean.length ? clean : sorted;

  const center = weightedCenter(active);
  const centerMeters = Math.round(distance(point, center));
  const centerAccuracy = Math.round(center.accuracy);
  const supportCount = active.filter(s => distance(point, s) <= BASE_ALLOWANCE_METERS + s.accuracy).length;
  const hasMajoritySupport = supportCount * 2 >= active.length;
  const isNearCenter = centerMeters <= BASE_ALLOWANCE_METERS + center.accuracy;

  // 自然な連続移動で投稿地点へ近づき、最新測位が許容範囲内にあるかを確認する
  const hasTimestamps = active.every(s => Number.isFinite(s.recorded_at));
  const latest = active[active.length - 1];
  const latestMeters = Math.round(distance(point, latest));
  const isNearLatest = latestMeters <= BASE_ALLOWANCE_METERS + latest.accuracy;
  const movingTowardPoint = hasTimestamps && distance(point, latest) <= distance(point, active[0]);
  const arrivedByMoving = !excessiveJumps && hasTimestamps && isNearLatest && movingTowardPoint && !(isNearCenter && hasMajoritySupport);

  const ok = (!excessiveJumps && isNearCenter && hasMajoritySupport) || arrivedByMoving;
  const displayDistance = arrivedByMoving ? latestMeters : centerMeters;
  const displayAccuracy = arrivedByMoving ? Math.round(latest.accuracy) : centerAccuracy;

  let reason;
  if (excessiveJumps) {
    reason = `短時間での不自然な位置移動を検出しました。${GPS_DISCLAIMER}`;
  } else if (arrivedByMoving) {
    reason = `時系列の移動経路と最新測位から判定。${GPS_DISCLAIMER}`;
  } else if (!ok) {
    reason = `複数測位の重み付き平均と投稿地点に乖離があります。${GPS_DISCLAIMER}`;
  } else if (spikeCount > 0) {
    reason = `外れ値を除いた複数測位の重み付き平均から判定。${GPS_DISCLAIMER}`;
  } else {
    reason = `複数測位の重み付き平均と時系列の連続性から判定。${GPS_DISCLAIMER}`;
  }

  return {
    status: ok ? 'consistent' : 'attention',
    label: ok ? '位置情報に大きな矛盾なし' : '位置情報に注意が必要',
    distance: displayDistance,
    accuracy: displayAccuracy,
    count: list.length,
    reason
  };
}
export function priority(posts) {
  const score = p => (p.gps.status === 'consistent' ? 1 : 0) + (p.ai.result === 'consistent' ? 1 : 0);
  const latest = [...posts].sort((a,b) => b.created_at.localeCompare(a.created_at));
  const ranked = [...latest].filter(p => score(p) > 0).sort((a,b) => score(b)-score(a));
  return [...new Map([...latest.slice(0,3), ...ranked.slice(0,3)].map(p => [p.id,p])).values()];
}
