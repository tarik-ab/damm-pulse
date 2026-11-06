require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET debe tener al menos 32 caracteres.");
}
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
  throw new Error("ADMIN_PASSWORD debe tener al menos 12 caracteres. Define una contraseña larga y única en el hosting.");
}

const dbFile = path.resolve(process.env.DB_FILE || "./data/dammpulse.sqlite");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    department TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
  CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role,status);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    event_type TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_user_date ON audit_log(user_id,created_at);

  CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL, area TEXT, status TEXT NOT NULL DEFAULT 'operativo'
      CHECK(status IN ('operativo','mantenimiento','fuera_de_servicio')),
    description TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_equipment_name ON equipment(name);
  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL,
    equipment_id INTEGER, priority TEXT NOT NULL DEFAULT 'media'
      CHECK(priority IN ('baja','media','alta','critica')),
    status TEXT NOT NULL DEFAULT 'abierta' CHECK(status IN ('abierta','en_curso','resuelta')),
    created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(equipment_id) REFERENCES equipment(id) ON DELETE SET NULL,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status,priority,created_at);
  CREATE TABLE IF NOT EXISTS academy_courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    duration_minutes INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL DEFAULT '',
    published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
    created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS academy_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, course_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed')),
    completed_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id,course_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(course_id) REFERENCES academy_courses(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS knowledge_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General',
    body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
    created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_articles(status,category);
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General', format TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

`);

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(x => x.trim()).filter(Boolean);
app.disable("x-powered-by");
// Railway proxies requests through one trusted edge proxy.
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origen no autorizado por CORS."));
  },
  methods: ["GET","POST","PATCH"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.use(express.json({ limit: "20kb" }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));

function audit(req, userId, event) {
  try {
    db.prepare("INSERT INTO audit_log (user_id,event_type,ip_address,user_agent) VALUES (?,?,?,?)")
      .run(userId || null,event,req.ip,String(req.get("user-agent") || "").slice(0,255));
  } catch (err) { console.error("Audit log:",err.message); }
}
function issueToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, process.env.JWT_SECRET, {
    expiresIn: "8h", issuer: "dammpulse-api", audience: "dammpulse-app"
  });
}
function auth(req,res,next) {
  try {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Inicia sesión para continuar." });
    const claims = jwt.verify(token,process.env.JWT_SECRET,{issuer:"dammpulse-api",audience:"dammpulse-app"});
    const user = db.prepare("SELECT id,name,username,email,department,role,status FROM users WHERE id=?").get(claims.sub);
    if (!user || user.status !== "active") return res.status(401).json({ error: "Sesión no válida." });
    req.user = user;
    next();
  } catch { return res.status(401).json({ error: "Sesión caducada o no válida." }); }
}
function adminOnly(req,res,next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Acceso exclusivo de administración." });
  next();
}

app.get("/api/health",(_req,res) => {
  try { db.prepare("SELECT 1").get(); res.json({status:"ok",database:"connected",engine:"SQLite"}); }
  catch { res.status(503).json({status:"unavailable",database:"disconnected"}); }
});

app.post("/api/auth/register",async (req,res) => {
  try {
    const name = String(req.body.name || "").trim();
    const username = String(req.body.username || "").trim().toLowerCase();
    const email = String(req.body.email || "").trim().toLowerCase();
    const department = String(req.body.department || "").trim().slice(0,100) || null;
    const password = String(req.body.password || "");
    if (name.length < 2 || name.length > 80) return res.status(400).json({error:"Introduce un nombre válido."});
    if (!/^[a-z0-9._-]{3,32}$/.test(username) || username === String(process.env.ADMIN_USERNAME || "Tarik").toLowerCase()) return res.status(400).json({error:"Nombre de usuario no válido o reservado."});
    if (!/^[^\s@]+@[^\s@]+\\.[^\s@]+$/.test(email)) return res.status(400).json({error:"Introduce un correo electrónico válido."});
    if (password.length < 12) return res.status(400).json({error:"La contraseña debe tener al menos 12 caracteres."});
    const hash = await bcrypt.hash(password,12);
    const result = db.prepare("INSERT INTO users (name,username,email,department,password_hash,role) VALUES (?,?,?,?,?,'user')")
      .run(name,username,email,department,hash);
    const user = {id:Number(result.lastInsertRowid),name,username,email,department,role:"user"};
    audit(req,user.id,"user.register");
    res.status(201).json({token:issueToken(user),user});
  } catch (err) {
    if (String(err.code || "").includes("CONSTRAINT")) return res.status(409).json({error:"El usuario o correo ya está registrado."});
    console.error(err); res.status(500).json({error:"No se pudo crear la cuenta."});
  }
});

app.post("/api/auth/login",async (req,res) => {
  try {
    const identifier = String(req.body.identifier || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const user = db.prepare("SELECT id,name,username,email,department,password_hash,role,status FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE LIMIT 1").get(identifier,identifier);
    if (!user || user.status !== "active" || !(await bcrypt.compare(password,user.password_hash))) return res.status(401).json({error:"Usuario o contraseña incorrectos."});
    db.prepare("UPDATE users SET last_login_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(user.id);
    audit(req,user.id,"user.login");
    delete user.password_hash; delete user.status;
    res.json({token:issueToken(user),user});
  } catch (err) { console.error(err); res.status(500).json({error:"No se pudo iniciar sesión."}); }
});

app.get("/api/auth/me",auth,(req,res) => res.json({user:req.user}));

app.get("/api/admin/users",auth,adminOnly,(req,res) => {
  try {
    const page = Math.max(1,Number.parseInt(req.query.page,10) || 1);
    const limit = Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10) || 25));
    const search = String(req.query.search || "").trim().slice(0,100);
    const where = search ? "WHERE name LIKE ? OR username LIKE ? OR email LIKE ? OR department LIKE ?" : "";
    const params = search ? Array(4).fill("%"+search+"%") : [];
    const total = db.prepare("SELECT COUNT(*) AS total FROM users "+where).get(...params).total;
    const users = db.prepare("SELECT id,name,username,email,department,role,status,created_at AS createdAt,last_login_at AS lastLoginAt FROM users "+where+" ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(...params,limit,(page-1)*limit);
    res.json({users,page,limit,total:Number(total)});
  } catch (err) { console.error(err); res.status(500).json({error:"No se pudo consultar el directorio."}); }
});

app.patch("/api/admin/users/:id/status",auth,adminOnly,(req,res) => {
  const status = req.body.status;
  if (!["active","disabled"].includes(status)) return res.status(400).json({error:"Estado no válido."});
  try {
    const result = db.prepare("UPDATE users SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND role='user'").run(status,req.params.id);
    if (!result.changes) return res.status(404).json({error:"Usuario no encontrado."});
    audit(req,req.user.id,"user.status."+status);
    res.json({ok:true});
  } catch (err) { console.error(err); res.status(500).json({error:"No se pudo actualizar el usuario."}); }
});


function textValue(value, max = 5000) { return String(value ?? "").trim().slice(0,max); }
function numericId(value) { const n=Number(value); return Number.isSafeInteger(n)&&n>0?n:null; }

// Equipment: shared plant inventory; no fictional assets are seeded.
app.get("/api/equipment",auth,(req,res)=>{
  const q=textValue(req.query.search,100), like="%"+q+"%";
  const items=q
    ? db.prepare("SELECT id,code,name,area,status,description,created_at AS createdAt,updated_at AS updatedAt FROM equipment WHERE code LIKE ? OR name LIKE ? OR area LIKE ? ORDER BY name LIMIT 200").all(like,like,like)
    : db.prepare("SELECT id,code,name,area,status,description,created_at AS createdAt,updated_at AS updatedAt FROM equipment ORDER BY name LIMIT 200").all();
  res.json({items});
});
app.get("/api/equipment/code/:code",auth,(req,res)=>{
  const item=db.prepare("SELECT id,code,name,area,status,description,created_at AS createdAt,updated_at AS updatedAt FROM equipment WHERE code=? COLLATE NOCASE").get(textValue(req.params.code,80));
  if(!item) return res.status(404).json({error:"No existe ningún equipo con ese código."});
  res.json({item});
});
app.post("/api/equipment",auth,adminOnly,(req,res)=>{
  const code=textValue(req.body.code,80), name=textValue(req.body.name,160), area=textValue(req.body.area,120);
  const status=textValue(req.body.status,32)||"operativo", description=textValue(req.body.description,2000);
  if(!code||!name) return res.status(400).json({error:"El código y el nombre son obligatorios."});
  if(!["operativo","mantenimiento","fuera_de_servicio"].includes(status)) return res.status(400).json({error:"Estado de equipo no válido."});
  try {
    const result=db.prepare("INSERT INTO equipment(code,name,area,status,description,created_by) VALUES(?,?,?,?,?,?)").run(code,name,area,status,description,req.user.id);
    audit(req,req.user.id,"equipment.create");
    res.status(201).json({item:db.prepare("SELECT id,code,name,area,status,description,created_at AS createdAt,updated_at AS updatedAt FROM equipment WHERE id=?").get(result.lastInsertRowid)});
  } catch(err) { if(String(err.code||"").includes("CONSTRAINT")) return res.status(409).json({error:"Ya existe un equipo con ese código."}); console.error(err); res.status(500).json({error:"No se pudo guardar el equipo."}); }
});
app.patch("/api/equipment/:id",auth,adminOnly,(req,res)=>{
  const id=numericId(req.params.id); if(!id) return res.status(400).json({error:"Identificador no válido."});
  const old=db.prepare("SELECT * FROM equipment WHERE id=?").get(id); if(!old) return res.status(404).json({error:"Equipo no encontrado."});
  const code=req.body.code===undefined?old.code:textValue(req.body.code,80);
  const name=req.body.name===undefined?old.name:textValue(req.body.name,160);
  const area=req.body.area===undefined?old.area:textValue(req.body.area,120);
  const description=req.body.description===undefined?old.description:textValue(req.body.description,2000);
  const status=req.body.status===undefined?old.status:textValue(req.body.status,32);
  if(!code||!name||!["operativo","mantenimiento","fuera_de_servicio"].includes(status)) return res.status(400).json({error:"Datos de equipo no válidos."});
  try {
    db.prepare("UPDATE equipment SET code=?,name=?,area=?,status=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(code,name,area,status,description,id);
    audit(req,req.user.id,"equipment.update");
    res.json({ok:true});
  } catch(err) { if(String(err.code||"").includes("CONSTRAINT")) return res.status(409).json({error:"Ya existe otro equipo con ese código."}); console.error(err); res.status(500).json({error:"No se pudo actualizar el equipo."}); }
});

// Incidents: logged-in users create; creator or administrator updates.
app.get("/api/incidents",auth,(req,res)=>{
  const status=textValue(req.query.status,24);
  const where=status?"WHERE i.status=?":"";
  const query="SELECT i.id,i.title,i.description,i.equipment_id AS equipmentId,e.code AS equipmentCode,e.name AS equipmentName,i.priority,i.status,i.created_by AS createdBy,u.name AS createdByName,i.created_at AS createdAt,i.updated_at AS updatedAt FROM incidents i LEFT JOIN equipment e ON e.id=i.equipment_id LEFT JOIN users u ON u.id=i.created_by "+where+" ORDER BY CASE i.priority WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,i.created_at DESC LIMIT 300";
  res.json({items:status?db.prepare(query).all(status):db.prepare(query).all()});
});
app.post("/api/incidents",auth,(req,res)=>{
  const title=textValue(req.body.title,160), description=textValue(req.body.description,4000);
  const priority=textValue(req.body.priority,16)||"media", equipmentId=req.body.equipmentId?numericId(req.body.equipmentId):null;
  if(title.length<4||description.length<5) return res.status(400).json({error:"Añade un título y una descripción suficientes."});
  if(!["baja","media","alta","critica"].includes(priority)) return res.status(400).json({error:"Prioridad no válida."});
  if(req.body.equipmentId&&!equipmentId) return res.status(400).json({error:"Equipo no válido."});
  if(equipmentId&&!db.prepare("SELECT id FROM equipment WHERE id=?").get(equipmentId)) return res.status(404).json({error:"El equipo indicado no existe."});
  const result=db.prepare("INSERT INTO incidents(title,description,equipment_id,priority,created_by) VALUES(?,?,?,?,?)").run(title,description,equipmentId,priority,req.user.id);
  audit(req,req.user.id,"incident.create");
  res.status(201).json({id:Number(result.lastInsertRowid),ok:true});
});
app.patch("/api/incidents/:id",auth,(req,res)=>{
  const id=numericId(req.params.id); if(!id) return res.status(400).json({error:"Identificador no válido."});
  const old=db.prepare("SELECT * FROM incidents WHERE id=?").get(id); if(!old) return res.status(404).json({error:"Incidencia no encontrada."});
  if(req.user.role!=="admin"&&Number(old.created_by)!==Number(req.user.id)) return res.status(403).json({error:"No tienes permiso para modificar esta incidencia."});
  const status=req.body.status===undefined?old.status:textValue(req.body.status,20);
  const priority=req.body.priority===undefined?old.priority:textValue(req.body.priority,16);
  if(!["abierta","en_curso","resuelta"].includes(status)||!["baja","media","alta","critica"].includes(priority)) return res.status(400).json({error:"Estado o prioridad no válidos."});
  db.prepare("UPDATE incidents SET status=?,priority=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status,priority,id);
  audit(req,req.user.id,"incident.update");
  res.json({ok:true});
});

// Academy: published lessons and per-user completion tracking.
app.get("/api/academy/courses",auth,(req,res)=>{
  const drafts=req.user.role==="admin"&&String(req.query.includeDrafts||"")==="true";
  const items=drafts
    ? db.prepare("SELECT id,title,description,duration_minutes AS durationMinutes,content,published FROM academy_courses ORDER BY title").all()
    : db.prepare("SELECT id,title,description,duration_minutes AS durationMinutes,content,published FROM academy_courses WHERE published=1 ORDER BY title").all();
  const progress=db.prepare("SELECT course_id AS courseId,status,completed_at AS completedAt FROM academy_progress WHERE user_id=?").all(req.user.id);
  res.json({items,progress});
});
app.post("/api/academy/courses",auth,adminOnly,(req,res)=>{
  const title=textValue(req.body.title,160), description=textValue(req.body.description,1000), content=textValue(req.body.content,12000);
  const duration=Math.min(1440,Math.max(0,Number(req.body.durationMinutes)||0)), published=req.body.published===true?1:0;
  if(title.length<3||content.length<10) return res.status(400).json({error:"El curso necesita título y contenido."});
  const result=db.prepare("INSERT INTO academy_courses(title,description,duration_minutes,content,published,created_by) VALUES(?,?,?,?,?,?)").run(title,description,duration,content,published,req.user.id);
  audit(req,req.user.id,"academy.course.create");
  res.status(201).json({id:Number(result.lastInsertRowid),ok:true});
});
app.post("/api/academy/progress",auth,(req,res)=>{
  const courseId=numericId(req.body.courseId), status=textValue(req.body.status,20)||"in_progress";
  if(!courseId||!["in_progress","completed"].includes(status)) return res.status(400).json({error:"Progreso no válido."});
  if(!db.prepare("SELECT id FROM academy_courses WHERE id=? AND published=1").get(courseId)) return res.status(404).json({error:"Curso no encontrado o no publicado."});
  db.prepare("INSERT INTO academy_progress(user_id,course_id,status,completed_at,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id,course_id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at,updated_at=CURRENT_TIMESTAMP")
    .run(req.user.id,courseId,status,status==="completed"?new Date().toISOString():null);
  audit(req,req.user.id,"academy.progress."+status);
  res.json({ok:true,status});
});

// Knowledge articles: only published content is visible to standard users.
app.get("/api/knowledge",auth,(req,res)=>{
  const q=textValue(req.query.search,120), drafts=req.user.role==="admin"&&String(req.query.includeDrafts||"")==="true";
  const clauses=[drafts?"1=1":"status='published'"], args=[];
  if(q){clauses.push("(title LIKE ? OR body LIKE ? OR tags LIKE ?)");args.push("%"+q+"%","%"+q+"%","%"+q+"%");}
  const items=db.prepare("SELECT id,title,category,body,tags,status,updated_at AS updatedAt FROM knowledge_articles WHERE "+clauses.join(" AND ")+" ORDER BY updated_at DESC LIMIT 100").all(...args);
  res.json({items});
});
app.post("/api/knowledge",auth,adminOnly,(req,res)=>{
  const title=textValue(req.body.title,180),category=textValue(req.body.category,80)||"General";
  const body=textValue(req.body.body,12000),tags=textValue(req.body.tags,500),status=textValue(req.body.status,16)||"draft";
  if(title.length<3||body.length<20||!["draft","published"].includes(status)) return res.status(400).json({error:"Artículo no válido: completa título y contenido."});
  const result=db.prepare("INSERT INTO knowledge_articles(title,category,body,tags,status,created_by) VALUES(?,?,?,?,?,?)").run(title,category,body,tags,status,req.user.id);
  audit(req,req.user.id,"knowledge.create."+status);
  res.status(201).json({id:Number(result.lastInsertRowid),ok:true});
});

// Shared product catalogue; no invented products are preloaded.
app.get("/api/products",auth,(req,res)=>{
  const q=textValue(req.query.search,100), like="%"+q+"%";
  const items=q
    ? db.prepare("SELECT id,sku,name,category,format,description,updated_at AS updatedAt FROM products WHERE sku LIKE ? OR name LIKE ? OR category LIKE ? ORDER BY name LIMIT 200").all(like,like,like)
    : db.prepare("SELECT id,sku,name,category,format,description,updated_at AS updatedAt FROM products ORDER BY name LIMIT 200").all();
  res.json({items});
});
app.post("/api/products",auth,adminOnly,(req,res)=>{
  const sku=textValue(req.body.sku,80),name=textValue(req.body.name,160),category=textValue(req.body.category,80)||"General";
  const format=textValue(req.body.format,120),description=textValue(req.body.description,2000);
  if(!sku||name.length<2) return res.status(400).json({error:"Código y nombre del producto son obligatorios."});
  try {
    const result=db.prepare("INSERT INTO products(sku,name,category,format,description) VALUES(?,?,?,?,?)").run(sku,name,category,format,description);
    audit(req,req.user.id,"product.create");
    res.status(201).json({id:Number(result.lastInsertRowid),ok:true});
  } catch(err) { if(String(err.code||"").includes("CONSTRAINT")) return res.status(409).json({error:"Ya existe un producto con ese código."}); console.error(err); res.status(500).json({error:"No se pudo guardar el producto."}); }
});

// DAM Bot is a grounded search over approved articles, not an unconfigured generative model.
app.post("/api/assistant/query",auth,(req,res)=>{
  const question=textValue(req.body.question,500);
  if(question.length<3) return res.status(400).json({error:"Escribe una consulta más concreta."});
  const terms=[...new Set(question.toLowerCase().split(/[^a-z0-9áéíóúüñ_-]+/i).filter(x=>x.length>=3))].slice(0,8);
  if(!terms.length) return res.status(400).json({error:"Incluye palabras concretas en la consulta."});
  const stmt=db.prepare("SELECT id,title,category,body,tags,updated_at AS updatedAt FROM knowledge_articles WHERE status='published' AND (lower(title) LIKE ? OR lower(body) LIKE ? OR lower(tags) LIKE ?) LIMIT 100");
  const found=[];
  for(const term of terms) for(const row of stmt.all("%"+term+"%","%"+term+"%","%"+term+"%")) if(!found.some(x=>x.id===row.id)) found.push(row);
  const sources=found.slice(0,5).map(row=>({id:row.id,title:row.title,category:row.category,excerpt:row.body.slice(0,700),updatedAt:row.updatedAt}));
  const answer=sources.length
    ? "He encontrado documentación publicada relacionada. Consulta las fuentes siguientes y sigue siempre los procedimientos oficiales y las instrucciones de seguridad de tu planta."
    : "No he encontrado documentación publicada que responda a esta consulta. No voy a inventar una respuesta: pide al responsable que incorpore un procedimiento aprobado en Conocimiento experto.";
  audit(req,req.user.id,"assistant.search");
  res.json({mode:"knowledge_search",answer,sources});
});

app.use((err,_req,res,_next) => {
  if (err.message?.includes("CORS")) return res.status(403).json({error:"Origen no autorizado."});
  console.error(err); res.status(500).json({error:"Error interno."});
});

const adminUsername = String(process.env.ADMIN_USERNAME || "Tarik").trim().toLowerCase();
const existingAdmin = db.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").get(adminUsername);
if (!existingAdmin) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD,12);
  db.prepare("INSERT INTO users (name,username,email,password_hash,role) VALUES (?,?,?,?, 'admin')")
    .run(process.env.ADMIN_NAME || "Tarik",adminUsername,(process.env.ADMIN_EMAIL || "admin@dammpulse.local").toLowerCase(),hash);
}
const port = Number(process.env.PORT || 8080);
app.listen(port,() => console.log("DammPulse API con SQLite escuchando en puerto",port));
