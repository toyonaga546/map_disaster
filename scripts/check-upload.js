import { execFileSync } from 'node:child_process';
const limit=10_000_000;
const files=execFileSync('git',['diff','--cached','--name-only','--diff-filter=ACMR','-z']).toString().split('\0').filter(Boolean);
let total=0, invalid=false;
for(const file of files){
  if(file.split('/').some(part=>['node_modules','data','.env'].includes(part)||(part.startsWith('.env.')&&part!=='.env.example'))){console.error(`禁止対象: ${file}`);invalid=true;}
  const size=execFileSync('git',['show',`:${file}`],{maxBuffer:110_000_000}).length;
  total+=size;if(size>limit){console.error(`ファイル上限超過: ${file} (${size} bytes)`);invalid=true;}
}
console.log(`ステージ済み: ${files.length} files / ${total.toLocaleString('en-US')} bytes / 上限 ${limit.toLocaleString('en-US')} bytes`);
if(total>limit||invalid)process.exitCode=1;
