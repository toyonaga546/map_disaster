import { bearing, distance } from './domain.js';

const API = 'https://maps.googleapis.com/maps/api/streetview';
const unavailable = reason => ({ info: { status: 'unavailable', reason }, bytes: null });

// Never throws: a missing Street View image must not prevent posting.
// The API key stays on the server; callers only receive the saved image.
export async function fetchStreetView(point, request = fetch) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return unavailable('Google Maps APIキーが設定されていません。');
  try {
    const metadata = await request(`${API}/metadata?${new URLSearchParams({ location: `${point.latitude},${point.longitude}`, radius: '50', source: 'outdoor', key })}`, { signal: AbortSignal.timeout(8000) });
    if (!metadata.ok) throw new Error('metadata');
    const info = await metadata.json();
    if (info.status === 'ZERO_RESULTS' || info.status === 'NOT_FOUND') return unavailable('投稿地点の50m以内にストリートビューがありません。');
    const pano = { latitude: info.location?.lat, longitude: info.location?.lng };
    if (info.status !== 'OK' || typeof info.pano_id !== 'string' || !Number.isFinite(pano.latitude) || !Number.isFinite(pano.longitude)) throw new Error('metadata');
    const meters = Math.round(distance(pano, point));
    // Face the post location; near-zero distances give a meaningless heading.
    const params = { size: '640x640', pano: info.pano_id, fov: '90', return_error_code: 'true', key };
    if (meters >= 5) params.heading = String(Math.round(bearing(pano, point)));
    const image = await request(`${API}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(8000) });
    if (!image.ok || !String(image.headers.get('content-type')).startsWith('image/jpeg')) throw new Error('image');
    const bytes = Buffer.from(await image.arrayBuffer());
    if (!bytes.length || bytes.length > 2_000_000) throw new Error('image');
    return { info: { status: 'available', captured: typeof info.date === 'string' ? info.date.slice(0, 7) : null, distance: meters, copyright: typeof info.copyright === 'string' ? info.copyright.slice(0, 100) : '© Google', fetched_at: new Date().toISOString() }, bytes };
  } catch {
    return unavailable('ストリートビュー画像を取得できませんでした。');
  }
}
