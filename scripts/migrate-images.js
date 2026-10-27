import {fileURLToPath} from 'node:url';
import {createPostStore} from '../src/post-store.js';
import {localImageStore,createFirebaseImageStore} from '../src/image-store.js';

const directory=fileURLToPath(new URL('../data/',import.meta.url));
const apply=process.argv.includes('--apply');
let store,images;
let migrated=0,failed=0;
try {
  store=await createPostStore(directory);
  const posts=(await store.list()).filter(p=>!p.image_storage||p.image_storage==='local');
  console.log(`対象: ${posts.length}件 / ${apply?'移行を実行':'確認のみ（--applyで実行）'}`);
  const local=localImageStore(directory);
  if(apply){images=await createFirebaseImageStore();await images.check();}
  for(const post of posts){
    try {
      const bytes=await local.read(post.id);
      if(apply){
        try{await images.save(post.id,bytes);}
        catch(error){if(error.code!==412||!(await images.read(post.id)).equals(bytes))throw error;}
        const updated=await store.patch(post.id,{image_storage:'firebase'});
        if(!updated){await images.delete(post.id);throw new Error('Post deleted during migration');}
        migrated++;
      }
      console.log(`${apply?'移行済み':'移行可能'}: ${post.id}`);
    } catch {failed++;console.error(`移行できません: ${post.id}（ローカル写真・保存先・権限を確認）`);}
  }
  console.log(`移行完了: ${migrated}件 / 失敗: ${failed}件。ローカル原本は保持しています。`);
  if(failed)process.exitCode=1;
} catch {console.error('写真移行の接続設定を確認してください。');process.exitCode=1;}
finally {if(images)await images.close();if(store)await store.close();}
