import { createFirestoreStore } from '../src/post-store.js';

let store;
try {
  store=await createFirestoreStore();
  await store.check();
  console.log(`Firestore接続成功: ${process.env.FIREBASE_PROJECT_ID} / (default)`);
  console.log('読み取り専用の接続確認です。データの追加・変更は行っていません。');
} catch {
  console.error('Firestore接続失敗。FIREBASE_PROJECT_IDとサーバー認証情報・IAM権限・ネットワークを確認してください。');
  console.error('Firebase CLIのログイン情報は、Admin SDKの認証情報とは別です。docs/firebase.mdを参照してください。');
  process.exitCode=1;
} finally { if (store) await store.close(); }
