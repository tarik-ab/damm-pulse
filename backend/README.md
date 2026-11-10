# DAMM+ API + MariaDB

Backend preparado para desplegar por separado de GitHub Pages. GitHub Pages solo sirve archivos estáticos; no ejecuta Node.js ni MariaDB.

## Incluye
- MariaDB con tablas `users` y `audit_log`.
- Registro e inicio de sesión con contraseñas bcrypt.
- Tokens JWT con caducidad de 8 horas.
- Rol administrador y endpoint protegido para consultar usuarios.
- Búsqueda y paginación del directorio.
- Activación/desactivación de cuentas.
- Rate limit en autenticación, CORS por origen permitido y cabeceras Helmet.
- El panel nunca recibe ni almacena contraseñas en texto plano.

## Preparar la base de datos
1. Crea una base de datos MariaDB y un usuario de aplicación con permisos solo sobre esa base.
2. Puedes ejecutar `schema.sql` desde el cliente MariaDB. El servidor también crea las tablas si no existen.
3. Instala dependencias con `npm install`.
4. Configura las variables del archivo `.env.example` como secretos del hosting.
5. Arranca con `npm start`.

## Variables importantes
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`: conexión MariaDB.
- `JWT_SECRET`: secreto aleatorio de al menos 32 caracteres.
- `ADMIN_USERNAME`: por defecto Tarik.
- `ADMIN_PASSWORD`: contraseña inicial configurada solo en el panel privado del hosting; mínimo 12 caracteres.
- `CORS_ORIGIN`: origen exacto de GitHub Pages o dominio propio.

No publiques `.env`, credenciales, volcados de base de datos ni datos reales de empleados.

## API
- `GET /api/health`
- `POST /api/auth/register` — `{name, username, email, department?, password}`
- `POST /api/auth/login` — `{identifier, password}`
- `GET /api/auth/me` — Bearer token
- `GET /api/admin/users?page=1&limit=25&search=` — solo admin
- `PATCH /api/admin/users/:id/status` — solo admin, `{status:"active"|"disabled"}`

El frontend actual aún necesita conectarse a la URL del backend para que el registro y el panel consulten esta base de datos compartida. Hasta desplegarlo y configurar esa URL, la web sigue en modo demo/localStorage.
