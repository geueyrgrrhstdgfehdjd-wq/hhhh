const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-render';
const ADMIN_USER = process.env.ADMIN_USER || process.env.ADMIN_USERNAME || 'vvfd';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '12321';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

if (!DATABASE_URL) console.warn('DATABASE_URL is not set. The web UI can load, but database actions require Render PostgreSQL to be connected.');
const pool = new Pool({connectionString: DATABASE_URL, ssl: DATABASE_URL ? {rejectUnauthorized:false} : undefined});

app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');if(req.method==='OPTIONS')return res.sendStatus(204);next();});
app.use(express.static(path.join(__dirname,'public')));

const uploadDir = path.join(__dirname,'uploads');
fs.mkdirSync(uploadDir,{recursive:true});
const upload = multer({dest: uploadDir, limits:{fileSize:100*1024*1024}});

const prices = {1:5,3:15,7:25,15:40,30:80,60:200,90:300,0:800};
function now(){return new Date();}
function tokenFor(user, role, resellerId=null){return jwt.sign({user,role,resellerId},JWT_SECRET,{expiresIn:'7d'});}
function requireDatabase(req,res,next){
  if(!DATABASE_URL) return res.status(503).json({message:'ฐานข้อมูลยังไม่ได้เชื่อมต่อ: ตั้งค่า DATABASE_URL ใน Render หรือ Deploy ด้วย render.yaml'});
  next();
}
function auth(req,res,next){
  if(!DATABASE_URL) return res.status(503).json({message:'ฐานข้อมูลยังไม่ได้เชื่อมต่อ: ตั้งค่า DATABASE_URL ใน Render หรือ Deploy ด้วย render.yaml'});
  const h=req.headers.authorization||''; const t=h.startsWith('Bearer ')?h.slice(7):null;
  if(!t) return res.status(401).json({message:'ต้องเข้าสู่ระบบ'});
  try{req.auth=jwt.verify(t,JWT_SECRET);next();}catch(e){return res.status(401).json({message:'เซสชันหมดอายุ'});}
}
function adminOnly(req,res,next){if(req.auth?.role!=='admin')return res.status(403).json({message:'เฉพาะ Admin'});next();}
function makeKey(){return crypto.randomBytes(5).toString('hex').toUpperCase()+'-'+crypto.randomBytes(5).toString('hex').toUpperCase();}
async function expireRows(){await pool.query("UPDATE keys_tbl SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= NOW()");}
async function init(){
  if(!DATABASE_URL) return;
  await pool.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
}

app.get('/health',async(req,res)=>{
  if(!DATABASE_URL) return res.status(503).json({ok:false,service:'NEXTRA PRO',database:'not_configured',message:'DATABASE_URL is not configured'});
  try{await pool.query('SELECT 1');res.json({ok:true,service:'NEXTRA PRO',database:'connected'});}catch(e){res.status(503).json({ok:false,service:'NEXTRA PRO',database:'error',message:'Database connection failed'});}
});
app.post('/api/login',async(req,res)=>{
  try{
    const u=String(req.body.username||'').trim(), p=String(req.body.password||'');
    if(u===ADMIN_USER && p===ADMIN_PASSWORD) return res.json({token:tokenFor(u,'admin'),role:'admin',username:u});
    const r=await pool.query('SELECT * FROM resellers WHERE username=$1 LIMIT 1',[u]);
    const row=r.rows[0];
    if(!row || !row.active || (row.expires_at && new Date(row.expires_at)<=now()) || !(await bcrypt.compare(p,row.password_hash))) return res.status(401).json({message:'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'});
    res.json({token:tokenFor(u,'reseller',row.id),role:'reseller',username:u,credits:row.unlimited?null:row.credits,unlimited:row.unlimited,expires_at:row.expires_at});
  }catch(e){res.status(500).json({message:'Server error'});}
});

app.get('/api/me',auth,async(req,res)=>{
  if(req.auth.role==='admin') return res.json({role:'admin',username:req.auth.user});
  const r=await pool.query('SELECT username,credits,unlimited,expires_at,active FROM resellers WHERE id=$1',[req.auth.resellerId]);
  res.json({role:'reseller',...r.rows[0]});
});

