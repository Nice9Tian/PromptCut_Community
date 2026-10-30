import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const preload=new URL('../../scripts/lib/test-silent-processes.mjs',import.meta.url).href;
function run(code,env=process.env) {
  return execFileSync(process.execPath,['--import',preload,'--input-type=module','--eval',code],{env,windowsHide:true,encoding:'utf8',timeout:15000});
}

test('SILENT-1 保留 execFile 的 Promise 输出、子进程及失败回包',()=>{
  const output=run(`
    import assert from 'node:assert/strict';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    const success=promisify(execFile)(process.execPath,['--eval','process.stdout.write("ok");process.stderr.write("err")']);
    assert.ok(Number.isInteger(success.child.pid));
    assert.deepEqual(await success,{stdout:'ok',stderr:'err'});
    await assert.rejects(promisify(execFile)(process.execPath,['--eval','process.stdout.write("partial");process.stderr.write("failed");process.exitCode=7']),e=>e.code===7 && e.stdout==='partial' && e.stderr==='failed');
    process.stdout.write('passed');
  `);
  assert.equal(output,'passed');
});

test('SILENT-2 保留 exec 的 Promise 输出与子进程',()=>{
  const output=run(`
    import assert from 'node:assert/strict';
    import { exec } from 'node:child_process';
    import { promisify } from 'node:util';
    const child=promisify(exec)('"'+process.execPath+'" --version');
    assert.ok(Number.isInteger(child.child.pid));
    const result=await child;
    assert.match(result.stdout,/^v/); assert.equal(result.stderr,'');
    process.stdout.write('passed');
  `);
  assert.equal(output,'passed');
});

test('SILENT-3 显式隔离数据目录不被预加载清除，后代仍继承静默设置',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pc-silent-contract-'));
  try {
    const output=run(`
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      assert.ok(process.env.PROMPTCUT_DATA_DIR?.includes('pc-silent-contract-'));
      if(process.platform==='win32') assert.ok(process.env.NODE_OPTIONS.includes('test-silent-processes.mjs'));
      const child=execFileSync(process.execPath,['--eval', 'if(!process.env.PROMPTCUT_DATA_DIR?.includes("pc-silent-contract-")) process.exit(1); else if(process.platform==="win32" && !process.env.NODE_OPTIONS.includes("test-silent-processes.mjs")) process.exit(2); else process.stdout.write("passed")'],{encoding:'utf8'});
      assert.equal(child,'passed'); process.stdout.write('passed');
    `,{...process.env,PROMPTCUT_DATA_DIR:dir});
    assert.equal(output,'passed');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('SILENT-4 原生 fork 后代保留 IPC 与静默设置',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pc-silent-fork-'));
  try {
    const file=path.join(dir,'child.mjs');
    fs.writeFileSync(file,'process.send({silent:process.platform!=="win32" || process.env.NODE_OPTIONS.includes("test-silent-processes.mjs")});process.disconnect();');
    const output=run(`
      import assert from 'node:assert/strict';
      import { fork } from 'node:child_process';
      const child=fork(process.env.PC_SILENT_CHILD_FILE,[],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
      const message=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});
      assert.equal(message.silent,true);
      const code=await new Promise(resolve=>child.once('exit',resolve));
      assert.equal(code,0);process.stdout.write('passed');
    `,{...process.env,PC_SILENT_CHILD_FILE:file});
    assert.equal(output,'passed');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
