require("dotenv").config();
const express = require("express");
const mariadb = require("mariadb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const required = ["DB_HOST","DB_USER","DB_PASSWORD","DB_NAME","JWT_SECRET","ADMIN_PASSWORD"];
for (const key of required) {
  if (!process.env[key]) {
    console.error("Falta la variable obligatoria:", key);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET debe tener al menos 32 caracteres.");
}
if (process.env.ADMIN_PASSWORD.length < 12) {
  throw new Error("ADMIN_PASSWORD debe tener al menos 12 caracteres. No uses claves débiles.");
}

const app = express();
const pool = mariadb.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 10,
  charset: "utf8mb4",
  timezone: "Z"
});
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
  pool.query(
    "INSERT INTO audit_log (user_id,event_type,ip_address,user_agent) VALUES (?,?,?,?)",
    [userId || null,event,req.ip, String(req.get("user-agent") || "").slice(0,255)]
  ).catch(err => console.error("Audit log:", err.message));
}
function issueToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, process.env.JWT_SECRET, { expiresIn: "8h", issuer: "dammpulse-api", audience: "dammpulse-app" });
}
async function auth(req,res,next) {
  try {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Inicia sesión para continuar." });
    const claims = jwt.verify(token, process.env.JWT_SECRET, { issuer: "dammpulse-api", audience: "dammpulse-app" });
    const rows = await pool.query("SELECT id,name,username,email,department,role,status FROM users WHERE id=? LIMIT 1", [claims.sub]);
    if (!rows.length || rows[0].status !== "active") return res.status(401).json({ error: "Sesión no válida." });
    req.user = rows[0];
    next();
  } catch {
    return res.status(401).json({ error: "Sesión caducada o no válida." });
  }
}
function adminOnly(req,res,next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Acceso exclusivo de administración." });
  next();
}

app.get("/api/health", async (_req,res) => {
  try { await pool.query("SELECT 1"); res.json({ status: "ok", database: "connected" }); }
  catch { res.status(503).json({ status: "unavailable", database: "disconnected" }); }
});

app.post("/api/auth/register", async (req,res) => {
  try {
    const name = String(req.body.name || "").trim();
    const username = String(req.body.username || "").trim().toLowerCase();
    const email = String(req.body.email || "").trim().toLowerCase();
    const department = String(req.body.department || "").trim().slice(0,100) || null;
    const password = String(req.body.password || "");
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "Introduce un nombre válido." });
    if (!/^[a-z0-9._-]{3,32}$/.test(username) || username === String(process.env.ADMIN_USERNAME || "Tarik").toLowerCase()) return res.status(400).json({ error: "Nombre de usuario no válido o reservado." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Introduce un correo electrónico válido." });
    if (password.length < 12) return res.status(400).json({ error: "La contraseña debe tener al menos 12 caracteres." });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (name,username,email,department,password_hash,role) VALUES (?,?,?,?,?,'user')",
      [name,username,email,department,hash]
    );
    const user = { id: Number(result.insertId), name, username, email, department, role: "user" };
    audit(req,user.id,"user.register");
    res.status(201).json({ token: issueToken(user), user });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "El usuario o correo ya está registrado." });
    console.error(err);
    res.status(500).json({ error: "No se pudo crear la cuenta." });
  }
});

app.post("/api/auth/login", async (req,res) => {
  try {
    const identifier = String(req.body.identifier || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const rows = await pool.query(
      "SELECT id,name,username,email,department,password_hash,role,status FROM users WHERE LOWER(username)=? OR LOWER(email)=? LIMIT 1",
      [identifier,identifier]
    );
    if (!rows.length || rows[0].status !== "active" || !(await bcrypt.compare(password,rows[0].password_hash))) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }
    const user = rows[0];
    await pool.query("UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?", [user.id]);
    audit(req,user.id,"user.login");
    delete user.password_hash;
    res.json({ token: issueToken(user), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo iniciar sesión." });
  }
});

app.get("/api/auth/me", auth, (req,res) => res.json({ user: req.user }));

app.get("/api/admin/users", auth, adminOnly, async (req,res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page,10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit,10) || 25));
    const search = String(req.query.search || "").trim().slice(0,100);
    const offset = (page - 1) * limit;
    const where = search ? "WHERE name LIKE ? OR username LIKE ? OR email LIKE ? OR department LIKE ?" : "";
    const params = search ? Array(4).fill("%" + search + "%") : [];
    const count = await pool.query("SELECT COUNT(*) AS total FROM users " + where, params);
    const rows = await pool.query(
      "SELECT id,name,username,email,department,role,status,created_at AS createdAt,last_login_at AS lastLoginAt FROM users " + where + " ORDER BY created_at DESC LIMIT ? OFFSET ?",
      [...params,limit,offset]
    );
    res.json({ users: rows, page, limit, total: Number(count[0].total) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo consultar el directorio." });
  }
});

app.patch("/api/admin/users/:id/status", auth, adminOnly, async (req,res) => {
  const status = req.body.status;
  if (!["active","disabled"].includes(status)) return res.status(400).json({ error: "Estado no válido." });
  try {
    const result = await pool.query("UPDATE users SET status=? WHERE id=? AND role='user'", [status,req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Usuario no encontrado." });
    audit(req,req.user.id,"user.status."+status);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo actualizar el usuario." });
  }
});

app.use((err,_req,res,_next) => {
  if (err.message?.includes("CORS")) return res.status(403).json({ error: "Origen no autorizado." });
  console.error(err);
  res.status(500).json({ error: "Error interno." });
});

async function start() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      username VARCHAR(32) NOT NULL UNIQUE,
      email VARCHAR(190) NOT NULL UNIQUE,
      department VARCHAR(100) NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin','user') NOT NULL DEFAULT 'user',
      status ENUM('active','disabled') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP NULL DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_users_created_at (created_at),
      KEY idx_users_role_status (role,status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await conn.query(`CREATE TABLE IF NOT EXISTS audit_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NULL,
      event_type VARCHAR(60) NOT NULL,
      ip_address VARCHAR(45) NULL,
      user_agent VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_audit_user_date (user_id,created_at),
      CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const adminName = String(process.env.ADMIN_USERNAME || "Tarik").trim().toLowerCase();
    const existing = await conn.query("SELECT id FROM users WHERE username=? LIMIT 1", [adminName]);
    if (!existing.length) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD,12);
      await conn.query(
        "INSERT INTO users (name,username,email,password_hash,role) VALUES (?,?,?,?, 'admin')",
        [process.env.ADMIN_NAME || "Tarik",adminName,process.env.ADMIN_EMAIL || "admin@dammpulse.local",hash]
      );
    }
  } finally { conn.release(); }
  const port = Number(process.env.PORT || 8080);
  app.listen(port,() => console.log("DammPulse API escuchando en puerto",port));
}
start().catch(err => { console.error("No se pudo iniciar DammPulse API:",err); process.exit(1); });
