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
`);

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(x => x.trim()).filter(Boolean);
app.disable("x-powered-by");
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
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return res.status(400).json({error:"Introduce un correo electrónico válido."});
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
