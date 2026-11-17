import { distance } from './domain.js';
import { compareImages } from './ai.js';

const unavailable = reason => ({ status: 'unavailable', result: 'unknown', reason });

// Compares a stored post with the nearest earlier consenting post and its saved
// Street View images. Reads everything from storage so it can run in a separate
// process (for example a Firestore trigger) from the one that accepted the post.
export async function analyzePost({ store, imageStoreFor, post, consent, request }) {
  if (!consent) return unavailable('外部AIへの画像送信に同意されていません。');
  if (!process.env.OPENAI_API_KEY) return unavailable('AIのAPIキーが設定されていません。');
  try {
    const images = imageStoreFor(post);
    const current = await images.read(post.id);
    const previous = (await store.listConsenting())
      .filter(p => p.id !== post.id && p.created_at < post.created_at && distance(p, post) <= 100)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const streetviews = await Promise.all((post.streetview?.status === 'available' ? post.streetview.images ?? [] : [])
      .map(async ({ heading }) => ({ heading, bytes: await images.read(post.id, `streetview-${heading}`) })));
    return await compareImages(current, previous ? await imageStoreFor(previous).read(previous.id) : null, request, streetviews);
  } catch {
    return unavailable('比較用写真を取得できません。');
  }
}