app.get('/api/dashboard',auth,async(req,res)=>{
  await expireRows();
  if(req.auth.role==='reseller'){
    const r=await pool.query('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status=\'active\')::int AS active, COUNT(*) FILTER (WHERE status=\'expired\')::int AS expired FROM keys_tbl WHERE created_by=$1',['reseller:'+req.auth.user]);
    return res.json(r.rows[0]);
  }
  const r=await pool.query(`SELECT
    (SELECT COUNT(*) FROM keys_tbl)::int total,
    (SELECT COUNT(*) FROM keys_tbl WHERE status='active')::int active,
    (SELECT COUNT(*) FROM keys_tbl WHERE status='expired')::int expired,
    (SELECT COUNT(*) FROM resellers)::int reseller_total,
    (SELECT COUNT(*) FROM resellers WHERE active=false)::int reseller_disabled`);
  res.json(r.rows[0]);
});

app.post('/api/keys/generate',auth,async(req,res)=>{
  const name=String(req.body.name||'Unnamed').trim().slice(0,100); const count=Math.max(1,Math.min(100,parseInt(req.body.count||1,10))); const days=parseInt(req.body.days,10);
  if(!name || !Object.prototype.hasOwnProperty.call(prices,days)) return res.status(400).json({message:'ข้อมูลไม่ถูกต้อง'});
  const cost=prices[days]*count; const client=await pool.connect();
  try{
    await client.query('BEGIN');
    if(req.auth.role==='reseller'){
      const rr=(await client.query('SELECT * FROM resellers WHERE id=$1 FOR UPDATE',[req.auth.resellerId])).rows[0];
      if(!rr || !rr.active || (rr.expires_at && new Date(rr.expires_at)<=now()) || (!rr.unlimited && rr.credits<cost)) throw new Error('เครดิตไม่พอหรือแผงหมดอายุ/ถูกปิดใช้งาน');
      if(!rr.unlimited) await client.query('UPDATE resellers SET credits=credits-$1 WHERE id=$2',[cost,rr.id]);
    }
    const out=[];
    for(let i=0;i<count;i++){
      let k=makeKey();
      while((await client.query('SELECT 1 FROM keys_tbl WHERE key_value=$1',[k])).rowCount) k=makeKey();
      const r=await client.query(`INSERT INTO keys_tbl(name,key_value,duration_days,credits,status,created_by) VALUES($1,$2,$3,$4,'unused',$5) RETURNING *`,[name,k,days,prices[days],req.auth.role==='admin'?'admin':'reseller:'+req.auth.user]);
      out.push(r.rows[0]);
    }
    await client.query('COMMIT'); res.json({keys:out});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({message:e.message||'สร้างคีย์ไม่สำเร็จ'});}finally{client.release();}
});

app.get('/api/keys',auth,async(req,res)=>{await expireRows(); let q,params=[]; if(req.auth.role==='admin')q='SELECT * FROM keys_tbl ORDER BY id DESC';else{q='SELECT * FROM keys_tbl WHERE created_by=$1 ORDER BY id DESC';params=['reseller:'+req.auth.user];} const r=await pool.query(q,params);res.json(r.rows);});
app.delete('/api/keys/:id',auth,adminOnly,async(req,res)=>{await pool.query('DELETE FROM keys_tbl WHERE id=$1',[req.params.id]);res.json({ok:true});});

app.post('/api/keys/:id/toggle',auth,adminOnly,async(req,res)=>{
  const row=(await pool.query('SELECT status FROM keys_tbl WHERE id=$1',[req.params.id])).rows[0];
  if(!row) return res.status(404).json({message:'ไม่พบคีย์'});
  const next=row.status==='disabled'?'unused':'disabled';
  const r=await pool.query('UPDATE keys_tbl SET status=$1 WHERE id=$2 RETURNING *',[next,req.params.id]);
  res.json(r.rows[0]);
});

