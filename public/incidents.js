import { postLifecycle } from './lifecycle.js';

export function distanceMeters(a, b) {
  const radians = value => value * Math.PI / 180;
  const latitude = radians(b.latitude - a.latitude);
  const longitude = radians(b.longitude - a.longitude);
  const value = Math.sin(latitude / 2) ** 2 + Math.cos(radians(a.latitude)) *
    Math.cos(radians(b.latitude)) * Math.sin(longitude / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(value)));
}

// Keep each episode within 200 m of every member to avoid joining distant reports through a chain.
export function groupIncidents(posts, now = Date.now()) {
  const groups = [];
  for (const post of [...posts].sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const category = post.hazard?.status === 'complete' ? post.hazard.category : 'unknown';
    const start = Date.parse(post.created_at);
    const state = postLifecycle(post, now);
    const end = Date.parse(post.resolved_at || state.expires_at);
    let group = groups.find(item => category !== 'unknown' && category !== 'other' &&
      item.category === category && start < item.end &&
      item.posts.every(member => distanceMeters(member, post) <= 200));
    if (!group) {
      group = {id:post.id, category, posts:[], end};
      groups.push(group);
    }
    group.posts.push(post);
    group.end = Math.max(group.end, end);
  }
  return groups.map(group => ({...group,
    active:group.posts.filter(post => postLifecycle(post, now).status === 'active')
  }));
}

export function incidentTimeline(group) {
  return [...group.posts]
    .sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map(post => ({post, time:post.created_at, label:'投稿', note:post.description, image:post.image_url}));
}
