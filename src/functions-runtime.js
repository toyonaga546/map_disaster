import os from 'node:os';
import path from 'node:path';
import { createApp } from './server.js';

// Cloud Functions reserves FIREBASE_* names for .env files, so the values the
// app needs are derived from what the runtime provides.
export function configureEnv(env = process.env) {
  const project = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT;
  let bucket;
  try { bucket = JSON.parse(env.FIREBASE_CONFIG || '{}').storageBucket; } catch { /* Fall back below. */ }
  env.DB_DRIVER = 'firestore';
  env.STORAGE_DRIVER = 'firebase';
  env.FIREBASE_PROJECT_ID ??= project;
  env.FIREBASE_STORAGE_BUCKET ??= bucket || (project && `${project}.firebasestorage.app`);
  env.APP_ORIGIN ??= project && `https://${project}.web.app`;
  return env;
}

let pending;
// One app per instance. A failed start is not cached, so the next request retries.
export function getApp(create = () => createApp(path.join(os.tmpdir(), 'disaster-map'), undefined, undefined, undefined, { deferAnalysis: true })) {
  pending ??= Promise.resolve().then(() => { configureEnv(); return create(); }).catch(error => { pending = undefined; throw error; });
  return pending;
}

export async function handleRequest(req, res) {
  try {
    return (await getApp()).handler(req, res);
  } catch {
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'サーバー処理に失敗しました。' })); }
    else res.end();
  }
}

export async function analyzeCreatedPost(id) {
  return (await getApp()).runAnalysis(id);
}
