import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
test('Некорректная дата — 400, неверный новый пароль не сохраняет имя',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tracker-regression-')),app=createApp({dataDir:dir,demo:true});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${app.server.address().port}/api/team/`;
 try{
  const login=await fetch(base+'login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:'admin',password:'Demo-Tracker-2026'})});
  const state=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  const headers={'Content-Type':'application/json',Cookie:cookie};
  const badDate=await fetch(base+'tasks',{method:'POST',headers,body:JSON.stringify({...state.tasks[0],due:'2026-99-99'})});
  assert.equal(badDate.status,400);
  const profile=await fetch(base+'profile',{method:'PUT',headers,body:JSON.stringify({name:'Имя не должно сохраниться',password:'short'})});
  assert.equal(profile.status,400);
  const after=await (await fetch(base+'state',{headers})).json();assert.equal(after.user.name,state.user.name);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
