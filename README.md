# Backend de Tapin — contador de toques + valor de suscripción

Este servidor ahora hace mucho más que contar toques. Resume así:

**Plan único ($89.900 COP):**
- Registro de toques NFC/QR con fecha, hora y dispositivo
- Filtro de reputación (positivo → Google, negativo → formulario privado)
- Panel de estadísticas, historial, exportación CSV/PDF

**Plan Pro ($180.000 COP/mes) — lo nuevo:**
1. **Rescate de reseñas negativas en tiempo real** — apenas un cliente califica mal, el dueño recibe un correo al instante con el comentario y, si lo dejó, su teléfono para llamarlo. Incluye un pipeline de seguimiento (`/quejas/:slug`) con estados *pendiente → contactado → resuelto* y tasa de recuperación.
2. **Reporte mensual automático por correo** (`/notificar/:slug`) — métricas, recomendaciones automáticas y comparación contra el promedio de tu categoría, todo en un correo con diseño de marca, sin que el dueño tenga que entrar al panel.
3. **Generador de contenido para redes** (`/contenido/:slug`) — cuando un cliente califica positivo, puede tocar una frase corta ("Excelente atención", etc.) sin fricción. Eso genera automáticamente una tarjeta cuadrada (1080x1080, lista para Instagram/Stories) descargable como SVG.

## Configurar el envío de correos

Necesitas una cuenta de correo para que el servidor envíe los emails. La opción más simple es Gmail:

1. Activa la verificación en dos pasos en la cuenta de Gmail que vas a usar.
2. Genera una "contraseña de aplicación" en https://myaccount.google.com/apppasswords
3. En Render, agrega estas variables de entorno:
   - `EMAIL_USER` → tu correo de Gmail (ej: tapin.notificaciones@gmail.com)
   - `EMAIL_PASS` → la contraseña de aplicación de 16 caracteres (no tu contraseña normal)

Si prefieres otro proveedor (Outlook, un dominio propio, etc.), agrega también `EMAIL_HOST` y `EMAIL_PORT`.

## Configurar tus negocios

Abre `server.js` y edita el objeto `NEGOCIOS`, o usa el panel `/editar?key=...` desde el navegador:

```js
const NEGOCIOS = {
  "mi-negocio": {
    nombre: "Mi Negocio",
    googleUrl: "https://g.page/r/TU_ENLACE_REAL/review",
    categoria: "restaurante",
    pais: "colombia",
    claveAcceso: "mi-negocio-2026",
    email: "dueno@minegocio.com",
  },
};
```

El campo `email` es donde llegan las alertas de quejas y los reportes mensuales — es obligatorio para que el Plan Pro funcione.

## Cómo se bloquea el Plan Pro

Cada negocio tiene un campo `plan` con valor `"basico"` o `"pro"`. Las 3 funciones nuevas verifican ese campo antes de hacer nada:

- Si `plan` no es `"pro"`, **no se envía ningún correo** de alerta ni de reporte mensual, sin importar lo que pase.
- Si `plan` no es `"pro"`, el cliente que califica bien va **directo a Google** — no le aparece el paso de elegir una frase, así que no se genera contenido.
- Las páginas `/contenido/:slug` y `/notificar/:slug` devuelven un error 402 ("Plan Pro requerido") si el negocio no está en Pro, en vez de mostrar datos o enviar nada.

Para subir un negocio a Pro: entra a `/editar/:slug?key=TU_CLAVE`, cambia el campo "Plan" a Pro, y guarda. Se activa de inmediato, sin redesplegar. Si el cliente deja de pagar, lo regresas a Básico y las 3 funciones se desactivan solas — los datos básicos (toques, redirección a Google, filtro de reseñas negativas) siguen funcionando igual.

## Cómo correrlo localmente

```bash
npm install
npm start
```

El servidor queda corriendo en `http://localhost:3000`.

## Rutas nuevas (Plan Pro)

- `/quejas/:slug?key=...` — pipeline de recuperación de clientes insatisfechos
- `/contenido/:slug?key=...` — galería de tarjetas de testimonios para redes
- `/notificar/:slug?key=...` — dispara el reporte mensual por correo (ver abajo)

## Automatizar el reporte mensual

El endpoint `/notificar/:slug?key=TU_CLAVE` envía el reporte mensual cuando lo visitas, pero no se dispara solo. Usa un servicio gratuito de cron para que lo visite automáticamente:

1. Crea una cuenta gratis en [cron-job.org](https://cron-job.org)
2. Crea un cron job nuevo por cada negocio, apuntando a:
   `https://tu-dominio.com/notificar/mi-negocio?key=TU_CLAVE`
3. Configúralo para que corra una vez al mes (ej: el día 1 a las 8am)

Repite esto por cada negocio que tengas activo.

## Cómo ver el historial y estadísticas

```
http://localhost:3000/stats?key=cambia-esta-clave
```

Desde ahí puedes ver historial, descargar CSV/PDF, revisar quejas, y ver el contenido generado para redes.

## Cómo ponerlo en internet

1. Sube esta carpeta a un repositorio de GitHub.
2. Conecta el repositorio en Render (Web Service, detecta Node.js automáticamente).
3. Agrega las variables de entorno `ADMIN_KEY`, `EMAIL_USER`, `EMAIL_PASS`.
4. Usa la URL pública resultante + `/r/mi-negocio` como el enlace del QR/NFC.

## Nota sobre el almacenamiento

Este backend guarda los datos en un archivo `data.json` en el propio servidor. Funciona bien para empezar y para varios negocios. Si más adelante necesitas algo más robusto (muchísimos negocios, reportes pesados), se puede migrar a PostgreSQL o Supabase conservando la misma lógica.
