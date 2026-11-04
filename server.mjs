import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=dirname(fileURLToPath(import.meta.url));
export const CASES={
 team:{name:'Курсор',subtitle:'Работа команды в одном ритме',scope:'Проект',unit:'проектов',theme:'violet',mark:'К',projects:['Запуск сайта','Сервис и поддержка'],titles:['Согласовать структуру главной','Подготовить мобильный макет','Подключить форму заявки','Проверить сценарий регистрации','Обновить справочный раздел','Собрать обратную связь'],labels:['Дизайн','Разработка','Поддержка']},
 sites:{name:'Контур',subtitle:'Все объекты. Полная картина.',scope:'Объект',unit:'объекта',theme:'teal',mark:'⌂',projects:['Северный квартал','Речной парк'],titles:['Принять отделку входной группы','Проверить освещение двора','Согласовать поставку материалов','Завершить окраску лестницы','Проверить водоотвод','Подготовить акт осмотра'],labels:['Отделка','Инженерия','Приёмка']},
 event:{name:'Событие',subtitle:'От первой идеи до открытых дверей',scope:'Мероприятие',unit:'мероприятия',theme:'amber',mark:'✳',projects:['Форум новых идей','Встреча сообщества'],titles:['Подтвердить площадку','Проверить звук на сцене','Согласовать программу','Подготовить стойку регистрации','Собрать презентации спикеров','Заказать навигацию'],labels:['Площадка','Программа','Участники']}
};
const STATUSES=['new','active','review','done'];
const hash=(pass,salt)=>scryptSync(pass,salt,32);
const token=()=>randomBytes(24).toString('hex');
const day=(delta=0)=>new Date(Date.now()+delta*86400000).toISOString().slice(0,10);
function fail(status,message){throw Object.assign(new Error(message),{status});}
function text(value,max=300,required=false){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))fail(400,'Проверьте заполнение полей');return value.trim();}
function integer(value){if(!Number.isSafeInteger(Number(value))||Number(value)<1)fail(400,'Некорректный идентификатор');return Number(value);}
function date(value){const parsed=new Date(value+'T00:00:00Z');if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)fail(400,'Некорректная дата');return value;}

