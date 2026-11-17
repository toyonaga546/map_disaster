import path from 'node:path';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// variant 'streetview' is the Street View image saved next to the post photo.
function filename(id,variant='photo') {
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid image ID');
  if(variant==='photo')return `${id}.jpg`;
  if(variant==='streetview')return `${id}.streetview.jpg`;
  throw new Error('Invalid image variant');
}

export function localImageStore(directory) {
  const folder=path.join(directory,'images');
  return {
    driver:'local',
    async check(){},
    async save(id,bytes,variant){await mkdir(folder,{recursive:true,mode:0o700});await writeFile(path.join(folder,filename(id,variant)),bytes,{mode:0o600,flag:'wx'});},
    async read(id,variant){return readFile(path.join(folder,filename(id,variant)));},
    async delete(id,variant){try{await unlink(path.join(folder,filename(id,variant)));}catch(error){if(error.code!=='ENOENT')throw error;}},
    async close(){}
  };
}

export function firebaseImageStore(bucket,close=async()=>{}) {
  const file=(id,variant)=>bucket.file(`posts/${filename(id,variant)}`);
  return {
    driver:'firebase',
    async check(){await bucket.getMetadata();},
    async save(id,bytes,variant){
      await file(id,variant).save(bytes,{
        resumable:false,
        validation:'crc32c',
        preconditionOpts:{ifGenerationMatch:0},
        metadata:{contentType:'image/jpeg',cacheControl:'private, no-store'}
      });
    },
    async read(id,variant){const [bytes]=await file(id,variant).download();return bytes;},
    async delete(id,variant){await file(id,variant).delete({ignoreNotFound:true});},
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
