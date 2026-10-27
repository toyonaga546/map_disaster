import path from 'node:path';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

function filename(id) {
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid image ID');
  return `${id}.jpg`;
}

export function localImageStore(directory) {
  const folder=path.join(directory,'images');
  return {
    driver:'local',
    async check(){},
    async save(id,bytes){await mkdir(folder,{recursive:true,mode:0o700});await writeFile(path.join(folder,filename(id)),bytes,{mode:0o600,flag:'wx'});},
    async read(id){return readFile(path.join(folder,filename(id)));},
    async delete(id){try{await unlink(path.join(folder,filename(id)));}catch(error){if(error.code!=='ENOENT')throw error;}},
    async close(){}
  };
}

export function firebaseImageStore(bucket,close=async()=>{}) {
  const file=id=>bucket.file(`posts/${filename(id)}`);
  return {
    driver:'firebase',
    async check(){await bucket.getMetadata();},
    async save(id,bytes){
      await file(id).save(bytes,{
        resumable:false,
        validation:'crc32c',
        preconditionOpts:{ifGenerationMatch:0},
        metadata:{contentType:'image/jpeg',cacheControl:'private, no-store'}
      });
    },
    async read(id){const [bytes]=await file(id).download();return bytes;},
    async delete(id){await file(id).delete({ignoreNotFound:true});},
    close
  };
}

export async function createFirebaseImageStore() {
  const projectId=process.env.FIREBASE_PROJECT_ID;
  const bucketName=process.env.FIREBASE_STORAGE_BUCKET;
  if(!projectId||!bucketName)throw new Error('FIREBASE_PROJECT_IDとFIREBASE_STORAGE_BUCKETを設定してください。');
  if(!/^[a-z0-9][a-z0-9._-]+[a-z0-9]$/.test(bucketName))throw new Error('バケット名はgs://やパスを含めずに指定してください。');
  const {initializeApp,applicationDefault,deleteApp}=await import('firebase-admin/app');
  const {getStorage}=await import('firebase-admin/storage');
  const credential=applicationDefault();await credential.getAccessToken();
  const app=initializeApp({projectId,storageBucket:bucketName,credential},`disaster-images-${randomUUID()}`);
  return firebaseImageStore(getStorage(app).bucket(),()=>deleteApp(app));
}

export async function createImageStore(directory) {
  const driver=process.env.STORAGE_DRIVER||'local';
  if(driver==='local')return localImageStore(directory);
  if(driver==='firebase')return createFirebaseImageStore();
  throw new Error('STORAGE_DRIVERはlocalまたはfirebaseを指定してください。');
}
