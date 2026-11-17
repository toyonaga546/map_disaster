// Copies the app code into functions/ so the Functions source directory is
// self-contained. The copies are build output and are not committed.
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const name of ['src', 'public']) {
  const target = new URL(`../functions/${name}/`, import.meta.url);
  rmSync(target, { recursive: true, force: true });
  cpSync(new URL(`../${name}/`, import.meta.url), target, { recursive: true });
}
console.log(`functions/ に src と public をコピーしました（${root}）`);
