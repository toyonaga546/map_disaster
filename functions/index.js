import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { handleRequest, analyzeCreatedPost } from './src/functions-runtime.js';

// scripts/deploy.sh lists the secrets that exist in DEPLOY_SECRETS. Binding a
// secret that was never created makes the deploy fail, so only listed ones are bound.
const secrets = (process.env.DEPLOY_SECRETS || '').split(',').filter(name => ['OPENAI_API_KEY', 'GOOGLE_MAPS_API_KEY'].includes(name)).map(name => defineSecret(name));
const region = 'asia-northeast1';

// Hosting rewrites every path here, so the same function serves the page, the API and photos.
export const app = onRequest({ region, secrets, memory: '1GiB', timeoutSeconds: 60, maxInstances: 3, concurrency: 10 }, handleRequest);

// AI comparison runs outside the request: a function stops getting CPU once it has responded.
export const analyzePost = onDocumentCreated({ document: 'posts/{postId}', region, secrets, memory: '1GiB', timeoutSeconds: 120, maxInstances: 3 }, event => analyzeCreatedPost(event.params.postId));
