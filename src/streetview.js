import { distance } from './domain.js';

const API = 'https://maps.googleapis.com/maps/api/streetview';
// North, east, south and west with a 90 degree field of view cover the full 360 degrees.
export const HEADINGS = [0, 90, 180, 270];
// Image variants stored for a post: the legacy single image and/or the four directions.
export const streetviewVariants = view => view?.status === 'available'
  ? [...(view.image_url ? ['streetview'] : []), ...(view.images ?? []).map(({ heading }) => `streetview-${heading}`)]
  : [];
const unavailable = reason => ({ info: { status: 'unavailable', reason }, images: null });

// Never throws: a missing Street View image must not prevent posting.
// The API key stays on the server; callers only receive the images.
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
    // The photographed direction is unknown, so fetch all four compass directions.
    const images = await Promise.all(HEADINGS.map(async heading => {
      const params = { size: '640x640', pano: info.pano_id, heading: String(heading), fov: '90', return_error_code: 'true', key };
      const image = await request(`${API}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(8000) });
      if (!image.ok || !String(image.headers.get('content-type')).startsWith('image/jpeg')) throw new Error('image');
      const bytes = Buffer.from(await image.arrayBuffer());
      if (!bytes.length || bytes.length > 2_000_000) throw new Error('image');
      return { heading, bytes };
    }));
    return { info: { status: 'available', captured: typeof info.date === 'string' ? info.date.slice(0, 7) : null, distance: meters, copyright: typeof info.copyright === 'string' ? info.copyright.slice(0, 100) : '© Google', fetched_at: new Date().toISOString() }, images };
  } catch {
    return unavailable('ストリートビュー画像を取得できませんでした。');
  }
}
