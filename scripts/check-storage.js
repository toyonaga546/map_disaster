import {createFirebaseImageStore} from '../src/image-store.js';
let images;
try {
  images=await createFirebaseImageStore();await images.check();
  console.log(`Storage接続成功: ${process.env.FIREBASE_STORAGE_BUCKET}`);
  console.log('バケット情報の読み取りのみ行いました。写真の変更はありません。');
} catch {
  console.error('Storage接続失敗。バケット名・サーバー認証・IAM権限・ネットワークを確認してください。');process.exitCode=1;
} finally {if(images)await images.close();}
