import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Keep the public API separate from private GPS records and token hashes.
export async function createSqliteStore(directory) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(directory, 'posts.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, payload TEXT NOT NULL, gps_private TEXT NOT NULL, ai_consent INTEGER NOT NULL DEFAULT 0)');
  if (!db.prepare('PRAGMA table_info(posts)').all().some(c=>c.name==='ai_consent')) db.exec('ALTER TABLE posts ADD COLUMN ai_consent INTEGER NOT NULL DEFAULT 0');
  return {
    db,
    async list() { return db.prepare('SELECT payload FROM posts').all().map(r=>JSON.parse(r.payload)); },
    async listConsenting() { return db.prepare('SELECT payload FROM posts WHERE ai_consent=1').all().map(r=>JSON.parse(r.payload)); },
    async get(id) { const row=db.prepare('SELECT * FROM posts WHERE id=?').get(id); return row ? {post:JSON.parse(row.payload),private:{token_hash:row.token_hash,gps_samples:JSON.parse(row.gps_private),ai_consent:!!row.ai_consent}} : null; },
    async create(post, privateData) { db.prepare('INSERT INTO posts (id,token_hash,payload,gps_private,ai_consent) VALUES (?,?,?,?,?)').run(post.id,privateData.token_hash,JSON.stringify(post),JSON.stringify(privateData.gps_samples),privateData.ai_consent?1:0); },
    async patch(id, fields) {
      const row=db.prepare('SELECT payload FROM posts WHERE id=?').get(id);
      if (!row) return null;
      const post={...JSON.parse(row.payload),...fields};
      db.prepare('UPDATE posts SET payload=? WHERE id=?').run(JSON.stringify(post),id);
      return post;
    },
    async delete(id) { db.prepare('DELETE FROM posts WHERE id=?').run(id); },
    async close() { db.close(); }
  };
}

export function firestoreStore(db, close=async()=>{}) {
  const posts=db.collection('posts'), privatePosts=db.collection('postPrivate');
  return {
    async check() { await posts.limit(1).get(); },
    async list() { return (await posts.get()).docs.map(doc=>doc.data()); },
    async listConsenting() {
      const consented=(await privatePosts.where('ai_consent','==',true).get()).docs;
      if (!consented.length) return [];
      const snapshots=await db.getAll(...consented.map(doc=>posts.doc(doc.id)));
      return snapshots.filter(doc=>doc.exists).map(doc=>doc.data());
    },
    async get(id) {
      const [post,privateData]=await db.getAll(posts.doc(id),privatePosts.doc(id));
      return post.exists ? {post:post.data(),private:privateData.exists?privateData.data():null} : null;
    },
    async create(post,privateData) {
      const batch=db.batch();
      batch.create(posts.doc(post.id),post);
      batch.create(privatePosts.doc(post.id),privateData);
      await batch.commit();
    },
    async patch(id,fields) {
      return db.runTransaction(async transaction=>{
        const ref=posts.doc(id), snapshot=await transaction.get(ref);
        if (!snapshot.exists) return null;
        transaction.update(ref,fields);
        return {...snapshot.data(),...fields};
      });
    },
    async delete(id) {
      const batch=db.batch();batch.delete(posts.doc(id));batch.delete(privatePosts.doc(id));await batch.commit();
    },
    close
  };
}

export async function createFirestoreStore() {
  const projectId=process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_IDを設定してください。');
  const {initializeApp,applicationDefault,deleteApp}=await import('firebase-admin/app');
  const {getFirestore}=await import('firebase-admin/firestore');
  const options={projectId};
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    options.credential=applicationDefault();
    // Validate before constructing Firestore's gRPC client so missing ADC is
    // reported by the caller rather than a background client rejection.
    await options.credential.getAccessToken();
  }
  const app=initializeApp(options,`disaster-map-${randomUUID()}`);
  const db=getFirestore(app);
  return firestoreStore(db,async()=>{await db.terminate();await deleteApp(app);});
}

export async function createPostStore(directory) {
  const driver=process.env.DB_DRIVER || 'sqlite';
  if(driver==='sqlite') return createSqliteStore(directory);
  if(driver==='firestore') return createFirestoreStore();
  throw new Error('DB_DRIVERはsqliteまたはfirestoreを指定してください。');
}
