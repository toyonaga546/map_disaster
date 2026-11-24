const hours = { flood:24, fire:6, utility:24, road:72, landslide:168, building:168 };
export function postLifecycle(post, now = Date.now()) {
  const confirmedAt = post.last_confirmed_at || post.created_at;
  const duration = hours[post.hazard?.category] || 24;
  const expiresAt = Date.parse(confirmedAt) + duration * 3600000;
  const status = post.resolved_at ? 'resolved' : now >= expiresAt || !Number.isFinite(expiresAt) ? 'expired' : 'active';
  return { status, expires_at:Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
    confirmed_at:confirmedAt, hours:duration };
}