export function createApp({dataDir=process.env.DATA_DIR||join(ROOT,'data'),demo=process.env.DEMO_MODE==='1',password=process.env.ADMIN_PASSWORD}={}){
 if(!demo&&(!password||password.length<12))throw Error('Задайте ADMIN_PASSWORD (не менее 12 знаков) либо DEMO_MODE=1 для тестовых данных');
 mkdirSync(dataDir,{recursive:true});
 const db=new DatabaseSync(join(dataDir,'trackers.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,case_id TEXT,name TEXT,login TEXT,role TEXT,salt TEXT,hash BLOB,UNIQUE(case_id,login));
 CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY,case_id TEXT,title TEXT,owner_id INTEGER REFERENCES users(id),archived INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY,case_id TEXT,project_id INTEGER REFERENCES projects(id),title TEXT,description TEXT DEFAULT '',status TEXT DEFAULT 'new',priority TEXT DEFAULT 'normal',assignee INTEGER REFERENCES users(id),due TEXT,category TEXT,rating INTEGER DEFAULT 0,version INTEGER DEFAULT 1);
 CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY,task_id INTEGER REFERENCES tasks(id),user_id INTEGER REFERENCES users(id),body TEXT,created TEXT);
 CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY,case_id TEXT,task_id INTEGER,user_id INTEGER,body TEXT,created TEXT);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER);`);
 for(const [key,config] of Object.entries(CASES)){
  if(db.prepare('SELECT id FROM users WHERE case_id=? LIMIT 1').get(key))continue;
  const users=[];
  for(const [i,role] of ['admin','manager','employee'].entries()){
   const salt=token();
   users.push(Number(db.prepare('INSERT INTO users(case_id,name,login,role,salt,hash) VALUES(?,?,?,?,?,?)').run(key,['Алексей Миронов','Мария Орлова','Илья Соколов'][i],role,role,salt,hash(password||'Demo-Tracker-2026',salt)).lastInsertRowid));
  }
  const projects=config.projects.map(title=>Number(db.prepare('INSERT INTO projects(case_id,title,owner_id) VALUES(?,?,?)').run(key,title,users[1]).lastInsertRowid));
  for(let i=0;i<9;i++)db.prepare('INSERT INTO tasks(case_id,project_id,title,description,status,priority,assignee,due,category,rating) VALUES(?,?,?,?,?,?,?,?,?,?)').run(key,projects[i%2],config.titles[i%6],['Подготовить результат и передать на проверку.','Согласовать детали с командой и отметить выполнение.'][i%2],STATUSES[i%4],i%3===0?'high':'normal',users[i%2?1:2],day(i-2),config.labels[i%3],key==='team'&&i%4===3?4:0);
 }
 const loginAttempts=new Map();
 function safeUser(u){return {id:u.id,name:u.name,login:u.login,role:u.role};}
 function allowedTask(u,id){
  const task=db.prepare('SELECT * FROM tasks WHERE case_id=? AND id=?').get(u.case_id,id);
  if(!task)fail(404,'Задача не найдена');
  if(u.role==='employee'&&task.assignee!==u.id)fail(403,'Нет доступа к этой задаче');
  return task;
 }
 function manage(u){if(u.role==='employee')fail(403,'Нужны права руководителя');}
 function ensureProject(u,id){const p=db.prepare('SELECT * FROM projects WHERE id=? AND case_id=? AND archived=0').get(id,u.case_id);if(!p)fail(400,'Проект недоступен');return p;}
 function log(u,task,body){db.prepare('INSERT INTO activity(case_id,task_id,user_id,body,created) VALUES(?,?,?,?,?)').run(u.case_id,task,u.id,body,new Date().toISOString());}
 function taskFields(u,body){
  const title=text(body.title,160,true),description=text(body.description??'',3000),project_id=integer(body.project_id),assignee=integer(body.assignee),due=date(body.due),category=text(body.category||'Общее',60,true);
  ensureProject(u,project_id);
  if(!db.prepare('SELECT id FROM users WHERE id=? AND case_id=?').get(assignee,u.case_id))fail(400,'Исполнитель не найден');
  const status=body.status||'new',priority=body.priority||'normal',rating=Number(body.rating||0);
  if(!STATUSES.includes(status)||!['normal','high','low'].includes(priority)||!Number.isInteger(rating)||rating<0||rating>5)fail(400,'Некорректный статус, приоритет или оценка');
  return {title,description,project_id,assignee,due,category,status,priority,rating};
 }
 function state(u){
  const tasks=u.role==='employee'?db.prepare('SELECT * FROM tasks WHERE case_id=? AND assignee=?').all(u.case_id,u.id):db.prepare('SELECT * FROM tasks WHERE case_id=?').all(u.case_id);
  const ids=new Set(tasks.map(t=>t.id));
  return {config:CASES[u.case_id],demo,user:safeUser(u),users:db.prepare('SELECT id,name,role FROM users WHERE case_id=?').all(u.case_id),projects:db.prepare('SELECT * FROM projects WHERE case_id=?').all(u.case_id),tasks,activity:db.prepare('SELECT a.*,u.name FROM activity a JOIN users u ON u.id=a.user_id WHERE a.case_id=? ORDER BY a.id DESC LIMIT 100').all(u.case_id).filter(a=>ids.has(a.task_id))};
 }
 const server=http.createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/health'){send(200,{ok:true});return;}
   const api=url.pathname.match(/^\/api\/(team|sites|event)\/(.*)$/);
   if(!api){
    const paths={'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],'/':['index.html','text/html'],'/team':['index.html','text/html'],'/sites':['index.html','text/html'],'/event':['index.html','text/html']};
    const item=paths[url.pathname];if(!item||req.method!=='GET')fail(404,'Страница не найдена');
    res.writeHead(200,{'Content-Type':item[1]+'; charset=utf-8'});res.end(readFileSync(join(ROOT,'public',item[0])));return;
   }
   const [,key,path]=api;
   let body={};
   if(['POST','PUT','DELETE'].includes(req.method)){
    const origin=req.headers.origin;
    if(origin&&new URL(origin).host!==req.headers.host)fail(403,'Запрос из другого источника отклонён');
    if(!req.headers['content-type']?.startsWith('application/json'))fail(415,'Ожидается JSON');
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>32768)fail(413,'Слишком большой запрос');}
    try{body=JSON.parse(raw||'{}');}catch{fail(400,'Некорректный JSON');}
    if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Некорректные данные');
   }
   if(path==='login'&&req.method==='POST'){
    const address=req.socket.remoteAddress,now=Date.now(),attempts=(loginAttempts.get(address)||[]).filter(x=>x>now-60000);
    if(attempts.length>=12)fail(429,'Слишком много попыток, попробуйте через минуту');
    attempts.push(now);loginAttempts.set(address,attempts);
    const login=text(body.login,80,true),pass=text(body.password||'',200);
    const u=db.prepare('SELECT * FROM users WHERE case_id=? AND login=?').get(key,login);
    if(!u||!timingSafeEqual(hash(pass,u.salt),Buffer.from(u.hash)))fail(401,'Неверный логин или пароль');
    const session=token();db.prepare('DELETE FROM sessions WHERE expires<?').run(now);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(session,u.id,now+8*3600000);
    const secure=req.socket.encrypted||req.headers['x-forwarded-proto']==='https';
    res.setHeader('Set-Cookie',`session_${key}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure?'; Secure':''}`);
    send(200,state(u));return;
   }
   const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('session_'+key+'='))?.split('=')[1]||'';
   const u=db.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>? AND u.case_id=?').get(cookie,Date.now(),key);
   if(!u)fail(401,'Войдите в систему');
   if(path==='state'&&req.method==='GET'){send(200,state(u));return;}
   if(path==='logout'&&req.method==='POST'){db.prepare('DELETE FROM sessions WHERE token=?').run(cookie);res.setHeader('Set-Cookie',`session_${key}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);send(200,{ok:true});return;}
   if(path==='profile'&&req.method==='PUT'){
    const name=text(body.name,100,true),pass=body.password?text(body.password,200,true):null;
    if(pass&&pass.length<12)fail(400,'Пароль должен содержать не менее 12 знаков');
    db.prepare('UPDATE users SET name=? WHERE id=?').run(name,u.id);
    if(pass){const salt=token();db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt,hash(pass,salt),u.id);db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id,cookie);}
    send(200,{ok:true});return;
   }
   if(path==='projects'&&req.method==='POST'){
    manage(u);const title=text(body.title,120,true);db.prepare('INSERT INTO projects(case_id,title,owner_id) VALUES(?,?,?)').run(key,title,u.id);send(201,{ok:true});return;
   }
   if(path==='users'&&req.method==='POST'){
    if(u.role!=='admin')fail(403,'Нужны права администратора');
    const name=text(body.name,100,true),login=text(body.login,50,true),pass=text(body.password,200,true),role=body.role;
    if(!/^[a-z0-9_.-]{3,50}$/i.test(login)||pass.length<12||!['manager','employee'].includes(role))fail(400,'Проверьте логин, пароль (12+) и роль');
    const salt=token();try{db.prepare('INSERT INTO users(case_id,name,login,role,salt,hash) VALUES(?,?,?,?,?,?)').run(key,name,login,role,salt,hash(pass,salt));}catch{fail(409,'Такой логин уже существует');}send(201,{ok:true});return;
   }
   if(path==='tasks'&&req.method==='POST'){
    manage(u);const f=taskFields(u,body);
    const id=Number(db.prepare('INSERT INTO tasks(case_id,project_id,title,description,status,priority,assignee,due,category,rating) VALUES(?,?,?,?,?,?,?,?,?,?)').run(key,f.project_id,f.title,f.description,f.status,f.priority,f.assignee,f.due,f.category,f.rating).lastInsertRowid);
    log(u,id,'Создана задача «'+f.title+'»');send(201,{id});return;
   }
   const match=path.match(/^tasks\/(\d+)(\/comments)?$/);
   if(match){
    const id=integer(match[1]),task=allowedTask(u,id);
    if(match[2]){
     if(req.method==='GET'){send(200,db.prepare('SELECT c.*,u.name FROM comments c JOIN users u ON u.id=c.user_id WHERE task_id=? ORDER BY c.id').all(id));return;}
     if(req.method==='POST'){const comment=text(body.body,2000,true);db.prepare('INSERT INTO comments(task_id,user_id,body,created) VALUES(?,?,?,?)').run(id,u.id,comment,new Date().toISOString());log(u,id,'Добавлен комментарий');send(201,{ok:true});return;}
    }else if(req.method==='PUT'){
     if(Number(body.version)!==task.version)fail(409,'Задача уже изменена. Обновите данные и повторите правку.');
     let f;
     if(u.role==='employee'){
      if(Object.keys(body).some(k=>!['status','version'].includes(k)))fail(403,'Сотрудник может менять только статус своей задачи');
      if(!STATUSES.includes(body.status))fail(400,'Некорректный статус');f={...task,status:body.status};
     }else f=taskFields(u,{...task,...body});
     const changed=db.prepare('UPDATE tasks SET project_id=?,title=?,description=?,status=?,priority=?,assignee=?,due=?,category=?,rating=?,version=version+1 WHERE id=? AND version=?').run(f.project_id,f.title,f.description,f.status,f.priority,f.assignee,f.due,f.category,f.rating,id,task.version).changes;
     if(!changed)fail(409,'Конфликт обновления');log(u,id,'Обновлена задача «'+f.title+'»');send(200,{ok:true});return;
    }else if(req.method==='DELETE'){
     manage(u);db.prepare('DELETE FROM comments WHERE task_id=?').run(id);db.prepare('DELETE FROM tasks WHERE id=?').run(id);send(200,{ok:true});return;
    }
   }
   if(path==='export'&&req.method==='GET'){
    const escape=x=>'"'+String(x??'').replace(/^[=+@\-]/,"'$&").replaceAll('"','""')+'"';
    const lines=[['Название','Статус','Исполнитель','Срок','Категория'],...state(u).tasks.map(t=>[t.title,t.status,state(u).users.find(x=>x.id===t.assignee)?.name,t.due,t.category])];
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="tasks.csv"'});res.end('\ufeff'+lines.map(r=>r.map(escape).join(';')).join('\r\n'));return;
   }
   fail(404,'Метод не найден');
  }catch(error){send(error.status||500,{error:error.status?error.message:'Ошибка сервера'});if(!error.status)console.error(error);}
 });
 return {server,db,close:()=>new Promise(resolveClose=>server.close(()=>{db.close();resolveClose();}))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const demo=process.env.DEMO_MODE==='1',app=createApp({demo});
 app.server.listen(Number(process.env.PORT||8797),process.env.HOST||'127.0.0.1',()=>console.log(`Trackers: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||8797}/team | /sites | /event${demo?' | demo: admin / manager / employee, password Demo-Tracker-2026':''}`));
}