app.post('/api/resellers',auth,adminOnly,async(req,res)=>{
  const username=String(req.body.username||'').trim(); const password=String(req.body.password||''); const credits=Math.max(0,parseInt(req.body.credits||0,10)); const days=parseInt(req.body.days||0,10); const unlimited=!!req.body.unlimited;
  if(!username||!password||![0,30].includes(days))return res.status(400).json({message:'ข้อมูลไม่ถูกต้อง'});
  try{const hash=await bcrypt.hash(password,12); const ex=days?new Date(Date.now()+days*86400000):null; const r=await pool.query('INSERT INTO resellers(username,password_hash,credits,unlimited,expires_at,active) VALUES($1,$2,$3,$4,$5,true) RETURNING id,username,credits,unlimited,expires_at,active',[username,hash,credits,unlimited,ex]);res.json(r.rows[0]);}catch(e){res.status(400).json({message:'Username นี้มีอยู่แล้ว'});}
});
app.get('/api/resellers',auth,adminOnly,async(req,res)=>res.json((await pool.query('SELECT id,username,credits,unlimited,expires_at,active,created_at FROM resellers ORDER BY id DESC')).rows));
app.post('/api/resellers/:id/toggle',auth,adminOnly,async(req,res)=>{const r=await pool.query('UPDATE resellers SET active=NOT active WHERE id=$1 RETURNING id,username,active',[req.params.id]);res.json(r.rows[0]);});

app.post('/api/patch-files',auth,adminOnly,upload.single('file'),async(req,res)=>{
  if(!req.file)return res.status(400).json({message:'กรุณาเลือกไฟล์'});
  const name=String(req.body.name||req.file.originalname).slice(0,120); const target=req.body.target_path?String(req.body.target_path).slice(0,500):null;
  const r=await pool.query('INSERT INTO patch_files(name,original_name,storage_path,target_path,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[name,req.file.originalname,req.file.path,target,req.auth.user]);
  res.json(r.rows[0]);
});
app.get('/api/patch-files',auth,adminOnly,async(req,res)=>res.json((await pool.query('SELECT * FROM patch_files ORDER BY id DESC')).rows));
app.delete('/api/patch-files/:id',auth,adminOnly,async(req,res)=>{const r=await pool.query('DELETE FROM patch_files WHERE id=$1 RETURNING storage_path',[req.params.id]);if(r.rows[0]){try{fs.unlinkSync(r.rows[0].storage_path)}catch(e){}}res.json({ok:true});});

app.post('/api/validate-key',async(req,res)=>{
  try{
    const key=String(req.body.key||'').trim().toUpperCase();
    if(!key)return res.status(400).json({valid:false,message:'กรุณาใส่คีย์'});
    await expireRows();
    const r=await pool.query('SELECT * FROM keys_tbl WHERE key_value=$1 LIMIT 1',[key]);
    const row=r.rows[0];
    if(!row)return res.status(404).json({valid:false,message:'ไม่พบคีย์นี้ในระบบ'});
    if(row.status==='expired')return res.status(403).json({valid:false,message:'คีย์หมดอายุแล้ว'});
    if(row.status==='disabled')return res.status(403).json({valid:false,message:'คีย์ถูกปิดใช้งาน'});
    if(row.status==='unused'){
      const activated=now(); const expires=row.duration_days>0?new Date(Date.now()+row.duration_days*86400000):null;
      const u=await pool.query("UPDATE keys_tbl SET status='active',activated_at=$1,expires_at=$2 WHERE id=$3 AND status='unused' RETURNING *",[activated,expires,row.id]);
      if(u.rowCount) return res.json({valid:true,message:'คีย์ใช้งานได้',expires_at:u.rows[0].expires_at||null});
    }
    const fresh=(await pool.query('SELECT * FROM keys_tbl WHERE id=$1',[row.id])).rows[0];
    if(fresh.expires_at && new Date(fresh.expires_at)<=now())return res.status(403).json({valid:false,message:'คีย์หมดอายุแล้ว'});
    return res.json({valid:true,message:'คีย์ใช้งานได้',expires_at:fresh.expires_at||null});
  }catch(e){return res.status(500).json({valid:false,message:'Server error'});}
});

app.get('/login',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

init().then(()=>app.listen(PORT,()=>console.log(`NEXTRA PRO running on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
