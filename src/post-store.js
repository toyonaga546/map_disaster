import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

function tallyVote(totals, previous, choice) {
  const next = { genuine: 0, false: 0, ...totals };
  if (previous) next[previous]--;
  next[choice]++;
  return next;
}

// Keep the public API separate from private GPS records and token hashes.
export async function createSqliteStore(directory) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(directory, 'posts.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, payload TEXT NOT NULL, gps_private TEXT NOT NULL, ai_consent INTEGER NOT NULL DEFAULT 0)');
  if (!db.prepare('PRAGMA table_info(posts)').all().some(c=>c.name==='ai_consent')) db.exec('ALTER TABLE posts ADD COLUMN ai_consent INTEGER NOT NULL DEFAULT 0');
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS photo_votes (post_id TEXT NOT NULL, voter_hash TEXT NOT NULL, choice TEXT NOT NULL, PRIMARY KEY (post_id, voter_hash))');
  function transaction(write) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = write();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    db,
    async list() { return db.prepare('SELECT payload FROM posts').all().map(r=>JSON.parse(r.payload)); },
    async listConsenting() { return db.prepare('SELECT payload FROM posts WHERE ai_consent=1').all().map(r=>JSON.parse(r.payload)); },
    async get(id) { const row=db.prepare('SELECT * FROM posts WHERE id=?').get(id); return row ? {post:JSON.parse(row.payload),private:{token_hash:row.token_hash,gps_samples:JSON.parse(row.gps_private),ai_consent:!!row.ai_consent}} : null; },
    async create(post, privateData) { db.prepare('INSERT INTO posts (id,token_hash,payload,gps_private,ai_consent) VALUES (?,?,?,?,?)').run(post.id,privateData.token_hash,JSON.stringify(post),JSON.stringify(privateData.gps_samples),privateData.ai_consent?1:0); },
    async patch(id, fields, matches = () => true) {
      return transaction(() => {
        const row = db.prepare('SELECT payload FROM posts WHERE id=?').get(id);
        if (!row) return null;
        const current = JSON.parse(row.payload);
        if (!matches(current)) return null;
        const post = { ...current, ...fields };
        db.prepare('UPDATE posts SET payload=? WHERE id=?').run(JSON.stringify(post), id);
        return post;
      });
    },
    async vote(id, voterHash, choice) {
      return transaction(() => {
        const row = db.prepare('SELECT payload FROM posts WHERE id=?').get(id);
        if (!row) return null;
        const post = JSON.parse(row.payload);
        const previous = db.prepare('SELECT choice FROM photo_votes WHERE post_id=? AND voter_hash=?').get(id, voterHash);
        post.photo_votes = tallyVote(post.photo_votes, previous?.choice, choice);
        db.prepare('INSERT INTO photo_votes VALUES (?,?,?) ON CONFLICT(post_id,voter_hash) DO UPDATE SET choice=excluded.choice').run(id, voterHash, choice);
        db.prepare('UPDATE posts SET payload=? WHERE id=?').run(JSON.stringify(post), id);
        return post.photo_votes;
      });
    },
    async delete(id) {
      transaction(() => {
        db.prepare('DELETE FROM photo_votes WHERE post_id=?').run(id);
        db.prepare('DELETE FROM posts WHERE id=?').run(id);
      });
    },
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
    async patch(id,fields,matches = () => true) {
      return db.runTransaction(async transaction=>{
        const ref=posts.doc(id), snapshot=await transaction.get(ref);
        if (!snapshot.exists) return null;
        const current=snapshot.data();
        if (!matches(current)) return null;
        transaction.update(ref,fields);
        return {...current,...fields};
      });
    },
    async vote(id, voterHash, choice) {
      return db.runTransaction(async transaction => {
        const postRef = posts.doc(id), privateRef = privatePosts.doc(id);
        const [post, privateData] = await Promise.all([transaction.get(postRef), transaction.get(privateRef)]);
        if (!post.exists || !privateData.exists) return null;
        const ballots = privateData.data().photo_ballots || {};
        const photo_votes = tallyVote(post.data().photo_votes, ballots[voterHash], choice);
        transaction.update(privateRef, { photo_ballots: { ...ballots, [voterHash]: choice } });
        transaction.update(postRef, { photo_votes });
        return photo_votes;
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
