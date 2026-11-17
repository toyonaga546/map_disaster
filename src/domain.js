export function distance(a, b) {
  const rad = n => n * Math.PI / 180;
  const x = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, x)));
}
export function validPoint(p) {
  return p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
}
export function gpsResult(point, samples) {
  const usable = samples.filter(s => s.accuracy <= 1000);
  if (!usable.length) return { status: 'unknown', label: '判定不可', reason: 'GPSを取得できないか、測位精度が不足しています。' };
  const best = usable.reduce((a, b) => a.accuracy < b.accuracy ? a : b);
  const meters = Math.round(distance(point, best));
  return { status: meters <= 300 + best.accuracy ? 'consistent' : 'attention', label: meters <= 300 + best.accuracy ? '位置情報に大きな矛盾なし' : '位置情報に注意が必要', distance: meters, accuracy: Math.round(best.accuracy), count: samples.length, reason: '最も精度が高い測位を使用。GPSは写真の撮影場所や真偽を証明しません。' };
}
export function priority(posts) {
  const score = p => (p.gps.status === 'consistent' ? 1 : 0) + (p.ai.result === 'consistent' ? 1 : 0);
  const latest = [...posts].sort((a,b) => b.created_at.localeCompare(a.created_at));
  const ranked = [...latest].filter(p => score(p) > 0).sort((a,b) => score(b)-score(a));
  return [...new Map([...latest.slice(0,3), ...ranked.slice(0,3)].map(p => [p.id,p])).values()];
}
