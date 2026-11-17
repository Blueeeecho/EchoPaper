/** From _system: node --import tsx scripts/migrate-collaboration-roles.ts [--port N] [--apply] */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {planRoleMigration,applyRoleMigration} from '../shared/role-migration';
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2),index=args.indexOf('--port');
const port=index>=0?Number(args[index+1]):JSON.parse(await fs.readFile(path.join(workspace,'_system/runtime/instance.json'),'utf8')).port;
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('无法确定端口，请显式传 --port。');
const base=`http://127.0.0.1:${port}`,request:typeof fetch=(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(15000)});
const plan=await planRoleMigration(base,workspace,request);
const dir=path.join(workspace,'_system/qa/orchestration-role-simplification-20261110-r2/migrations',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());
await fs.mkdir(dir,{recursive:true});
await fs.writeFile(path.join(dir,'public-before.json'),JSON.stringify(plan.before,null,2),{flag:'wx'});
await fs.writeFile(path.join(dir,'proposal.json'),JSON.stringify({expectedRevision:plan.before.revision,assistant:plan.assistant,changed:plan.changed,warnings:plan.warnings},null,2),{flag:'wx'});
if(args.includes('--apply')){const after=await applyRoleMigration(base,plan,request);await fs.writeFile(path.join(dir,'public-after.json'),JSON.stringify(after,null,2),{flag:'wx'});console.log('迁移处理完成：'+dir);}else console.log('仅生成迁移预览，未修改配置：'+dir);
