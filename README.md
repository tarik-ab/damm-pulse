# DAMM+

Prototipo académico de una plataforma de conocimiento y formación industrial.

## Funcionalidades incluidas
- Panel principal y navegación por secciones.
- Catálogo de máquinas con búsqueda, ficha contextual y QR.
- Registro y consulta de incidencias simuladas.
- Cápsulas de formación con cuestionarios.
- Formulario de aportación de conocimiento experto (borradores locales).
- DAM Bot de demostración con respuestas predefinidas y salida segura cuando no conoce una respuesta.
- Diseño responsive para ordenador, tablet y móvil.

## Ejecutar
Abre `index.html` en un navegador o publica el repositorio mediante GitHub Pages.

## Publicar con GitHub Pages
1. En el repositorio, abre **Settings → Pages**.
2. En **Build and deployment**, selecciona **Deploy from a branch**.
3. Selecciona la rama **main** y la carpeta **/(root)**.
4. Pulsa **Save** y espera a que GitHub genere la URL.

## Importante
Todo el contenido actual es ficticio. No contiene procedimientos reales ni debe utilizarse para operar o mantener maquinaria. Los formularios y aportaciones se guardan localmente en el navegador; no hay backend, usuarios, permisos, base de datos compartida ni IA conectada. El QR se genera para la URL de la ficha en el navegador y requiere que la web esté publicada para que otros dispositivos puedan abrirlo. Los datos reales de Damm solo deben incorporarse con autorización y validación de responsables competentes.

## Siguientes fases
1. Validar el problema y los flujos con trabajadores de Damm.
2. Diseñar backend, autenticación, roles y base de datos.
3. Incorporar búsqueda semántica/IA con fuentes aprobadas y registro de referencias.
4. Añadir transcripción de audio con revisión humana obligatoria.
5. Añadir métricas basadas en datos reales autorizados.

## Backend MariaDB (preparado, pendiente de despliegue)
El directorio `backend/` contiene una API Node.js y el esquema MariaDB para registro, inicio de sesión y administración centralizada de usuarios. Incluye hash bcrypt, roles, auditoría, paginación y protección del endpoint administrativo.

**Importante:** GitHub Pages no ejecuta el backend. Para tener cuentas compartidas entre dispositivos hay que desplegar `backend/` en un servidor con Node.js y conectar una instancia MariaDB. Después se debe configurar el frontend con la URL pública de la API. Hasta completar ese despliegue, el inicio de sesión existente sigue siendo una demo local con datos en el navegador.

Las credenciales de administración se configuran como secretos privados del servidor (`ADMIN_USERNAME` y `ADMIN_PASSWORD`). No deben escribirse en archivos públicos del repositorio. Usa una contraseña larga y única; el backend exige al menos 12 caracteres.
