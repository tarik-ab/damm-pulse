const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

test("DammPulse API: autenticación, permisos y módulos operativos", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dammpulse-api-"));
  const port = await freePort();
  const base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname.replace(/[\\/]test$/, ""),
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: path.join(dir, "test.sqlite"),
      JWT_SECRET: "test-only-secret-with-at-least-32-characters-2026",
      ADMIN_PASSWORD: "TestAdminPassword!2026",
      ADMIN_USERNAME: "testadmin",
      ADMIN_NAME: "Test Administrator",
      ADMIN_EMAIL: "testadmin@example.test",
      CORS_ORIGIN: "",
      NODE_ENV: "test"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });

  async function call(route, { method = "GET", token, body } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}
    return { status: response.status, data };
  }

  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error("API exited early:\n" + output);
      try {
        const res = await fetch(base + "/api/health");
        if (res.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 125));
    }
    assert.equal(ready, true, "API did not become healthy:\n" + output);

    const health = await call("/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.data.database, "connected");

    const adminLogin = await call("/api/auth/login", {
      method: "POST", body: { identifier: "testadmin", password: "TestAdminPassword!2026" }
    });
    assert.equal(adminLogin.status, 200);
    const admin = adminLogin.data.token;
    assert.ok(admin);

    const suffix = String(Date.now());
    const registration = await call("/api/auth/register", {
      method: "POST",
      body: {
        name: "Test Employee",
        username: "employee" + suffix,
        email: "employee" + suffix + "@example.test",
        department: "Operations",
        password: "EmployeePassword!2026"
      }
    });
    assert.equal(registration.status, 201, JSON.stringify(registration.data));
    const employee = registration.data.token;
    assert.ok(employee);

    assert.equal((await call("/api/auth/me", { token: employee })).status, 200);
    assert.equal((await call("/api/equipment")).status, 401);
    assert.equal((await call("/api/equipment", { token: employee })).status, 200);
    assert.equal((await call("/api/equipment", { method: "POST", token: employee, body: { code: "E-1", name: "Unauthorized" } })).status, 403);

    const equipment = await call("/api/equipment", {
      method: "POST", token: admin,
      body: { code: "TEST-EQ-" + suffix, name: "Test Filling Machine", area: "Line 1", status: "operativo", description: "QA test equipment" }
    });
    assert.equal(equipment.status, 201, JSON.stringify(equipment.data));
    const equipmentId = equipment.data.item.id;
    assert.equal((await call("/api/equipment/code/TEST-EQ-" + suffix, { token: employee })).status, 200);
    assert.equal((await call("/api/equipment/" + equipmentId, { method: "PATCH", token: admin, body: { status: "mantenimiento" } })).status, 200);

    const incident = await call("/api/incidents", {
      method: "POST", token: employee,
      body: { title: "Test vibration alert", description: "Automated API test incident", equipmentId, priority: "alta" }
    });
    assert.equal(incident.status, 201, JSON.stringify(incident.data));
    const incidentId = incident.data.id;
    assert.equal((await call("/api/incidents/" + incidentId, { method: "PATCH", token: employee, body: { status: "en_curso" } })).status, 200);
    assert.equal((await call("/api/incidents/" + incidentId, { method: "PATCH", token: admin, body: { status: "resuelta" } })).status, 200);

    const course = await call("/api/academy/courses", {
      method: "POST", token: admin,
      body: { title: "Test Academy Course", description: "Automated test course", durationMinutes: 12, content: "This is sufficiently long test course content.", published: false }
    });
    assert.equal(course.status, 201, JSON.stringify(course.data));
    const courseId = course.data.id;
    assert.equal((await call("/api/academy/courses", { token: employee })).data.items.length, 0);
    assert.equal((await call("/api/academy/courses?includeDrafts=true", { token: admin })).data.items.length, 1);
    assert.equal((await call("/api/academy/courses/" + courseId, { method: "PATCH", token: admin, body: { published: true } })).status, 200);
    assert.equal((await call("/api/academy/progress", { method: "POST", token: employee, body: { courseId, status: "in_progress" } })).status, 200);
    assert.equal((await call("/api/academy/progress", { method: "POST", token: employee, body: { courseId, status: "completed" } })).status, 200);

    const article = await call("/api/knowledge", {
      method: "POST", token: admin,
      body: { title: "SafetyProtocolDamm " + suffix, category: "Safety", tags: "shutdown, safety", body: "Approved safety procedure content for an automated integration test.", status: "draft" }
    });
    assert.equal(article.status, 201, JSON.stringify(article.data));
    const articleId = article.data.id;
    assert.equal((await call("/api/knowledge", { token: employee })).data.items.length, 0);
    assert.equal((await call("/api/knowledge/" + articleId, { method: "PATCH", token: admin, body: { status: "published" } })).status, 200);
    const assistant = await call("/api/assistant/query", { method: "POST", token: employee, body: { question: "SafetyProtocolDamm " + suffix } });
    assert.equal(assistant.status, 200);
    assert.ok(assistant.data.sources.length > 0, "assistant must return approved sources");

    const product = await call("/api/products", {
      method: "POST", token: admin,
      body: { sku: "TEST-SKU-" + suffix, name: "Test Beverage", category: "QA", format: "330ml", description: "Automated product test" }
    });
    assert.equal(product.status, 201, JSON.stringify(product.data));
    assert.equal((await call("/api/products/" + product.data.id, { method: "PATCH", token: admin, body: { format: "500ml" } })).status, 200);
    assert.ok((await call("/api/products?search=Test%20Beverage", { token: employee })).data.items.length > 0);

    const directory = await call("/api/admin/users", { token: admin });
    assert.equal(directory.status, 200);
    assert.ok(directory.data.total >= 2);

    t.diagnostic("All authenticated API module checks passed.");
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
